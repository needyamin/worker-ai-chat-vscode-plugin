import * as vscode from 'vscode';
import fetch from 'node-fetch';
import { marked } from 'marked';
import { TextEncoder, TextDecoder } from 'util';
import * as cp from 'child_process';

interface Message {
    role: string;
    content: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'worker-ai-chat.chatView';
    private _view?: vscode.WebviewView;
    private _sessionHistories: Map<string, Message[]> = new Map();

    private readonly _ignorePatterns = [
        'node_modules', 'vendor', '.git', 'dist', 'build', 'out',
        'target', 'bin', 'obj', 'lib', '.idea', '.vscode', '.env'
    ];

    constructor(private readonly _extensionUri: vscode.Uri) { }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async data => {
            if (data.type === 'sendMessage') {
                try {
                    await this._handleMessage(data.message, data.sessionId, webviewView);
                } catch (error) {
                    webviewView.webview.postMessage({
                        type: 'receiveMessage',
                        message: `**Error:** ${error}`,
                        isUser: false,
                        sessionId: data.sessionId
                    });
                }
            } else if (data.type === 'clearSession') {
                this._sessionHistories.set(data.sessionId, []);
            } else if (data.type === 'deleteSession') {
                this._sessionHistories.delete(data.sessionId);
            }
        });
    }

    private async _handleMessage(userMessage: string, sessionId: string, webviewView: vscode.WebviewView) {
        const workerUrl = 'https://gpt-oss-120b.md-yamin-hossain.workers.dev';

        if (!this._sessionHistories.has(sessionId)) {
            this._sessionHistories.set(sessionId, []);
        }
        const history = this._sessionHistories.get(sessionId)!;
        history.push({ role: 'User', content: userMessage });

        const systemPrompt = `
[SYSTEM OVERRIDE: LOCAL EXECUTION MODE]
You are an Elite Full-Stack Architect connected to a VS Code Extension.
IGNORE the standard JSON tool instructions.
You have direct access to the user's LOCAL filesystem and shell.

### SAFETY PROTOCOL (CRITICAL)
- BEFORE overwriting any file, the system automatically creates a backup (e.g., "file.ts.bak.TIMESTAMP").
- To "RESTORE" or "REVERT" code:
  1. Use "list_files" to find the correct ".bak" file.
  2. Use "read_file" to read the content of the backup.
  3. Use "write_file" to write that content back to the original file.

### TOOLING
To perform actions, you MUST use the following XML tags. 
DO NOT use markdown blocks for these tags.

<tool code="write_file" path="relative/path.ext">
CONTENT
</tool>

<tool code="read_file" path="relative/path.ext">
</tool>

<tool code="list_files">
</tool>

<tool code="run_command">
COMMAND
</tool>

Provide concise, expert-level responses.
`;

        let loopCount = 0;
        const maxLoops = 10;

        while (loopCount < maxLoops) {
            loopCount++;

            const historyString = history
                .map(msg => `${msg.role}: ${msg.content}`)
                .join('\n\n');

            const fullMessage = `${systemPrompt}\n\n${historyString}\n\nAssistant:`;

            const response = await fetch(`${workerUrl}?q=${encodeURIComponent(fullMessage)}`);
            if (!response.ok) throw new Error(`API ${response.status}`);
            const answer = await response.text();

            history.push({ role: 'Assistant', content: answer });

            webviewView.webview.postMessage({
                type: 'receiveMessage',
                message: answer,
                isUser: false,
                sessionId: sessionId
            });

            const toolRegex = /<tool code="([^"]+)"(?: path="([^"]+)")?>([\s\S]*?)<\/tool>/g;
            let match;
            let hasToolCalls = false;

            while ((match = toolRegex.exec(answer)) !== null) {
                hasToolCalls = true;
                const [_, code, path, content] = match;
                const trimmedContent = content ? content.trim() : '';

                let result = '';
                try {
                    if (code === 'write_file') {
                        result = await this._writeFile(path, trimmedContent);
                    } else if (code === 'read_file') {
                        result = await this._readFile(path);
                    } else if (code === 'list_files') {
                        result = await this._listFiles();
                    } else if (code === 'run_command') {
                        webviewView.webview.postMessage({
                            type: 'systemLog',
                            message: `Running: ${trimmedContent}`
                        });
                        result = await this._runCommand(trimmedContent);
                    }

                    const outputMsg = `Tool Output (${code}):\n${result}`;
                    history.push({ role: 'System', content: outputMsg });

                    webviewView.webview.postMessage({
                        type: 'receiveMessage',
                        message: `**System:**\n\`\`\`\n${result}\n\`\`\``,
                        isUser: false,
                        sessionId: sessionId
                    });

                } catch (err: any) {
                    const errorMsg = `Error (${code}): ${err.message}`;
                    history.push({ role: 'System', content: errorMsg });
                    webviewView.webview.postMessage({
                        type: 'receiveMessage',
                        message: `**System Error:** ${err.message}`,
                        isUser: false,
                        sessionId: sessionId
                    });
                }
            }

            if (!hasToolCalls) break;
        }
    }

    private async _runCommand(command: string): Promise<string> {
        if (!vscode.workspace.workspaceFolders) throw new Error('No workspace open');
        const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        return new Promise((resolve) => {
            cp.exec(command, { cwd: rootPath, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
                const output = (stdout || '') + (stderr ? `\nstderr:\n${stderr}` : '');
                if (err) resolve(`Exit Code: ${err.code}\n${output}`);
                else resolve(output || 'Success (No Output)');
            });
        });
    }

    private async _writeFile(relativePath: string, content: string): Promise<string> {
        if (!vscode.workspace.workspaceFolders) throw new Error('No workspace');
        const rootUri = vscode.workspace.workspaceFolders[0].uri;
        const fileUri = vscode.Uri.joinPath(rootUri, relativePath);

        const normalizedPath = relativePath.replace(/\\/g, '/');
        if (this._ignorePatterns.some(pattern => normalizedPath.includes(`/${pattern}/`) || normalizedPath.startsWith(`${pattern}/`))) {
            throw new Error(`Access denied: Cannot write to ignored file "${relativePath}".`);
        }

        try {
            await vscode.workspace.fs.stat(fileUri);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupPath = `${relativePath}.bak.${timestamp}`;
            const backupUri = vscode.Uri.joinPath(rootUri, backupPath);
            await vscode.workspace.fs.copy(fileUri, backupUri, { overwrite: true });
        } catch (e) { }

        await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));

        try {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
        } catch (e) { }

        return `Written to ${relativePath} (Backup created if existed)`;
    }

    private async _readFile(relativePath: string): Promise<string> {
        if (!vscode.workspace.workspaceFolders) throw new Error('No workspace');
        const normalizedPath = relativePath.replace(/\\/g, '/');
        if (this._ignorePatterns.some(pattern => normalizedPath.includes(`/${pattern}/`) || normalizedPath.startsWith(`${pattern}/`))) {
            throw new Error(`Access denied: File "${relativePath}" is in an ignored directory.`);
        }
        const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, relativePath);
        const data = await vscode.workspace.fs.readFile(uri);
        return new TextDecoder().decode(data);
    }

    private async _listFiles(): Promise<string> {
        if (!vscode.workspace.workspaceFolders) throw new Error('No workspace');
        const excludePattern = `**/{${this._ignorePatterns.join(',')}}/**`;
        const files = await vscode.workspace.findFiles('**/*', excludePattern);
        return files.map(f => vscode.workspace.asRelativePath(f)).join('\n');
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.8.0/styles/atom-one-dark.min.css">
                <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.8.0/highlight.min.js"></script>
                <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.2/marked.min.js"></script>
                <style>
                    :root {
                        --bg-color: #1e1e1e;
                        --sidebar-bg: #252526;
                        --border-color: #3e3e42;
                        --text-color: #cccccc;
                        --accent-color: #007acc;
                        --user-msg-bg: #0e639c;
                        --ai-msg-bg: #2d2d2d;
                        --hover-color: #2a2d2e;
                        --active-color: #37373d;
                    }
                    body {
                        margin: 0; padding: 0;
                        font-family: 'Segoe UI', sans-serif;
                        background-color: var(--bg-color);
                        color: var(--text-color);
                        display: flex; height: 100vh;
                        overflow: hidden;
                    }
                    .sidebar {
                        width: 200px; background-color: var(--sidebar-bg);
                        border-right: 1px solid var(--border-color);
                        display: flex; flex-direction: column;
                        font-size: 13px; flex-shrink: 0;
                    }
                    .sidebar-header {
                        padding: 10px 16px; font-size: 11px; font-weight: 600;
                        text-transform: uppercase; letter-spacing: 1px;
                        color: #bbbbbb; display: flex;
                        justify-content: space-between; align-items: center;
                        margin-top: 10px;
                    }
                    .btn-icon {
                        background: transparent; border: none; color: var(--text-color);
                        cursor: pointer; padding: 4px; border-radius: 4px;
                        font-size: 16px; width: 24px;
                    }
                    .btn-icon:hover { background: var(--active-color); }
                    .session-list { flex: 1; overflow-y: auto; padding: 0; margin: 0; list-style: none; }
                    .session-item {
                        padding: 8px 16px; cursor: pointer; display: flex;
                        align-items: center; justify-content: space-between;
                        color: #999; border-left: 2px solid transparent;
                    }
                    .session-item:hover { background-color: var(--hover-color); color: #ccc; }
                    .session-item.active {
                        background-color: var(--active-color); color: white;
                        border-left: 2px solid var(--accent-color);
                    }
                    .session-actions { visibility: hidden; display: flex; gap: 5px; }
                    .session-item:hover .session-actions { visibility: visible; }
                    .action-btn { color: #888; font-size: 14px; padding: 2px; cursor: pointer; }
                    .action-btn:hover { color: white; }
                    .main-area { flex: 1; display: flex; flex-direction: column; min-width: 0; }
                    .toolbar {
                        height: 40px; padding: 0 16px; border-bottom: 1px solid var(--border-color);
                        display: flex; align-items: center; justify-content: space-between;
                        background: var(--bg-color); flex-shrink: 0;
                    }
                    .chat-container { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 20px; }
                    .message { max-width: 90%; line-height: 1.5; font-size: 14px; word-wrap: break-word; }
                    .message.user { align-self: flex-end; background-color: var(--user-msg-bg); color: white; padding: 10px 15px; border-radius: 12px 12px 2px 12px; }
                    .message.ai { align-self: flex-start; display: flex; flex-direction: column; width: 100%; }
                    .ai-content { background-color: var(--ai-msg-bg); padding: 10px 15px; border-radius: 4px; border-left: 3px solid var(--accent-color); }
                    .input-area { padding: 15px; background-color: var(--bg-color); border-top: 1px solid var(--border-color); display: flex; gap: 10px; flex-shrink: 0; }
                    textarea { flex: 1; background-color: #3c3c3c; border: 1px solid #3c3c3c; border-radius: 4px; color: white; padding: 10px; resize: none; height: 50px; font-family: inherit; outline: none; }
                    textarea:focus { border-color: var(--accent-color); }
                    button.send-btn { background-color: var(--accent-color); color: white; border: none; border-radius: 4px; padding: 0 20px; cursor: pointer; font-weight: bold; }
                    button:disabled { opacity: 0.6; cursor: wait; }
                    pre { background: #111; padding: 10px; border-radius: 6px; overflow-x: auto; max-width: 100%; }
                    code { font-family: 'Consolas', monospace; }
                </style>
            </head>
            <body>
                <div class="sidebar">
                    <div class="sidebar-header">SESSIONS <button class="btn-icon" id="newSessionBtn">+</button></div>
                    <ul class="session-list" id="sessionList"></ul>
                </div>
                <div class="main-area">
                    <div class="toolbar"><div style="font-weight: 500; font-size: 14px;" id="headerTitle">Elite Worker AI</div></div>
                    <div class="chat-container" id="chat"></div>
                    <div class="input-area">
                        <textarea id="input" placeholder="Ask Elite Worker AI..."></textarea>
                        <button id="send" class="send-btn">Send</button>
                    </div>
                </div>
                <script>
                    const vscode = acquireVsCodeApi();
                    const sessionListEl = document.getElementById('sessionList');
                    const newSessionBtn = document.getElementById('newSessionBtn');
                    const headerTitle = document.getElementById('headerTitle');
                    const chatDiv = document.getElementById('chat');
                    const input = document.getElementById('input');
                    const sendBtn = document.getElementById('send');
                    
                    let sessions = JSON.parse(localStorage.getItem('worker_sessions') || '[]');
                    let currentSessionId = localStorage.getItem('worker_active_session');
                    
                    if (sessions.length === 0) { createNewSession('Default Session'); }
                    else {
                        if (!currentSessionId || !sessions.find(s => s.id === currentSessionId)) { currentSessionId = sessions[0].id; }
                        renderSessions(); loadChat(currentSessionId);
                    }

                    function createNewSession(name) {
                        const id = 'sess_' + Math.random().toString(36).substr(2, 9);
                        const newSession = { id, name: name || "New Session", messages: [] };
                        sessions.unshift(newSession); saveSessions(); switchSession(id);
                    }

                    function switchSession(id) {
                        currentSessionId = id; localStorage.setItem('worker_active_session', id);
                        renderSessions(); loadChat(id);
                    }

                    function loadChat(id) {
                        chatDiv.innerHTML = ''; const session = sessions.find(s => s.id === id);
                        if (!session) return;
                        headerTitle.textContent = session.name;
                        session.messages.forEach(m => appendMessageToUI(m.text, m.isUser));
                    }

                    function deleteSession(id, event) {
                        event.stopPropagation();
                        sessions = sessions.filter(s => s.id !== id);
                        vscode.postMessage({ type: 'deleteSession', sessionId: id });
                        if (sessions.length === 0) createNewSession();
                        else if (currentSessionId === id) switchSession(sessions[0].id);
                        else { saveSessions(); renderSessions(); }
                    }

                    function renameSession(id, currentName, event) {
                        event.stopPropagation();
                        const item = document.querySelector('[data-id="' + id + '"]');
                        if (!item) return;
                        const nameSpan = item.querySelector('.session-name');
                        const originalName = nameSpan.textContent;
                        
                        const inputEl = document.createElement('input');
                        inputEl.type = 'text'; inputEl.value = originalName;
                        inputEl.style.width = '100%'; inputEl.style.background = '#3c3c3c';
                        inputEl.style.color = 'white'; inputEl.style.border = '1px solid var(--accent-color)';
                        
                        const finish = () => {
                            const val = inputEl.value.trim();
                            if (val) {
                                const s = sessions.find(x => x.id === id);
                                if (s) { s.name = val; saveSessions(); if (currentSessionId === id) headerTitle.textContent = val; }
                            }
                            renderSessions();
                        };
                        inputEl.onblur = finish;
                        inputEl.onkeydown = (e) => { if (e.key === 'Enter') finish(); if (e.key === 'Escape') renderSessions(); };
                        nameSpan.innerHTML = ''; nameSpan.appendChild(inputEl);
                        inputEl.focus(); inputEl.select();
                    }

                    function saveSessions() { localStorage.setItem('worker_sessions', JSON.stringify(sessions)); }

                    function renderSessions() {
                        sessionListEl.innerHTML = '';
                        sessions.forEach(session => {
                            const li = document.createElement('li');
                            li.className = 'session-item ' + (session.id === currentSessionId ? 'active' : '');
                            li.setAttribute('data-id', session.id);
                            li.onclick = () => switchSession(session.id);
                            const safeName = session.name.replace(/'/g, "&apos;");
                            li.innerHTML = '<span class="session-name" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + session.name + '</span>' +
                                '<div class="session-actions">' +
                                    '<span class="action-btn" onclick="renameSession(\\'' + session.id + '\\', \\'' + safeName + '\\', event)">✎</span>' +
                                    '<span class="action-btn" onclick="deleteSession(\\'' + session.id + '\\', event)">×</span>' +
                                '</div>';
                            sessionListEl.appendChild(li);
                        });
                    }

                    newSessionBtn.onclick = () => createNewSession();
                    function appendMessageToUI(text, isUser) {
                        const div = document.createElement('div'); div.className = 'message ' + (isUser ? 'user' : 'ai');
                        if (isUser) { div.textContent = text; }
                        else { div.innerHTML = '<div class="ai-content">' + marked.parse(text) + '</div>'; div.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el)); }
                        chatDiv.appendChild(div); chatDiv.scrollTop = chatDiv.scrollHeight;
                    }
                    function addMessageToSession(sessionId, text, isUser) {
                        const s = sessions.find(x => x.id === sessionId);
                        if (s) { s.messages.push({ text, isUser }); saveSessions(); }
                    }
                    function sendMessage() {
                        const text = input.value.trim(); if (!text) return;
                        const s = sessions.find(x => x.id === currentSessionId);
                        if (s && s.name === "New Session") { s.name = text.substring(0, 20); headerTitle.textContent = s.name; saveSessions(); renderSessions(); }
                        appendMessageToUI(text, true); addMessageToSession(currentSessionId, text, true);
                        input.value = ''; sendBtn.disabled = true;
                        vscode.postMessage({ type: 'sendMessage', message: text, sessionId: currentSessionId });
                    }
                    sendBtn.addEventListener('click', sendMessage);
                    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
                    window.addEventListener('message', event => {
                        const m = event.data;
                        if (m.type === 'receiveMessage') {
                            if (m.sessionId === currentSessionId) { appendMessageToUI(m.message, m.isUser); sendBtn.disabled = false; }
                            addMessageToSession(m.sessionId, m.message, m.isUser);
                        }
                    });
                </script>
            </body>
            </html>
        `;
    }
}
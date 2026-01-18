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
        const workerUrl = 'XXXXXXXXXXXXXXXXXXXXX';

        if (!this._sessionHistories.has(sessionId)) {
            this._sessionHistories.set(sessionId, []);
        }
        const history = this._sessionHistories.get(sessionId)!;
        history.push({ role: 'User', content: userMessage });

        const systemPrompt = `
[SYSTEM OVERRIDE: ELITE ARCHITECT MODE]
You are an Elite Full-Stack AI Engineer connected to a VS Code Extension.
Operating Workflow: **READ-WRITE-VERIFY**.

### 🛠️ CORE PROTOCOLS
1. **READ**: Analyze structure/code before edits.
2. **WRITE**: Use <tool code="replace_lines"> for existing files; <tool code="write_file"> ONLY for new ones.
3. **VERIFY**: AFTER every write, you MUST run a validation command (e.g., "npm test", "tsc", "ls").
4. **FIX**: If verification fails, immediately fix the error using the output.

### 🧰 TOOLING (XML ONLY)
<tool code="replace_lines" path="file.ext">
<search>Exact lines</search>
<replace>New lines</replace>
</tool>

<tool code="write_file" path="file.ext">CONTENT</tool>
<tool code="read_file" path="file.ext"></tool>
<tool code="list_files"></tool>
<tool code="run_command">COMMAND</tool>
<tool code="restore_file" path="file.ext">Restores latest backup.</tool>

### 🛡️ SAFETY
- Backups are automatic.
- Exclude node_modules, .git, vendor, etc.

Proceed with precision. Execute the next step in the loop.
`;

        let loopCount = 0;
        const maxLoops = 10;

        webviewView.webview.postMessage({ type: 'status', working: true, sessionId });

        try {
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

                const toolRegex = /<tool code="([^"]+)"(?: path="([^"]+)")?>([\s\S]*?)<\/tool>/g;
                let match;
                let hasToolCalls = false;

                webviewView.webview.postMessage({
                    type: 'receiveMessage',
                    message: answer.replace(toolRegex, '').trim(),
                    isUser: false,
                    sessionId: sessionId
                });

                while ((match = toolRegex.exec(answer)) !== null) {
                    hasToolCalls = true;
                    const [fullTool, code, path, content] = match;

                    webviewView.webview.postMessage({
                        type: 'toolCall',
                        code, path, status: 'running',
                        sessionId
                    });

                    let result = '';
                    try {
                        if (code === 'replace_lines') {
                            result = await this._replaceLines(path || '', content);
                        } else if (code === 'write_file') {
                            result = await this._writeFile(path || '', content);
                        } else if (code === 'read_file') {
                            result = await this._readFile(path || '');
                        } else if (code === 'list_files') {
                            result = await this._listFiles();
                        } else if (code === 'run_command') {
                            result = await this._runCommand(content.trim());
                        } else if (code === 'restore_file') {
                            result = await this._restoreFile(path || '');
                        }

                        history.push({ role: 'System', content: `Tool Output (${code}):\n${result}` });

                        webviewView.webview.postMessage({
                            type: 'toolCall',
                            code, path, status: 'success',
                            result: result,
                            sessionId
                        });

                    } catch (err: any) {
                        history.push({ role: 'System', content: `Error (${code}): ${err.message}` });
                        webviewView.webview.postMessage({
                            type: 'toolCall',
                            code, path, status: 'error',
                            result: err.message,
                            sessionId
                        });
                    }
                }

                if (!hasToolCalls) break;
            }
        } finally {
            webviewView.webview.postMessage({ type: 'status', working: false, sessionId });
        }
    }

    private async _replaceLines(relativePath: string, content: string): Promise<string> {
        if (!vscode.workspace.workspaceFolders) throw new Error('No workspace');
        const rootUri = vscode.workspace.workspaceFolders[0].uri;
        const fileUri = vscode.Uri.joinPath(rootUri, relativePath);

        const searchMatch = content.match(/<search>([\s\S]*?)<\/search>/);
        const replaceMatch = content.match(/<replace>([\s\S]*?)<\/replace>/);

        if (!searchMatch || !replaceMatch) throw new Error('Malformed replace_lines content.');

        const search = searchMatch[1];
        const replace = replaceMatch[1];

        const bytes = await vscode.workspace.fs.readFile(fileUri);
        const original = new TextDecoder().decode(bytes);

        if (!original.includes(search)) {
            throw new Error(`Search string not found in "${relativePath}".`);
        }

        await this._createBackup(relativePath, fileUri, rootUri);
        const updated = original.replace(search, replace);
        await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(updated));

        return `Successfully updated ${relativePath}`;
    }

    private async _restoreFile(relativePath: string): Promise<string> {
        if (!vscode.workspace.workspaceFolders) throw new Error('No workspace');
        const rootUri = vscode.workspace.workspaceFolders[0].uri;
        const fileUri = vscode.Uri.joinPath(rootUri, relativePath);

        const files = await vscode.workspace.fs.readDirectory(rootUri);
        const baks = files
            .filter(([name, type]) => name.startsWith(relativePath + '.bak.'))
            .sort((a, b) => b[0].localeCompare(a[0]));

        if (baks.length === 0) throw new Error(`No backups found for "${relativePath}"`);

        const latestBak = baks[0][0];
        const bakUri = vscode.Uri.joinPath(rootUri, latestBak);
        await vscode.workspace.fs.copy(bakUri, fileUri, { overwrite: true });
        return `Restored "${relativePath}" from backup.`;
    }

    private async _createBackup(relativePath: string, fileUri: vscode.Uri, rootUri: vscode.Uri) {
        try {
            await vscode.workspace.fs.stat(fileUri);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupPath = `${relativePath}.bak.${timestamp}`;
            const backupUri = vscode.Uri.joinPath(rootUri, backupPath);
            await vscode.workspace.fs.copy(fileUri, backupUri, { overwrite: true });
        } catch (e) { }
    }

    private async _runCommand(command: string): Promise<string> {
        if (!vscode.workspace.workspaceFolders) throw new Error('No workspace');
        const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        return new Promise((resolve) => {
            cp.exec(command, { cwd: rootPath, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
                const output = (stdout || '') + (stderr ? `\nstderr:\n${stderr}` : '');
                if (err) resolve(`Exit Code: ${err.code}\n${output}`);
                else resolve(output || 'Done');
            });
        });
    }

    private async _writeFile(relativePath: string, content: string): Promise<string> {
        if (!vscode.workspace.workspaceFolders) throw new Error('No workspace');
        const rootUri = vscode.workspace.workspaceFolders[0].uri;
        const fileUri = vscode.Uri.joinPath(rootUri, relativePath);
        const normalizedPath = relativePath.replace(/\\/g, '/');
        if (this._ignorePatterns.some(pattern => normalizedPath.includes(`/${pattern}/`) || normalizedPath.startsWith(`${pattern}/`))) {
            throw new Error(`Access denied: "${relativePath}" is ignored.`);
        }
        await this._createBackup(relativePath, fileUri, rootUri);
        await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));
        try {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
        } catch (e) { }
        return `Written to ${relativePath}`;
    }

    private async _readFile(relativePath: string): Promise<string> {
        if (!vscode.workspace.workspaceFolders) throw new Error('No workspace');
        const normalizedPath = relativePath.replace(/\\/g, '/');
        if (this._ignorePatterns.some(pattern => normalizedPath.includes(`/${pattern}/`) || normalizedPath.startsWith(`${pattern}/`))) {
            throw new Error(`Access denied: "${relativePath}" is ignored.`);
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
                        --bg-color: #0d1117;
                        --sidebar-bg: #161b22;
                        --border-color: #30363d;
                        --text-color: #c9d1d9;
                        --accent-color: #58a6ff;
                        --user-msg-bg: #21262d;
                        --ai-msg-bg: transparent;
                        --card-bg: #161b22;
                        --hover-color: #21262d;
                        --active-color: #30363d;
                        --success-color: #238636;
                        --error-color: #f85149;
                        --online-color: #3fb950;
                        --offline-color: #f85149;
                    }
                    * { box-sizing: border-box; }
                    body {
                        margin: 0; padding: 0;
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
                        background-color: var(--bg-color); color: var(--text-color);
                        display: flex; height: 100vh; overflow: hidden;
                    }
                    .sidebar {
                        width: 240px; background-color: var(--sidebar-bg);
                        border-right: 1px solid var(--border-color);
                        display: flex; flex-direction: column; flex-shrink: 0;
                    }
                    .sidebar-header { padding: 16px; font-size: 11px; font-weight: 600; color: #8b949e; display: flex; justify-content: space-between; }
                    .session-list { flex: 1; overflow-y: auto; list-style: none; padding: 0; margin: 0; }
                    .session-item { padding: 10px 16px; cursor: pointer; display: flex; align-items: center; justify-content: space-between; font-size: 13px; color: #8b949e; }
                    .session-item:hover { background: var(--hover-color); color: #c9d1d9; }
                    .session-item.active { background: var(--active-color); color: #fff; border-left: 2px solid var(--accent-color); }
                    .action-btn { visibility: hidden; opacity: 0.6; cursor: pointer; }
                    .session-item:hover .action-btn { visibility: visible; }
                    .main-area { flex: 1; display: flex; flex-direction: column; min-width: 0; position: relative; }
                    .header { height: 40px; border-bottom: 1px solid var(--border-color); display: flex; align-items: center; justify-content: space-between; padding: 0 16px; }
                    .health-status { display: flex; align-items: center; gap: 6px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
                    .chat-container { flex: 1; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 24px; }
                    .message { max-width: 100%; animation: fadeIn 0.3s ease; }
                    .message.user { align-self: flex-end; background: var(--user-msg-bg); padding: 12px 16px; border-radius: 12px; max-width: 80%; }
                    .message.ai { align-self: flex-start; width: 100%; border-bottom: 1px solid var(--border-color); padding-bottom: 24px; }
                    .ai-content { font-size: 14px; line-height: 1.6; }
                    .tool-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; margin: 10px 0; overflow: hidden; }
                    .tool-header { padding: 8px 12px; background: rgba(255,255,255,0.03); display: flex; justify-content: space-between; align-items: center; cursor: pointer; font-size: 12px; }
                    .tool-status { display: flex; align-items: center; gap: 8px; }
                    .status-dot { width: 8px; height: 8px; border-radius: 50%; }
                    .status-running { background: var(--accent-color); animation: pulse 1.5s infinite; }
                    .status-success { background: var(--success-color); }
                    .status-error { background: var(--error-color); }
                    .tool-details { padding: 12px; border-top: 1px solid var(--border-color); display: none; }
                    .tool-details.show { display: block; }
                    pre { background: #000; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 12px; }
                    .input-area { padding: 20px; border-top: 1px solid var(--border-color); background: var(--bg-color); }
                    .input-wrapper { background: #161b22; border: 1px solid var(--border-color); border-radius: 12px; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
                    textarea { background: transparent; border: none; color: #fff; width: 100%; min-height: 60px; resize: none; outline: none; padding: 8px; font-family: inherit; }
                    .input-footer { display: flex; justify-content: space-between; align-items: center; }
                    .send-btn { background: var(--accent-color); color: #fff; border: none; padding: 6px 16px; border-radius: 6px; font-weight: 600; cursor: pointer; }
                    .working-indicator { color: var(--accent-color); font-size: 12px; display: none; align-items: center; gap: 8px; }
                    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
                    @keyframes pulse { 0% { opacity: 0.4; } 50% { opacity: 1; } 100% { opacity: 0.4; } }
                </style>
            </head>
            <body>
                <div class="sidebar">
                    <div class="sidebar-header">CHATS <span id="newChatBtn" style="cursor:pointer">+</span></div>
                    <ul class="session-list" id="sessionList"></ul>
                </div>
                <div class="main-area">
                    <div class="header">
                        <div style="font-size: 12px; font-weight: 600;">Elite Worker AI</div>
                        <div class="health-status" id="healthBox">
                            <span class="status-dot" id="healthDot" style="background: grey;"></span>
                            <span id="healthText">Checking...</span>
                        </div>
                    </div>
                    <div class="chat-container" id="chat"></div>
                    <div class="working-indicator" id="working" style="padding: 10px 24px;">
                         <span class="status-dot status-running"></span> Assistant is working...
                    </div>
                    <div class="input-area">
                        <div class="input-wrapper">
                            <textarea id="input" placeholder="Ask Elite Architect..."></textarea>
                            <div class="input-footer">
                                <span style="font-size: 10px; color: #8b949e;">Shift+Enter for newline</span>
                                <button id="send" class="send-btn">Send</button>
                            </div>
                        </div>
                    </div>
                </div>
                <script>
                    const vscode = acquireVsCodeApi();
                    const chatDiv = document.getElementById('chat');
                    const input = document.getElementById('input');
                    const sendBtn = document.getElementById('send');
                    const workingInd = document.getElementById('working');
                    const sessionListEl = document.getElementById('sessionList');
                    const healthDot = document.getElementById('healthDot');
                    const healthText = document.getElementById('healthText');
                    
                    let sessions = JSON.parse(localStorage.getItem('worker_sessions') || '[]');
                    let currentId = localStorage.getItem('worker_active_session');
                    
                    if (!sessions.length) createNewSession('Initial Chat');
                    else { if (!currentId || !sessions.find(s=>s.id === currentId)) currentId = sessions[0].id; switchSession(currentId); }

                    async function checkHealth() {
                        try {
                            const res = await fetch('XXXXXXXXXXXXXXXXXXXX/health');
                            if (res.ok) {
                                healthDot.style.background = 'var(--online-color)';
                                healthText.textContent = 'System Online';
                                healthText.style.color = 'var(--online-color)';
                            } else { throw new Error(); }
                        } catch (e) {
                            healthDot.style.background = 'var(--offline-color)';
                            healthText.textContent = 'System Offline';
                            healthText.style.color = 'var(--offline-color)';
                        }
                    }
                    setInterval(checkHealth, 30000); checkHealth();

                    function createNewSession(name) {
                        const id = 'sess_' + Date.now();
                        sessions.unshift({ id, name, messages: [] });
                        save(); switchSession(id);
                    }
                    function switchSession(id) {
                        currentId = id; localStorage.setItem('worker_active_session', id);
                        workingInd.style.display = 'none';
                        renderSessions(); loadChat(id);
                    }
                    function save() { localStorage.setItem('worker_sessions', JSON.stringify(sessions)); }
                    function renderSessions() {
                        sessionListEl.innerHTML = '';
                        sessions.forEach(s => {
                            const li = document.createElement('li');
                            li.className = 'session-item ' + (s.id === currentId ? 'active' : '');
                            li.innerHTML = '<span class="s-name">' + s.name + '</span>' +
                                '<div><span class="action-btn" onclick="renameChat(\\''+s.id+'\\',event)">✎</span> <span class="action-btn" onclick="deleteChat(\\''+s.id+'\\',event)">×</span></div>';
                            li.onclick = () => switchSession(s.id);
                            sessionListEl.appendChild(li);
                        });
                    }
                    function deleteChat(id, e) {
                        e.stopPropagation(); sessions = sessions.filter(s => s.id !== id);
                        workingInd.style.display = 'none';
                        if (!sessions.length) createNewSession('New Chat');
                        else if (currentId === id) switchSession(sessions[0].id);
                        save(); renderSessions();
                    }
                    function renameChat(id, e) {
                        e.stopPropagation();
                        const s = sessions.find(x => x.id === id);
                        const newName = prompt('New name:', s.name);
                        if (newName) { s.name = newName; save(); renderSessions(); }
                    }
                    function loadChat(id) {
                        chatDiv.innerHTML = ''; const s = sessions.find(x => x.id === id);
                        s.messages.forEach(m => {
                            if (m.type === 'tool') addToolCard(m.data, m.data.sessionId === currentId);
                            else appendUI(m.text, m.isUser, m.sessionId === currentId);
                        });
                    }
                    function appendUI(text, isUser, visible=true) {
                        if (!text) return;
                        const div = document.createElement('div');
                        div.className = 'message ' + (isUser ? 'user' : 'ai');
                        div.innerHTML = isUser ? text : '<div class="ai-content">' + marked.parse(text) + '</div>';
                        if (visible) { chatDiv.appendChild(div); chatDiv.scrollTop = chatDiv.scrollHeight; }
                        div.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el));
                    }
                    function addToolCard(data, visible=true) {
                        const id = 'tool_' + Date.now() + Math.random();
                        const div = document.createElement('div');
                        div.className = 'tool-card'; div.id = id;
                        const title = (data.code === 'write_file' || data.code === 'replace_lines') ? 
                            '🛠️ ' + data.code + ': ' + (data.path || 'file') : '⚙️ ' + data.code;
                        div.innerHTML = \`
                            <div class="tool-header" onclick="toggleTool('\${id}')">
                                <span>\${title}</span>
                                <div class="tool-status"><span class="status-dot status-\${data.status}"></span>\${data.status}</div>
                            </div>
                            <div class="tool-details"><pre><code>\${data.result || 'Processing...'}</code></pre></div>
                        \`;
                        if (visible) { chatDiv.appendChild(div); chatDiv.scrollTop = chatDiv.scrollHeight; }
                        return id;
                    }
                    window.toggleTool = (id) => { document.getElementById(id).querySelector('.tool-details').classList.toggle('show'); };
                    function sendMessage() {
                        const text = input.value.trim(); if (!text) return;
                        appendUI(text, true); const s = sessions.find(x => x.id === currentId);
                        s.messages.push({ text, isUser: true, sessionId: currentId });
                        if (s.name === 'Initial Chat' || s.name === 'New Chat') { s.name = text.substring(0,15); renderSessions(); }
                        save(); input.value = ''; sendBtn.disabled = true;
                        vscode.postMessage({ type: 'sendMessage', message: text, sessionId: currentId });
                    }
                    sendBtn.onclick = sendMessage;
                    input.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } };
                    window.addEventListener('message', e => {
                        const m = e.data; const s = sessions.find(x => x.id === m.sessionId);
                        if (m.type === 'status' && m.sessionId === currentId) workingInd.style.display = m.working ? 'flex' : 'none';
                        if (m.type === 'receiveMessage') {
                            appendUI(m.message, false, m.sessionId === currentId);
                            s.messages.push({ text: m.message, isUser: false, sessionId: m.sessionId });
                            if (m.sessionId === currentId) sendBtn.disabled = false;
                            save();
                        }
                        if (m.type === 'toolCall') {
                            addToolCard(m, m.sessionId === currentId);
                            s.messages.push({ type: 'tool', data: m, sessionId: m.sessionId });
                            save();
                        }
                    });
                    document.getElementById('newChatBtn').onclick = () => createNewSession('New Chat');
                </script>
            </body>
            </html>
        `;
    }
}
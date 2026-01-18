# Worker AI Chat

Chat with GPT-OSS-120B via your Cloudflare Worker directly inside VS Code. This extension provides a sidebar chat interface similar to ChatGPT.

## Features

- 💬 Sidebar chat interface
- ⚡ Quick access through Command Palette
- 🔑 Keyboard shortcuts support
- 🌐 Powered by Cloudflare Worker

## Installation

### From VS Code Marketplace
1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X)
3. Search for "Worker AI Chat"
4. Click Install

### From Source
1. Clone the repository
```bash
git clone https://github.com/needyamin/Worker-AI-Chat-VSCode-Plugin.git
<<<<<<< HEAD
cd Worker-AI-Chat-VSCode-Plugin
=======
cd worker-ai-chat
>>>>>>> d81749075c557e45bc0ee63bd65d65d3d7bb5d87
```

2. Install dependencies and vsce
```bash
npm install
npm install -g @vscode/vsce
```

3. Build the extension
```bash
npm run compile
```

4. Package the extension
```bash
vsce package
```

5. Install the generated .vsix file in VS Code:
   - Press Ctrl+Shift+P
   - Type "Install from VSIX"
   - Select the generated .vsix file

## Usage

### Sidebar Chat
1. Click the Worker AI Chat icon in the Activity Bar (sidebar)
2. Type your question in the input box
3. Press Enter or click Send
4. View the AI's response in the chat window

### Command Palette
1. Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (Mac)
2. Type "Ask Worker AI"
3. Enter your question

### Keyboard Shortcut
- Use `Ctrl+Shift+A` (Windows/Linux) or `Cmd+Shift+A` (Mac) to quickly ask a question

## Configuration

The extension uses the following Cloudflare Worker URL by default:
```
XXXXXXXXXXXXXXXXXXXXXXXXXXX
```

To use your own worker:
1. Deploy your Cloudflare Worker
2. Update the URL in `src/extension.ts`

## Requirements

- VS Code version 1.80.0 or higher
- Active internet connection
- Access to the Cloudflare Worker endpoint

## Known Issues

- Worker response time may vary based on network conditions
- Limited to text-based conversations currently

## Contributing

1. Fork the repository from [Worker-AI-Chat-VSCode-Plugin](https://github.com/needyamin/Worker-AI-Chat-VSCode-Plugin)
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

If you encounter any issues or have questions:
1. Open an issue on GitHub
2. Contact the developer at [needyamin@gmail.com]


## WORKER_URL = "XXXXXXXXXXXXXXXX"; // Replace with your deployed worker URL
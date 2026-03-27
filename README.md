# Operator Chat

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-GPL--3.0-green)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)
![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)

A chat-first workspace for running LLMs with tools, approvals, and per-chat sandboxes. Built with a ReAct agentic workflow that integrates with llama.cpp-compatible servers.

## ✨ Features

- **Chat with LLMs** - Connect to any llama.cpp-compatible server
- **Real-time Streaming** - Separate streaming for reasoning steps and final answers
- **Structured Reasoning** - Visual display of the agent's thought process
- **Built-in Tools**:
  - 🔍 Web search (SearXNG integration)
  - 📁 File system operations (read, write, list, delete)
  - 🐍 Python code execution
  - 🌐 Browser automation (Puppeteer)
  - 🧮 Calculator
- **Tool Approval System** - Require user approval for higher-risk operations
- **Per-Chat Preferences** - Remember tool settings and auto-approve choices
- **Dedicated Sandboxes** - Isolated filesystem for each conversation
- **MCP Integration** - Model Context Protocol support for extensibility
- **Docker Ready** - Easy deployment with Docker Compose
- **Internationalization** - Multi-language support (i18n)
- **Persistent Storage** - MariaDB backend for chats and settings

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend                              │
│         React + TypeScript + Vite + Tailwind CSS             │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ Socket.IO + REST API
                              │
┌─────────────────────────────────────────────────────────────┐
│                        Backend                               │
│              Express + Socket.IO + TypeScript                │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                    ReAct Agent                         │  │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐ │  │
│  │  │  Tools  │  │ Sandbox │  │  Memory │  │   MCP   │ │  │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘ │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              │
┌─────────────────────────────────────────────────────────────┐
│                       Database                               │
│                         MariaDB                              │
└─────────────────────────────────────────────────────────────┘
```

## 🚀 Quick Start

### Prerequisites

- [Docker](https://www.docker.com/) and [Docker Compose](https://docs.docker.com/compose/)
- (Optional) A [llama.cpp](https://github.com/ggerganov/llama.cpp) compatible server
- (Optional) A [SearXNG](https://searxng.org/) instance for web search

### 1. Clone the Repository

```bash
git clone <repository-url>
cd chatinterface
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and update the following:

```env
# Database (CHANGE THESE!)
DB_ROOT_PASSWORD=your_secure_root_password
DB_USER=chatapp
DB_PASSWORD=your_secure_password

# Security (IMPORTANT: Change this!)
JWT_SECRET=your-super-secret-jwt-key

# LLM Server
LLAMA_BASE_URL=http://localhost:8080
LLAMA_MODEL=your-model-name

# Optional: SearXNG for web search
SEARXNG_BASE_URL=http://localhost:8888
```

### 3. Start with Docker

```bash
# Start all services
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f
```

### 4. Access the Application

- **Frontend**: http://localhost
- **Backend API**: http://localhost:3001
- **phpMyAdmin** (dev): http://localhost:8081

## 🛠️ Development Setup

### Prerequisites

- Node.js 18+
- MariaDB/MySQL server
- llama.cpp-compatible server
- Python 3 (for `python_execute` tool)

### Install Dependencies

```bash
npm run install:all
```

### Configure Database

```bash
# Start MariaDB with Docker
docker-compose -f docker-compose.mariadb.yml up -d

# Configure backend
cd backend
cp .env.example .env
# Edit .env with your database credentials

# Run migrations (if you have existing JSON data)
npm run migrate
```

### Run Development Servers

```bash
# From project root - starts both frontend and backend
npm run dev

# Or run separately:
npm run dev:backend
npm run dev:frontend
```

### Build for Production

```bash
npm run build
```

## ⚙️ Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DB_HOST` | Database host | `mariadb` |
| `DB_PORT` | Database port | `3306` |
| `DB_USER` | Database user | `chatapp` |
| `DB_PASSWORD` | Database password | - |
| `DB_NAME` | Database name | `chatinterface` |
| `JWT_SECRET` | JWT signing secret | - |
| `BACKEND_PORT` | Backend API port | `3001` |
| `FRONTEND_PORT` | Frontend port | `80` |
| `LLAMA_BASE_URL` | LLM server URL | `http://localhost:8080` |
| `LLAMA_MODEL` | Model name | - |
| `SEARXNG_BASE_URL` | SearXNG URL | - |

### LLM Server

Operator Chat works with any llama.cpp-compatible server. Configure in `.env`:

```env
LLAMA_BASE_URL=http://your-llm-server:8080
LLAMA_MODEL=your-model-name
```

## 🔧 Tool System

Operator Chat includes a powerful tool system with approval policies:

### Built-in Tools

| Tool | Description | Risk Level |
|------|-------------|------------|
| `web_search` | Search the web via SearXNG | Low |
| `calculator` | Evaluate mathematical expressions | Low |
| `file_read` | Read files from sandbox | Low |
| `file_write` | Write files to sandbox | Medium |
| `file_list` | List sandbox directory contents | Low |
| `file_delete` | Delete sandbox files | High |
| `file_mkdir` | Create sandbox directories | Medium |
| `python_execute` | Execute Python code | High |
| `browser_visit` | Visit and scrape websites | Medium |

### Tool Policies

Each tool has an execution policy:

```typescript
interface ToolExecutionPolicy {
  requiresApproval: boolean;      // Requires user approval
  supportsAutoApprove: boolean;   // Can be auto-approved
  capabilities: string[];         // Tool capabilities
  sandboxPolicy: string;          // Sandbox restrictions
  riskLevel: 'low' | 'medium' | 'high';
}
```

For detailed information on creating custom tools, see [docs/tools.md](docs/tools.md).

## 📡 API Reference

### Chats

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/chat` | List all chats |
| `POST` | `/api/chat` | Create new chat |
| `DELETE` | `/api/chat/:id` | Delete chat |
| `GET` | `/api/chat/:id/messages` | Get chat messages |
| `PATCH` | `/api/chat/:id/messages/:index` | Edit message |
| `POST` | `/api/chat/:id/retry/:index` | Retry from message |

### Settings & Models

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/settings` | Get settings |
| `POST` | `/api/settings` | Update settings |
| `GET` | `/api/models` | List available models |
| `GET` | `/api/tools` | List available tools |

### Sandbox

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/sandbox/:id/files` | List sandbox files |
| `GET` | `/api/sandbox/:id/files/:path` | Get file content |
| `POST` | `/api/sandbox/:id/files` | Create file |
| `DELETE` | `/api/sandbox/:id/files/:path` | Delete file |
| `POST` | `/api/sandbox/:id/upload` | Upload file |

### Socket.IO Events

**Client → Server:**
- `join-chat` - Join a chat room
- `send-message` - Send a message
- `stop-agent` - Stop agent execution
- `tool-approval-response` - Respond to tool approval

**Server → Client:**
- `message` - New message
- `agent-step` - Agent reasoning step
- `thought-token` - Streaming thought
- `final-answer-token` - Streaming answer
- `agent-complete` - Agent finished
- `tool-approval-required` - Tool needs approval
- `error` - Error occurred

## 🐳 Docker Services

| Service | Port | Description |
|---------|------|-------------|
| `mariadb` | 3306 | MariaDB database |
| `backend` | 3001 | Node.js API server |
| `frontend` | 80 | Nginx + React app |
| `phpmyadmin` | 8081 | DB management (dev) |

### Docker Commands

```bash
# Start services
docker-compose up -d

# Stop services
docker-compose down

# View logs
docker-compose logs -f [service]

# Rebuild after changes
docker-compose up -d --build

# Remove volumes (WARNING: deletes data)
docker-compose down -v
```

## 📁 Project Structure

```
operator-chat/
├── backend/
│   ├── src/
│   │   ├── agent/           # ReAct agent implementation
│   │   ├── services/        # Business logic services
│   │   ├── tools/           # Tool implementations
│   │   ├── repositories/    # Data access layer
│   │   └── server.ts        # Entry point
│   ├── sandboxes/           # Chat sandbox directories
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/      # React components
│   │   ├── services/        # API clients
│   │   ├── i18n/            # Translations
│   │   └── App.tsx          # Main app
│   └── package.json
├── docs/
│   └── tools.md             # Tool authoring guide
├── docker-compose.yml
└── README.md
```

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines

- Follow existing code style
- Add tests for new features
- Update documentation as needed
- Ensure Docker builds succeed

## 📝 License

This project is licensed under the **GNU General Public License v3.0**.

```
Copyright (C) 2026 Operator Chat Contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
```

See the [LICENSE](LICENSE) file for the full license text.

## 🙏 Acknowledgments

- [llama.cpp](https://github.com/ggerganov/llama.cpp) - LLM inference
- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP specification
- [SearXNG](https://searxng.org/) - Privacy-respecting metasearch
- [Puppeteer](https://pptr.dev/) - Browser automation

## 📧 Support

For issues and questions:
- Open an issue on GitHub
- Check existing [documentation](docs/)

---

**Built with ❤️ using React, TypeScript, and Node.js**
# Operator Chat - Build Guide

## Project Overview

**Operator Chat** is a chat-first workspace for running LLMs with tools, approvals, per-chat sandboxes, and SSH-backed coding agents. It uses a ReAct (Reasoning + Acting) agentic workflow and integrates with llama.cpp-compatible servers.

**Tech Stack:**
- **Backend:** Node.js 18+, TypeScript, Express.js, Socket.IO, MariaDB, OpenAI SDK
- **Frontend:** React 18, Vite 7, TailwindCSS, React Router, Socket.IO-client
- **Infrastructure:** Docker Compose, Nginx, SearXNG, llama-swap, Kokoro (TTS), whisper.cpp

---

## Prerequisites

- Docker and Docker Compose
- Node.js 18+ (for local development)
- MariaDB/MySQL server (or use Docker)
- Python 3 (for Python code execution tool)
- A llama.cpp-compatible server (optional, for LLM backend)
- SearXNG instance (optional, for web search)

---

## Installation (Docker - Recommended)

### 1. Clone the Repository

```bash
git clone <repository-url>
cd operator-chat
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and update the following (IMPORTANT - change defaults!):

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

### 3. Start All Services

```bash
# Start all services in detached mode
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f
```

### 4. Access the Application

- **Frontend:** http://localhost
- **Backend API:** http://localhost:3001
- **phpMyAdmin** (dev profile): http://localhost:8081 (requires `--profile dev`)

---

## Local Development Setup

### 1. Install All Dependencies

```bash
npm run install:all
```

### 2. Start MariaDB (Docker)

```bash
docker-compose -f docker-compose.mariadb.yml up -d
```

### 3. Configure Backend

```bash
cd backend
cp .env.example .env
# Edit .env with your database credentials
```

### 4. Run Development Servers

```bash
# From project root - starts both frontend and backend
npm run dev

# Or run separately:
npm run dev:backend
npm run dev:frontend
```

### 5. Build for Production

```bash
npm run build
```

---

## Docker Services Reference

| Service | Port | Description |
|---------|------|-------------|
| `mariadb` | 3306 | MariaDB 11 database |
| `backend` | 3001 | Node.js API server (Express + Socket.IO) |
| `frontend` | 80 | Nginx + React SPA |
| `phpmyadmin` | 8081 | DB management (dev only) |
| `llama-swap` | 9292 | GPU-accelerated LLM inference |
| `searxng` | 8888 | Privacy-respecting web search |
| `kokoro` | 8880 | Text-to-speech (TTS) |
| `whisper-cpp` | 2022 | Speech-to-text (whisper.cpp) |
| `mcp-searxng` | 3333 | MCP server for web search |
| `playwright-mcp` | 8931 | Browser automation MCP |

### Useful Docker Commands

```bash
# Start services
docker-compose up -d

# Stop services
docker-compose down

# View logs for a specific service
docker-compose logs -f backend

# Rebuild after changes
docker-compose up -d --build

# Remove volumes (WARNING: deletes all data!)
docker-compose down -v
```

---

## SSH Agent Workspace Setup

Operator Chat supports a remote coding agent that runs commands and edits files on a remote server via SSH.

### 1. Prepare the Remote Server

The target server needs:
- SSH access from the backend container/host
- A user account (e.g., `operatorchat`)
- A writable workspace directory (e.g., `/home/operatorchat/project`)
- Common shell tools (`sh`, `grep`, `find`, `tail`, `base64`, etc.)

### 2. Create an SSH Key

```bash
ssh-keygen -t ed25519 -C "operator-chat-agent" -f ~/.ssh/operator_chat_agent
```

### 3. Install Public Key on Remote Server

```bash
ssh-copy-id -i ~/.ssh/operator_chat_agent.pub operatorchat@192.168.1.20
```

### 4. Verify Access

```bash
ssh -i ~/.ssh/operator_chat_agent operatorchat@192.168.1.20
```

### 5. Configure in Settings

Open **Settings → Agent Workspace** and configure:

| Field | Description |
|-------|-------------|
| Enable SSH agent workspace | Turns agent mode on |
| Host or IP | Remote host (e.g., `192.168.1.20`) |
| Port | SSH port (usually `22`) |
| Username | Remote SSH user |
| Workspace root | Absolute remote path where agents work |
| Private SSH key | Private key contents |
| Strict host key checking | Enable/disable host verification |

---

## Architecture Overview

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
│                   SSH Workspace Runtime                      │
└─────────────────────────────────────────────────────────────┘
                               │
                               │ SSH for agent commands/files
                               │
┌─────────────────────────────────────────────────────────────┐
│                  Remote Agent Workspace                      │
│             Your server, VM, container, or homelab           │
└─────────────────────────────────────────────────────────────┘
                               │
                               │ Chat and settings persistence
                               │
┌─────────────────────────────────────────────────────────────┐
│                       Database                               │
│                         MariaDB                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Configuration Variables

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

---

## Built-in Tools

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
| `create_agent` | Start an SSH remote coding agent | High |

---

## API Endpoints

### Chats
- `GET /api/chat` - List all chats
- `POST /api/chat` - Create new chat
- `DELETE /api/chat/:id` - Delete chat
- `GET /api/chat/:id/messages` - Get chat messages
- `PATCH /api/chat/:id/messages/:index` - Edit message
- `POST /api/chat/:id/retry/:index` - Retry from message

### Settings & Models
- `GET /api/settings` - Get settings
- `POST /api/settings` - Update settings
- `GET /api/models` - List available models
- `GET /api/tools` - List available tools
- `GET /api/agents` - List SSH agent runs

### Sandbox
- `GET /api/sandbox/:id/files` - List sandbox files
- `GET /api/sandbox/:id/files/:path` - Get file content
- `POST /api/sandbox/:id/files` - Create file
- `DELETE /api/sandbox/:id/files/:path` - Delete file
- `POST /api/sandbox/:id/upload` - Upload file

---

## Socket.IO Events

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
- `agent-runs` - Current chat's persisted SSH agent runs
- `agent-run-updated` - Live update for an SSH agent run
- `tool-approval-required` - Tool needs approval
- `tool-approval-resolved` - Tool approval has been consumed
- `error` - Error occurred

---

## Project Structure

```
operator-chat/
├── backend/
│   ├── src/
│   │   ├── agent/           # ReAct agent implementation
│   │   │   └── v2/          # v2 SSH agent system
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
│   │   ├── i18n/            # Translations (10 languages)
│   │   └── App.tsx          # Main app
│   └── package.json
├── docs/                    # Documentation
├── llama_swap/              # LLM swap configuration
├── models/                  # AI models storage
├── searxng/                 # SearXNG configuration
├── whisper_models/          # Whisper model storage
├── docker-compose.yml       # Docker orchestration
└── README.md
```

---

## License

GNU General Public License v3.0

---

## Acknowledgments

- [llama.cpp](https://github.com/ggerganov/llama.cpp) - LLM inference
- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP specification
- [SearXNG](https://searxng.org/) - Privacy-respecting metasearch
- [Puppeteer](https://pptr.dev/) - Browser automation

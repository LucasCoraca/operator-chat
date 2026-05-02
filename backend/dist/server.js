"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const socket_io_1 = require("socket.io");
const http_1 = require("http");
const crypto_1 = __importDefault(require("crypto"));
const multer_1 = __importDefault(require("multer"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const llamaClient_1 = require("./services/llamaClient");
const searxngClient_1 = require("./services/searxngClient");
const sandboxManager_1 = require("./services/sandboxManager");
const memoryManager_1 = require("./services/memoryManager");
const mcpClientManager_1 = require("./services/mcpClientManager");
const tools_1 = require("./tools");
const ReActAgent_1 = require("./agent/ReActAgent");
const workspaceRuntime_1 = require("./services/workspaceRuntime");
const agentMemoryService_1 = require("./services/agentMemoryService");
const auth_1 = require("./auth");
const db_1 = require("./db");
const repositories_1 = require("./repositories");
const schedule_1 = require("./services/schedule");
// JWT secret for socket.io
const JWT_SECRET = process.env.JWT_SECRET || 'operator-chat-secret-key-12345';
const app = (0, express_1.default)();
const httpServer = (0, http_1.createServer)(app);
const io = new socket_io_1.Server(httpServer, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
});
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// Configure multer for file uploads
const storage = multer_1.default.diskStorage({
    destination: (req, file, cb) => {
        // Get sandboxId from URL params
        const sandboxId = req.params.sandboxId;
        const sandbox = sandboxManager.getSandbox(sandboxId);
        // Check if sandbox exists in memory
        if (sandbox) {
            cb(null, sandbox.basePath);
        }
        else {
            // Check if sandbox directory exists on disk (for persistence after restart)
            // Use absolute path to sandboxes directory
            const sandboxPath = path_1.default.join(process.cwd(), 'sandboxes', sandboxId);
            if (fs_1.default.existsSync(sandboxPath)) {
                // Add sandbox to manager for future use
                sandboxManager.addSandbox(sandboxId, sandboxPath);
                cb(null, sandboxPath);
            }
            else {
                cb(new Error('Sandbox not found'), '');
            }
        }
    },
    filename: (req, file, cb) => {
        // Use original filename
        cb(null, file.originalname);
    },
});
const upload = (0, multer_1.default)({
    storage,
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB limit
    },
});
function shellQuote(value) {
    return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
// Default settings
const defaultSettings = {
    llama: {
        baseUrl: process.env.LLAMA_BASE_URL || 'http://localhost:8080',
    },
    searxng: {
        baseUrl: process.env.SEARXNG_BASE_URL || 'http://localhost:8080',
        safeSearch: parseInt(process.env.SEARXNG_SAFE_SEARCH || '1', 10),
    },
    ui: {
        showStats: false,
        selectedPersonality: 'professional',
        selectedModel: undefined,
        defaultToolPreferences: {},
    },
    mcpServers: {},
    remoteWorkspace: {
        enabled: false,
        host: '',
        port: 22,
        username: '',
        root: '',
        privateKey: '',
        strictHostKeyChecking: true,
        approvalPolicy: 'ask',
        toolApprovals: {},
        agentModel: undefined,
        contextWindowTokens: 128000,
        reservedOutputTokens: 30000,
        autoCompactThreshold: 0.82,
    },
};
// Settings will be loaded asynchronously
let loadedSettings = defaultSettings;
// Global state
const sandboxManager = new sandboxManager_1.SandboxManager();
const memoryManager = new memoryManager_1.MemoryManager();
const workspaceRuntimeFactory = new workspaceRuntime_1.WorkspaceRuntimeFactory(sandboxManager);
let searxngConfig = loadedSettings.searxng;
let llamaConfig = loadedSettings.llama;
// Initialize clients
let searxngClient = new searxngClient_1.SearXNGClient(searxngConfig);
let llamaClient = new llamaClient_1.LlamaClient(llamaConfig);
// Initialize MCP Client Manager
const mcpClientManager = new mcpClientManager_1.MCPClientManager();
// Initialize Tool Registry with MCP support
let toolRegistry = new tools_1.ToolRegistry(searxngClient, sandboxManager, memoryManager, mcpClientManager, agentMemoryService_1.agentMemoryService);
// Set up callback to re-register MCP tools when servers connect/disconnect
mcpClientManager.setOnToolsChangedCallback(() => {
    toolRegistry.registerMCPTools();
    console.log('MCP tools re-registered due to server change');
});
// Load MCP servers from settings
async function loadMCPServers() {
    const mcpServers = loadedSettings.mcpServers || {};
    for (const [name, config] of Object.entries(mcpServers)) {
        try {
            await mcpClientManager.addServer(name, config);
            console.log(`Loaded MCP server '${name}'`);
        }
        catch (error) {
            console.error(`Failed to load MCP server '${name}':`, error);
        }
    }
}
async function getUserSettings(userId) {
    const uiSettings = await repositories_1.settingsRepository.getUiSettings(userId);
    const mcpServersSettings = await repositories_1.settingsRepository.getMcpServers(userId);
    const remoteWorkspaceSettings = await repositories_1.settingsRepository.getRemoteWorkspace(userId);
    const settings = {
        ...defaultSettings,
        ui: {
            ...defaultSettings.ui,
            ...(uiSettings || {}),
        },
        mcpServers: mcpServersSettings || defaultSettings.mcpServers,
        remoteWorkspace: normalizeRemoteWorkspaceSettings(remoteWorkspaceSettings),
    };
    settings.ui.defaultToolPreferences = toolRegistry.mergeWithDefaultPreferences(settings.ui.defaultToolPreferences);
    return settings;
}
// Initialize database and load settings
async function initializeApp() {
    try {
        // Test database connection
        const connected = await (0, db_1.testConnection)();
        if (!connected) {
            console.error('Failed to connect to database. Please check your database configuration.');
            process.exit(1);
        }
        // Initialize database schema
        await (0, db_1.initializeDatabase)();
        console.log('Database initialized successfully');
        // Llama/SearXNG are server-level env config. UI and remote workspace settings are loaded per user.
        loadedSettings = defaultSettings;
        // Hydrate in-memory chat sessions from the database only after schema setup succeeds.
        await loadChats();
        // Load MCP servers
        await loadMCPServers();
        startTaskScheduler();
        console.log('Application initialized successfully');
        console.log('Llama server:', loadedSettings.llama.baseUrl);
        console.log('SearXNG server:', loadedSettings.searxng.baseUrl);
    }
    catch (error) {
        console.error('Failed to initialize application:', error);
        process.exit(1);
    }
}
// Initialize app on startup
initializeApp().catch(console.error);
function normalizeToolPreferences(preferences, defaultPreferences) {
    return restrictInternalAgentTools(toolRegistry.mergeWithDefaultPreferences(preferences, defaultPreferences || defaultSettings.ui.defaultToolPreferences));
}
const AGENT_INTERNAL_TOOL_NAMES = new Set([
    'list',
    'read',
    'glob',
    'grep',
    'bash',
    'terminal_list',
    'terminal_read',
    'terminal_kill',
    'write',
    'edit',
    'apply_patch',
    'memory_get',
    'memory_set',
    'memory_checkpoint',
]);
function restrictInternalAgentTools(preferences) {
    const next = { ...preferences };
    for (const toolName of AGENT_INTERNAL_TOOL_NAMES) {
        if (next[toolName]) {
            next[toolName] = { enabled: false, autoApprove: false };
        }
    }
    return next;
}
function buildSpawnedAgentToolPreferences(base, remoteWorkspace) {
    const preferences = toolRegistry.mergeWithDefaultPreferences(base);
    const toolApprovals = remoteWorkspace.toolApprovals || {};
    for (const [toolName, preference] of Object.entries(preferences)) {
        const enabled = AGENT_INTERNAL_TOOL_NAMES.has(toolName);
        preferences[toolName] = {
            ...preference,
            enabled,
            autoApprove: enabled && toolApprovals[toolName] === 'auto-approve',
        };
    }
    if (preferences.create_agent) {
        preferences.create_agent = { enabled: false, autoApprove: false };
    }
    return preferences;
}
function normalizeRemoteWorkspaceSettings(input) {
    const source = input && typeof input === 'object' ? input : {};
    const enabled = Boolean(source.enabled);
    const host = String(source.host || '').trim();
    const username = String(source.username || '').trim();
    const root = String(source.root || '').trim();
    const port = source.port !== undefined ? Number(source.port) : 22;
    const privateKey = source.privateKey ? String(source.privateKey).trim() : '';
    const privateKeyPath = source.privateKeyPath ? String(source.privateKeyPath).trim() : undefined;
    const approvalPolicy = source.approvalPolicy === 'auto-approve' ? 'auto-approve' : 'ask';
    const agentModel = source.agentModel ? String(source.agentModel).trim() : undefined;
    const contextWindowTokens = Number(source.contextWindowTokens ?? defaultSettings.remoteWorkspace.contextWindowTokens);
    const reservedOutputTokens = Number(source.reservedOutputTokens ?? defaultSettings.remoteWorkspace.reservedOutputTokens);
    const autoCompactThreshold = Number(source.autoCompactThreshold ?? defaultSettings.remoteWorkspace.autoCompactThreshold);
    const sourceToolApprovals = source.toolApprovals && typeof source.toolApprovals === 'object'
        ? source.toolApprovals
        : {};
    const toolApprovals = Array.from(AGENT_INTERNAL_TOOL_NAMES).reduce((acc, toolName) => {
        acc[toolName] = sourceToolApprovals[toolName] === 'auto-approve' || approvalPolicy === 'auto-approve'
            ? 'auto-approve'
            : 'ask';
        return acc;
    }, {});
    if (!enabled) {
        return {
            ...defaultSettings.remoteWorkspace,
            approvalPolicy,
            toolApprovals,
            agentModel,
            contextWindowTokens: Number.isFinite(contextWindowTokens) && contextWindowTokens >= 4096 ? contextWindowTokens : defaultSettings.remoteWorkspace.contextWindowTokens,
            reservedOutputTokens: Number.isFinite(reservedOutputTokens) && reservedOutputTokens >= 0 ? reservedOutputTokens : defaultSettings.remoteWorkspace.reservedOutputTokens,
            autoCompactThreshold: Number.isFinite(autoCompactThreshold) && autoCompactThreshold > 0 && autoCompactThreshold <= 1 ? autoCompactThreshold : defaultSettings.remoteWorkspace.autoCompactThreshold,
        };
    }
    if (!host ||
        !username ||
        !root ||
        host.startsWith('-') ||
        username.startsWith('-') ||
        !/^[A-Za-z0-9._-]+$/.test(username) ||
        !/^[A-Za-z0-9.-]+$/.test(host) ||
        !root.startsWith('/') ||
        (!privateKey && !privateKeyPath)) {
        return { ...defaultSettings.remoteWorkspace };
    }
    return {
        enabled: true,
        host,
        username,
        root,
        port: Number.isFinite(port) && port > 0 ? port : 22,
        privateKey,
        privateKeyPath,
        strictHostKeyChecking: source.strictHostKeyChecking !== false,
        approvalPolicy,
        toolApprovals,
        agentModel,
        contextWindowTokens: Number.isFinite(contextWindowTokens) && contextWindowTokens >= 4096 ? contextWindowTokens : defaultSettings.remoteWorkspace.contextWindowTokens,
        reservedOutputTokens: Number.isFinite(reservedOutputTokens) && reservedOutputTokens >= 0 ? reservedOutputTokens : defaultSettings.remoteWorkspace.reservedOutputTokens,
        autoCompactThreshold: Number.isFinite(autoCompactThreshold) && autoCompactThreshold > 0 && autoCompactThreshold <= 1 ? autoCompactThreshold : defaultSettings.remoteWorkspace.autoCompactThreshold,
    };
}
function getConfiguredWorkspaceConfig(remoteWorkspace) {
    if (!remoteWorkspace.enabled) {
        return undefined;
    }
    return {
        type: 'ssh_remote',
        ssh: {
            enabled: true,
            host: remoteWorkspace.host,
            username: remoteWorkspace.username,
            root: remoteWorkspace.root,
            port: remoteWorkspace.port,
            privateKey: remoteWorkspace.privateKey,
            privateKeyPath: remoteWorkspace.privateKeyPath,
            strictHostKeyChecking: remoteWorkspace.strictHostKeyChecking,
        },
    };
}
function getWorkspaceConfigForRoot(workspaceRoot, remoteWorkspace) {
    const configured = getConfiguredWorkspaceConfig(remoteWorkspace);
    if (!configured?.ssh) {
        return undefined;
    }
    return {
        type: 'ssh_remote',
        ssh: {
            ...configured.ssh,
            root: workspaceRoot,
        },
    };
}
function serializeRemoteWorkspaceSettings(settings) {
    return {
        ...settings,
        privateKey: '',
        hasPrivateKey: Boolean(settings.privateKey),
    };
}
function serializeAgentRun(run) {
    return {
        id: run.id,
        chatId: run.chatId,
        title: run.title,
        prompt: run.prompt,
        workspaceRoot: run.workspaceRoot,
        status: run.status,
        steps: run.steps,
        finalAnswer: run.finalAnswer,
        error: run.error,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        model: run.model,
    };
}
function normalizeWorkspaceConfig(input) {
    if (!input || typeof input !== 'object') {
        return undefined;
    }
    const workspace = input;
    if (workspace.type !== 'ssh_remote' && !workspace.ssh?.enabled) {
        return undefined;
    }
    const ssh = workspace.ssh || workspace;
    const host = String(ssh.host || '').trim();
    const username = String(ssh.username || '').trim();
    const root = String(ssh.root || '').trim();
    if (!host || !username || !root) {
        return undefined;
    }
    if (host.startsWith('-') || username.startsWith('-') || !/^[A-Za-z0-9._-]+$/.test(username) || !/^[A-Za-z0-9.-]+$/.test(host)) {
        return undefined;
    }
    if (!root.startsWith('/')) {
        return undefined;
    }
    const port = ssh.port !== undefined ? Number(ssh.port) : 22;
    return {
        type: 'ssh_remote',
        ssh: {
            enabled: true,
            host,
            username,
            root,
            port: Number.isFinite(port) && port > 0 ? port : 22,
            privateKeyPath: ssh.privateKeyPath ? String(ssh.privateKeyPath).trim() : undefined,
            strictHostKeyChecking: ssh.strictHostKeyChecking !== false,
        },
    };
}
const chatSessions = new Map();
const pendingChatSaveTimers = new Map();
const pendingApprovals = new Map();
const MAX_PERSISTED_STEP_CONTENT_CHARS = 20000;
const MAX_PERSISTED_PARTIAL_ANSWER_CHARS = 100000;
function scheduleChatSave(session, delayMs = 750) {
    const existingTimer = pendingChatSaveTimers.get(session.id);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
        pendingChatSaveTimers.delete(session.id);
        void saveChat(session).catch(console.error);
    }, delayMs);
    timer.unref?.();
    pendingChatSaveTimers.set(session.id, timer);
}
async function flushScheduledChatSave(session) {
    const existingTimer = pendingChatSaveTimers.get(session.id);
    if (existingTimer) {
        clearTimeout(existingTimer);
        pendingChatSaveTimers.delete(session.id);
    }
    await saveChat(session);
}
function truncateForPersistence(content, maxLength) {
    if (content === undefined || content.length <= maxLength) {
        return content;
    }
    return `${content.slice(0, maxLength)}\n\n[Truncated while saving to avoid oversized database packets.]`;
}
function parseJsonIfNeeded(value) {
    if (typeof value !== 'string') {
        return value;
    }
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
function sanitizeAgentStepsForPersistence(steps) {
    const parsedSteps = parseJsonIfNeeded(steps);
    if (!Array.isArray(parsedSteps)) {
        return [];
    }
    return parsedSteps.map((step) => ({
        ...step,
        content: truncateForPersistence(typeof step.content === 'string' ? step.content : '', MAX_PERSISTED_STEP_CONTENT_CHARS) ?? '',
    }));
}
function sanitizeAgentStateForPersistence(agentState) {
    const parsedAgentState = parseJsonIfNeeded(agentState);
    if (!parsedAgentState || typeof parsedAgentState !== 'object') {
        return undefined;
    }
    return {
        ...parsedAgentState,
        steps: sanitizeAgentStepsForPersistence(parsedAgentState.steps),
        finalAnswer: truncateForPersistence(typeof parsedAgentState.finalAnswer === 'string' ? parsedAgentState.finalAnswer : undefined, MAX_PERSISTED_PARTIAL_ANSWER_CHARS) ?? null,
        partialFinalAnswer: truncateForPersistence(typeof parsedAgentState.partialFinalAnswer === 'string' ? parsedAgentState.partialFinalAnswer : undefined, MAX_PERSISTED_PARTIAL_ANSWER_CHARS),
    };
}
function sanitizeAgentRunsForPersistence(agentRuns) {
    const parsedAgentRuns = parseJsonIfNeeded(agentRuns);
    if (!Array.isArray(parsedAgentRuns)) {
        return [];
    }
    return parsedAgentRuns.map((run) => ({
        ...run,
        status: ['running', 'completed', 'failed', 'cancelled'].includes(run.status) ? run.status : 'failed',
        steps: sanitizeAgentStepsForPersistence(run.steps),
        finalAnswer: truncateForPersistence(typeof run.finalAnswer === 'string' ? run.finalAnswer : undefined, MAX_PERSISTED_PARTIAL_ANSWER_CHARS) ?? null,
        error: truncateForPersistence(typeof run.error === 'string' ? run.error : undefined, MAX_PERSISTED_STEP_CONTENT_CHARS),
    }));
}
function normalizePersistedAgentRun(run) {
    if (run.status !== 'running') {
        return run;
    }
    return {
        ...run,
        status: 'failed',
        error: run.error || 'Agent run was interrupted by a server restart.',
    };
}
function latestIsoDate(values) {
    let latestTime = Number.NEGATIVE_INFINITY;
    let latestValue;
    for (const value of values) {
        if (!value)
            continue;
        const date = value instanceof Date ? value : new Date(value);
        const time = date.getTime();
        if (!Number.isFinite(time) || time <= latestTime)
            continue;
        latestTime = time;
        latestValue = date.toISOString();
    }
    return latestValue;
}
function normalizeChatMessages(messages, agentState, fallbackModel) {
    const normalizedMessages = (messages ?? []).map((message) => {
        if (message.id) {
            return message;
        }
        return {
            ...message,
            id: crypto_1.default.randomUUID(),
        };
    });
    let changed = normalizedMessages.some((message, index) => message !== (messages ?? [])[index]);
    const inferredModel = agentState?.model ?? fallbackModel;
    if (inferredModel) {
        for (let index = 0; index < normalizedMessages.length; index++) {
            const message = normalizedMessages[index];
            if (message.role === 'assistant' && !message.model) {
                normalizedMessages[index] = {
                    ...message,
                    model: inferredModel,
                };
                changed = true;
            }
        }
    }
    return { messages: normalizedMessages, changed };
}
function normalizeChatSession(session) {
    const normalizedToolPreferences = normalizeToolPreferences(session.toolPreferences);
    const toolPreferencesChanged = JSON.stringify(session.toolPreferences) !== JSON.stringify(normalizedToolPreferences);
    session.toolPreferences = normalizedToolPreferences;
    const normalizedApprovalMode = {
        alwaysApprove: session.approvalMode?.alwaysApprove ?? false,
    };
    const approvalModeChanged = (session.approvalMode?.alwaysApprove ?? false) !== normalizedApprovalMode.alwaysApprove;
    session.approvalMode = normalizedApprovalMode;
    const { messages, changed: messagesChanged } = normalizeChatMessages(session.messages, session.agentState, llamaConfig.model);
    session.messages = messages;
    if (!Array.isArray(session.agentRuns)) {
        session.agentRuns = [];
    }
    return toolPreferencesChanged || approvalModeChanged || messagesChanged;
}
function getChatNameFromQuery(query) {
    const normalized = query.replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return 'New Conversation';
    }
    const maxLength = 80;
    return normalized.length > maxLength
        ? `${normalized.slice(0, maxLength - 1).trimEnd()}…`
        : normalized;
}
// Load chats from database on startup
async function loadChats() {
    try {
        chatSessions.clear();
        const persistedChats = await repositories_1.chatRepository.findAll();
        console.log(`Loaded ${persistedChats.length} chats from database`);
        for (const chat of persistedChats) {
            const result = await repositories_1.chatRepository.getWithMessages(chat.id);
            if (result) {
                const { chat: persistedChat, messages } = result;
                const persistedAgentState = sanitizeAgentStateForPersistence(persistedChat.agent_state);
                const parsedPersistedAgentState = parseJsonIfNeeded(persistedChat.agent_state);
                const persistedAgentRuns = sanitizeAgentRunsForPersistence(parsedPersistedAgentState?.agentRuns)
                    .map(normalizePersistedAgentRun);
                const sharedAgentContext = parsedPersistedAgentState?.sharedAgentContext &&
                    typeof parsedPersistedAgentState.sharedAgentContext === 'object' &&
                    typeof parsedPersistedAgentState.sharedAgentContext.summary === 'string'
                    ? parsedPersistedAgentState.sharedAgentContext
                    : undefined;
                const latestActivityAt = latestIsoDate([
                    ...messages.map((message) => message.created_at),
                    ...persistedAgentRuns.map((run) => run.updatedAt),
                    persistedChat.updated_at,
                ]);
                const restoredMessages = messages.map((msg, idx) => ({
                    id: msg.id,
                    role: msg.role,
                    content: msg.content,
                    model: msg.model || undefined,
                    agentSteps: sanitizeAgentStepsForPersistence(msg.agent_steps),
                    agentRunId: msg.content.startsWith('__operator_agent_run__:') ? msg.content.slice('__operator_agent_run__:'.length).trim() : undefined,
                }));
                let restoredMessagesChanged = false;
                const restoredAgentMessageIds = new Set(restoredMessages
                    .map((message) => message.agentRunId || (message.content.startsWith('__operator_agent_run__:') ? message.content.slice('__operator_agent_run__:'.length).trim() : undefined))
                    .filter(Boolean));
                for (const run of persistedAgentRuns) {
                    if (restoredAgentMessageIds.has(run.id)) {
                        continue;
                    }
                    restoredMessages.push({
                        id: crypto_1.default.randomUUID(),
                        role: 'assistant',
                        content: `__operator_agent_run__:${run.id}`,
                        model: run.model,
                        agentSteps: [],
                        agentRunId: run.id,
                    });
                    restoredMessagesChanged = true;
                }
                const session = {
                    id: persistedChat.id,
                    userId: persistedChat.user_id,
                    sandboxId: persistedChat.sandbox_id,
                    messages: restoredMessages,
                    name: persistedChat.name,
                    createdAt: persistedChat.created_at.toISOString(),
                    updatedAt: latestActivityAt || persistedChat.updated_at.toISOString(),
                    agentState: persistedAgentState,
                    toolPreferences: persistedChat.tool_preferences || {},
                    approvalMode: persistedChat.approval_mode || { alwaysApprove: false },
                    agentRuns: persistedAgentRuns,
                    sharedAgentContext,
                };
                const sessionChanged = normalizeChatSession(session);
                chatSessions.set(persistedChat.id, session);
                if (sessionChanged || restoredMessagesChanged) {
                    await saveChat(session, { touchUpdatedAt: false });
                }
            }
        }
    }
    catch (error) {
        console.error('Error loading chats:', error);
    }
}
// Save chat to database
async function saveChat(session, options = {}) {
    try {
        // Update or create chat
        const existingChat = await repositories_1.chatRepository.findById(session.id);
        if (existingChat) {
            await repositories_1.chatRepository.update(session.id, {
                name: session.name,
                agent_state: {
                    ...sanitizeAgentStateForPersistence(session.agentState),
                    agentRuns: sanitizeAgentRunsForPersistence(session.agentRuns),
                    sharedAgentContext: session.sharedAgentContext,
                },
                tool_preferences: session.toolPreferences,
                approval_mode: session.approvalMode,
            }, { touchUpdatedAt: options.touchUpdatedAt });
        }
        else {
            await repositories_1.chatRepository.create({
                id: session.id,
                userId: session.userId,
                sandboxId: session.sandboxId,
                name: session.name,
                toolPreferences: session.toolPreferences,
                approvalMode: session.approvalMode,
            });
            await repositories_1.chatRepository.update(session.id, {
                agent_state: {
                    ...sanitizeAgentStateForPersistence(session.agentState),
                    agentRuns: sanitizeAgentRunsForPersistence(session.agentRuns),
                    sharedAgentContext: session.sharedAgentContext,
                },
            }, { touchUpdatedAt: options.touchUpdatedAt });
        }
        // Sync messages
        const existingMessages = await repositories_1.chatRepository.findMessagesByChatId(session.id);
        const existingMessageIds = new Set(existingMessages.map(m => m.id));
        const currentMessageIds = new Set(session.messages.map(m => m.id));
        // Delete messages that no longer exist
        for (const existingMsg of existingMessages) {
            if (!currentMessageIds.has(existingMsg.id)) {
                await repositories_1.chatRepository.deleteMessagesFromIndex(session.id, existingMsg.message_index);
            }
        }
        // Add or update messages
        for (let i = 0; i < session.messages.length; i++) {
            const msg = session.messages[i];
            if (existingMessageIds.has(msg.id)) {
                await repositories_1.chatRepository.updateMessage(msg.id, {
                    content: msg.content,
                    agent_steps: sanitizeAgentStepsForPersistence(msg.agentSteps),
                });
            }
            else {
                await repositories_1.chatRepository.addMessage({
                    id: msg.id,
                    chatId: session.id,
                    role: msg.role,
                    content: msg.content,
                    model: msg.model,
                    agentSteps: sanitizeAgentStepsForPersistence(msg.agentSteps),
                    messageIndex: i,
                });
            }
        }
    }
    catch (error) {
        console.error('Error saving chat:', error);
    }
}
// Save all chats to database
async function saveChats() {
    try {
        for (const session of chatSessions.values()) {
            await saveChat(session);
        }
    }
    catch (error) {
        console.error('Error saving all chats:', error);
    }
}
// Auth routes
app.post('/api/auth/register', auth_1.registerUser);
app.post('/api/auth/login', auth_1.loginUser);
app.get('/api/auth/me', auth_1.protect, auth_1.getMe);
function clearPendingApprovalsForChat(chatId, reason = 'cancelled') {
    for (const [approvalId, approval] of pendingApprovals.entries()) {
        if (approval.chatId !== chatId) {
            continue;
        }
        approval.resolve({
            approved: false,
            reason,
        });
        pendingApprovals.delete(approvalId);
    }
}
function getPendingApprovalPayloadForChat(chatId) {
    for (const approval of pendingApprovals.values()) {
        if (approval.chatId === chatId) {
            return {
                ...approval.request,
                chatId,
            };
        }
    }
    return null;
}
function parseWorkspaceListOutput(output, basePath) {
    const base = typeof basePath === 'string' ? basePath.replace(/^\/+|\/+$/g, '') : '';
    return output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => line !== '(empty directory)')
        .map((line) => {
        const [type, ...nameParts] = line.split(/\s+/);
        const rawName = nameParts.join(' ');
        const name = rawName.endsWith('/') ? rawName.slice(0, -1) : rawName;
        const isDirectory = type === 'd';
        return {
            path: base ? path_1.default.posix.join(base, name) : name,
            isDirectory,
            isProtected: false,
        };
    })
        .filter((item) => item.path && item.path !== '.');
}
function normalizeRemoteBrowserPath(input) {
    const raw = typeof input === 'string' ? input.trim().replaceAll('\\', '/') : '';
    if (!raw || raw === '/') {
        return '.';
    }
    const normalized = path_1.default.posix.normalize(`/${raw}`).slice(1);
    if (!normalized || normalized === '.') {
        return '.';
    }
    if (normalized === '..' || normalized.startsWith('../')) {
        throw new Error('Path escapes remote workspace root.');
    }
    return normalized;
}
function remoteBrowserAbsolutePath(workspace, relativePath) {
    const root = workspace.ssh?.root;
    if (!root) {
        throw new Error('Remote workspace root is not configured.');
    }
    const normalized = normalizeRemoteBrowserPath(relativePath);
    return normalized === '.'
        ? path_1.default.posix.normalize(root)
        : path_1.default.posix.join(path_1.default.posix.normalize(root), normalized);
}
function parseRemoteWorkspaceMetadata(output) {
    return output
        .split('\n')
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .map((line) => {
        const [type, encodedPath, encodedName, size, modifiedAt, createdAt, gitStatus] = line.split('\t');
        const decode = (value) => Buffer.from(value || '', 'base64').toString('utf8');
        return {
            path: decode(encodedPath),
            name: decode(encodedName),
            isDirectory: type === 'd',
            isProtected: false,
            size: Number(size) || 0,
            modifiedAt: Number(modifiedAt) > 0 ? new Date(Number(modifiedAt) * 1000).toISOString() : null,
            createdAt: Number(createdAt) > 0 ? new Date(Number(createdAt) * 1000).toISOString() : null,
            gitStatus: gitStatus && gitStatus !== '-' ? gitStatus : null,
        };
    });
}
async function getSelectedPersonality(userId, uiSettings) {
    const selectedPersonalityId = uiSettings?.selectedPersonality || defaultSettings.ui.selectedPersonality;
    if (!selectedPersonalityId)
        return null;
    const dbPersonality = await repositories_1.personalityRepository.findById(selectedPersonalityId);
    if (!dbPersonality)
        return null;
    if (dbPersonality.user_id && dbPersonality.user_id !== userId)
        return null;
    return {
        id: dbPersonality.id,
        name: dbPersonality.name,
        description: dbPersonality.description || '',
        tone: dbPersonality.tone || '',
        systemPrompt: dbPersonality.system_prompt,
        isCustom: dbPersonality.is_custom,
    };
}
function serializeTask(task) {
    return {
        id: task.id,
        userId: task.user_id,
        chatId: task.chat_id,
        sandboxId: task.sandbox_id,
        title: task.title,
        prompt: task.prompt,
        scheduleType: task.schedule_type,
        runAt: task.run_at,
        intervalMinutes: task.interval_minutes,
        daysOfWeek: task.days_of_week,
        timeOfDay: task.time_of_day,
        timezone: task.timezone,
        status: task.status,
        model: task.model,
        toolPreferences: normalizeToolPreferences(task.tool_preferences || {}),
        approvalMode: task.approval_mode || { alwaysApprove: false },
        reasoningEffort: task.reasoning_effort,
        lastRunAt: task.last_run_at,
        nextRunAt: task.next_run_at,
        createdAt: task.created_at,
        updatedAt: task.updated_at,
    };
}
function createSessionForUser(userId, name = 'Scheduled Task') {
    const chatId = crypto_1.default.randomUUID();
    const sandbox = sandboxManager.createSandbox();
    const now = new Date().toISOString();
    const session = {
        id: chatId,
        userId,
        sandboxId: sandbox.id,
        messages: [],
        name,
        createdAt: now,
        updatedAt: now,
        toolPreferences: normalizeToolPreferences(),
        approvalMode: { alwaysApprove: false },
        agentRuns: [],
    };
    chatSessions.set(chatId, session);
    return session;
}
function emitChatUpdated(session) {
    io.to(session.userId).emit('chat-updated', {
        chatId: session.id,
        sandboxId: session.sandboxId,
        name: session.name,
        messageCount: session.messages.length,
        updatedAt: session.updatedAt,
    });
}
function getAgentRunIdFromMessage(message) {
    if (message.agentRunId) {
        return message.agentRunId;
    }
    if (message.content.startsWith('__operator_agent_run__:')) {
        return message.content.slice('__operator_agent_run__:'.length).trim();
    }
    return undefined;
}
function getAgentFinalAnswer(run) {
    if (run.finalAnswer?.trim()) {
        return run.finalAnswer.trim();
    }
    for (let index = run.steps.length - 1; index >= 0; index--) {
        const step = run.steps[index];
        if (step.type === 'final_answer' && step.content.trim()) {
            return step.content.trim();
        }
    }
    return null;
}
function formatAgentRunForChatHistory(run) {
    const filesTouched = new Map();
    const commands = [];
    for (const step of run.steps) {
        if (step.type !== 'action' || !step.actionName) {
            continue;
        }
        if (['write', 'edit', 'apply_patch'].includes(step.actionName)) {
            const pathValue = String(step.actionArgs?.path || step.actionArgs?.filePath || step.actionArgs?.patchPath || '').trim();
            if (pathValue) {
                filesTouched.set(pathValue, step.actionName);
            }
            else if (step.actionName === 'apply_patch') {
                filesTouched.set('(patch applied)', step.actionName);
            }
        }
        if (step.actionName === 'bash') {
            const command = String(step.actionArgs?.command || '').trim();
            if (command) {
                commands.push(command);
            }
        }
    }
    const sections = [
        `Agent run: ${run.title}`,
        `Status: ${run.status}`,
        `Workspace: ${run.workspaceRoot}`,
    ];
    if (run.error) {
        sections.push(`Error: ${truncateForAgentContext(run.error, 1200)}`);
    }
    const finalAnswer = getAgentFinalAnswer(run);
    if (finalAnswer) {
        sections.push(`Final answer:\n${truncateForAgentContext(finalAnswer, 5000)}`);
    }
    if (filesTouched.size > 0) {
        sections.push(`Files touched:\n${Array.from(filesTouched.entries()).slice(-25).map(([filePath, action]) => `- ${filePath} (${action})`).join('\n')}`);
    }
    if (commands.length > 0) {
        sections.push(`Recent commands:\n${commands.slice(-12).map((command) => `- ${truncateForAgentContext(command, 500)}`).join('\n')}`);
    }
    return sections.join('\n\n');
}
function buildChatConversationHistory(session, excludeLastMessage = false) {
    const runById = new Map(session.agentRuns.map((run) => [run.id, run]));
    const messages = excludeLastMessage ? session.messages.slice(0, -1) : session.messages;
    return messages.map((message) => {
        const agentRunId = getAgentRunIdFromMessage(message);
        const run = agentRunId ? runById.get(agentRunId) : undefined;
        if (message.role === 'assistant' && run) {
            return {
                role: 'assistant',
                content: formatAgentRunForChatHistory(run),
            };
        }
        return {
            role: message.role,
            content: message.content,
        };
    });
}
function ensureCodingAgentSuccessContract(prompt) {
    const hasSuccessCriteria = /(^|\n)\s*#{0,3}\s*success criteria\s*:?\s*(\n|$)/i.test(prompt);
    const hasNonGoals = /(^|\n)\s*#{0,3}\s*non-?goals\s*:?\s*(\n|$)/i.test(prompt);
    const hasRequiredVerification = /(^|\n)\s*#{0,3}\s*required verification\s*:?\s*(\n|$)/i.test(prompt);
    if (hasSuccessCriteria && hasNonGoals && hasRequiredVerification) {
        return prompt;
    }
    return `${prompt.trim()}

Success Criteria:
- Complete the user's requested coding task in the configured remote workspace.
- The original issue or requested behavior is fixed from the user's perspective.
- Any changed code is saved in the remote workspace.

Non-goals:
- Do not expand into unrelated cleanup, optimization, or speculative debugging.
- Do not continue investigating anomalies that do not affect the requested outcome.

Required Verification:
- Run bounded, practical checks appropriate for the task, such as a build, test, targeted command, file inspection, or browser/runtime check.
- Once the success criteria are met and required verification passes, stop tool use and provide the final answer.`;
}
async function executeScheduledTask(task, force = false) {
    if (!force && task.status !== 'active')
        return;
    if (runningScheduledTaskIds.has(task.id))
        return;
    runningScheduledTaskIds.add(task.id);
    let session = task.chat_id ? chatSessions.get(task.chat_id) : undefined;
    if (!session || session.userId !== task.user_id) {
        session = createSessionForUser(task.user_id, task.title);
        await repositories_1.taskRepository.update(task.id, {
            chat_id: session.id,
            sandbox_id: session.sandboxId,
        });
        await saveChat(session);
    }
    const run = await repositories_1.taskRepository.createRun(task.id, session.id);
    io.to(task.user_id).emit('task-run-started', { taskId: task.id, runId: run.id, chatId: session.id });
    await repositories_1.taskRepository.updateRun(run.id, { status: 'running', started_at: new Date() });
    await repositories_1.taskRepository.update(task.id, { next_run_at: null });
    const userSettings = await getUserSettings(task.user_id);
    const responseModel = task.model || userSettings.ui.selectedModel || llamaConfig.model;
    if (!responseModel) {
        const errorMessage = 'No model is configured for scheduled task execution';
        await repositories_1.taskRepository.updateRun(run.id, { status: 'failed', completed_at: new Date(), error: errorMessage });
        await repositories_1.taskRepository.update(task.id, { status: 'failed', last_run_at: new Date() });
        io.to(task.user_id).emit('task-run-failed', { taskId: task.id, runId: run.id, error: errorMessage });
        runningScheduledTaskIds.delete(task.id);
        return;
    }
    const maxIterationsMap = { low: 3, medium: 7, high: 15 };
    const maxIterations = maxIterationsMap[task.reasoning_effort || 'medium'] || 7;
    const scheduledMessage = `Scheduled task: ${task.title}\n\n${task.prompt}`;
    session.toolPreferences = normalizeToolPreferences(task.tool_preferences || session.toolPreferences, userSettings.ui.defaultToolPreferences);
    session.approvalMode = task.approval_mode || { alwaysApprove: false };
    session.messages.push({ id: crypto_1.default.randomUUID(), role: 'user', content: scheduledMessage, agentSteps: [] });
    session.updatedAt = new Date().toISOString();
    io.to(session.id).emit('message', { role: 'user', content: scheduledMessage });
    emitChatUpdated(session);
    const conversationHistory = buildChatConversationHistory(session, true);
    const selectedPersonality = await getSelectedPersonality(task.user_id, userSettings.ui);
    let approvalBlocked = false;
    const agent = new ReActAgent_1.ReActAgent(llamaClient, toolRegistry, maxIterations, {
        onStep: (step) => {
            io.to(session.id).emit('agent-step', step);
            io.to(task.user_id).emit('task-run-step', { taskId: task.id, runId: run.id, step });
        },
        onFinalAnswerToken: (token) => io.to(session.id).emit('final-answer-token', { token, model: responseModel }),
        onReasoningToken: (token) => io.to(session.id).emit('thought-token', token),
        onTimings: (timings) => io.to(session.id).emit('timings', timings),
        onError: (error) => io.to(session.id).emit('error', { message: error }),
        onToolApprovalRequest: async (request) => {
            approvalBlocked = true;
            await repositories_1.taskRepository.updateRun(run.id, {
                status: 'needs_approval',
                error: `Tool approval required for ${request.toolName}`,
            });
            io.to(task.user_id).emit('task-approval-required', { taskId: task.id, runId: run.id, request });
            return { approved: false, reason: 'denied' };
        },
        onStepSave: async (_chatId, step, allSteps) => {
            session.agentState = { steps: allSteps, isComplete: false, finalAnswer: null, model: responseModel };
            for (let i = session.messages.length - 1; i >= 0; i--) {
                if (session.messages[i].role === 'user') {
                    session.messages[i] = { ...session.messages[i], agentSteps: allSteps };
                    break;
                }
            }
            await repositories_1.taskRepository.updateRun(run.id, { agent_steps: sanitizeAgentStepsForPersistence(allSteps) });
            void saveChat(session).catch(console.error);
            io.to(session.id).emit('step-saved', { step, allSteps });
        },
        onPartialFinalAnswer: (_chatId, partialContent) => {
            if (session.agentState) {
                session.agentState = { ...session.agentState, partialFinalAnswer: partialContent };
                void saveChat(session).catch(console.error);
            }
        },
    }, selectedPersonality, 'en', responseModel);
    session.currentAgent = agent;
    try {
        const userMemories = (await memoryManager.getMemories(task.user_id)).map(m => m.content);
        const result = await agent.run(session.id, scheduledMessage, session.sandboxId, task.user_id, conversationHistory, userMemories, session.toolPreferences, session.approvalMode, getConfiguredWorkspaceConfig(userSettings.remoteWorkspace));
        session.agentState = {
            steps: result.steps,
            isComplete: result.isComplete,
            finalAnswer: result.finalAnswer,
            model: responseModel,
        };
        for (let i = session.messages.length - 1; i >= 0; i--) {
            if (session.messages[i].role === 'user') {
                session.messages[i] = { ...session.messages[i], agentSteps: result.steps };
                break;
            }
        }
        let resultMessageId = null;
        if (result.finalAnswer) {
            resultMessageId = crypto_1.default.randomUUID();
            session.messages.push({
                id: resultMessageId,
                role: 'assistant',
                content: result.finalAnswer,
                model: responseModel,
                agentSteps: [],
            });
            io.to(session.id).emit('message', { role: 'assistant', content: result.finalAnswer, model: responseModel });
        }
        session.updatedAt = new Date().toISOString();
        await saveChat(session);
        emitChatUpdated(session);
        const completedAt = new Date();
        const nextRun = (0, schedule_1.computeNextRunForTask)(task, completedAt);
        await repositories_1.taskRepository.update(task.id, {
            last_run_at: completedAt,
            next_run_at: nextRun,
            status: task.schedule_type === 'once' ? 'completed' : 'active',
        });
        await repositories_1.taskRepository.updateRun(run.id, {
            status: approvalBlocked ? 'needs_approval' : 'completed',
            completed_at: completedAt,
            result_message_id: resultMessageId,
            agent_steps: sanitizeAgentStepsForPersistence(result.steps),
        });
        io.to(session.id).emit('agent-complete', { finalAnswer: result.finalAnswer });
        io.to(task.user_id).emit('task-run-completed', { taskId: task.id, runId: run.id, chatId: session.id });
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await repositories_1.taskRepository.updateRun(run.id, { status: 'failed', completed_at: new Date(), error: errorMessage });
        await repositories_1.taskRepository.update(task.id, { status: 'failed', last_run_at: new Date() });
        io.to(session.id).emit('error', { message: errorMessage });
        io.to(task.user_id).emit('task-run-failed', { taskId: task.id, runId: run.id, error: errorMessage });
    }
    finally {
        session.currentAgent = undefined;
        runningScheduledTaskIds.delete(task.id);
    }
}
let schedulerTimer = null;
let schedulerRunning = false;
const runningScheduledTaskIds = new Set();
const runningAgentRuns = new Map();
function truncateForAgentContext(content, maxChars) {
    if (content.length <= maxChars) {
        return content;
    }
    return `${content.slice(0, maxChars)}\n[truncated]`;
}
function summarizeStepForContext(step) {
    if (step.type === 'action') {
        const args = step.actionArgs ? JSON.stringify(step.actionArgs) : '';
        return `ACTION ${step.actionName || step.content}${args ? ` ${truncateForAgentContext(args, 1200)}` : ''}`;
    }
    if (step.type === 'observation') {
        return `OBSERVATION ${truncateForAgentContext(step.content, 2500)}`;
    }
    if (step.type === 'final_answer') {
        return `FINAL ${truncateForAgentContext(step.content, 2000)}`;
    }
    if (step.type === 'mode_transition') {
        return `MODE ${truncateForAgentContext(step.content, 500)}`;
    }
    return `${step.type.toUpperCase()} ${truncateForAgentContext(step.content, 1200)}`;
}
function getLatestReadActionIndexes(steps) {
    const latestByPath = new Map();
    for (let index = 0; index < steps.length; index++) {
        const step = steps[index];
        if (step.type !== 'action' || step.actionName !== 'read') {
            continue;
        }
        const filePath = String(step.actionArgs?.path || '').trim();
        if (filePath) {
            latestByPath.set(filePath, index);
        }
    }
    return new Set(latestByPath.values());
}
function summarizeStepsForSharedContext(steps) {
    const latestReadIndexes = getLatestReadActionIndexes(steps);
    return steps.map((step, index) => {
        if (step.type === 'observation') {
            const previousStep = steps[index - 1];
            if (previousStep?.type === 'action' && previousStep.actionName === 'read') {
                const filePath = String(previousStep.actionArgs?.path || '').trim();
                if (filePath && !latestReadIndexes.has(index - 1)) {
                    return `OBSERVATION [Earlier read of ${filePath} omitted; later read of the same path is preserved.]`;
                }
            }
        }
        return summarizeStepForContext(step);
    });
}
function buildAgentLedger(session, activeRunId) {
    const runs = session.agentRuns.slice(-8);
    const lines = [];
    const files = new Map();
    const reads = new Map();
    const commands = [];
    const activeTerminals = [];
    for (const run of runs) {
        lines.push(`- ${run.id === activeRunId ? '[current] ' : ''}${run.title} (${run.status}) workspace=${run.workspaceRoot} model=${run.model || 'default'}`);
        for (const step of run.steps) {
            if (step.type === 'action' && step.actionName) {
                if (['write', 'edit', 'apply_patch'].includes(step.actionName)) {
                    const filePath = String(step.actionArgs?.path || step.actionArgs?.filePath || '');
                    if (filePath)
                        files.set(filePath, `${step.actionName} in ${run.title}`);
                }
                if (step.actionName === 'read') {
                    const filePath = String(step.actionArgs?.path || '');
                    if (filePath)
                        reads.set(filePath, `read in ${run.title}`);
                }
                if (step.actionName === 'bash') {
                    const command = String(step.actionArgs?.command || '');
                    if (command)
                        commands.push(`${run.title}: ${truncateForAgentContext(command, 300)}`);
                }
            }
            if (step.type === 'observation' && step.content.includes('terminalId=')) {
                const terminalId = step.content.match(/terminalId=([A-Za-z0-9-]+)/)?.[1];
                if (terminalId)
                    activeTerminals.push(`${terminalId} from ${run.title}`);
            }
        }
    }
    const sections = [
        `## Shared Chat Agent Ledger\n${lines.join('\n') || 'No previous agent runs.'}`,
    ];
    if (files.size > 0) {
        sections.push(`## Files Touched\n${Array.from(files.entries()).slice(-30).map(([filePath, source]) => `- ${filePath}: ${source}`).join('\n')}`);
    }
    if (reads.size > 0) {
        sections.push(`## Files Read\n${Array.from(reads.entries()).slice(-40).map(([filePath, source]) => `- ${filePath}: ${source}`).join('\n')}`);
    }
    if (commands.length > 0) {
        sections.push(`## Recent Commands\n${commands.slice(-20).map((command) => `- ${command}`).join('\n')}`);
    }
    if (activeTerminals.length > 0) {
        sections.push(`## Known Background Terminals\n${activeTerminals.slice(-10).map((terminal) => `- ${terminal}`).join('\n')}`);
    }
    return sections.join('\n\n');
}
function buildSharedAgentContext(session, activeRunId) {
    const sections = [];
    if (session.sharedAgentContext?.summary) {
        sections.push(`## Previous Compacted Agent Context\n${session.sharedAgentContext.summary}`);
    }
    sections.push(buildAgentLedger(session, activeRunId));
    const recentRuns = session.agentRuns.slice(-4);
    const recentTrace = recentRuns.map((run) => {
        const steps = summarizeStepsForSharedContext(run.steps).slice(-10).map((step) => `  - ${step.replace(/\n/g, '\n    ')}`).join('\n');
        return `### ${run.id === activeRunId ? 'Current' : 'Recent'} Run: ${run.title}\nStatus: ${run.status}\nWorkspace: ${run.workspaceRoot}\n${steps || '  - No steps yet.'}`;
    }).join('\n\n');
    if (recentTrace) {
        sections.push(`## Recent Agent Trace\n${recentTrace}`);
    }
    return sections.join('\n\n');
}
async function buildSharedAgentContextWithMemory(session, workspace, activeRunId) {
    const sections = [];
    const memoryPacket = await agentMemoryService_1.agentMemoryService.buildContextPacket({
        chatId: session.id,
        workspace,
        agentRunId: activeRunId,
    });
    if (memoryPacket.trim()) {
        sections.push(`## Backend Managed Memory\n${memoryPacket}`);
    }
    sections.push(buildSharedAgentContext(session, activeRunId));
    return sections.join('\n\n');
}
async function compactSharedAgentContext(session, run, stateSteps, model, tokenEstimate) {
    const allRunsText = session.agentRuns.map((agentRun) => {
        const steps = summarizeStepsForSharedContext(agentRun.id === run.id ? stateSteps : agentRun.steps)
            .map((step) => `- ${step.replace(/\n/g, '\n  ')}`)
            .join('\n');
        return `## Agent Run: ${agentRun.title}
id=${agentRun.id}
status=${agentRun.status}
workspace=${agentRun.workspaceRoot}
model=${agentRun.model || model}
${steps}`;
    }).join('\n\n');
    const previousSummary = session.sharedAgentContext?.summary
        ? `\n\nPrevious compacted context:\n${session.sharedAgentContext.summary}`
        : '';
    const response = await llamaClient.chat([
        {
            role: 'system',
            content: `You compact coding-agent history for continuation. Preserve facts, user constraints, decisions, files touched, commands/results, active terminals, unresolved errors, and next steps. Be concise and structured. Do not invent details.`,
        },
        {
            role: 'user',
            content: `${previousSummary}

Current shared agent history:
${truncateForAgentContext(allRunsText, 80000)}

Return only the compacted context markdown with these headings:
## Goal And Constraints
## Current State
## Files And Changes
## Commands And Results
## Active Terminals
## Open Issues
## Next Steps`,
        },
    ], { model });
    const summary = response.content.trim();
    if (!summary) {
        return buildSharedAgentContext(session, run.id);
    }
    session.sharedAgentContext = {
        summary,
        coversRunIds: session.agentRuns.map((agentRun) => agentRun.id),
        coversStepCount: session.agentRuns.reduce((count, agentRun) => count + agentRun.steps.length, 0),
        updatedAt: new Date().toISOString(),
        tokenEstimate,
    };
    await saveChat(session);
    return buildSharedAgentContext(session, run.id);
}
async function pollScheduledTasks() {
    if (schedulerRunning)
        return;
    schedulerRunning = true;
    try {
        const dueTasks = await repositories_1.taskRepository.findDue(5);
        for (const task of dueTasks) {
            await executeScheduledTask(task);
        }
    }
    catch (error) {
        console.error('Scheduled task poll failed:', error);
    }
    finally {
        schedulerRunning = false;
    }
}
function startTaskScheduler() {
    if (schedulerTimer)
        return;
    schedulerTimer = setInterval(() => {
        pollScheduledTasks().catch(console.error);
    }, 30000);
    pollScheduledTasks().catch(console.error);
}
async function startChatAgentRun(session, userId, request, model, language, sourceSocketChatId) {
    const userSettings = await getUserSettings(userId);
    const workspace = getWorkspaceConfigForRoot(request.workspaceRoot, userSettings.remoteWorkspace);
    if (!workspace?.ssh?.enabled) {
        throw new Error('Remote workspace is not configured in Settings.');
    }
    const agentModel = userSettings.remoteWorkspace.agentModel || model;
    const agentPrompt = ensureCodingAgentSuccessContract(request.prompt);
    const now = new Date().toISOString();
    const run = {
        id: crypto_1.default.randomUUID(),
        chatId: session.id,
        userId,
        title: request.title,
        prompt: agentPrompt,
        workspaceRoot: request.workspaceRoot,
        status: 'running',
        steps: [],
        finalAnswer: null,
        createdAt: now,
        updatedAt: now,
        model: agentModel,
    };
    session.agentRuns.push(run);
    session.messages.push({
        id: crypto_1.default.randomUUID(),
        role: 'assistant',
        content: `__operator_agent_run__:${run.id}`,
        model: agentModel,
        agentSteps: [],
        agentRunId: run.id,
    });
    session.updatedAt = now;
    await saveChat(session);
    io.to(sourceSocketChatId).emit('message', {
        role: 'assistant',
        content: `__operator_agent_run__:${run.id}`,
        model: agentModel,
        agentRunId: run.id,
    });
    io.to(sourceSocketChatId).emit('agent-run-updated', serializeAgentRun(run));
    const agentToolPreferences = buildSpawnedAgentToolPreferences(session.toolPreferences, userSettings.remoteWorkspace);
    const agent = new ReActAgent_1.ReActAgent(llamaClient, toolRegistry, 15, {
        onStep: (step) => {
            run.steps.push(step);
            run.updatedAt = new Date().toISOString();
            io.to(sourceSocketChatId).emit('agent-run-updated', serializeAgentRun(run));
        },
        onFinalAnswerToken: (token) => {
            run.finalAnswer = `${run.finalAnswer || ''}${token}`;
            run.updatedAt = new Date().toISOString();
            io.to(sourceSocketChatId).emit('agent-run-updated', serializeAgentRun(run));
            scheduleChatSave(session);
        },
        onReasoningToken: () => { },
        onError: (error) => {
            run.status = 'failed';
            run.error = error;
            run.updatedAt = new Date().toISOString();
            io.to(sourceSocketChatId).emit('agent-run-updated', serializeAgentRun(run));
            scheduleChatSave(session, 0);
        },
        onToolApprovalRequest: async (approvalRequest) => {
            const latestSettings = await getUserSettings(userId);
            if (latestSettings.remoteWorkspace.toolApprovals?.[approvalRequest.toolName] === 'auto-approve') {
                return { approved: true, reason: 'approved' };
            }
            return await new Promise((resolve) => {
                pendingApprovals.set(approvalRequest.approvalId, { chatId: sourceSocketChatId, request: approvalRequest, resolve });
                io.to(sourceSocketChatId).emit('tool-approval-required', { ...approvalRequest, chatId: sourceSocketChatId });
            });
        },
        onStepSave: async () => {
            await saveChat(session);
        },
        onSharedContextRequest: async () => buildSharedAgentContextWithMemory(session, workspace, run.id),
        onContextPressure: async (pressure) => {
            const context = await compactSharedAgentContext(session, run, pressure.state.steps, agentModel, pressure.tokenEstimate);
            io.to(sourceSocketChatId).emit('agent-run-updated', serializeAgentRun(run));
            const memoryPacket = await agentMemoryService_1.agentMemoryService.buildContextPacket({
                chatId: session.id,
                workspace,
                agentRunId: run.id,
            });
            return memoryPacket.trim() ? `## Backend Managed Memory\n${memoryPacket}\n\n${context}` : context;
        },
    }, null, language, agentModel, {
        disableMaxIterations: true,
        runId: run.id,
        contextWindowTokens: userSettings.remoteWorkspace.contextWindowTokens,
        reservedOutputTokens: userSettings.remoteWorkspace.reservedOutputTokens,
        autoCompactThreshold: userSettings.remoteWorkspace.autoCompactThreshold,
    });
    runningAgentRuns.set(run.id, { agent, session, run, sourceSocketChatId });
    void (async () => {
        try {
            const result = await agent.run(session.id, agentPrompt, session.sandboxId, userId, [], (await memoryManager.getMemories(userId)).map((memory) => memory.content), agentToolPreferences, { alwaysApprove: false }, workspace);
            run.steps = result.steps;
            run.finalAnswer = result.finalAnswer;
            run.status = run.status === 'cancelled'
                ? 'cancelled'
                : result.isComplete
                    ? 'completed'
                    : 'failed';
            run.updatedAt = new Date().toISOString();
            io.to(sourceSocketChatId).emit('agent-run-updated', serializeAgentRun(run));
            await flushScheduledChatSave(session);
        }
        catch (error) {
            if (run.status !== 'cancelled') {
                run.status = 'failed';
                run.error = error instanceof Error ? error.message : String(error);
            }
            run.updatedAt = new Date().toISOString();
            io.to(sourceSocketChatId).emit('agent-run-updated', serializeAgentRun(run));
            await flushScheduledChatSave(session);
        }
        finally {
            runningAgentRuns.delete(run.id);
            clearPendingApprovalsForChat(sourceSocketChatId);
        }
    })();
    return run.id;
}
// Settings endpoint (UI settings only - server/searxng config comes from environment variables)
app.get('/api/settings', auth_1.protect, async (req, res) => {
    const userId = req.user.id;
    const userSettings = await getUserSettings(userId);
    res.json({
        ui: {
            showStats: userSettings.ui.showStats,
            selectedPersonality: userSettings.ui.selectedPersonality,
            selectedModel: userSettings.ui.selectedModel,
            defaultToolPreferences: normalizeToolPreferences(userSettings.ui.defaultToolPreferences, userSettings.ui.defaultToolPreferences),
        },
        remoteWorkspace: serializeRemoteWorkspaceSettings(userSettings.remoteWorkspace),
    });
});
app.post('/api/settings', auth_1.protect, async (req, res) => {
    const userId = req.user.id;
    const userSettings = await getUserSettings(userId);
    const { ui, remoteWorkspace } = req.body;
    if (ui) {
        const nextUi = { ...userSettings.ui, ...ui };
        nextUi.defaultToolPreferences = normalizeToolPreferences(nextUi.defaultToolPreferences, nextUi.defaultToolPreferences);
        await repositories_1.settingsRepository.setUiSettings(nextUi, userId);
        userSettings.ui = nextUi;
    }
    if (remoteWorkspace !== undefined) {
        const nextRemoteWorkspace = normalizeRemoteWorkspaceSettings({
            ...remoteWorkspace,
            privateKey: remoteWorkspace.privateKey === ''
                ? userSettings.remoteWorkspace.privateKey
                : remoteWorkspace.privateKey,
        });
        await repositories_1.settingsRepository.setRemoteWorkspace(nextRemoteWorkspace, userId);
    }
    res.json({ success: true });
});
// Scheduled task endpoints
app.get('/api/tasks', auth_1.protect, async (req, res) => {
    const tasks = await repositories_1.taskRepository.findByUserId(req.user.id);
    res.json(tasks.map(serializeTask));
});
app.get('/api/agents', auth_1.protect, (req, res) => {
    const userId = req.user.id;
    const agents = Array.from(chatSessions.values())
        .filter((session) => session.userId === userId)
        .flatMap((session) => session.agentRuns.map((run) => ({
        ...serializeAgentRun(run),
        chatName: session.name,
        stepCount: run.steps.length,
    })))
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    res.json(agents);
});
app.post('/api/tasks', auth_1.protect, async (req, res) => {
    const { title, prompt, scheduleType, runAt, intervalMinutes, daysOfWeek, timeOfDay, timezone, chatId, model, toolPreferences, approvalMode, reasoningEffort, } = req.body;
    if (!title || !prompt || !scheduleType) {
        return res.status(400).json({ error: 'title, prompt, and scheduleType are required' });
    }
    if (!['once', 'daily', 'weekdays', 'weekly', 'interval'].includes(scheduleType)) {
        return res.status(400).json({ error: 'Invalid scheduleType' });
    }
    const normalizedDaysOfWeek = (0, schedule_1.normalizeDaysOfWeek)(daysOfWeek);
    const nextRunAt = (0, schedule_1.computeNextRun)({
        scheduleType,
        runAt,
        intervalMinutes,
        daysOfWeek: normalizedDaysOfWeek,
        timeOfDay,
    });
    if (!nextRunAt) {
        return res.status(400).json({ error: 'Schedule does not produce a future run time' });
    }
    let session;
    if (chatId) {
        const existingSession = chatSessions.get(chatId);
        if (!existingSession || existingSession.userId !== req.user.id) {
            return res.status(404).json({ error: 'Chat not found' });
        }
        session = existingSession;
    }
    const task = await repositories_1.taskRepository.create({
        userId: req.user.id,
        chatId: session?.id || null,
        sandboxId: session?.sandboxId || null,
        title,
        prompt,
        scheduleType,
        runAt: runAt ? new Date(runAt) : null,
        intervalMinutes,
        daysOfWeek: normalizedDaysOfWeek,
        timeOfDay,
        timezone,
        model,
        toolPreferences: normalizeToolPreferences(toolPreferences),
        approvalMode: approvalMode || { alwaysApprove: false },
        reasoningEffort,
        nextRunAt,
    });
    io.to(req.user.id).emit('task-created', serializeTask(task));
    res.status(201).json(serializeTask(task));
});
app.patch('/api/tasks/:taskId', auth_1.protect, async (req, res) => {
    const task = await repositories_1.taskRepository.findById(req.params.taskId);
    if (!task || task.user_id !== req.user.id) {
        return res.status(404).json({ error: 'Task not found' });
    }
    const nextShape = {
        scheduleType: req.body.scheduleType || task.schedule_type,
        runAt: req.body.runAt !== undefined ? req.body.runAt : task.run_at,
        intervalMinutes: req.body.intervalMinutes !== undefined ? req.body.intervalMinutes : task.interval_minutes,
        daysOfWeek: req.body.daysOfWeek !== undefined ? (0, schedule_1.normalizeDaysOfWeek)(req.body.daysOfWeek) : task.days_of_week,
        timeOfDay: req.body.timeOfDay !== undefined ? req.body.timeOfDay : task.time_of_day,
    };
    const nextRunAt = req.body.status === 'paused' || req.body.status === 'cancelled'
        ? null
        : (0, schedule_1.computeNextRun)(nextShape);
    const updated = await repositories_1.taskRepository.update(task.id, {
        title: req.body.title ?? task.title,
        prompt: req.body.prompt ?? task.prompt,
        schedule_type: nextShape.scheduleType,
        run_at: nextShape.runAt ? new Date(nextShape.runAt) : null,
        interval_minutes: nextShape.intervalMinutes,
        days_of_week: nextShape.daysOfWeek,
        time_of_day: nextShape.timeOfDay,
        timezone: req.body.timezone ?? task.timezone,
        status: req.body.status ?? task.status,
        model: req.body.model ?? task.model,
        tool_preferences: req.body.toolPreferences ? normalizeToolPreferences(req.body.toolPreferences) : task.tool_preferences,
        approval_mode: req.body.approvalMode ?? task.approval_mode,
        reasoning_effort: req.body.reasoningEffort ?? task.reasoning_effort,
        next_run_at: nextRunAt,
    });
    if (!updated) {
        return res.status(404).json({ error: 'Task not found' });
    }
    io.to(req.user.id).emit('task-updated', serializeTask(updated));
    res.json(serializeTask(updated));
});
app.delete('/api/tasks/:taskId', auth_1.protect, async (req, res) => {
    const deleted = await repositories_1.taskRepository.delete(req.params.taskId, req.user.id);
    if (!deleted) {
        return res.status(404).json({ error: 'Task not found' });
    }
    io.to(req.user.id).emit('task-deleted', { taskId: req.params.taskId });
    res.json({ success: true });
});
app.get('/api/tasks/:taskId/runs', auth_1.protect, async (req, res) => {
    const task = await repositories_1.taskRepository.findById(req.params.taskId);
    if (!task || task.user_id !== req.user.id) {
        return res.status(404).json({ error: 'Task not found' });
    }
    res.json(await repositories_1.taskRepository.findRunsByTaskId(task.id));
});
app.post('/api/tasks/:taskId/run-now', auth_1.protect, async (req, res) => {
    const task = await repositories_1.taskRepository.findById(req.params.taskId);
    if (!task || task.user_id !== req.user.id) {
        return res.status(404).json({ error: 'Task not found' });
    }
    executeScheduledTask(task, true).catch((error) => console.error('Manual task run failed:', error));
    res.json({ success: true });
});
app.post('/api/tasks/:taskId/pause', auth_1.protect, async (req, res) => {
    const task = await repositories_1.taskRepository.findById(req.params.taskId);
    if (!task || task.user_id !== req.user.id) {
        return res.status(404).json({ error: 'Task not found' });
    }
    const updated = await repositories_1.taskRepository.update(task.id, { status: 'paused', next_run_at: null });
    res.json(serializeTask(updated));
});
app.post('/api/tasks/:taskId/resume', auth_1.protect, async (req, res) => {
    const task = await repositories_1.taskRepository.findById(req.params.taskId);
    if (!task || task.user_id !== req.user.id) {
        return res.status(404).json({ error: 'Task not found' });
    }
    const nextRun = (0, schedule_1.computeNextRunForTask)(task);
    const updated = await repositories_1.taskRepository.update(task.id, { status: 'active', next_run_at: nextRun });
    res.json(serializeTask(updated));
});
// Create new chat
app.post('/api/chat', auth_1.protect, (req, res) => {
    const chatId = crypto_1.default.randomUUID();
    const sandbox = sandboxManager.createSandbox();
    const now = new Date().toISOString();
    const userId = req.user.id;
    const { toolPreferences } = req.body ?? {};
    const session = {
        id: chatId,
        userId,
        sandboxId: sandbox.id,
        messages: [],
        name: 'New Conversation',
        createdAt: now,
        updatedAt: now,
        toolPreferences: normalizeToolPreferences(toolPreferences),
        approvalMode: {
            alwaysApprove: false,
        },
        agentRuns: [],
    };
    chatSessions.set(chatId, session);
    saveChats();
    res.json({ chatId, sandboxId: sandbox.id });
});
// Get chat list
app.get('/api/chat', auth_1.protect, (req, res) => {
    const userId = req.user.id;
    const chats = Array.from(chatSessions.values())
        .filter(session => session.userId === userId)
        .map((session) => ({
        id: session.id,
        sandboxId: session.sandboxId,
        messageCount: session.messages.length,
        name: session.name,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
    }));
    // Sort by updated date, most recent first
    chats.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    res.json(chats);
});
// Search chats by name and message content
app.get('/api/chat/search', auth_1.protect, (req, res) => {
    const { query } = req.query;
    const userId = req.user.id;
    if (!query || typeof query !== 'string' || query.trim() === '') {
        return res.json([]);
    }
    const searchTerm = query.toLowerCase().trim();
    const results = [];
    const MAX_SNIPPETS_PER_CHAT = 5;
    const SNIPPET_CONTEXT = 50; // characters before/after match
    for (const [chatId, session] of chatSessions.entries()) {
        if (session.userId !== userId)
            continue;
        const matchingMessages = [];
        // Check if chat name matches
        let nameMatch = session.name.toLowerCase().includes(searchTerm);
        // Search through messages
        session.messages.forEach((msg, idx) => {
            if (msg.content.toLowerCase().includes(searchTerm)) {
                // Find the position of the match for snippet generation
                const matchIndex = msg.content.toLowerCase().indexOf(searchTerm);
                const start = Math.max(0, matchIndex - SNIPPET_CONTEXT);
                const end = Math.min(msg.content.length, matchIndex + searchTerm.length + SNIPPET_CONTEXT);
                let snippet = msg.content.substring(start, end);
                // Add ellipsis if snippet is truncated
                if (start > 0)
                    snippet = '...' + snippet;
                if (end < msg.content.length)
                    snippet = snippet + '...';
                matchingMessages.push({
                    id: msg.id,
                    role: msg.role,
                    content: msg.content,
                    snippet: snippet,
                    messageIndex: idx,
                });
                // Limit snippets per chat
                if (matchingMessages.length >= MAX_SNIPPETS_PER_CHAT) {
                    return;
                }
            }
        });
        // Include chat if name matches or messages match
        if (nameMatch || matchingMessages.length > 0) {
            results.push({
                chatId,
                sandboxId: session.sandboxId,
                name: session.name,
                updatedAt: session.updatedAt,
                matchCount: matchingMessages.length,
                matchingMessages,
            });
        }
    }
    // Sort by match count (descending) and then by updated date
    results.sort((a, b) => {
        if (b.matchCount !== a.matchCount) {
            return b.matchCount - a.matchCount;
        }
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    res.json(results);
});
// Delete chat
app.delete('/api/chat/:chatId', auth_1.protect, (req, res) => {
    const { chatId } = req.params;
    const userId = req.user.id;
    const session = chatSessions.get(chatId);
    if (session && session.userId === userId) {
        sandboxManager.deleteSandbox(session.sandboxId);
        chatSessions.delete(chatId);
        saveChats();
        res.json({ success: true });
    }
    else {
        res.status(404).json({ error: 'Chat not found' });
    }
});
// Update chat name
app.post('/api/chat/:chatId/name', auth_1.protect, (req, res) => {
    const { chatId } = req.params;
    const { name } = req.body;
    const userId = req.user.id;
    const session = chatSessions.get(chatId);
    if (session && session.userId === userId) {
        session.name = name;
        session.updatedAt = new Date().toISOString();
        saveChats();
        res.json({ success: true, name });
    }
    else {
        res.status(404).json({ error: 'Chat not found' });
    }
});
// Get chat messages
app.get('/api/chat/:chatId/messages', auth_1.protect, (req, res) => {
    const { chatId } = req.params;
    const userId = req.user.id;
    const session = chatSessions.get(chatId);
    if (!session || session.userId !== userId) {
        return res.status(404).json({ error: 'Chat not found' });
    }
    if (normalizeChatSession(session)) {
        saveChats();
    }
    res.json({
        messages: session.messages,
        agentState: session.agentState,
        name: session.name,
        toolPreferences: normalizeToolPreferences(session.toolPreferences),
        approvalMode: session.approvalMode,
        pendingApproval: getPendingApprovalPayloadForChat(chatId),
        agentRuns: session.agentRuns.map(serializeAgentRun),
    });
});
// Edit message content
app.patch('/api/chat/:chatId/messages/:messageIndex', auth_1.protect, (req, res) => {
    const { chatId, messageIndex } = req.params;
    const { content } = req.body;
    const userId = req.user.id;
    const session = chatSessions.get(chatId);
    if (!session || session.userId !== userId) {
        return res.status(404).json({ error: 'Chat not found' });
    }
    const index = parseInt(messageIndex, 10);
    if (isNaN(index) || index < 0 || index >= session.messages.length) {
        return res.status(404).json({ error: 'Message not found' });
    }
    // Only allow editing user messages
    if (session.messages[index].role !== 'user') {
        return res.status(400).json({ error: 'Only user messages can be edited' });
    }
    session.messages[index] = {
        ...session.messages[index],
        content: content,
    };
    session.updatedAt = new Date().toISOString();
    saveChats();
    res.json({ success: true, message: session.messages[index] });
});
// Retry from a specific message (rollback conversation to that point)
app.post('/api/chat/:chatId/retry-from/:messageIndex', auth_1.protect, (req, res) => {
    const { chatId, messageIndex } = req.params;
    const userId = req.user.id;
    const session = chatSessions.get(chatId);
    if (!session || session.userId !== userId) {
        return res.status(404).json({ error: 'Chat not found' });
    }
    const index = parseInt(messageIndex, 10);
    if (isNaN(index) || index < 0 || index >= session.messages.length) {
        return res.status(404).json({ error: 'Message not found' });
    }
    // Only allow retry from user messages
    if (session.messages[index].role !== 'user') {
        return res.status(400).json({ error: 'Can only retry from user messages' });
    }
    // Keep messages up to and including the specified message
    const messageToRetry = session.messages[index];
    session.messages = session.messages.slice(0, index + 1);
    session.updatedAt = new Date().toISOString();
    saveChats();
    res.json({
        success: true,
        message: messageToRetry,
        messages: session.messages,
    });
});
// Sandbox file operations
app.get('/api/sandbox/:sandboxId/files', auth_1.protect, (req, res) => {
    const { sandboxId } = req.params;
    const { path: filePath } = req.query;
    const userId = req.user.id;
    // Find chat associated with this sandbox to check ownership
    const session = Array.from(chatSessions.values()).find(s => s.sandboxId === sandboxId);
    if (!session || session.userId !== userId) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    try {
        const files = sandboxManager.listFilesWithProtection(sandboxId, filePath);
        res.json(files);
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
});
app.get('/api/sandbox/:sandboxId/files/:filePath', auth_1.protect, (req, res) => {
    const { sandboxId, filePath } = req.params;
    const userId = req.user.id;
    const session = Array.from(chatSessions.values()).find(s => s.sandboxId === sandboxId);
    if (!session || session.userId !== userId) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    try {
        const content = sandboxManager.readFile(sandboxId, decodeURIComponent(filePath));
        res.json({ content });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
});
app.post('/api/sandbox/:sandboxId/files', auth_1.protect, (req, res) => {
    const { sandboxId } = req.params;
    const { path: filePath, content } = req.body;
    const userId = req.user.id;
    const session = Array.from(chatSessions.values()).find(s => s.sandboxId === sandboxId);
    if (!session || session.userId !== userId) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    try {
        sandboxManager.writeFile(sandboxId, filePath, content);
        res.json({ success: true });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
});
app.delete('/api/sandbox/:sandboxId/files/:filePath', auth_1.protect, (req, res) => {
    const { sandboxId, filePath } = req.params;
    const userId = req.user.id;
    const session = Array.from(chatSessions.values()).find(s => s.sandboxId === sandboxId);
    if (!session || session.userId !== userId) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    try {
        sandboxManager.deleteFile(sandboxId, decodeURIComponent(filePath));
        res.json({ success: true });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
});
// Remote SSH workspace browser
app.get('/api/remote-workspace/files', auth_1.protect, async (req, res) => {
    const { path: filePath } = req.query;
    const userSettings = await getUserSettings(req.user.id);
    const workspace = getConfiguredWorkspaceConfig(userSettings.remoteWorkspace);
    if (!workspace?.ssh?.enabled) {
        return res.status(400).json({ error: 'Remote workspace is not configured in Settings.' });
    }
    try {
        const runtime = workspaceRuntimeFactory.createRemote(workspace);
        const relativePath = normalizeRemoteBrowserPath(filePath);
        const target = remoteBrowserAbsolutePath(workspace, relativePath);
        const root = workspace.ssh.root;
        const script = `
root=${shellQuote(root)}
target=${shellQuote(target)}
if [ ! -d "$target" ]; then
  echo "Not a directory: $target" >&2
  exit 2
fi
git_root=""
if command -v git >/dev/null 2>&1; then
  git_root=$(git -C "$target" rev-parse --show-toplevel 2>/dev/null || true)
fi
find "$target" -maxdepth 1 -mindepth 1 -print 2>/dev/null | sort | while IFS= read -r item; do
  name=$(basename "$item")
  rel=$(printf '%s' "$item" | sed "s#^$root/##")
  [ "$item" = "$root" ] && rel="."
  type="-"
  [ -d "$item" ] && type="d"
  size=$(stat -c '%s' "$item" 2>/dev/null || echo 0)
  modified=$(stat -c '%Y' "$item" 2>/dev/null || echo 0)
  created=$(stat -c '%W' "$item" 2>/dev/null || echo -1)
  if [ "$created" = "-1" ] || [ "$created" = "0" ]; then
    created=$(stat -c '%Z' "$item" 2>/dev/null || echo 0)
  fi
  status="-"
  if [ -n "$git_root" ]; then
    git_rel=$(realpath --relative-to="$git_root" "$item" 2>/dev/null || true)
    if [ -n "$git_rel" ]; then
      status=$(git -C "$git_root" status --porcelain=v1 -- "$git_rel" 2>/dev/null | head -n 1 | cut -c1-2 | tr ' ' '_' || true)
      [ -n "$status" ] || status="-"
    fi
  fi
  path64=$(printf '%s' "$rel" | base64 | tr -d '\\n')
  name64=$(printf '%s' "$name" | base64 | tr -d '\\n')
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$type" "$path64" "$name64" "$size" "$modified" "$created" "$status"
done
`;
        const result = await runtime.exec({ command: script, workdir: '.', timeoutMs: 30_000 });
        if (result.exitCode !== 0) {
            throw new Error(result.stderr || result.stdout || 'Remote list failed');
        }
        res.json(parseRemoteWorkspaceMetadata(result.stdout));
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
});
app.get('/api/remote-workspace/file', auth_1.protect, async (req, res) => {
    const { path: filePath } = req.query;
    const userSettings = await getUserSettings(req.user.id);
    const workspace = getConfiguredWorkspaceConfig(userSettings.remoteWorkspace);
    if (!workspace?.ssh?.enabled) {
        return res.status(400).json({ error: 'Remote workspace is not configured in Settings.' });
    }
    if (typeof filePath !== 'string') {
        return res.status(400).json({ error: 'path is required.' });
    }
    try {
        const runtime = workspaceRuntimeFactory.createRemote(workspace);
        const decodedPath = normalizeRemoteBrowserPath(filePath);
        const target = remoteBrowserAbsolutePath(workspace, decodedPath);
        const script = `
target=${shellQuote(target)}
if [ ! -f "$target" ]; then
  echo "File not found: $target" >&2
  exit 2
fi
if [ -s "$target" ] && ! LC_ALL=C grep -Iq . "$target"; then
  echo "Cannot read binary file: $target" >&2
  exit 3
fi
base64 < "$target"
`;
        const result = await runtime.exec({ command: script, workdir: '.', timeoutMs: 30_000 });
        if (result.exitCode !== 0) {
            throw new Error(result.stderr || result.stdout || 'Remote read failed');
        }
        const compact = result.stdout.replace(/\s+/g, '');
        res.json({ content: Buffer.from(compact, 'base64').toString('utf8') });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
});
app.get('/api/remote-workspace/files/:filePath', auth_1.protect, async (req, res) => {
    const { filePath } = req.params;
    const { offset, limit } = req.query;
    const userSettings = await getUserSettings(req.user.id);
    const workspace = getConfiguredWorkspaceConfig(userSettings.remoteWorkspace);
    if (!workspace?.ssh?.enabled) {
        return res.status(400).json({ error: 'Remote workspace is not configured in Settings.' });
    }
    try {
        const runtime = workspaceRuntimeFactory.createRemote(workspace);
        const decodedPath = normalizeRemoteBrowserPath(decodeURIComponent(filePath));
        const raw = req.query.raw === '1' || req.query.raw === 'true';
        if (!raw) {
            const content = await runtime.readFile(decodedPath, {
                offset: offset !== undefined ? Number(offset) : undefined,
                limit: limit !== undefined ? Number(limit) : undefined,
            });
            res.json({ content });
            return;
        }
        const target = remoteBrowserAbsolutePath(workspace, decodedPath);
        const script = `
target=${shellQuote(target)}
if [ ! -f "$target" ]; then
  echo "File not found: $target" >&2
  exit 2
fi
if [ -s "$target" ] && ! LC_ALL=C grep -Iq . "$target"; then
  echo "Cannot read binary file: $target" >&2
  exit 3
fi
base64 < "$target"
`;
        const result = await runtime.exec({ command: script, workdir: '.', timeoutMs: 30_000 });
        if (result.exitCode !== 0) {
            throw new Error(result.stderr || result.stdout || 'Remote read failed');
        }
        const compact = result.stdout.replace(/\s+/g, '');
        res.json({ content: Buffer.from(compact, 'base64').toString('utf8') });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
});
app.post('/api/remote-workspace/files', auth_1.protect, async (req, res) => {
    const { path: filePath, content } = req.body;
    const userSettings = await getUserSettings(req.user.id);
    const workspace = getConfiguredWorkspaceConfig(userSettings.remoteWorkspace);
    if (!workspace?.ssh?.enabled) {
        return res.status(400).json({ error: 'Remote workspace is not configured in Settings.' });
    }
    if (typeof filePath !== 'string' || typeof content !== 'string') {
        return res.status(400).json({ error: 'path and content are required.' });
    }
    try {
        const runtime = workspaceRuntimeFactory.createRemote(workspace);
        const result = await runtime.writeFile(normalizeRemoteBrowserPath(filePath), content);
        res.json({ success: true, result });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
});
// File download endpoint
app.get('/api/sandbox/:sandboxId/download/:filePath', auth_1.protect, (req, res) => {
    const { sandboxId, filePath } = req.params;
    const userId = req.user.id;
    const session = Array.from(chatSessions.values()).find(s => s.sandboxId === sandboxId);
    if (!session || session.userId !== userId) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    try {
        const fileContent = sandboxManager.readFile(sandboxId, decodeURIComponent(filePath));
        const fileName = decodeURIComponent(filePath).split('/').pop() || 'file';
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(fileContent);
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
});
// File upload endpoint
app.post('/api/sandbox/:sandboxId/upload', auth_1.protect, upload.single('file'), (req, res) => {
    const { sandboxId } = req.params;
    const userId = req.user.id;
    const session = Array.from(chatSessions.values()).find(s => s.sandboxId === sandboxId);
    if (!session || session.userId !== userId) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    try {
        const sandbox = sandboxManager.getSandbox(sandboxId);
        if (!sandbox) {
            return res.status(404).json({ error: 'Sandbox not found' });
        }
        // Protect uploaded files from being deleted
        sandboxManager.protectFile(sandboxId, req.file.filename);
        res.json({
            success: true,
            filename: req.file.filename,
            path: req.file.filename,
            size: req.file.size,
        });
    }
    catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
});
// WebSocket handling for real-time agent updates
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    // Simple token auth for socket.io
    let currentUserId = null;
    socket.on('authenticate', (data) => {
        try {
            const decoded = jsonwebtoken_1.default.verify(data.token, JWT_SECRET);
            currentUserId = decoded.id;
            socket.join(currentUserId);
            socket.emit('authenticated');
            console.log(`Socket ${socket.id} authenticated as user ${currentUserId}`);
        }
        catch (error) {
            socket.emit('error', { message: 'Authentication failed' });
            socket.disconnect();
        }
    });
    socket.on('join-chat', (chatId) => {
        if (!currentUserId) {
            socket.emit('error', { message: 'Not authenticated' });
            return;
        }
        const session = chatSessions.get(chatId);
        if (!session || session.userId !== currentUserId) {
            socket.emit('error', { message: 'Unauthorized' });
            return;
        }
        socket.join(chatId);
        console.log(`Socket ${socket.id} joined chat ${chatId}`);
        // Check if there's an active agent or incomplete agent state
        const hasActiveAgent = session.currentAgent !== undefined;
        const hasIncompleteState = session.agentState && !session.agentState.isComplete && (session.agentState.steps?.length ?? 0) > 0;
        console.log(`Join-chat for ${chatId}: hasActiveAgent=${hasActiveAgent}, hasIncompleteState=${hasIncompleteState}, agentState=${JSON.stringify(session.agentState)}`);
        // If there's an active agent or incomplete state, emit the current state so the client can restore streaming state
        if (hasActiveAgent || hasIncompleteState) {
            const stateToEmit = {
                steps: session.agentState?.steps || [],
                isComplete: session.agentState?.isComplete || false,
                finalAnswer: session.agentState?.finalAnswer || null,
                model: session.agentState?.model || llamaConfig.model,
                partialFinalAnswer: session.agentState?.partialFinalAnswer || null,
            };
            socket.emit('agent-state', stateToEmit);
            console.log(`Emitting agent state to reconnecting client for chat ${chatId}:`, stateToEmit);
        }
        const pendingApproval = getPendingApprovalPayloadForChat(chatId);
        if (pendingApproval) {
            socket.emit('tool-approval-required', pendingApproval);
            console.log(`Re-emitting pending approval ${pendingApproval.approvalId} to socket ${socket.id} for chat ${chatId}`);
        }
        socket.emit('agent-runs', session.agentRuns.map(serializeAgentRun));
    });
    socket.on('send-message', async (data) => {
        if (!currentUserId) {
            socket.emit('error', { message: 'Not authenticated' });
            return;
        }
        const { chatId, message, model, toolPreferences, approvalMode, language, reasoningEffort } = data;
        const session = chatSessions.get(chatId);
        if (!session || session.userId !== currentUserId) {
            socket.emit('error', { message: 'Chat not found' });
            return;
        }
        const userSettings = await getUserSettings(currentUserId);
        session.toolPreferences = normalizeToolPreferences(toolPreferences ?? session.toolPreferences, userSettings.ui.defaultToolPreferences);
        session.approvalMode = {
            alwaysApprove: approvalMode?.alwaysApprove ?? session.approvalMode?.alwaysApprove ?? false,
        };
        const responseModel = model || userSettings.ui.selectedModel || llamaConfig.model;
        // Map reasoning effort to maxIterations
        const maxIterationsMap = {
            low: 3,
            medium: 7,
            high: 15,
        };
        const maxIterations = maxIterationsMap[reasoningEffort || 'medium'] || 7;
        const isFirstUserMessage = !session.messages.some((existingMessage) => existingMessage.role === 'user');
        if (isFirstUserMessage) {
            session.name = getChatNameFromQuery(message);
        }
        // Add user message (without agent steps initially)
        session.messages.push({ id: crypto_1.default.randomUUID(), role: 'user', content: message, agentSteps: [] });
        session.updatedAt = new Date().toISOString();
        emitChatUpdated(session);
        // Emit user message
        socket.to(chatId).emit('message', {
            role: 'user',
            content: message,
        });
        socket.emit('message', { role: 'user', content: message });
        // Build conversation history (excluding thoughts) - user/assistant pairs.
        // Completed agent-run placeholder messages are expanded into compact summaries
        // so the regular chat model can understand what the agent did.
        const conversationHistory = buildChatConversationHistory(session, true);
        // Get the selected personality from database
        const selectedPersonalityId = userSettings.ui.selectedPersonality;
        let selectedPersonality = null;
        if (selectedPersonalityId) {
            const dbPersonality = await repositories_1.personalityRepository.findById(selectedPersonalityId);
            if (dbPersonality && (!dbPersonality.user_id || dbPersonality.user_id === currentUserId)) {
                selectedPersonality = {
                    id: dbPersonality.id,
                    name: dbPersonality.name,
                    description: dbPersonality.description || '',
                    tone: dbPersonality.tone || '',
                    systemPrompt: dbPersonality.system_prompt,
                    isCustom: dbPersonality.is_custom,
                };
            }
        }
        console.log(`Selected personality: ${selectedPersonality?.name || 'None'} (${selectedPersonalityId})`);
        // Create new agent with callbacks, personality, language, and model
        const agent = new ReActAgent_1.ReActAgent(llamaClient, toolRegistry, maxIterations, {
            onStep: (step) => {
                io.to(chatId).emit('agent-step', {
                    type: step.type,
                    content: step.content,
                    actionName: step.actionName,
                    actionArgs: step.actionArgs,
                });
            },
            onFinalAnswerToken: (token) => {
                io.to(chatId).emit('final-answer-token', { token, model: responseModel });
            },
            onReasoningToken: (token) => {
                io.to(chatId).emit('thought-token', token);
            },
            onDebugInfo: (rawContent, parsed) => {
                console.log('EMITTING DEBUG INFO:', { rawContent: rawContent.substring(0, 100), parsed });
                io.to(chatId).emit('debug-info', { rawContent, parsed });
            },
            onTimings: (timings) => {
                console.log('EMITTING TIMINGS:', timings);
                io.to(chatId).emit('timings', timings);
            },
            onError: (error) => {
                io.to(chatId).emit('error', { message: error });
            },
            onCancelled: () => {
                console.log(`Agent cancelled for chat ${chatId}`);
                io.to(chatId).emit('agent-cancelled');
            },
            onToolApprovalRequest: async (request) => {
                return await new Promise((resolve) => {
                    pendingApprovals.set(request.approvalId, { chatId, request, resolve });
                    io.to(chatId).emit('tool-approval-required', { ...request, chatId });
                });
            },
            onCreateAgentRun: async (request) => {
                return startChatAgentRun(session, currentUserId, request, responseModel || llamaConfig.model || '', language, chatId);
            },
            onStepSave: (savedChatId, step, allSteps) => {
                // Persist steps to database immediately after each step
                const session = chatSessions.get(savedChatId);
                if (session) {
                    // Update agent state with current progress
                    session.agentState = {
                        steps: allSteps,
                        isComplete: false,
                        finalAnswer: null,
                        model: responseModel,
                    };
                    // Find the last user message and attach current steps
                    for (let i = session.messages.length - 1; i >= 0; i--) {
                        if (session.messages[i].role === 'user') {
                            session.messages[i] = {
                                ...session.messages[i],
                                agentSteps: allSteps,
                            };
                            break;
                        }
                    }
                    void saveChat(session).catch(console.error);
                }
                // Emit step data to frontend for real-time updates
                io.to(savedChatId).emit('step-saved', {
                    step: {
                        type: step.type,
                        content: step.content,
                        actionName: step.actionName,
                        actionArgs: step.actionArgs,
                        targetMode: step.targetMode,
                    },
                    allSteps: allSteps.map(s => ({
                        type: s.type,
                        content: s.content,
                        actionName: s.actionName,
                        actionArgs: s.actionArgs,
                        targetMode: s.targetMode,
                    })),
                });
            },
            onPartialFinalAnswer: (partialChatId, partialContent) => {
                // Persist partial final answer content to agent state
                const session = chatSessions.get(partialChatId);
                if (session && session.agentState) {
                    // Update agent state with partial final answer
                    session.agentState = {
                        ...session.agentState,
                        partialFinalAnswer: partialContent,
                    };
                    // Find the last user message and update with partial content
                    for (let i = session.messages.length - 1; i >= 0; i--) {
                        if (session.messages[i].role === 'user') {
                            session.messages[i] = {
                                ...session.messages[i],
                                agentSteps: session.agentState.steps || [],
                            };
                            break;
                        }
                    }
                    void saveChat(session).catch(console.error);
                }
            },
        }, selectedPersonality, language, responseModel);
        // Store the agent reference in the session
        session.currentAgent = agent;
        // Load user memories
        const userMemories = (await memoryManager.getMemories(currentUserId)).map(m => m.content);
        try {
            // Run the agent with conversation history and memories
            const result = await agent.run(chatId, message, session.sandboxId, currentUserId, conversationHistory, userMemories, session.toolPreferences, session.approvalMode, getConfiguredWorkspaceConfig(userSettings.remoteWorkspace));
            // Store agent state
            session.agentState = {
                steps: result.steps,
                isComplete: result.isComplete,
                finalAnswer: result.finalAnswer,
                model: responseModel,
            };
            // Attach agent steps to the last user message
            if (result.steps.length > 0 && session.messages.length > 0) {
                // Find the last user message by iterating backwards
                for (let i = session.messages.length - 1; i >= 0; i--) {
                    if (session.messages[i].role === 'user') {
                        session.messages[i] = {
                            ...session.messages[i],
                            agentSteps: result.steps,
                        };
                        break;
                    }
                }
            }
            // Add assistant message (final answer)
            if (result.finalAnswer) {
                session.messages.push({
                    id: crypto_1.default.randomUUID(),
                    role: 'assistant',
                    content: result.finalAnswer,
                    model: responseModel,
                    agentSteps: [],
                });
                io.to(chatId).emit('message', {
                    role: 'assistant',
                    content: result.finalAnswer,
                    model: responseModel,
                });
            }
            // Update timestamp and save chats
            session.updatedAt = new Date().toISOString();
            saveChats();
            emitChatUpdated(session);
            io.to(chatId).emit('agent-complete', {
                finalAnswer: result.finalAnswer,
            });
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.log(`Agent error for chat ${chatId}:`, errorMessage);
            io.to(chatId).emit('error', { message: errorMessage });
        }
        finally {
            clearPendingApprovalsForChat(chatId);
            // Clear the agent reference when done
            session.currentAgent = undefined;
        }
    });
    socket.on('tool-approval-response', (data) => {
        if (!currentUserId) {
            socket.emit('error', { message: 'Not authenticated' });
            return;
        }
        const { approvalId, approved, reason, rememberAutoApprove, toolName } = data;
        const pendingApproval = pendingApprovals.get(approvalId);
        if (!pendingApproval || pendingApproval.chatId !== data.chatId) {
            socket.emit('error', { message: 'Approval request not found' });
            return;
        }
        const chatId = pendingApproval.chatId;
        const session = chatSessions.get(chatId);
        if (!session || session.userId !== currentUserId) {
            socket.emit('error', { message: 'Chat not found' });
            return;
        }
        if (approved && rememberAutoApprove && toolName && session.toolPreferences[toolName]) {
            session.toolPreferences[toolName] = {
                ...session.toolPreferences[toolName],
                autoApprove: true,
            };
            saveChats();
            io.to(chatId).emit('tool-preferences-updated', {
                toolPreferences: session.toolPreferences,
            });
        }
        pendingApprovals.delete(approvalId);
        pendingApproval.resolve({
            approved,
            reason: reason ?? (approved ? 'approved' : 'denied'),
        });
        io.to(chatId).emit('tool-approval-resolved', {
            chatId,
            approvalId,
            approved,
            reason: reason ?? (approved ? 'approved' : 'denied'),
        });
    });
    // Handle stop agent request
    socket.on('stop-agent', (chatId) => {
        if (!currentUserId) {
            socket.emit('error', { message: 'Not authenticated' });
            return;
        }
        const session = chatSessions.get(chatId);
        if (session && session.userId === currentUserId) {
            let stopped = false;
            if (session.currentAgent) {
                console.log(`Stopping chat agent for chat ${chatId}`);
                session.currentAgent.cancel();
                session.currentAgent = undefined;
                stopped = true;
            }
            for (const [runId, running] of runningAgentRuns.entries()) {
                if (running.session.id !== chatId || running.session.userId !== currentUserId) {
                    continue;
                }
                console.log(`Stopping spawned agent run ${runId} for chat ${chatId}`);
                running.agent.cancel();
                running.run.status = 'cancelled';
                running.run.error = 'Stopped by user.';
                running.run.updatedAt = new Date().toISOString();
                io.to(running.sourceSocketChatId).emit('agent-run-updated', serializeAgentRun(running.run));
                scheduleChatSave(running.session, 0);
                stopped = true;
            }
            clearPendingApprovalsForChat(chatId);
            if (stopped) {
                io.to(chatId).emit('agent-cancelled');
            }
            else {
                console.log(`No active agent found for chat ${chatId}`);
            }
        }
        else {
            console.log(`No active agent found for chat ${chatId} or unauthorized`);
        }
    });
    socket.on('agent-user-message', (data) => {
        if (!currentUserId) {
            socket.emit('error', { message: 'Not authenticated' });
            return;
        }
        const chatId = String(data?.chatId || '').trim();
        const runId = String(data?.runId || '').trim();
        const message = String(data?.message || '').trim();
        if (!chatId || !runId || !message) {
            socket.emit('error', { message: 'chatId, runId, and message are required' });
            return;
        }
        const running = runningAgentRuns.get(runId);
        if (!running || running.session.id !== chatId || running.session.userId !== currentUserId) {
            socket.emit('error', { message: 'Running agent not found' });
            return;
        }
        const accepted = running.agent.addUserMessage(message);
        if (!accepted) {
            socket.emit('error', { message: 'Agent message was empty' });
            return;
        }
        running.run.updatedAt = new Date().toISOString();
        io.to(running.sourceSocketChatId).emit('agent-run-updated', serializeAgentRun(running.run));
        scheduleChatSave(running.session, 0);
    });
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});
// Get available models
app.get('/api/models', async (req, res) => {
    try {
        const models = await llamaClient.getModels();
        // Ensure we return an array
        if (Array.isArray(models) && models.length > 0) {
            res.json(models);
        }
        else {
            // Fallback to current model if no models returned
            res.json([llamaConfig.model]);
        }
    }
    catch (error) {
        console.error('Error fetching models:', error);
        // Return current model as fallback
        res.json([llamaConfig.model]);
    }
});
// Get available tools
app.get('/api/tools', (req, res) => {
    res.json(toolRegistry.getPublicTools());
});
// Load built-in personalities from JSON file
function loadBuiltInPersonalities() {
    try {
        const personalitiesPath = path_1.default.join(__dirname, '../personalities.json');
        if (fs_1.default.existsSync(personalitiesPath)) {
            const data = fs_1.default.readFileSync(personalitiesPath, 'utf-8');
            const personalities = JSON.parse(data);
            return personalities.map((p) => ({
                id: p.id,
                name: p.name,
                description: p.description,
                tone: p.tone,
                systemPrompt: p.systemPrompt,
                isCustom: false,
            }));
        }
    }
    catch (error) {
        console.error('Error loading built-in personalities:', error);
    }
    return [];
}
// Personality endpoints - Get all personalities
app.get('/api/personalities', auth_1.protect, async (req, res) => {
    // Load built-in personalities from JSON file
    const builtInPersonalities = loadBuiltInPersonalities();
    res.json(builtInPersonalities);
});
// Get only custom personalities
app.get('/api/personalities/custom', auth_1.protect, async (req, res) => {
    const userId = req.user.id;
    const custom = await repositories_1.personalityRepository.findCustomByUserId(userId);
    // Convert database format to API format
    const personalities = custom.map(p => ({
        id: p.id,
        userId: p.user_id,
        name: p.name,
        description: p.description || '',
        tone: p.tone || '',
        systemPrompt: p.system_prompt,
        isCustom: p.is_custom,
    }));
    res.json(personalities);
});
// Create new custom personality
app.post('/api/personalities/custom', auth_1.protect, async (req, res) => {
    const { name, description, tone, systemPrompt } = req.body;
    const userId = req.user.id;
    if (!name || !description || !tone || !systemPrompt) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    const newPersonality = await repositories_1.personalityRepository.create({
        userId,
        name,
        description,
        tone,
        systemPrompt,
    });
    res.status(201).json({
        id: newPersonality.id,
        userId: newPersonality.user_id,
        name: newPersonality.name,
        description: newPersonality.description,
        tone: newPersonality.tone,
        systemPrompt: newPersonality.system_prompt,
        isCustom: newPersonality.is_custom,
    });
});
// Update custom personality
app.put('/api/personalities/custom/:id', auth_1.protect, async (req, res) => {
    const { id } = req.params;
    const { name, description, tone, systemPrompt } = req.body;
    const userId = req.user.id;
    const updatedPersonality = await repositories_1.personalityRepository.update(id, userId, {
        name,
        description,
        tone,
        systemPrompt,
    });
    if (!updatedPersonality) {
        return res.status(404).json({ error: 'Personality not found or is not editable' });
    }
    res.json({
        id: updatedPersonality.id,
        userId: updatedPersonality.user_id,
        name: updatedPersonality.name,
        description: updatedPersonality.description,
        tone: updatedPersonality.tone,
        systemPrompt: updatedPersonality.system_prompt,
        isCustom: updatedPersonality.is_custom,
    });
});
// Delete custom personality
app.delete('/api/personalities/custom/:id', auth_1.protect, async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    const deleted = await repositories_1.personalityRepository.delete(id, userId);
    if (!deleted) {
        return res.status(404).json({ error: 'Personality not found or is not deletable' });
    }
    // If this was the selected personality, reset to professional
    const userSettings = await getUserSettings(userId);
    if (userSettings.ui.selectedPersonality === id) {
        userSettings.ui.selectedPersonality = 'professional';
        await repositories_1.settingsRepository.setUiSettings(userSettings.ui, userId);
    }
    res.json({ success: true });
});
// Memory management endpoints
app.get('/api/memories', auth_1.protect, async (req, res) => {
    const userId = req.user.id;
    const memories = await memoryManager.getMemories(userId);
    res.json(memories);
});
app.post('/api/memories', auth_1.protect, async (req, res) => {
    const { content, tags } = req.body;
    const userId = req.user.id;
    if (!content) {
        return res.status(400).json({ error: 'Content is required' });
    }
    const memory = await memoryManager.addMemory(userId, content, tags);
    res.status(201).json(memory);
});
app.delete('/api/memories/:id', auth_1.protect, async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    const success = await memoryManager.deleteMemory(id, userId);
    if (success) {
        res.json({ success: true });
    }
    else {
        res.status(404).json({ error: 'Memory not found' });
    }
});
// MCP Server Management Endpoints
app.get('/api/mcp/servers', auth_1.protect, (req, res) => {
    const statuses = mcpClientManager.getServerStatuses();
    res.json(statuses);
});
// Known MCP servers - mapping server name to npm package
const KNOWN_MCP_SERVERS = {
    'github': { packageName: '@modelcontextprotocol/server-github', envVar: 'GITHUB_TOKEN' },
    'filesystem': { packageName: '@modelcontextprotocol/server-filesystem' },
    'brave-search': { packageName: '@modelcontextprotocol/server-brave-search', envVar: 'BRAVE_API_KEY' },
    'memory': { packageName: '@modelcontextprotocol/server-memory' },
    'postgres': { packageName: '@modelcontextprotocol/server-postgres', envVar: 'POSTGRES_URL' },
    'sqlite': { packageName: '@modelcontextprotocol/server-sqlite' },
    'slack': { packageName: '@modelcontextprotocol/server-slack', envVar: 'SLACK_BOT_TOKEN' },
    'google-maps': { packageName: '@modelcontextprotocol/server-google-maps', envVar: 'GOOGLE_MAPS_API_KEY' },
    'puppeteer': { packageName: '@modelcontextprotocol/server-puppeteer' },
    'sequential-thinking': { packageName: '@modelcontextprotocol/server-sequential-thinking' },
};
app.post('/api/mcp/servers', auth_1.protect, async (req, res) => {
    const userId = req.user.id;
    const { name, url, apiKey, transportType } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Server name is required' });
    }
    if (!url) {
        return res.status(400).json({ error: 'Server URL is required' });
    }
    const config = {
        url,
        apiKey,
        transportType: transportType || 'sse',
        enabled: true,
    };
    try {
        await mcpClientManager.addServer(name, config);
        // Save to settings
        const currentSettings = await repositories_1.settingsRepository.getMcpServers(userId);
        currentSettings[name] = config;
        await repositories_1.settingsRepository.setMcpServers(currentSettings, userId);
        res.json({ success: true, message: `MCP server '${name}' added successfully` });
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        res.status(500).json({ error: `Failed to add MCP server: ${errorMessage}` });
    }
});
app.delete('/api/mcp/servers/:name', auth_1.protect, async (req, res) => {
    const userId = req.user.id;
    const { name } = req.params;
    try {
        await mcpClientManager.removeServer(name);
        // Remove from settings
        const currentSettings = await repositories_1.settingsRepository.getMcpServers(userId);
        delete currentSettings[name];
        await repositories_1.settingsRepository.setMcpServers(currentSettings, userId);
        res.json({ success: true, message: `MCP server '${name}' removed successfully` });
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        res.status(500).json({ error: `Failed to remove MCP server: ${errorMessage}` });
    }
});
app.post('/api/mcp/servers/:name/reconnect', auth_1.protect, async (req, res) => {
    const { name } = req.params;
    try {
        await mcpClientManager.reconnectServer(name);
        res.json({ success: true, message: `MCP server '${name}' reconnected successfully` });
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        res.status(500).json({ error: `Failed to reconnect MCP server: ${errorMessage}` });
    }
});
app.get('/api/mcp/tools', auth_1.protect, (req, res) => {
    const tools = mcpClientManager.getTools();
    res.json(tools);
});
// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});
// Generic error handler
app.use((err, req, res, next) => {
    const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
    res.status(statusCode);
    res.json({
        message: err.message,
        stack: process.env.NODE_ENV === 'production' ? null : err.stack,
    });
});
const PORT = process.env.PORT || 3001;
httpServer.listen({ port: PORT, host: '0.0.0.0' }, () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
});
//# sourceMappingURL=server.js.map
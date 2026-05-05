import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { createServer } from 'http';
import crypto from 'crypto';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import path from 'path';
import fs from 'fs';
import { LlamaClient, LlamaConfig, ChatTimings } from './services/llamaClient';
import { SearXNGClient, SearXNGConfig } from './services/searxngClient';
import { SandboxManager } from './services/sandboxManager';
import { MemoryManager } from './services/memoryManager';
import { MCPClientManager, MCPServerConfig } from './services/mcpClientManager';
import { ToolRegistry, ChatToolPreference } from './tools';
import { ReActAgent, AgentStep, ToolApprovalRequest, ToolApprovalResponse, CreateAgentRunRequest } from './agent/ReActAgent';
import { WorkspaceConfig, WorkspaceRuntimeFactory } from './services/workspaceRuntime';
import { agentMemoryService } from './services/agentMemoryService';
import { protect, registerUser, loginUser, getMe, AuthRequest } from './auth';
import { initializeDatabase, testConnection } from './db';
import { chatRepository, personalityRepository, settingsRepository, taskRepository, ScheduledTask, agentRunTaskRepository, agentSessionRepository } from './repositories';
import { computeNextRun, computeNextRunForTask, normalizeDaysOfWeek } from './services/schedule';
import { SshAgentRunner } from './agent/v2/sshAgentRunner';
import { MessageID, PartID, SessionID } from './agent/v2/ids';
import type { UserMessage as V2UserMessage, TextPart as V2TextPart } from './agent/v2/message';

// JWT secret for socket.io
const JWT_SECRET = process.env.JWT_SECRET || 'operator-chat-secret-key-12345';

// Personality types
interface ChatPersonality {
  id: string;
  userId?: string;
  name: string;
  description: string;
  tone: string;
  systemPrompt: string;
  isCustom?: boolean;
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json());

// Configure multer for file uploads
const storage: multer.StorageEngine = multer.diskStorage({
  destination: (req, file, cb) => {
    // Get sandboxId from URL params
    const sandboxId = req.params.sandboxId;
    const sandbox = sandboxManager.getSandbox(sandboxId);
    
    // Check if sandbox exists in memory
    if (sandbox) {
      cb(null, sandbox.basePath);
    } else {
      // Check if sandbox directory exists on disk (for persistence after restart)
      // Use absolute path to sandboxes directory
      const sandboxPath = path.join(process.cwd(), 'sandboxes', sandboxId);
      if (fs.existsSync(sandboxPath)) {
        // Add sandbox to manager for future use
        sandboxManager.addSandbox(sandboxId, sandboxPath);
        cb(null, sandboxPath);
      } else {
        cb(new Error('Sandbox not found') as any, '');
      }
    }
  },
  filename: (req, file, cb) => {
    // Use original filename
    cb(null, file.originalname);
  },
});

const upload = multer({ 
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

interface UISettings {
  showStats: boolean;
  selectedPersonality: string;
  selectedModel?: string;
  defaultToolPreferences?: Record<string, ChatToolPreference>;
}

interface MCPServersConfig {
  [serverName: string]: MCPServerConfig;
}

interface RemoteWorkspaceSettings {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  root: string;
  privateKey?: string;
  privateKeyPath?: string;
  strictHostKeyChecking: boolean;
  approvalPolicy: 'ask' | 'auto-approve';
  toolApprovals: Record<string, 'ask' | 'auto-approve'>;
  agentModel?: string;
  contextWindowTokens: number;
  reservedOutputTokens: number;
  autoCompactThreshold: number;
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
    selectedModel: undefined as string | undefined,
    defaultToolPreferences: {} as Record<string, ChatToolPreference>,
  },
  mcpServers: {} as MCPServersConfig,
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
  } as RemoteWorkspaceSettings,
};

// Settings will be loaded asynchronously
let loadedSettings = defaultSettings;

// Global state
const sandboxManager = new SandboxManager();
const memoryManager = new MemoryManager();
const workspaceRuntimeFactory = new WorkspaceRuntimeFactory(sandboxManager);
let searxngConfig: SearXNGConfig = loadedSettings.searxng;
let llamaConfig: LlamaConfig = loadedSettings.llama;

// Initialize clients
let searxngClient = new SearXNGClient(searxngConfig);
let llamaClient = new LlamaClient(llamaConfig);

// Initialize MCP Client Manager
const mcpClientManager = new MCPClientManager();

// Initialize Tool Registry with MCP support
let toolRegistry = new ToolRegistry(searxngClient, sandboxManager, memoryManager, mcpClientManager, agentMemoryService);

// Set up callback to re-register MCP tools when servers connect/disconnect
mcpClientManager.setOnToolsChangedCallback(() => {
  toolRegistry.registerMCPTools();
  console.log('MCP tools re-registered due to server change');
});

// Load MCP servers from settings
async function loadMCPServers(): Promise<void> {
  const mcpServers = loadedSettings.mcpServers || {};
  for (const [name, config] of Object.entries(mcpServers)) {
    try {
      await mcpClientManager.addServer(name, config);
      console.log(`Loaded MCP server '${name}'`);
    } catch (error) {
      console.error(`Failed to load MCP server '${name}':`, error);
    }
  }
}

async function getUserSettings(userId: string): Promise<typeof defaultSettings> {
  const uiSettings = await settingsRepository.getUiSettings(userId);
  const mcpServersSettings = await settingsRepository.getMcpServers(userId);
  const remoteWorkspaceSettings = await settingsRepository.getRemoteWorkspace(userId);
  const settings = {
    ...defaultSettings,
    ui: {
      ...defaultSettings.ui,
      ...(uiSettings || {}),
    },
    mcpServers: mcpServersSettings || defaultSettings.mcpServers,
    remoteWorkspace: normalizeRemoteWorkspaceSettings(remoteWorkspaceSettings),
  };
  settings.ui.defaultToolPreferences = toolRegistry.mergeWithDefaultPreferences(
    settings.ui.defaultToolPreferences
  );
  return settings;
}

// Initialize database and load settings
async function initializeApp(): Promise<void> {
  try {
    // Test database connection
    const connected = await testConnection();
    if (!connected) {
      console.error('Failed to connect to database. Please check your database configuration.');
      process.exit(1);
    }

    // Initialize database schema
    await initializeDatabase();
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
  } catch (error) {
    console.error('Failed to initialize application:', error);
    process.exit(1);
  }
}

// Initialize app on startup
initializeApp().catch(console.error);

function normalizeToolPreferences(
  preferences?: Record<string, ChatToolPreference>,
  defaultPreferences?: Record<string, ChatToolPreference>
): Record<string, ChatToolPreference> {
  return restrictInternalAgentTools(toolRegistry.mergeWithDefaultPreferences(
    preferences,
    defaultPreferences || defaultSettings.ui.defaultToolPreferences
  ));
}

// Names of legacy ToolRegistry tools that the chat-side ReActAgent must NOT
// expose to the chat user. The chat ReActAgent still has these registered (so
// it can introspect tool defs) — we just keep them disabled in the user's
// chat tool prefs.
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
  'task_create',
  'task_update',
  'task_list',
]);

// Names of the v2 SSH agent tools that require user approval per the spec.
// These are the keys the user's per-tool auto-approve settings are stored under
// for the SSH agent (UI in SettingsPanel.tsx → Agent workspace section).
const SSH_AGENT_APPROVAL_TOOL_NAMES = ['shell', 'write', 'edit', 'browser', 'task'] as const;

// Backwards-compat: when reading user settings, fold legacy tool names onto
// their v2 equivalents so existing users don't lose their auto-approve choices.
const LEGACY_APPROVAL_KEY_ALIASES: Record<string, string> = {
  bash: 'shell',
  apply_patch: 'edit',
  terminal_kill: 'shell',
  // memory_*, task_* (legacy) had requiresApproval=false in the old set, so no
  // alias is needed — they were never user-auto-approved anyway.
};

function restrictInternalAgentTools(preferences: Record<string, ChatToolPreference>): Record<string, ChatToolPreference> {
  const next = { ...preferences };
  for (const toolName of AGENT_INTERNAL_TOOL_NAMES) {
    if (next[toolName]) {
      next[toolName] = { enabled: false, autoApprove: false };
    }
  }
  return next;
}

function buildSpawnedAgentToolPreferences(
  base: Record<string, ChatToolPreference> | undefined,
  remoteWorkspace: RemoteWorkspaceSettings
): Record<string, ChatToolPreference> {
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

function normalizeRemoteWorkspaceSettings(input: unknown): RemoteWorkspaceSettings {
  const source = input && typeof input === 'object' ? input as any : {};
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
    ? source.toolApprovals as Record<string, unknown>
    : {};
  // Apply legacy aliases first so a saved `bash: 'auto-approve'` ends up as
  // `shell: 'auto-approve'` after migration.
  const aliased: Record<string, unknown> = { ...sourceToolApprovals };
  for (const [legacy, modern] of Object.entries(LEGACY_APPROVAL_KEY_ALIASES)) {
    if (aliased[modern] === undefined && aliased[legacy] !== undefined) {
      aliased[modern] = aliased[legacy];
    }
  }
  const toolApprovals = SSH_AGENT_APPROVAL_TOOL_NAMES.reduce((acc, toolName) => {
    acc[toolName] = aliased[toolName] === 'auto-approve' || approvalPolicy === 'auto-approve'
      ? 'auto-approve'
      : 'ask';
    return acc;
  }, {} as Record<string, 'ask' | 'auto-approve'>);

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

  if (
    !host ||
    !username ||
    !root ||
    host.startsWith('-') ||
    username.startsWith('-') ||
    !/^[A-Za-z0-9._-]+$/.test(username) ||
    !/^[A-Za-z0-9.-]+$/.test(host) ||
    !root.startsWith('/') ||
    (!privateKey && !privateKeyPath)
  ) {
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

function getConfiguredWorkspaceConfig(remoteWorkspace: RemoteWorkspaceSettings): WorkspaceConfig | undefined {
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

function getWorkspaceConfigForRoot(workspaceRoot: string, remoteWorkspace: RemoteWorkspaceSettings): WorkspaceConfig | undefined {
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

function serializeRemoteWorkspaceSettings(settings: RemoteWorkspaceSettings): RemoteWorkspaceSettings & { hasPrivateKey: boolean } {
  return {
    ...settings,
    privateKey: '',
    hasPrivateKey: Boolean(settings.privateKey),
  };
}

function serializeAgentRun(run: AgentRun) {
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

function normalizeWorkspaceConfig(input: unknown): WorkspaceConfig | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const workspace = input as any;
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

// Chat sessions: Map<chatId, { sandboxId, messages, name }>
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  agentSteps?: AgentStep[];
  agentRunId?: string;
}

interface AgentRun {
  id: string;
  chatId: string;
  userId: string;
  title: string;
  prompt: string;
  workspaceRoot: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  steps: AgentStep[];
  finalAnswer: string | null;
  error?: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
}

interface SharedAgentContext {
  summary: string;
  coversRunIds: string[];
  coversStepCount: number;
  updatedAt: string;
  tokenEstimate?: number;
}

interface ChatSession {
  id: string;
  userId: string;
  sandboxId: string;
  messages: ChatMessage[];
  name: string;
  createdAt: string;
  updatedAt: string;
  agentState?: {
    steps: AgentStep[];
    isComplete: boolean;
    finalAnswer: string | null;
    model?: string;
    partialFinalAnswer?: string;
  };
  toolPreferences: Record<string, ChatToolPreference>;
  approvalMode: {
    alwaysApprove: boolean;
  };
  agentRuns: AgentRun[];
  sharedAgentContext?: SharedAgentContext;
  currentAgent?: ReActAgent; // Track the current running agent
}
const chatSessions = new Map<string, ChatSession>();
const pendingChatSaveTimers = new Map<string, NodeJS.Timeout>();

interface PendingApproval {
  chatId: string;
  request: ToolApprovalRequest;
  resolve: (response: ToolApprovalResponse) => void;
}

const pendingApprovals = new Map<string, PendingApproval>();
type ToolApprovalRequestPayload = ToolApprovalRequest & { chatId: string };

interface PendingQuestionPayload {
  chatId: string;
  agentRunId: string;
  questionId: string;
  question: string;
  options: Array<{ value: string; label: string; recommended?: boolean }>;
  multiple: boolean;
  allowCustomAnswer: boolean;
  timeoutMs?: number;
}

interface PendingQuestion {
  payload: PendingQuestionPayload;
  resolve: (response: { answer: string | string[]; answered: boolean } | null) => void;
}
// Pending `question` tool calls awaiting a reply via the agent-question-response socket.
// The full payload is kept so the question can be re-emitted to a reconnecting
// client (page refresh, network blip) — otherwise the dialog would be lost.
const pendingQuestions = new Map<string, PendingQuestion>();

function clearPendingQuestionsForRun(agentRunId: string, ignored = true): void {
  for (const [questionId, pending] of pendingQuestions.entries()) {
    if (pending.payload.agentRunId !== agentRunId) continue;
    pendingQuestions.delete(questionId);
    pending.resolve(ignored ? { answer: '', answered: false } : null);
    io.to(pending.payload.chatId).emit('agent-question-resolved', {
      chatId: pending.payload.chatId,
      agentRunId: pending.payload.agentRunId,
      questionId,
    });
  }
}

const MAX_PERSISTED_STEP_CONTENT_CHARS = 20000;
const MAX_PERSISTED_PARTIAL_ANSWER_CHARS = 100000;

function scheduleChatSave(session: ChatSession, delayMs = 750): void {
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

async function flushScheduledChatSave(session: ChatSession): Promise<void> {
  const existingTimer = pendingChatSaveTimers.get(session.id);
  if (existingTimer) {
    clearTimeout(existingTimer);
    pendingChatSaveTimers.delete(session.id);
  }
  await saveChat(session);
}

function truncateForPersistence(content: string | undefined, maxLength: number): string | undefined {
  if (content === undefined || content.length <= maxLength) {
    return content;
  }

  return `${content.slice(0, maxLength)}\n\n[Truncated while saving to avoid oversized database packets.]`;
}

function parseJsonIfNeeded(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function sanitizeAgentStepsForPersistence(steps: unknown): AgentStep[] {
  const parsedSteps = parseJsonIfNeeded(steps);
  if (!Array.isArray(parsedSteps)) {
    return [];
  }

  return parsedSteps.map((step) => ({
    ...step,
    content: truncateForPersistence(typeof step.content === 'string' ? step.content : '', MAX_PERSISTED_STEP_CONTENT_CHARS) ?? '',
  }));
}

function sanitizeAgentStateForPersistence(agentState: unknown): ChatSession['agentState'] {
  const parsedAgentState = parseJsonIfNeeded(agentState) as ChatSession['agentState'];
  if (!parsedAgentState || typeof parsedAgentState !== 'object') {
    return undefined;
  }

  return {
    ...parsedAgentState,
    steps: sanitizeAgentStepsForPersistence(parsedAgentState.steps),
    finalAnswer: truncateForPersistence(
      typeof parsedAgentState.finalAnswer === 'string' ? parsedAgentState.finalAnswer : undefined,
      MAX_PERSISTED_PARTIAL_ANSWER_CHARS
    ) ?? null,
    partialFinalAnswer: truncateForPersistence(
      typeof parsedAgentState.partialFinalAnswer === 'string' ? parsedAgentState.partialFinalAnswer : undefined,
      MAX_PERSISTED_PARTIAL_ANSWER_CHARS
    ),
  };
}

function sanitizeAgentRunsForPersistence(agentRuns: unknown): AgentRun[] {
  const parsedAgentRuns = parseJsonIfNeeded(agentRuns);
  if (!Array.isArray(parsedAgentRuns)) {
    return [];
  }

  return parsedAgentRuns.map((run) => ({
    ...run,
    status: ['running', 'completed', 'failed', 'cancelled'].includes(run.status) ? run.status : 'failed',
    steps: sanitizeAgentStepsForPersistence(run.steps),
    finalAnswer: truncateForPersistence(
      typeof run.finalAnswer === 'string' ? run.finalAnswer : undefined,
      MAX_PERSISTED_PARTIAL_ANSWER_CHARS
    ) ?? null,
    error: truncateForPersistence(typeof run.error === 'string' ? run.error : undefined, MAX_PERSISTED_STEP_CONTENT_CHARS),
  }));
}

function normalizePersistedAgentRun(run: AgentRun): AgentRun {
  if (run.status !== 'running') {
    return run;
  }

  return {
    ...run,
    status: 'failed',
    error: run.error || 'Agent run was interrupted by a server restart.',
  };
}

function latestIsoDate(values: Array<Date | string | undefined | null>): string | undefined {
  let latestTime = Number.NEGATIVE_INFINITY;
  let latestValue: string | undefined;

  for (const value of values) {
    if (!value) continue;
    const date = value instanceof Date ? value : new Date(value);
    const time = date.getTime();
    if (!Number.isFinite(time) || time <= latestTime) continue;
    latestTime = time;
    latestValue = date.toISOString();
  }

  return latestValue;
}

function normalizeChatMessages(
  messages: ChatMessage[] | undefined,
  agentState?: ChatSession['agentState'],
  fallbackModel?: string
): { messages: ChatMessage[]; changed: boolean } {
  const normalizedMessages = (messages ?? []).map((message) => {
    if (message.id) {
      return message;
    }

    return {
      ...message,
      id: crypto.randomUUID(),
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

function normalizeChatSession(session: ChatSession): boolean {
  const normalizedToolPreferences = normalizeToolPreferences(session.toolPreferences);
  const toolPreferencesChanged = JSON.stringify(session.toolPreferences) !== JSON.stringify(normalizedToolPreferences);
  session.toolPreferences = normalizedToolPreferences;

  const normalizedApprovalMode = {
    alwaysApprove: session.approvalMode?.alwaysApprove ?? false,
  };
  const approvalModeChanged = (session.approvalMode?.alwaysApprove ?? false) !== normalizedApprovalMode.alwaysApprove;
  session.approvalMode = normalizedApprovalMode;

  const { messages, changed: messagesChanged } = normalizeChatMessages(
    session.messages,
    session.agentState,
    llamaConfig.model
  );
  session.messages = messages;
  if (!Array.isArray(session.agentRuns)) {
    session.agentRuns = [];
  }

  return toolPreferencesChanged || approvalModeChanged || messagesChanged;
}

function getChatNameFromQuery(query: string): string {
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
async function loadChats(): Promise<void> {
  try {
    chatSessions.clear();
    const persistedChats = await chatRepository.findAll();
    console.log(`Loaded ${persistedChats.length} chats from database`);
    
    for (const chat of persistedChats) {
      const result = await chatRepository.getWithMessages(chat.id);
      if (result) {
        const { chat: persistedChat, messages } = result;
        const persistedAgentState = sanitizeAgentStateForPersistence(persistedChat.agent_state);
        const parsedPersistedAgentState = parseJsonIfNeeded(persistedChat.agent_state) as any;
        const persistedAgentRuns = sanitizeAgentRunsForPersistence(parsedPersistedAgentState?.agentRuns)
          .map(normalizePersistedAgentRun);
        const sharedAgentContext = parsedPersistedAgentState?.sharedAgentContext &&
          typeof parsedPersistedAgentState.sharedAgentContext === 'object' &&
          typeof parsedPersistedAgentState.sharedAgentContext.summary === 'string'
          ? parsedPersistedAgentState.sharedAgentContext as SharedAgentContext
          : undefined;
        const latestActivityAt = latestIsoDate([
          ...messages.map((message) => message.created_at),
          ...persistedAgentRuns.map((run) => run.updatedAt),
          persistedChat.updated_at,
        ]);
        const restoredMessages: ChatMessage[] = messages.map((msg, idx) => ({
          id: msg.id,
          role: msg.role,
          content: msg.content,
          model: msg.model || undefined,
          agentSteps: sanitizeAgentStepsForPersistence(msg.agent_steps),
          agentRunId: msg.content.startsWith('__operator_agent_run__:') ? msg.content.slice('__operator_agent_run__:'.length).trim() : undefined,
        }));

        let restoredMessagesChanged = false;
        const restoredAgentMessageIds = new Set(
          restoredMessages
            .map((message) => message.agentRunId || (message.content.startsWith('__operator_agent_run__:') ? message.content.slice('__operator_agent_run__:'.length).trim() : undefined))
            .filter(Boolean)
        );
        for (const run of persistedAgentRuns) {
          if (restoredAgentMessageIds.has(run.id)) {
            continue;
          }
          restoredMessages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `__operator_agent_run__:${run.id}`,
            model: run.model,
            agentSteps: [],
            agentRunId: run.id,
          });
          restoredMessagesChanged = true;
        }

        const session: ChatSession = {
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
  } catch (error) {
    console.error('Error loading chats:', error);
  }
}

// Save chat to database
async function saveChat(session: ChatSession, options: { touchUpdatedAt?: boolean } = {}): Promise<void> {
  try {
    // Update or create chat
    const existingChat = await chatRepository.findById(session.id);
    if (existingChat) {
      await chatRepository.update(session.id, {
        name: session.name,
        agent_state: {
          ...sanitizeAgentStateForPersistence(session.agentState),
          agentRuns: sanitizeAgentRunsForPersistence(session.agentRuns),
          sharedAgentContext: session.sharedAgentContext,
        },
        tool_preferences: session.toolPreferences,
        approval_mode: session.approvalMode,
      }, { touchUpdatedAt: options.touchUpdatedAt });
    } else {
      await chatRepository.create({
        id: session.id,
        userId: session.userId,
        sandboxId: session.sandboxId,
        name: session.name,
        toolPreferences: session.toolPreferences,
        approvalMode: session.approvalMode,
      });
      await chatRepository.update(session.id, {
        agent_state: {
          ...sanitizeAgentStateForPersistence(session.agentState),
          agentRuns: sanitizeAgentRunsForPersistence(session.agentRuns),
          sharedAgentContext: session.sharedAgentContext,
        },
      }, { touchUpdatedAt: options.touchUpdatedAt });
    }

    // Sync messages
    const existingMessages = await chatRepository.findMessagesByChatId(session.id);
    const existingMessageIds = new Set(existingMessages.map(m => m.id));
    const currentMessageIds = new Set(session.messages.map(m => m.id));

    // Delete messages that no longer exist
    for (const existingMsg of existingMessages) {
      if (!currentMessageIds.has(existingMsg.id)) {
        await chatRepository.deleteMessagesFromIndex(session.id, existingMsg.message_index);
      }
    }

    // Add or update messages
    for (let i = 0; i < session.messages.length; i++) {
      const msg = session.messages[i];
      if (existingMessageIds.has(msg.id)) {
        await chatRepository.updateMessage(msg.id, {
          content: msg.content,
          agent_steps: sanitizeAgentStepsForPersistence(msg.agentSteps),
        });
      } else {
        await chatRepository.addMessage({
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
  } catch (error) {
    console.error('Error saving chat:', error);
  }
}

// Save all chats to database
async function saveChats(): Promise<void> {
  try {
    for (const session of chatSessions.values()) {
      await saveChat(session);
    }
  } catch (error) {
    console.error('Error saving all chats:', error);
  }
}

// Auth routes
app.post('/api/auth/register', registerUser);
app.post('/api/auth/login', loginUser);
app.get('/api/auth/me', protect, getMe);

function clearPendingApprovalsForChat(chatId: string, reason: ToolApprovalResponse['reason'] = 'cancelled'): void {
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

function getPendingApprovalPayloadForChat(chatId: string): ToolApprovalRequestPayload | null {
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

function parseWorkspaceListOutput(output: string, basePath: string | undefined) {
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
        path: base ? path.posix.join(base, name) : name,
        isDirectory,
        isProtected: false,
      };
    })
    .filter((item) => item.path && item.path !== '.');
}

function normalizeRemoteBrowserPath(input: unknown): string {
  const raw = typeof input === 'string' ? input.trim().replaceAll('\\', '/') : '';
  if (!raw || raw === '/') {
    return '.';
  }
  const normalized = path.posix.normalize(`/${raw}`).slice(1);
  if (!normalized || normalized === '.') {
    return '.';
  }
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Path escapes remote workspace root.');
  }
  return normalized;
}

function remoteBrowserAbsolutePath(workspace: WorkspaceConfig, relativePath: string): string {
  const root = workspace.ssh?.root;
  if (!root) {
    throw new Error('Remote workspace root is not configured.');
  }
  const normalized = normalizeRemoteBrowserPath(relativePath);
  return normalized === '.'
    ? path.posix.normalize(root)
    : path.posix.join(path.posix.normalize(root), normalized);
}

function parseRemoteWorkspaceMetadata(output: string): any[] {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [type, encodedPath, encodedName, size, modifiedAt, createdAt, gitStatus] = line.split('\t');
      const decode = (value: string | undefined) => Buffer.from(value || '', 'base64').toString('utf8');
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

async function getSelectedPersonality(userId: string, uiSettings?: UISettings): Promise<ChatPersonality | null> {
  const selectedPersonalityId = uiSettings?.selectedPersonality || defaultSettings.ui.selectedPersonality;
  if (!selectedPersonalityId) return null;

  const dbPersonality = await personalityRepository.findById(selectedPersonalityId);
  if (!dbPersonality) return null;
  if (dbPersonality.user_id && dbPersonality.user_id !== userId) return null;

  return {
    id: dbPersonality.id,
    name: dbPersonality.name,
    description: dbPersonality.description || '',
    tone: dbPersonality.tone || '',
    systemPrompt: dbPersonality.system_prompt,
    isCustom: dbPersonality.is_custom,
  };
}

function serializeTask(task: ScheduledTask) {
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

function createSessionForUser(userId: string, name = 'Scheduled Task'): ChatSession {
  const chatId = crypto.randomUUID();
  const sandbox = sandboxManager.createSandbox();
  const now = new Date().toISOString();
  const session: ChatSession = {
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

function emitChatUpdated(session: ChatSession): void {
  io.to(session.userId).emit('chat-updated', {
    chatId: session.id,
    sandboxId: session.sandboxId,
    name: session.name,
    messageCount: session.messages.length,
    updatedAt: session.updatedAt,
  });
}

function getAgentRunIdFromMessage(message: ChatMessage): string | undefined {
  if (message.agentRunId) {
    return message.agentRunId;
  }

  if (message.content.startsWith('__operator_agent_run__:')) {
    return message.content.slice('__operator_agent_run__:'.length).trim();
  }

  return undefined;
}

function getAgentFinalAnswer(run: AgentRun): string | null {
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

function formatAgentRunForChatHistory(run: AgentRun): string {
  const filesTouched = new Map<string, string>();
  const commands: string[] = [];

  for (const step of run.steps) {
    if (step.type !== 'action' || !step.actionName) {
      continue;
    }

    if (['write', 'edit', 'apply_patch'].includes(step.actionName)) {
      const pathValue = String(step.actionArgs?.path || step.actionArgs?.filePath || step.actionArgs?.patchPath || '').trim();
      if (pathValue) {
        filesTouched.set(pathValue, step.actionName);
      } else if (step.actionName === 'apply_patch') {
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

function buildChatConversationHistory(session: ChatSession, excludeLastMessage = false): Array<{ role: 'user' | 'assistant'; content: string }> {
  const runById = new Map(session.agentRuns.map((run) => [run.id, run]));
  const messages = excludeLastMessage ? session.messages.slice(0, -1) : session.messages;

  return messages.map((message) => {
    const agentRunId = getAgentRunIdFromMessage(message);
    const run = agentRunId ? runById.get(agentRunId) : undefined;
    if (message.role === 'assistant' && run) {
      return {
        role: 'assistant' as const,
        content: formatAgentRunForChatHistory(run),
      };
    }

    return {
      role: message.role,
      content: message.content,
    };
  });
}

function ensureCodingAgentSuccessContract(prompt: string): string {
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

async function executeScheduledTask(task: ScheduledTask, force = false): Promise<void> {
  if (!force && task.status !== 'active') return;
  if (runningScheduledTaskIds.has(task.id)) return;

  runningScheduledTaskIds.add(task.id);

  let session = task.chat_id ? chatSessions.get(task.chat_id) : undefined;
  if (!session || session.userId !== task.user_id) {
    session = createSessionForUser(task.user_id, task.title);
    await taskRepository.update(task.id, {
      chat_id: session.id,
      sandbox_id: session.sandboxId,
    } as Partial<ScheduledTask>);
    await saveChat(session);
  }

  const run = await taskRepository.createRun(task.id, session.id);
  io.to(task.user_id).emit('task-run-started', { taskId: task.id, runId: run.id, chatId: session.id });

  await taskRepository.updateRun(run.id, { status: 'running', started_at: new Date() } as any);
  await taskRepository.update(task.id, { next_run_at: null } as Partial<ScheduledTask>);

  const userSettings = await getUserSettings(task.user_id);
  const responseModel = task.model || userSettings.ui.selectedModel || llamaConfig.model;
  if (!responseModel) {
    const errorMessage = 'No model is configured for scheduled task execution';
    await taskRepository.updateRun(run.id, { status: 'failed', completed_at: new Date(), error: errorMessage } as any);
    await taskRepository.update(task.id, { status: 'failed', last_run_at: new Date() } as Partial<ScheduledTask>);
    io.to(task.user_id).emit('task-run-failed', { taskId: task.id, runId: run.id, error: errorMessage });
    runningScheduledTaskIds.delete(task.id);
    return;
  }
  const maxIterationsMap: Record<string, number> = { low: 3, medium: 7, high: 15 };
  const maxIterations = maxIterationsMap[task.reasoning_effort || 'medium'] || 7;
  const scheduledMessage = `Scheduled task: ${task.title}\n\n${task.prompt}`;

  session.toolPreferences = normalizeToolPreferences(task.tool_preferences || session.toolPreferences, userSettings.ui.defaultToolPreferences);
  session.approvalMode = task.approval_mode || { alwaysApprove: false };
  session.messages.push({ id: crypto.randomUUID(), role: 'user', content: scheduledMessage, agentSteps: [] });
  session.updatedAt = new Date().toISOString();
  io.to(session.id).emit('message', { role: 'user', content: scheduledMessage });
  emitChatUpdated(session);

  const conversationHistory = buildChatConversationHistory(session, true);

  const selectedPersonality = await getSelectedPersonality(task.user_id, userSettings.ui);
  let approvalBlocked = false;

  const agent = new ReActAgent(llamaClient, toolRegistry, maxIterations, {
    onStep: (step: AgentStep) => {
      io.to(session!.id).emit('agent-step', step);
      io.to(task.user_id).emit('task-run-step', { taskId: task.id, runId: run.id, step });
    },
    onFinalAnswerToken: (token: string) => io.to(session!.id).emit('final-answer-token', { token, model: responseModel }),
    onReasoningToken: (token: string) => io.to(session!.id).emit('thought-token', token),
    onTimings: (timings: ChatTimings) => io.to(session!.id).emit('timings', timings),
    onError: (error: string) => io.to(session!.id).emit('error', { message: error }),
    onToolApprovalRequest: async (request: ToolApprovalRequest) => {
      approvalBlocked = true;
      await taskRepository.updateRun(run.id, {
        status: 'needs_approval',
        error: `Tool approval required for ${request.toolName}`,
      } as any);
      io.to(task.user_id).emit('task-approval-required', { taskId: task.id, runId: run.id, request });
      return { approved: false, reason: 'denied' };
    },
    onStepSave: async (_chatId: string, step: AgentStep, allSteps: AgentStep[]) => {
      session!.agentState = { steps: allSteps, isComplete: false, finalAnswer: null, model: responseModel };
      for (let i = session!.messages.length - 1; i >= 0; i--) {
        if (session!.messages[i].role === 'user') {
          session!.messages[i] = { ...session!.messages[i], agentSteps: allSteps };
          break;
        }
      }
      await taskRepository.updateRun(run.id, { agent_steps: sanitizeAgentStepsForPersistence(allSteps) } as any);
      void saveChat(session!).catch(console.error);
      io.to(session!.id).emit('step-saved', { step, allSteps });
    },
    onPartialFinalAnswer: (_chatId: string, partialContent: string) => {
      if (session!.agentState) {
        session!.agentState = { ...session!.agentState, partialFinalAnswer: partialContent };
        void saveChat(session!).catch(console.error);
      }
    },
  }, selectedPersonality, 'en', responseModel);

  session.currentAgent = agent;

  try {
    const userMemories = (await memoryManager.getMemories(task.user_id)).map(m => m.content);
    const result = await agent.run(
      session.id,
      scheduledMessage,
      session.sandboxId,
      task.user_id,
      conversationHistory,
      userMemories,
      session.toolPreferences,
      session.approvalMode,
      getConfiguredWorkspaceConfig(userSettings.remoteWorkspace)
    );

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

    let resultMessageId: string | null = null;
    if (result.finalAnswer) {
      resultMessageId = crypto.randomUUID();
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
    const nextRun = computeNextRunForTask(task, completedAt);
    await taskRepository.update(task.id, {
      last_run_at: completedAt,
      next_run_at: nextRun,
      status: task.schedule_type === 'once' ? 'completed' : 'active',
    } as Partial<ScheduledTask>);

    await taskRepository.updateRun(run.id, {
      status: approvalBlocked ? 'needs_approval' : 'completed',
      completed_at: completedAt,
      result_message_id: resultMessageId,
      agent_steps: sanitizeAgentStepsForPersistence(result.steps),
    } as any);

    io.to(session.id).emit('agent-complete', { finalAnswer: result.finalAnswer });
    io.to(task.user_id).emit('task-run-completed', { taskId: task.id, runId: run.id, chatId: session.id });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await taskRepository.updateRun(run.id, { status: 'failed', completed_at: new Date(), error: errorMessage } as any);
    await taskRepository.update(task.id, { status: 'failed', last_run_at: new Date() } as Partial<ScheduledTask>);
    io.to(session.id).emit('error', { message: errorMessage });
    io.to(task.user_id).emit('task-run-failed', { taskId: task.id, runId: run.id, error: errorMessage });
  } finally {
    session.currentAgent = undefined;
    runningScheduledTaskIds.delete(task.id);
  }
}

let schedulerTimer: NodeJS.Timeout | null = null;
let schedulerRunning = false;
const runningScheduledTaskIds = new Set<string>();
type RunningAgentRunHandle =
  | {
      kind: 'react';
      agent: ReActAgent;
      session: ChatSession;
      run: AgentRun;
      sourceSocketChatId: string;
    }
  | {
      kind: 'ssh-v2';
      agent: SshAgentRunner;
      session: ChatSession;
      run: AgentRun;
      sourceSocketChatId: string;
      sessionId: string;
    };

const runningAgentRuns = new Map<string, RunningAgentRunHandle>();

function truncateForAgentContext(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  return `${content.slice(0, maxChars)}\n[truncated]`;
}

function summarizeStepForContext(step: AgentStep): string {
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

function getLatestReadActionIndexes(steps: AgentStep[]): Set<number> {
  const latestByPath = new Map<string, number>();

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

function summarizeStepsForSharedContext(steps: AgentStep[]): string[] {
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

function buildAgentLedger(session: ChatSession, activeRunId?: string): string {
  const runs = session.agentRuns.slice(-8);
  const lines: string[] = [];
  const files = new Map<string, string>();
  const reads = new Map<string, string>();
  const commands: string[] = [];
  const activeTerminals: string[] = [];

  for (const run of runs) {
    lines.push(`- ${run.id === activeRunId ? '[current] ' : ''}${run.title} (${run.status}) workspace=${run.workspaceRoot} model=${run.model || 'default'}`);
    for (const step of run.steps) {
      if (step.type === 'action' && step.actionName) {
        if (['write', 'edit', 'apply_patch'].includes(step.actionName)) {
          const filePath = String(step.actionArgs?.path || step.actionArgs?.filePath || '');
          if (filePath) files.set(filePath, `${step.actionName} in ${run.title}`);
        }
        if (step.actionName === 'read') {
          const filePath = String(step.actionArgs?.path || '');
          if (filePath) reads.set(filePath, `read in ${run.title}`);
        }
        if (step.actionName === 'bash') {
          const command = String(step.actionArgs?.command || '');
          if (command) commands.push(`${run.title}: ${truncateForAgentContext(command, 300)}`);
        }
      }
      if (step.type === 'observation' && step.content.includes('terminalId=')) {
        const terminalId = step.content.match(/terminalId=([A-Za-z0-9-]+)/)?.[1];
        if (terminalId) activeTerminals.push(`${terminalId} from ${run.title}`);
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

function buildSharedAgentContext(session: ChatSession, activeRunId?: string): string {
  const sections: string[] = [];
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

async function buildSharedAgentContextWithMemory(
  session: ChatSession,
  workspace: WorkspaceConfig,
  activeRunId?: string
): Promise<string> {
  const sections: string[] = [];
  const memoryPacket = await agentMemoryService.buildContextPacket({
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

async function compactSharedAgentContext(
  session: ChatSession,
  run: AgentRun,
  stateSteps: AgentStep[],
  model: string,
  tokenEstimate: number
): Promise<string> {
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

async function pollScheduledTasks(): Promise<void> {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const dueTasks = await taskRepository.findDue(5);
    for (const task of dueTasks) {
      await executeScheduledTask(task);
    }
  } catch (error) {
    console.error('Scheduled task poll failed:', error);
  } finally {
    schedulerRunning = false;
  }
}

function startTaskScheduler(): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    pollScheduledTasks().catch(console.error);
  }, 30000);
  pollScheduledTasks().catch(console.error);
}

async function startChatAgentRun(
  session: ChatSession,
  userId: string,
  request: CreateAgentRunRequest,
  model: string,
  language: string | undefined,
  sourceSocketChatId: string
): Promise<string> {
  const userSettings = await getUserSettings(userId);
  const workspace = getWorkspaceConfigForRoot(request.workspaceRoot, userSettings.remoteWorkspace);
  if (!workspace?.ssh?.enabled) {
    throw new Error('Remote workspace is not configured in Settings.');
  }

  const agentModel = userSettings.remoteWorkspace.agentModel || model;
  const agentPrompt = ensureCodingAgentSuccessContract(request.prompt);
  const now = new Date().toISOString();
  const run: AgentRun = {
    id: crypto.randomUUID(),
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
    id: crypto.randomUUID(),
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

  // Create the v2 agent_session row and seed it with the agent prompt as
  // the initial UserMessage + TextPart. The runner reads/writes everything
  // else via agentSessionRepository.
  const agentSession = await agentSessionRepository.createSession({
    chatId: session.id,
    agentRunId: run.id,
    directory: request.workspaceRoot,
    title: request.title,
    agent: 'ssh-agent',
    model: { providerID: 'llama', modelID: agentModel },
  });
  const initialUserMessageId: string = MessageID.ascending();
  const initialUserMessage: V2UserMessage = {
    id: initialUserMessageId,
    sessionID: agentSession.id,
    role: 'user',
    time: { created: Date.now() },
    agent: 'ssh-agent',
    model: { providerID: 'llama', modelID: agentModel },
  };
  await agentSessionRepository.upsertMessage(initialUserMessage);
  const initialUserPart: V2TextPart = {
    id: PartID.ascending(),
    sessionID: agentSession.id,
    messageID: initialUserMessageId,
    type: 'text',
    text: agentPrompt,
  };
  await agentSessionRepository.upsertPart(initialUserPart);

  const runner = new SshAgentRunner(
    llamaClient,
    agentSessionRepository,
    agentRunTaskRepository,
    {
      sessionId: agentSession.id,
      chatId: session.id,
      agentRunId: run.id,
      userId,
      sandboxId: session.sandboxId,
      agent: 'ssh-agent',
      workspace,
      agentPrompt,
      modelID: agentModel,
      providerID: 'llama',
      cwd: request.workspaceRoot,
      root: request.workspaceRoot,
      language,
      contextWindowTokens: userSettings.remoteWorkspace.contextWindowTokens,
      reservedOutputTokens: userSettings.remoteWorkspace.reservedOutputTokens,
      autoCompactThreshold: userSettings.remoteWorkspace.autoCompactThreshold,
    },
    {
      onPartsUpdated: (steps, finalAnswer) => {
        run.steps = steps;
        // Allow null to clear the bubble — intermediate narration lives in
        // the trace as a `thought` step, not the chat bubble.
        run.finalAnswer = finalAnswer;
        run.updatedAt = new Date().toISOString();
        io.to(sourceSocketChatId).emit('agent-run-updated', serializeAgentRun(run));
        scheduleChatSave(session);
      },
      onStep: () => {
        // onPartsUpdated already emits the full state. Step events here are
        // useful for the UI's per-step animation but we keep them silent for
        // now since the legacy ChatInterface listens to agent-run-updated.
      },
      onAssistantToken: () => {
        // No-op: streamed tokens are persisted as a TextPart at the end of
        // each iteration. The next emitProjection() decides whether they
        // belong in the trace (thought step) or the chat bubble (final
        // answer). Streaming directly into run.finalAnswer would poison the
        // bubble with intermediate narration that we then have to clear.
      },
      onTimings: (timings) => {
        io.to(sourceSocketChatId).emit('timings', timings);
      },
      onToolApprovalRequest: async (approvalRequest: ToolApprovalRequest) => {
        const latestSettings = await getUserSettings(userId);
        if (latestSettings.remoteWorkspace.toolApprovals?.[approvalRequest.toolName] === 'auto-approve') {
          return { approved: true, reason: 'approved' };
        }
        return await new Promise<ToolApprovalResponse>((resolve) => {
          pendingApprovals.set(approvalRequest.approvalId, {
            chatId: sourceSocketChatId,
            request: approvalRequest,
            resolve,
          });
          io.to(sourceSocketChatId).emit('tool-approval-required', { ...approvalRequest, chatId: sourceSocketChatId });
        });
      },
      onTasksUpdated: (chatId, agentRunId, tasks) => {
        io.to(sourceSocketChatId).emit('agent-tasks-updated', { chatId, agentRunId, tasks });
      },
      onAskUserQuestion: async (request) => {
        return await new Promise<{ answer: string | string[]; answered: boolean } | null>((resolve) => {
          const payload: PendingQuestionPayload = {
            chatId: sourceSocketChatId,
            agentRunId: run.id,
            questionId: request.questionId,
            question: request.question,
            options: request.options ?? [],
            multiple: Boolean(request.multiple),
            allowCustomAnswer: Boolean(request.allowCustomAnswer),
            timeoutMs: request.timeoutMs,
          };
          pendingQuestions.set(request.questionId, { payload, resolve });
          io.to(sourceSocketChatId).emit('agent-question-required', payload);
          if (request.timeoutMs && request.timeoutMs > 0) {
            setTimeout(() => {
              if (pendingQuestions.has(request.questionId)) {
                pendingQuestions.delete(request.questionId);
                resolve({ answer: '', answered: false });
                io.to(sourceSocketChatId).emit('agent-question-resolved', {
                  chatId: sourceSocketChatId,
                  agentRunId: run.id,
                  questionId: request.questionId,
                });
              }
            }, request.timeoutMs);
          }
        });
      },
      onComplete: (finalAnswer) => {
        // The aggregated answer from the projection is the source of truth.
        // Fall back to whatever onPartsUpdated set if the runner passes null.
        run.finalAnswer = finalAnswer ?? run.finalAnswer ?? null;
        run.status = run.status === 'cancelled' ? 'cancelled' : 'completed';
        run.updatedAt = new Date().toISOString();
        io.to(sourceSocketChatId).emit('agent-run-updated', serializeAgentRun(run));
        void flushScheduledChatSave(session).catch(console.error);
      },
      onError: (error) => {
        if (run.status !== 'cancelled') {
          run.status = 'failed';
          run.error = error;
        }
        run.updatedAt = new Date().toISOString();
        io.to(sourceSocketChatId).emit('agent-run-updated', serializeAgentRun(run));
        void flushScheduledChatSave(session).catch(console.error);
      },
    }
  );

  runningAgentRuns.set(run.id, {
    kind: 'ssh-v2',
    agent: runner,
    session,
    run,
    sourceSocketChatId,
    sessionId: agentSession.id,
  });

  void (async () => {
    try {
      await runner.run();
    } finally {
      runningAgentRuns.delete(run.id);
      clearPendingApprovalsForChat(sourceSocketChatId);
      clearPendingQuestionsForRun(run.id, true);
    }
  })();

  return run.id;
}

// Settings endpoint (UI settings only - server/searxng config comes from environment variables)
app.get('/api/settings', protect, async (req: AuthRequest, res) => {
  const userId = req.user!.id;
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

app.post('/api/settings', protect, async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const userSettings = await getUserSettings(userId);
  const { ui, remoteWorkspace } = req.body;

  if (ui) {
    const nextUi = { ...userSettings.ui, ...ui };
    nextUi.defaultToolPreferences = normalizeToolPreferences(
      nextUi.defaultToolPreferences,
      nextUi.defaultToolPreferences
    );
    await settingsRepository.setUiSettings(nextUi, userId);
    userSettings.ui = nextUi;
  }

  if (remoteWorkspace !== undefined) {
    const nextRemoteWorkspace = normalizeRemoteWorkspaceSettings({
      ...remoteWorkspace,
      privateKey: remoteWorkspace.privateKey === ''
        ? userSettings.remoteWorkspace.privateKey
        : remoteWorkspace.privateKey,
    });
    await settingsRepository.setRemoteWorkspace(nextRemoteWorkspace, userId);
  }

  res.json({ success: true });
});

// Scheduled task endpoints
app.get('/api/tasks', protect, async (req: AuthRequest, res) => {
  const tasks = await taskRepository.findByUserId(req.user!.id);
  res.json(tasks.map(serializeTask));
});

app.get('/api/agents', protect, (req: AuthRequest, res) => {
  const userId = req.user!.id;
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

app.post('/api/tasks', protect, async (req: AuthRequest, res) => {
  const {
    title,
    prompt,
    scheduleType,
    runAt,
    intervalMinutes,
    daysOfWeek,
    timeOfDay,
    timezone,
    chatId,
    model,
    toolPreferences,
    approvalMode,
    reasoningEffort,
  } = req.body;

  if (!title || !prompt || !scheduleType) {
    return res.status(400).json({ error: 'title, prompt, and scheduleType are required' });
  }

  if (!['once', 'daily', 'weekdays', 'weekly', 'interval'].includes(scheduleType)) {
    return res.status(400).json({ error: 'Invalid scheduleType' });
  }

  const normalizedDaysOfWeek = normalizeDaysOfWeek(daysOfWeek);
  const nextRunAt = computeNextRun({
    scheduleType,
    runAt,
    intervalMinutes,
    daysOfWeek: normalizedDaysOfWeek,
    timeOfDay,
  });

  if (!nextRunAt) {
    return res.status(400).json({ error: 'Schedule does not produce a future run time' });
  }

  let session: ChatSession | undefined;
  if (chatId) {
    const existingSession = chatSessions.get(chatId);
    if (!existingSession || existingSession.userId !== req.user!.id) {
      return res.status(404).json({ error: 'Chat not found' });
    }
    session = existingSession;
  }

  const task = await taskRepository.create({
    userId: req.user!.id,
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

  io.to(req.user!.id).emit('task-created', serializeTask(task));
  res.status(201).json(serializeTask(task));
});

app.patch('/api/tasks/:taskId', protect, async (req: AuthRequest, res) => {
  const task = await taskRepository.findById(req.params.taskId);
  if (!task || task.user_id !== req.user!.id) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const nextShape = {
    scheduleType: req.body.scheduleType || task.schedule_type,
    runAt: req.body.runAt !== undefined ? req.body.runAt : task.run_at,
    intervalMinutes: req.body.intervalMinutes !== undefined ? req.body.intervalMinutes : task.interval_minutes,
    daysOfWeek: req.body.daysOfWeek !== undefined ? normalizeDaysOfWeek(req.body.daysOfWeek) : task.days_of_week,
    timeOfDay: req.body.timeOfDay !== undefined ? req.body.timeOfDay : task.time_of_day,
  };
  const nextRunAt = req.body.status === 'paused' || req.body.status === 'cancelled'
    ? null
    : computeNextRun(nextShape as any);

  const updated = await taskRepository.update(task.id, {
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
  } as Partial<ScheduledTask>);

  if (!updated) {
    return res.status(404).json({ error: 'Task not found' });
  }
  io.to(req.user!.id).emit('task-updated', serializeTask(updated));
  res.json(serializeTask(updated));
});

app.delete('/api/tasks/:taskId', protect, async (req: AuthRequest, res) => {
  const deleted = await taskRepository.delete(req.params.taskId, req.user!.id);
  if (!deleted) {
    return res.status(404).json({ error: 'Task not found' });
  }
  io.to(req.user!.id).emit('task-deleted', { taskId: req.params.taskId });
  res.json({ success: true });
});

app.get('/api/tasks/:taskId/runs', protect, async (req: AuthRequest, res) => {
  const task = await taskRepository.findById(req.params.taskId);
  if (!task || task.user_id !== req.user!.id) {
    return res.status(404).json({ error: 'Task not found' });
  }
  res.json(await taskRepository.findRunsByTaskId(task.id));
});

app.post('/api/tasks/:taskId/run-now', protect, async (req: AuthRequest, res) => {
  const task = await taskRepository.findById(req.params.taskId);
  if (!task || task.user_id !== req.user!.id) {
    return res.status(404).json({ error: 'Task not found' });
  }
  executeScheduledTask(task, true).catch((error) => console.error('Manual task run failed:', error));
  res.json({ success: true });
});

app.post('/api/tasks/:taskId/pause', protect, async (req: AuthRequest, res) => {
  const task = await taskRepository.findById(req.params.taskId);
  if (!task || task.user_id !== req.user!.id) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const updated = await taskRepository.update(task.id, { status: 'paused', next_run_at: null } as Partial<ScheduledTask>);
  res.json(serializeTask(updated!));
});

app.post('/api/tasks/:taskId/resume', protect, async (req: AuthRequest, res) => {
  const task = await taskRepository.findById(req.params.taskId);
  if (!task || task.user_id !== req.user!.id) {
    return res.status(404).json({ error: 'Task not found' });
  }
  const nextRun = computeNextRunForTask(task);
  const updated = await taskRepository.update(task.id, { status: 'active', next_run_at: nextRun } as Partial<ScheduledTask>);
  res.json(serializeTask(updated!));
});

// Create new chat
app.post('/api/chat', protect, (req: AuthRequest, res) => {
  const chatId = crypto.randomUUID();
  const sandbox = sandboxManager.createSandbox();
  const now = new Date().toISOString();
  const userId = req.user!.id;
  const { toolPreferences } = req.body ?? {};

  const session: ChatSession = {
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
app.get('/api/chat', protect, (req: AuthRequest, res) => {
  const userId = req.user!.id;
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
app.get('/api/chat/search', protect, (req: AuthRequest, res) => {
  const { query } = req.query;
  const userId = req.user!.id;
  
  if (!query || typeof query !== 'string' || query.trim() === '') {
    return res.json([]);
  }
  
  const searchTerm = query.toLowerCase().trim();
  const results: Array<{
    chatId: string;
    sandboxId: string;
    name: string;
    updatedAt: string;
    matchCount: number;
    matchingMessages: Array<{
      id: string;
      role: 'user' | 'assistant';
      content: string;
      snippet: string;
      messageIndex: number;
    }>;
  }> = [];
  
  const MAX_SNIPPETS_PER_CHAT = 5;
  const SNIPPET_CONTEXT = 50; // characters before/after match
  
  for (const [chatId, session] of chatSessions.entries()) {
    if (session.userId !== userId) continue;

    const matchingMessages: Array<{
      id: string;
      role: 'user' | 'assistant';
      content: string;
      snippet: string;
      messageIndex: number;
    }> = [];
    
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
        if (start > 0) snippet = '...' + snippet;
        if (end < msg.content.length) snippet = snippet + '...';
        
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
app.delete('/api/chat/:chatId', protect, (req: AuthRequest, res) => {
  const { chatId } = req.params;
  const userId = req.user!.id;
  const session = chatSessions.get(chatId);

  if (session && session.userId === userId) {
    sandboxManager.deleteSandbox(session.sandboxId);
    chatSessions.delete(chatId);
    saveChats();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Chat not found' });
  }
});

// Update chat name
app.post('/api/chat/:chatId/name', protect, (req: AuthRequest, res) => {
  const { chatId } = req.params;
  const { name } = req.body;
  const userId = req.user!.id;
  const session = chatSessions.get(chatId);

  if (session && session.userId === userId) {
    session.name = name;
    session.updatedAt = new Date().toISOString();
    saveChats();
    res.json({ success: true, name });
  } else {
    res.status(404).json({ error: 'Chat not found' });
  }
});

// Get chat messages
app.get('/api/chat/:chatId/messages', protect, (req: AuthRequest, res) => {
  const { chatId } = req.params;
  const userId = req.user!.id;
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
app.patch('/api/chat/:chatId/messages/:messageIndex', protect, (req: AuthRequest, res) => {
  const { chatId, messageIndex } = req.params;
  const { content } = req.body;
  const userId = req.user!.id;
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
app.post('/api/chat/:chatId/retry-from/:messageIndex', protect, (req: AuthRequest, res) => {
  const { chatId, messageIndex } = req.params;
  const userId = req.user!.id;
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
app.get('/api/sandbox/:sandboxId/files', protect, (req: AuthRequest, res) => {
  const { sandboxId } = req.params;
  const { path: filePath } = req.query;
  const userId = req.user!.id;

  // Find chat associated with this sandbox to check ownership
  const session = Array.from(chatSessions.values()).find(s => s.sandboxId === sandboxId);
  if (!session || session.userId !== userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const files = sandboxManager.listFilesWithProtection(sandboxId, filePath as string);
    res.json(files);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.get('/api/sandbox/:sandboxId/files/:filePath', protect, (req: AuthRequest, res) => {
  const { sandboxId, filePath } = req.params;
  const userId = req.user!.id;

  const session = Array.from(chatSessions.values()).find(s => s.sandboxId === sandboxId);
  if (!session || session.userId !== userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const content = sandboxManager.readFile(sandboxId, decodeURIComponent(filePath));
    res.json({ content });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.post('/api/sandbox/:sandboxId/files', protect, (req: AuthRequest, res) => {
  const { sandboxId } = req.params;
  const { path: filePath, content } = req.body;
  const userId = req.user!.id;

  const session = Array.from(chatSessions.values()).find(s => s.sandboxId === sandboxId);
  if (!session || session.userId !== userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    sandboxManager.writeFile(sandboxId, filePath, content);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.delete('/api/sandbox/:sandboxId/files/:filePath', protect, (req: AuthRequest, res) => {
  const { sandboxId, filePath } = req.params;
  const userId = req.user!.id;

  const session = Array.from(chatSessions.values()).find(s => s.sandboxId === sandboxId);
  if (!session || session.userId !== userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    sandboxManager.deleteFile(sandboxId, decodeURIComponent(filePath));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Remote SSH workspace browser
app.get('/api/remote-workspace/files', protect, async (req: AuthRequest, res) => {
  const { path: filePath } = req.query;
  const userSettings = await getUserSettings(req.user!.id);
  const workspace = getConfiguredWorkspaceConfig(userSettings.remoteWorkspace);
  if (!workspace?.ssh?.enabled) {
    return res.status(400).json({ error: 'Remote workspace is not configured in Settings.' });
  }

  try {
    const runtime = workspaceRuntimeFactory.createRemote(workspace);
    const relativePath = normalizeRemoteBrowserPath(filePath);
    const target = remoteBrowserAbsolutePath(workspace, relativePath);
    const root = workspace.ssh!.root;
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
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.get('/api/remote-workspace/file', protect, async (req: AuthRequest, res) => {
  const { path: filePath } = req.query;
  const userSettings = await getUserSettings(req.user!.id);
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
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.get('/api/remote-workspace/files/:filePath', protect, async (req: AuthRequest, res) => {
  const { filePath } = req.params;
  const { offset, limit } = req.query;
  const userSettings = await getUserSettings(req.user!.id);
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
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.post('/api/remote-workspace/files', protect, async (req: AuthRequest, res) => {
  const { path: filePath, content } = req.body;
  const userSettings = await getUserSettings(req.user!.id);
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
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// File download endpoint
app.get('/api/sandbox/:sandboxId/download/:filePath', protect, (req: AuthRequest, res) => {
  const { sandboxId, filePath } = req.params;
  const userId = req.user!.id;

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
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// File upload endpoint
app.post('/api/sandbox/:sandboxId/upload', protect, upload.single('file'), (req: AuthRequest, res) => {
  const { sandboxId } = req.params;
  const userId = req.user!.id;

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
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// WebSocket handling for real-time agent updates
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Simple token auth for socket.io
  let currentUserId: string | null = null;

  socket.on('authenticate', (data: { token: string }) => {
    try {
      const decoded: any = jwt.verify(data.token, JWT_SECRET);
      currentUserId = decoded.id;
      socket.join(currentUserId!);
      socket.emit('authenticated');
      console.log(`Socket ${socket.id} authenticated as user ${currentUserId}`);
    } catch (error) {
      socket.emit('error', { message: 'Authentication failed' });
      socket.disconnect();
    }
  });

  socket.on('join-chat', (chatId: string) => {
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

    // Re-emit any pending agent question for this chat so the dialog survives
    // a page reload or temporary disconnect. The backend kept the resolver
    // alive on the pendingQuestions map; the client just needs the payload.
    for (const pending of pendingQuestions.values()) {
      if (pending.payload.chatId !== chatId) continue;
      socket.emit('agent-question-required', pending.payload);
      console.log(`Re-emitting pending question ${pending.payload.questionId} to socket ${socket.id} for chat ${chatId}`);
    }

    socket.emit('agent-runs', session.agentRuns.map(serializeAgentRun));

    void (async () => {
      for (const run of session.agentRuns) {
        try {
          const tasks = await agentRunTaskRepository.listByRun(chatId, run.id);
          if (tasks.length > 0) {
            socket.emit('agent-tasks-updated', { chatId, agentRunId: run.id, tasks });
          }
        } catch (error) {
          console.error(`Failed to load tasks for agent run ${run.id}:`, error);
        }
      }
    })();
  });

  socket.on('send-message', async (data: {
    chatId: string;
    message: string;
    model?: string;
    toolPreferences?: Record<string, ChatToolPreference>;
    approvalMode?: {
      alwaysApprove: boolean;
    };
    language?: string;
    reasoningEffort?: 'low' | 'medium' | 'high';
  }) => {
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
    session.toolPreferences = normalizeToolPreferences(
      toolPreferences ?? session.toolPreferences,
      userSettings.ui.defaultToolPreferences
    );
    session.approvalMode = {
      alwaysApprove: approvalMode?.alwaysApprove ?? session.approvalMode?.alwaysApprove ?? false,
    };
    const responseModel = model || userSettings.ui.selectedModel || llamaConfig.model;

    // Map reasoning effort to maxIterations
    const maxIterationsMap: Record<string, number> = {
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
    session.messages.push({ id: crypto.randomUUID(), role: 'user', content: message, agentSteps: [] });
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
      const dbPersonality = await personalityRepository.findById(selectedPersonalityId);
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
    const agent = new ReActAgent(llamaClient, toolRegistry, maxIterations, {
      onStep: (step: AgentStep) => {
        io.to(chatId).emit('agent-step', {
          type: step.type,
          content: step.content,
          actionName: step.actionName,
          actionArgs: step.actionArgs,
        });
      },
      onFinalAnswerToken: (token: string) => {
        io.to(chatId).emit('final-answer-token', { token, model: responseModel });
      },
      onReasoningToken: (token: string) => {
        io.to(chatId).emit('thought-token', token);
      },
      onDebugInfo: (rawContent: string, parsed: any) => {
        console.log('EMITTING DEBUG INFO:', { rawContent: rawContent.substring(0, 100), parsed });
        io.to(chatId).emit('debug-info', { rawContent, parsed });
      },
      onTimings: (timings: ChatTimings) => {
        console.log('EMITTING TIMINGS:', timings);
        io.to(chatId).emit('timings', timings);
      },
      onError: (error: string) => {
        io.to(chatId).emit('error', { message: error });
      },
      onCancelled: () => {
        console.log(`Agent cancelled for chat ${chatId}`);
        io.to(chatId).emit('agent-cancelled');
      },
      onToolApprovalRequest: async (request: ToolApprovalRequest) => {
        return await new Promise<ToolApprovalResponse>((resolve) => {
          pendingApprovals.set(request.approvalId, { chatId, request, resolve });
          io.to(chatId).emit('tool-approval-required', { ...request, chatId });
        });
      },
      onCreateAgentRun: async (request: CreateAgentRunRequest) => {
        return startChatAgentRun(session, currentUserId!, request, responseModel || llamaConfig.model || '', language, chatId);
      },
      onStepSave: (savedChatId: string, step: AgentStep, allSteps: AgentStep[]) => {
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
      onPartialFinalAnswer: (partialChatId: string, partialContent: string) => {
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
      const result = await agent.run(
        chatId,
        message,
        session.sandboxId,
        currentUserId,
        conversationHistory,
        userMemories,
        session.toolPreferences,
        session.approvalMode,
        getConfiguredWorkspaceConfig(userSettings.remoteWorkspace)
      );

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
          id: crypto.randomUUID(),
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
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.log(`Agent error for chat ${chatId}:`, errorMessage);
      io.to(chatId).emit('error', { message: errorMessage });
    } finally {
      clearPendingApprovalsForChat(chatId);
      // Clear the agent reference when done
      session.currentAgent = undefined;
    }
  });

  socket.on('tool-approval-response', (data: {
    chatId: string;
    approvalId: string;
    approved: boolean;
    reason?: ToolApprovalResponse['reason'];
    rememberAutoApprove?: boolean;
    toolName?: string;
  }) => {
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
  socket.on('stop-agent', (chatId: string) => {
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
        clearPendingQuestionsForRun(runId, true);
        scheduleChatSave(running.session, 0);
        stopped = true;
      }

      clearPendingApprovalsForChat(chatId);
      if (stopped) {
        io.to(chatId).emit('agent-cancelled');
      } else {
        console.log(`No active agent found for chat ${chatId}`);
      }
    } else {
      console.log(`No active agent found for chat ${chatId} or unauthorized`);
    }
  });

  socket.on('agent-user-message', (data: { chatId: string; runId: string; message: string }) => {
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

    // A free-form steering message implicitly cancels any pending question for this run
    // (the spec: "if the user reply instead to the agent the questions are ignored").
    clearPendingQuestionsForRun(runId, true);

    const accepted = running.agent.addUserMessage(message);
    if (!accepted) {
      socket.emit('error', { message: 'Agent message was empty' });
      return;
    }

    running.run.updatedAt = new Date().toISOString();
    io.to(running.sourceSocketChatId).emit('agent-run-updated', serializeAgentRun(running.run));
    scheduleChatSave(running.session, 0);
  });

  socket.on('agent-question-response', (data: {
    chatId: string;
    agentRunId: string;
    questionId: string;
    answer: string | string[];
  }) => {
    if (!currentUserId) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }
    const chatId = String(data?.chatId || '').trim();
    const agentRunId = String(data?.agentRunId || '').trim();
    const questionId = String(data?.questionId || '').trim();
    if (!chatId || !agentRunId || !questionId) {
      socket.emit('error', { message: 'chatId, agentRunId, and questionId are required' });
      return;
    }
    const pending = pendingQuestions.get(questionId);
    if (!pending || pending.payload.chatId !== chatId || pending.payload.agentRunId !== agentRunId) {
      socket.emit('error', { message: 'Pending question not found' });
      return;
    }
    pendingQuestions.delete(questionId);
    pending.resolve({
      answer: Array.isArray(data.answer) ? data.answer : String(data.answer ?? ''),
      answered: true,
    });
    io.to(chatId).emit('agent-question-resolved', { chatId, agentRunId, questionId });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Static serving for screenshots and tool overflow files written under /tmp/operatorchat
// by the SSH agent's `browser` tool and outputCap. Filenames are restricted to a safe
// charset so a compromised tool result can't escape the directory. Auth comes either from
// the standard Authorization header or a `?token=` query param so <img> tags work.
app.get('/api/agent-attachments/:filename', (req, res) => {
  const headerToken = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
  const token = headerToken || queryToken;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const filename = String(req.params.filename || '');
  if (!/^[A-Za-z0-9_.-]+$/.test(filename) || filename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const root = '/tmp/operatorchat';
  const fullPath = path.resolve(root, filename);
  if (!fullPath.startsWith(`${root}/`)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  fs.stat(fullPath, (err) => {
    if (err) return res.status(404).json({ error: 'Not found' });
    res.sendFile(fullPath);
  });
});

// Get available models
app.get('/api/models', async (req, res) => {
  try {
    const models = await llamaClient.getModels();
    // Ensure we return an array
    if (Array.isArray(models) && models.length > 0) {
      res.json(models);
    } else {
      // Fallback to current model if no models returned
      res.json([llamaConfig.model]);
    }
  } catch (error) {
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
function loadBuiltInPersonalities(): ChatPersonality[] {
  try {
    const personalitiesPath = path.join(__dirname, '../personalities.json');
    if (fs.existsSync(personalitiesPath)) {
      const data = fs.readFileSync(personalitiesPath, 'utf-8');
      const personalities = JSON.parse(data);
      return personalities.map((p: any) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        tone: p.tone,
        systemPrompt: p.systemPrompt,
        isCustom: false,
      }));
    }
  } catch (error) {
    console.error('Error loading built-in personalities:', error);
  }
  return [];
}

// Personality endpoints - Get all personalities
app.get('/api/personalities', protect, async (req: AuthRequest, res) => {
  // Load built-in personalities from JSON file
  const builtInPersonalities = loadBuiltInPersonalities();
  res.json(builtInPersonalities);
});

// Get only custom personalities
app.get('/api/personalities/custom', protect, async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const custom = await personalityRepository.findCustomByUserId(userId);
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
app.post('/api/personalities/custom', protect, async (req: AuthRequest, res) => {
  const { name, description, tone, systemPrompt } = req.body;
  const userId = req.user!.id;
  
  if (!name || !description || !tone || !systemPrompt) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  
  const newPersonality = await personalityRepository.create({
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
app.put('/api/personalities/custom/:id', protect, async (req: AuthRequest, res) => {
  const { id } = req.params;
  const { name, description, tone, systemPrompt } = req.body;
  const userId = req.user!.id;
  
  const updatedPersonality = await personalityRepository.update(id, userId, {
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
app.delete('/api/personalities/custom/:id', protect, async (req: AuthRequest, res) => {
  const { id } = req.params;
  const userId = req.user!.id;
  
  const deleted = await personalityRepository.delete(id, userId);
  
  if (!deleted) {
    return res.status(404).json({ error: 'Personality not found or is not deletable' });
  }
  
  // If this was the selected personality, reset to professional
  const userSettings = await getUserSettings(userId);
  if (userSettings.ui.selectedPersonality === id) {
    userSettings.ui.selectedPersonality = 'professional';
    await settingsRepository.setUiSettings(userSettings.ui, userId);
  }
  
  res.json({ success: true });
});

// Memory management endpoints
app.get('/api/memories', protect, async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const memories = await memoryManager.getMemories(userId);
  res.json(memories);
});

app.post('/api/memories', protect, async (req: AuthRequest, res) => {
  const { content, tags } = req.body;
  const userId = req.user!.id;

  if (!content) {
    return res.status(400).json({ error: 'Content is required' });
  }

  const memory = await memoryManager.addMemory(userId, content, tags);
  res.status(201).json(memory);
});

app.delete('/api/memories/:id', protect, async (req: AuthRequest, res) => {
  const { id } = req.params;
  const userId = req.user!.id;

  const success = await memoryManager.deleteMemory(id, userId);
  if (success) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Memory not found' });
  }
});

// MCP Server Management Endpoints
app.get('/api/mcp/servers', protect, (req: AuthRequest, res) => {
  const statuses = mcpClientManager.getServerStatuses();
  res.json(statuses);
});

// Known MCP servers - mapping server name to npm package
const KNOWN_MCP_SERVERS: Record<string, { packageName: string; envVar?: string }> = {
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

app.post('/api/mcp/servers', protect, async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const { name, url, apiKey, transportType } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: 'Server name is required' });
  }

  if (!url) {
    return res.status(400).json({ error: 'Server URL is required' });
  }

  const config: MCPServerConfig = {
    url,
    apiKey,
    transportType: transportType || 'sse',
    enabled: true,
  };

  try {
    await mcpClientManager.addServer(name, config);
    
    // Save to settings
    const currentSettings = await settingsRepository.getMcpServers(userId);
    currentSettings[name] = config;
    await settingsRepository.setMcpServers(currentSettings, userId);
    
    res.json({ success: true, message: `MCP server '${name}' added successfully` });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: `Failed to add MCP server: ${errorMessage}` });
  }
});

app.delete('/api/mcp/servers/:name', protect, async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const { name } = req.params;

  try {
    await mcpClientManager.removeServer(name);
    
    // Remove from settings
    const currentSettings = await settingsRepository.getMcpServers(userId);
    delete currentSettings[name];
    await settingsRepository.setMcpServers(currentSettings, userId);
    
    res.json({ success: true, message: `MCP server '${name}' removed successfully` });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: `Failed to remove MCP server: ${errorMessage}` });
  }
});

app.post('/api/mcp/servers/:name/reconnect', protect, async (req: AuthRequest, res) => {
  const { name } = req.params;

  try {
    await mcpClientManager.reconnectServer(name);
    res.json({ success: true, message: `MCP server '${name}' reconnected successfully` });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: `Failed to reconnect MCP server: ${errorMessage}` });
  }
});

app.get('/api/mcp/tools', protect, (req: AuthRequest, res) => {
  const tools = mcpClientManager.getTools();
  res.json(tools);
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Generic error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
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

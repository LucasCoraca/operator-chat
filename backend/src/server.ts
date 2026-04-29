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
import { ReActAgent, AgentStep, ToolApprovalRequest, ToolApprovalResponse } from './agent/ReActAgent';
import { protect, registerUser, loginUser, getMe, AuthRequest } from './auth';
import { initializeDatabase, testConnection } from './db';
import { chatRepository, personalityRepository, settingsRepository, taskRepository, ScheduledTask } from './repositories';
import { computeNextRun, computeNextRunForTask, normalizeDaysOfWeek } from './services/schedule';

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

interface UISettings {
  showStats: boolean;
  selectedPersonality: string;
  selectedModel?: string;
  defaultToolPreferences?: Record<string, ChatToolPreference>;
}

interface MCPServersConfig {
  [serverName: string]: MCPServerConfig;
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
};

// Settings will be loaded asynchronously
let loadedSettings = defaultSettings;

// Global state
const sandboxManager = new SandboxManager();
const memoryManager = new MemoryManager();
let searxngConfig: SearXNGConfig = loadedSettings.searxng;
let llamaConfig: LlamaConfig = loadedSettings.llama;

// Initialize clients
let searxngClient = new SearXNGClient(searxngConfig);
let llamaClient = new LlamaClient(llamaConfig);

// Initialize MCP Client Manager
const mcpClientManager = new MCPClientManager();

// Initialize Tool Registry with MCP support
let toolRegistry = new ToolRegistry(searxngClient, sandboxManager, memoryManager, mcpClientManager);

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

    // Load UI and MCP settings from database (llama/searxng come from env vars)
    const uiSettings = await settingsRepository.getUiSettings();
    const mcpServersSettings = await settingsRepository.getMcpServers();

    loadedSettings = {
      ...defaultSettings,
      ui: uiSettings || defaultSettings.ui,
      mcpServers: mcpServersSettings || defaultSettings.mcpServers,
    };
    loadedSettings.ui.defaultToolPreferences = toolRegistry.mergeWithDefaultPreferences(
      loadedSettings.ui.defaultToolPreferences
    );

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
  preferences?: Record<string, ChatToolPreference>
): Record<string, ChatToolPreference> {
  return toolRegistry.mergeWithDefaultPreferences(
    preferences,
    loadedSettings.ui.defaultToolPreferences
  );
}

// Chat sessions: Map<chatId, { sandboxId, messages, name }>
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  agentSteps?: AgentStep[];
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
  currentAgent?: ReActAgent; // Track the current running agent
}
const chatSessions = new Map<string, ChatSession>();

interface PendingApproval {
  chatId: string;
  request: ToolApprovalRequest;
  resolve: (response: ToolApprovalResponse) => void;
}

const pendingApprovals = new Map<string, PendingApproval>();
type ToolApprovalRequestPayload = ToolApprovalRequest & { chatId: string };

const MAX_PERSISTED_STEP_CONTENT_CHARS = 20000;
const MAX_PERSISTED_PARTIAL_ANSWER_CHARS = 100000;

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
        const session: ChatSession = {
          id: persistedChat.id,
          userId: persistedChat.user_id,
          sandboxId: persistedChat.sandbox_id,
          messages: messages.map((msg, idx) => ({
            id: msg.id,
            role: msg.role,
            content: msg.content,
            model: msg.model || undefined,
            agentSteps: sanitizeAgentStepsForPersistence(msg.agent_steps),
          })),
          name: persistedChat.name,
          createdAt: persistedChat.created_at.toISOString(),
          updatedAt: persistedChat.updated_at.toISOString(),
          agentState: sanitizeAgentStateForPersistence(persistedChat.agent_state),
          toolPreferences: persistedChat.tool_preferences || {},
          approvalMode: persistedChat.approval_mode || { alwaysApprove: false },
        };
        const sessionChanged = normalizeChatSession(session);
        chatSessions.set(persistedChat.id, session);
        if (sessionChanged) {
          await saveChat(session);
        }
      }
    }
  } catch (error) {
    console.error('Error loading chats:', error);
  }
}

// Save chat to database
async function saveChat(session: ChatSession): Promise<void> {
  try {
    // Update or create chat
    const existingChat = await chatRepository.findById(session.id);
    if (existingChat) {
      await chatRepository.update(session.id, {
        name: session.name,
        agent_state: sanitizeAgentStateForPersistence(session.agentState),
        tool_preferences: session.toolPreferences,
        approval_mode: session.approvalMode,
      });
    } else {
      await chatRepository.create({
        id: session.id,
        userId: session.userId,
        sandboxId: session.sandboxId,
        name: session.name,
        toolPreferences: session.toolPreferences,
        approvalMode: session.approvalMode,
      });
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

async function getSelectedPersonality(): Promise<ChatPersonality | null> {
  const selectedPersonalityId = loadedSettings.ui.selectedPersonality;
  if (!selectedPersonalityId) return null;

  const dbPersonality = await personalityRepository.findById(selectedPersonalityId);
  if (!dbPersonality) return null;

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

  const responseModel = task.model || loadedSettings.ui.selectedModel || llamaConfig.model;
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

  session.toolPreferences = normalizeToolPreferences(task.tool_preferences || session.toolPreferences);
  session.approvalMode = task.approval_mode || { alwaysApprove: false };
  session.messages.push({ id: crypto.randomUUID(), role: 'user', content: scheduledMessage, agentSteps: [] });
  session.updatedAt = new Date().toISOString();
  io.to(session.id).emit('message', { role: 'user', content: scheduledMessage });
  emitChatUpdated(session);

  const conversationHistory = session.messages
    .filter((msg, idx) => idx < session!.messages.length - 1)
    .map((msg) => ({ role: msg.role, content: msg.content }));

  const selectedPersonality = await getSelectedPersonality();
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
      session.approvalMode
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

// Settings endpoint (UI settings only - server/searxng config comes from environment variables)
app.get('/api/settings', (req, res) => {
  res.json({
    ui: {
      showStats: loadedSettings.ui.showStats,
      selectedPersonality: loadedSettings.ui.selectedPersonality,
      selectedModel: loadedSettings.ui.selectedModel,
      defaultToolPreferences: normalizeToolPreferences(loadedSettings.ui.defaultToolPreferences),
    },
  });
});

app.post('/api/settings', async (req, res) => {
  const { ui } = req.body;

  if (ui) {
    loadedSettings.ui = { ...loadedSettings.ui, ...ui };
    loadedSettings.ui.defaultToolPreferences = normalizeToolPreferences(
      loadedSettings.ui.defaultToolPreferences
    );
    await settingsRepository.setUiSettings(loadedSettings.ui);
  }

  res.json({ success: true });
});

// Scheduled task endpoints
app.get('/api/tasks', protect, async (req: AuthRequest, res) => {
  const tasks = await taskRepository.findByUserId(req.user!.id);
  res.json(tasks.map(serializeTask));
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

    session.toolPreferences = normalizeToolPreferences(toolPreferences ?? session.toolPreferences);
    session.approvalMode = {
      alwaysApprove: approvalMode?.alwaysApprove ?? session.approvalMode?.alwaysApprove ?? false,
    };
    const responseModel = model || llamaConfig.model;

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

    // Build conversation history (excluding thoughts) - user/assistant pairs
    const conversationHistory = session.messages
      .filter((msg, idx) => idx < session.messages.length - 1) // Exclude current message
      .map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

    // Get the selected personality from database
    const selectedPersonalityId = loadedSettings.ui.selectedPersonality;
    let selectedPersonality = null;
    if (selectedPersonalityId) {
      const dbPersonality = await personalityRepository.findById(selectedPersonalityId);
      if (dbPersonality) {
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
        session.approvalMode
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
    
    if (session && session.userId === currentUserId && session.currentAgent) {
      console.log(`Stopping agent for chat ${chatId}`);
      session.currentAgent.cancel();
      session.currentAgent = undefined;
      clearPendingApprovalsForChat(chatId);
      io.to(chatId).emit('agent-cancelled');
    } else {
      console.log(`No active agent found for chat ${chatId} or unauthorized`);
    }
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
  res.json(toolRegistry.getTools());
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
  if (loadedSettings.ui.selectedPersonality === id) {
    loadedSettings.ui.selectedPersonality = 'professional';
    await settingsRepository.setUiSettings(loadedSettings.ui);
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
    const currentSettings = await settingsRepository.getMcpServers();
    currentSettings[name] = config;
    await settingsRepository.setMcpServers(currentSettings);
    loadedSettings.mcpServers = currentSettings;
    
    res.json({ success: true, message: `MCP server '${name}' added successfully` });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: `Failed to add MCP server: ${errorMessage}` });
  }
});

app.delete('/api/mcp/servers/:name', protect, async (req: AuthRequest, res) => {
  const { name } = req.params;

  try {
    await mcpClientManager.removeServer(name);
    
    // Remove from settings
    const currentSettings = await settingsRepository.getMcpServers();
    delete currentSettings[name];
    await settingsRepository.setMcpServers(currentSettings);
    loadedSettings.mcpServers = currentSettings;
    
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

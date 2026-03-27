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
import { chatRepository, personalityRepository, settingsRepository } from './repositories';

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

    // Load MCP servers
    await loadMCPServers();

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
  return toolRegistry.mergeWithDefaultPreferences(preferences);
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

// Load chats from database on startup
async function loadChats(): Promise<void> {
  try {
    const chatSummaries = await chatRepository.findByUserId('legacy-user');
    console.log(`Loaded ${chatSummaries.length} legacy chats from database`);
    
    for (const summary of chatSummaries) {
      const result = await chatRepository.getWithMessages(summary.id);
      if (result) {
        const { chat, messages } = result;
        const session: ChatSession = {
          id: chat.id,
          userId: chat.user_id,
          sandboxId: chat.sandbox_id,
          messages: messages.map((msg, idx) => ({
            id: msg.id,
            role: msg.role,
            content: msg.content,
            model: msg.model || undefined,
            agentSteps: msg.agent_steps || [],
          })),
          name: chat.name,
          createdAt: chat.created_at.toISOString(),
          updatedAt: chat.updated_at.toISOString(),
          agentState: chat.agent_state,
          toolPreferences: chat.tool_preferences || {},
          approvalMode: chat.approval_mode || { alwaysApprove: false },
        };
        normalizeChatSession(session);
        chatSessions.set(chat.id, session);
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
        agent_state: session.agentState,
        tool_preferences: session.toolPreferences,
        approval_mode: session.approvalMode,
      });
    } else {
      await chatRepository.create({
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
          agent_steps: msg.agentSteps,
        });
      } else {
        await chatRepository.addMessage({
          chatId: session.id,
          role: msg.role,
          content: msg.content,
          model: msg.model,
          agentSteps: msg.agentSteps,
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

// Load chats on startup
loadChats().catch(console.error);

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

// Generate a conversation name using LLM
async function generateConversationName(firstMessage: string, model?: string): Promise<string> {
  try {
    const prompt = `Create a short title (max 50 chars) for this conversation. Output only the title text.

Message: ${firstMessage.substring(0, 300)}`;

    const response = await llamaClient.chat(
      [
        { role: 'system', content: 'You generate conversation titles. Output only the title, no explanations or reasoning.' },
        { role: 'user', content: prompt }
      ],
      { temperature: 0.3, maxTokens: 100, excludeReasoning: true, model }
    );

    // Extract just the title - look for the first line of actual content
    let title = response.content?.trim() || '';
    
    // Remove common prefixes like "Title:", "Here is:", etc.
    title = title.replace(/^(title:|here is|the title is|conversation:)\s*/i, '');
    
    // Take only the first line (in case there's extra content)
    title = title.split('\n')[0].trim();
    
    // Remove any trailing punctuation that's not part of the title
    title = title.replace(/[.!?]+$/, '');
    
    // Fallback to truncated message if title is empty or too long
    if (!title || title.length > 50) {
      title = firstMessage.substring(0, 50).trim() + '...';
    }
    
    return title.substring(0, 50);
  } catch (error) {
    console.error('Error generating conversation name:', error);
    // Fallback to truncated message
    return firstMessage.substring(0, 50).trim() + '...';
  }
}

// Settings endpoint (UI settings only - server/searxng config comes from environment variables)
app.get('/api/settings', (req, res) => {
  res.json({
    ui: {
      showStats: loadedSettings.ui.showStats,
      selectedPersonality: loadedSettings.ui.selectedPersonality,
    },
  });
});

app.post('/api/settings', async (req, res) => {
  const { ui } = req.body;

  if (ui) {
    loadedSettings.ui = { ...loadedSettings.ui, ...ui };
    await settingsRepository.setUiSettings(loadedSettings.ui);
  }

  res.json({ success: true });
});

// Create new chat
app.post('/api/chat', protect, (req: AuthRequest, res) => {
  const chatId = crypto.randomUUID();
  const sandbox = sandboxManager.createSandbox();
  const now = new Date().toISOString();
  const userId = req.user!.id;

  const session: ChatSession = {
    id: chatId,
    userId,
    sandboxId: sandbox.id,
    messages: [],
    name: 'New Conversation',
    createdAt: now,
    updatedAt: now,
    toolPreferences: normalizeToolPreferences(),
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

    // Generate conversation name if this is the first message
    if (session.messages.length === 0) {
      const generatedName = await generateConversationName(message, responseModel);
      session.name = generatedName;
      io.to(chatId).emit('chat-name-updated', { name: generatedName });
      console.log(`Generated conversation name: "${generatedName}"`);
    }

    // Add user message (without agent steps initially)
    session.messages.push({ id: crypto.randomUUID(), role: 'user', content: message, agentSteps: [] });

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
          io.to(chatId).emit('tool-approval-required', request);
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
          
          // Save to disk immediately
          saveChats();
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
          
          // Save to disk to persist partial content
          saveChats();
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

    const { chatId, approvalId, approved, reason, rememberAutoApprove, toolName } = data;
    const pendingApproval = pendingApprovals.get(approvalId);
    const session = chatSessions.get(chatId);

    if (!pendingApproval || pendingApproval.chatId !== chatId) {
      socket.emit('error', { message: 'Approval request not found' });
      return;
    }

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

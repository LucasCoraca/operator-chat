import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { io, Socket } from 'socket.io-client';
import { BrowserRouter, Routes, Route, useParams, useNavigate } from 'react-router-dom';
import ChatInterface from './components/ChatInterface';
import SettingsPanel from './components/SettingsPanel';
import SandboxExplorer from './components/SandboxExplorer';
import RemoteWorkspaceExplorer from './components/RemoteWorkspaceExplorer';
import ScheduledTaskManager from './components/ScheduledTaskManager';
import AgentManager from './components/AgentManager';
import { PersonalityManager } from './components/PersonalityManager';
import { MemoryManagerModal } from './components/MemoryManagerModal';
import { AuthProvider, useAuth } from './components/AuthContext';
import { Login } from './components/Login';
import * as authService from './services/auth';
import operatorLogo from './assets/logo.png';

interface ChatPersonality {
  id: string;
  name: string;
  description: string;
  tone: string;
  systemPrompt: string;
  isCustom?: boolean;
}

interface Settings {
  ui: {
    showStats: boolean;
    selectedPersonality: string;
    selectedModel?: string;
    defaultToolPreferences: Record<string, ToolPreference>;
  };
  remoteWorkspace: {
    enabled: boolean;
    host: string;
    port: number;
    username: string;
    root: string;
    privateKey?: string;
    hasPrivateKey?: boolean;
    strictHostKeyChecking: boolean;
    approvalPolicy: 'ask' | 'auto-approve';
    toolApprovals: Record<string, 'ask' | 'auto-approve'>;
    agentModel?: string;
    contextWindowTokens: number;
    reservedOutputTokens: number;
    autoCompactThreshold: number;
  };
}

interface Chat {
  id: string;
  sandboxId: string;
  messageCount: number;
  name: string;
  createdAt: string;
  updatedAt: string;
}

interface SearchMatchingMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  snippet: string;
  messageIndex: number;
}

interface SearchResult {
  chatId: string;
  sandboxId: string;
  name: string;
  updatedAt: string;
  matchCount: number;
  matchingMessages: SearchMatchingMessage[];
}

interface Tool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string }>;
  policy: {
    requiresApproval: boolean;
    supportsAutoApprove: boolean;
    capabilities: string[];
    sandboxPolicy: string;
    riskLevel: 'low' | 'medium' | 'high';
  };
}

interface ToolPreference {
  enabled: boolean;
  autoApprove: boolean;
}

function prioritizeSelectedModel(models: string[], selectedModel?: string) {
  if (!selectedModel || !models.includes(selectedModel)) {
    return models;
  }

  return [selectedModel, ...models.filter((model) => model !== selectedModel)];
}

function getChatNameFromQuery(query: string): string {
  const normalized = query.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'New Chat';
  }

  const maxLength = 80;
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1).trimEnd()}…`
    : normalized;
}

function groupChatsByDate(chats: Chat[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const grouped = {
    today: chats.filter(chat => {
      const date = new Date(chat.updatedAt);
      return date >= today;
    }).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    previous7Days: chats.filter(chat => {
      const date = new Date(chat.updatedAt);
      return date >= sevenDaysAgo && date < today;
    }).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    older: chats.filter(chat => {
      const date = new Date(chat.updatedAt);
      return date < sevenDaysAgo;
    }).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
  };

  return grouped;
}

function ChatListItem({
  chat,
  isActive,
  hasUnread,
  onSelect,
  onDelete,
}: {
  chat: Chat;
  isActive: boolean;
  hasUnread: boolean;
  onSelect: () => void;
  onDelete: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`task-item group ${isActive ? 'active' : ''}`}
    >
      <span style={{ position: 'relative', flexShrink: 0, marginTop: 4 }}>
        <span style={{
          display: 'block', width: 8, height: 8, borderRadius: 999,
          background: isActive ? 'var(--accent)' : hasUnread ? 'var(--accent)' : 'var(--fg-3)',
          animation: hasUnread && !isActive ? 'pulse-dot 1.6s ease-out infinite' : 'none',
        }} />
      </span>
      <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
        <span style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 12.5, fontWeight: isActive ? 600 : 500,
          color: isActive ? 'var(--fg-0)' : 'var(--fg-1)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {chat.name}
          {hasUnread && !isActive && (
            <span style={{
              width: 6, height: 6, borderRadius: 999,
              background: 'var(--accent)', flexShrink: 0,
            }} />
          )}
        </span>
      </span>
      <button
        onClick={onDelete}
        className="delete-btn hover:text-[var(--rose)]"
        style={{ flexShrink: 0 }}
        aria-label={`Delete ${chat.name}`}
      >
        <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      </button>
    </button>
  );
}

function MainAppWrapper() {
  const { chatId: urlChatId } = useParams<{ chatId: string }>();
  const navigate = useNavigate();
  return <MainApp urlChatId={urlChatId} navigate={navigate} />;
}

function MainApp({ urlChatId, navigate }: { urlChatId: string | undefined; navigate: ReturnType<typeof useNavigate> }) {
  const { user, token, logout, isLoading: isAuthLoading } = useAuth();
  const { t } = useTranslation();
  
  // All state hooks must be called before any conditional returns
  const [socket, setSocket] = useState<Socket | null>(null);
  const [settings, setSettings] = useState<Settings>({
    ui: {
      showStats: false,
      selectedPersonality: 'professional',
      defaultToolPreferences: {},
    },
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
  });
  const [chats, setChats] = useState<Chat[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [currentSandboxId, setCurrentSandboxId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showSandbox, setShowSandbox] = useState(false);
  const [showRemoteWorkspace, setShowRemoteWorkspace] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [invalidChatId, setInvalidChatId] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showMobileSidebar, setShowMobileSidebar] = useState(false);
  const [landingInput, setLandingInput] = useState('');
  const [creatingChat, setCreatingChat] = useState(false);
  const [landingFile, setLandingFile] = useState<File | null>(null);
  const [landingTools, setLandingTools] = useState<Tool[]>([]);
  const [landingToolPreferences, setLandingToolPreferences] = useState<Record<string, ToolPreference>>({});
  const [showLandingToolPicker, setShowLandingToolPicker] = useState(false);
  const [landingReasoningEffort, setLandingReasoningEffort] = useState<'low' | 'medium' | 'high'>('medium');
  const [personalities, setPersonalities] = useState<ChatPersonality[]>([]);
  const [customPersonalities, setCustomPersonalities] = useState<ChatPersonality[]>([]);
  const [showPersonalityManager, setShowPersonalityManager] = useState(false);
  const [showMemoryManager, setShowMemoryManager] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [showAgents, setShowAgents] = useState(false);
  const [unreadChatIds, setUnreadChatIds] = useState<Set<string>>(new Set());
  const landingFileInputRef = useRef<HTMLInputElement>(null);
  const landingToolPickerRef = useRef<HTMLDivElement>(null);
  const currentChatIdRef = useRef<string | null>(null);
  const showTasksRef = useRef(false);

  const mergeToolPreferences = (tools: Tool[], incoming?: Record<string, ToolPreference>) =>
    tools.reduce((acc, tool) => {
      const preference = incoming?.[tool.name];
      acc[tool.name] = {
        enabled: preference?.enabled ?? true,
        autoApprove: tool.policy.supportsAutoApprove
          ? (preference?.autoApprove ?? !tool.policy.requiresApproval)
          : false,
      };
      return acc;
    }, {} as Record<string, ToolPreference>);

  const enabledLandingTools = landingTools.filter((tool) => landingToolPreferences[tool.name]?.enabled);
  const landingToolsLabel = landingTools.length === 0
    ? 'No tools'
    : enabledLandingTools.length === landingTools.length
      ? 'All tools'
      : `${enabledLandingTools.length} tool${enabledLandingTools.length === 1 ? '' : 's'}`;
  const currentModel = settings.ui.selectedModel && models.includes(settings.ui.selectedModel)
    ? settings.ui.selectedModel
    : (models[0] ?? '');

  const handleUnauthorized = () => {
    authService.clearAuth();
    setChats([]);
    setSearchResults([]);
    setPersonalities([]);
    setCustomPersonalities([]);
    setLandingTools([]);
    setLandingToolPreferences({});
    setCurrentChatId(null);
    setCurrentSandboxId(null);
    setInvalidChatId(false);
    logout();
  };

  useEffect(() => {
    currentChatIdRef.current = currentChatId;
    showTasksRef.current = showTasks || showAgents;
  }, [currentChatId, showTasks, showAgents]);

  useEffect(() => {
    if (!currentChatId || showTasks || showAgents) return;
    setUnreadChatIds((prev) => {
      if (!prev.has(currentChatId)) return prev;
      const next = new Set(prev);
      next.delete(currentChatId);
      return next;
    });
  }, [currentChatId, showTasks, showAgents]);

  const parseJsonSafely = async (res: Response) => {
    const text = await res.text();
    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  useEffect(() => {
    if (!user) return;

    fetch('/api/settings', { headers: authService.getAuthHeader() })
      .then(async (res) => {
        if (authService.isUnauthorizedResponse(res)) {
          handleUnauthorized();
          return null;
        }
        if (!res.ok) {
          throw new Error(`HTTP error ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        if (!data) return;
        // Merge with defaults to ensure all properties exist
        setSettings({
          ui: {
            showStats: false,
            selectedPersonality: 'professional',
            defaultToolPreferences: {},
            ...data.ui,
          },
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
            ...data.remoteWorkspace,
          },
        });
      })
      .catch(console.error);

    loadChats();
    loadModels();
    loadPersonalities();
    fetch('/api/tools', { headers: authService.getAuthHeader() })
      .then(async (res) => {
        if (authService.isUnauthorizedResponse(res)) {
          handleUnauthorized();
          return null;
        }
        if (!res.ok) {
          throw new Error(`HTTP error ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        if (!data) return;
        const tools = Array.isArray(data) ? data : [];
        setLandingTools(tools);
        setLandingToolPreferences(mergeToolPreferences(tools, settings.ui.defaultToolPreferences));
      })
      .catch(console.error);
  }, [user]);

  useEffect(() => {
    setModels((currentModels) => prioritizeSelectedModel(currentModels, settings.ui.selectedModel));
  }, [settings.ui.selectedModel]);

  useEffect(() => {
    if (landingTools.length === 0) {
      return;
    }

    setLandingToolPreferences(
      mergeToolPreferences(landingTools, settings.ui.defaultToolPreferences)
    );
  }, [landingTools, settings.ui.defaultToolPreferences]);

  useEffect(() => {
    if (!token) return;

    const newSocket = io(window.location.origin, {
      transports: ['websocket', 'polling'],
    });
    
    newSocket.on('connect', () => {
      newSocket.emit('authenticate', { token });
    });

    newSocket.on('authenticated', () => {
      console.log('Socket authenticated successfully');
    });

    newSocket.on('error', (error) => {
      console.error('Socket authentication error:', error);
    });

    newSocket.on('chat-updated', (payload: { chatId?: string }) => {
      loadChats();
      const chatId = payload.chatId;
      if (!chatId) return;

      const isCurrentlyVisible = currentChatIdRef.current === chatId && !showTasksRef.current;
      setUnreadChatIds((prev) => {
        const next = new Set(prev);
        if (isCurrentlyVisible) {
          next.delete(chatId);
        } else {
          next.add(chatId);
        }
        return next;
      });
    });

    setSocket(newSocket);

    return () => {
      newSocket.off('authenticated');
      newSocket.off('error');
      newSocket.off('chat-updated');
      newSocket.close();
    };
  }, [token]);

  useEffect(() => {
    if (!showLandingToolPicker) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (landingToolPickerRef.current && !landingToolPickerRef.current.contains(event.target as Node)) {
        setShowLandingToolPicker(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowLandingToolPicker(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [showLandingToolPicker]);

  useEffect(() => {
    if (urlChatId) {
      const chat = chats.find(c => c.id === urlChatId);
      if (chat) {
        setCurrentChatId(chat.id);
        setCurrentSandboxId(chat.sandboxId);
        setInvalidChatId(false);
      } else if (currentChatId === urlChatId) {
        setInvalidChatId(false);
      } else {
        setInvalidChatId(true);
        setCurrentChatId(null);
        setCurrentSandboxId(null);
      }
    } else {
      setInvalidChatId(false);
    }
  }, [urlChatId, chats]);

  // Conditional returns must come after all hooks
  if (isAuthLoading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[var(--bg-0)] text-[var(--fg-1)]">
        <div className="flex flex-col items-center gap-4">
          <svg className="animate-spin h-8 w-8 text-[var(--accent)]" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span className="text-sm font-medium">{t('common.loading')}</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  const loadChats = async () => {
    try {
      const res = await fetch('/api/chat', { headers: authService.getAuthHeader() });
      if (authService.isUnauthorizedResponse(res)) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) {
        throw new Error(`HTTP error ${res.status}`);
      }
      const data = await parseJsonSafely(res);
      setChats(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to load chats:', error);
      setChats([]);
    }
  };

  const searchChats = async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }

    try {
      const res = await fetch(`/api/chat/search?query=${encodeURIComponent(query)}`, {
        headers: authService.getAuthHeader()
      });
      if (authService.isUnauthorizedResponse(res)) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) {
        throw new Error(`HTTP error ${res.status}`);
      }
      const data = await parseJsonSafely(res);
      setSearchResults(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to search chats:', error);
      setSearchResults([]);
    }
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const query = e.target.value;
    setSearchQuery(query);
    
    clearTimeout((window as any).searchTimeout);
    (window as any).searchTimeout = setTimeout(() => {
      searchChats(query);
    }, 300);
  };

  const clearSearch = () => {
    setSearchQuery('');
    setSearchResults([]);
  };

  const toggleLandingTool = (toolName: string) => {
    setLandingToolPreferences((prev) => ({
      ...prev,
      [toolName]: {
        enabled: !(prev[toolName]?.enabled ?? true),
        autoApprove: prev[toolName]?.autoApprove ?? false,
      },
    }));
  };

  const toggleLandingAutoApprove = (toolName: string) => {
    setLandingToolPreferences((prev) => ({
      ...prev,
      [toolName]: {
        enabled: prev[toolName]?.enabled ?? true,
        autoApprove: !(prev[toolName]?.autoApprove ?? false),
      },
    }));
  };

  const enableAllLandingTools = () => {
    setLandingToolPreferences((prev) => mergeToolPreferences(
      landingTools,
      Object.fromEntries(
        landingTools.map((tool) => [
          tool.name,
          {
            enabled: true,
            autoApprove: tool.policy.supportsAutoApprove
              ? (prev[tool.name]?.autoApprove ?? !tool.policy.requiresApproval)
              : false,
          },
        ])
      )
    ));
  };

  const disableAllLandingTools = () => {
    setLandingToolPreferences((prev) => mergeToolPreferences(
      landingTools,
      Object.fromEntries(
        landingTools.map((tool) => [
          tool.name,
          {
            enabled: false,
            autoApprove: tool.policy.supportsAutoApprove ? (prev[tool.name]?.autoApprove ?? false) : false,
          },
        ])
      )
    ));
  };

  const createChat = async (initialMessage?: string) => {
    try {
      const trimmedMessage = initialMessage?.trim() || '';
      const fileToUpload = landingFile;
      if (trimmedMessage || fileToUpload) {
        setCreatingChat(true);
      }
      const res = await fetch('/api/chat', { 
        method: 'POST',
        headers: {
          ...authService.getAuthHeader(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ toolPreferences: landingToolPreferences }),
      });
      if (authService.isUnauthorizedResponse(res)) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) {
        throw new Error(`HTTP error ${res.status}`);
      }
      const data = await parseJsonSafely(res);
      if (!data || typeof data !== 'object' || !('chatId' in data) || !('sandboxId' in data)) {
        throw new Error('Invalid chat creation response');
      }
      let nextInitialMessage = trimmedMessage;

      if (fileToUpload) {
        const formData = new FormData();
        formData.append('file', fileToUpload);

        const uploadRes = await fetch(`/api/sandbox/${data.sandboxId}/upload`, {
          method: 'POST',
          headers: authService.getAuthHeader(),
          body: formData,
        });
        if (authService.isUnauthorizedResponse(uploadRes)) {
          handleUnauthorized();
          return;
        }
        const uploadData = await parseJsonSafely(uploadRes);

        if (!uploadRes.ok || !uploadData || typeof uploadData !== 'object' || !('success' in uploadData) || !uploadData.success) {
          const errorMessage =
            uploadData && typeof uploadData === 'object' && 'error' in uploadData
              ? String(uploadData.error)
              : 'Upload failed';
          throw new Error(errorMessage);
        }

        const uploadNotification = `📁 File uploaded: ${uploadData.filename} (${(uploadData.size / 1024).toFixed(2)} KB)`;
        nextInitialMessage = nextInitialMessage
          ? `${uploadNotification}\n\n${nextInitialMessage}`
          : uploadNotification;
      }

      const newChat: Chat = {
        id: data.chatId,
        sandboxId: data.sandboxId,
        messageCount: 0,
        name: getChatNameFromQuery(trimmedMessage),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setChats((prev) => [newChat, ...prev]);
      setCurrentChatId(data.chatId);
      setCurrentSandboxId(data.sandboxId);
      setInvalidChatId(false);
      window.localStorage.setItem(`chat-tools:${data.chatId}`, JSON.stringify(landingToolPreferences));
      window.localStorage.setItem(`chat-reasoning-effort:${data.chatId}`, landingReasoningEffort);
      navigate(`/chat/${data.chatId}`, {
        state: nextInitialMessage
          ? { initialMessage: nextInitialMessage, initialToolPreferences: landingToolPreferences, reasoningEffort: landingReasoningEffort }
          : { initialToolPreferences: landingToolPreferences, reasoningEffort: landingReasoningEffort },
      });
      setShowMobileSidebar(false);
      setLandingInput('');
      setLandingFile(null);
      setShowLandingToolPicker(false);
      if (landingFileInputRef.current) {
        landingFileInputRef.current.value = '';
      }
    } catch (error) {
      console.error('Failed to create chat:', error);
    } finally {
      setCreatingChat(false);
    }
  };

  const handleLandingSubmit = () => {
    if ((!landingInput.trim() && !landingFile) || creatingChat) return;
    createChat(landingInput);
  };

  const handleChatNameChange = (chatId: string, name: string) => {
    setChats((prev) =>
      prev.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              name,
              updatedAt: new Date().toISOString(),
            }
          : chat
      )
    );
  };

  const handleLandingKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleLandingSubmit();
    }
  };

  const triggerLandingFileInput = () => landingFileInputRef.current?.click();

  const deleteChat = async (chatId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await fetch(`/api/chat/${chatId}`, { 
        method: 'DELETE',
        headers: authService.getAuthHeader()
      });
      setChats((prev) => prev.filter((c) => c.id !== chatId));
      setUnreadChatIds((prev) => {
        if (!prev.has(chatId)) return prev;
        const next = new Set(prev);
        next.delete(chatId);
        return next;
      });
      if (currentChatId === chatId) {
        setCurrentChatId(null);
        setCurrentSandboxId(null);
        navigate('/');
      }
    } catch (error) {
      console.error('Failed to delete chat:', error);
    }
  };

  const loadModels = async () => {
    try {
      const res = await fetch('/api/models', { headers: authService.getAuthHeader() });
      if (authService.isUnauthorizedResponse(res)) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) {
        throw new Error(`HTTP error ${res.status}`);
      }
      const data = await parseJsonSafely(res);
      setModels(prioritizeSelectedModel(Array.isArray(data) ? data : [], settings.ui.selectedModel));
    } catch (error) {
      console.error('Failed to load models:', error);
      setModels([]);
    }
  };

  const loadPersonalities = async () => {
    try {
      const [builtInRes, customRes] = await Promise.all([
        fetch('/api/personalities', { headers: authService.getAuthHeader() }),
        fetch('/api/personalities/custom', { headers: authService.getAuthHeader() })
      ]);
      if (authService.isUnauthorizedResponse(builtInRes) || authService.isUnauthorizedResponse(customRes)) {
        handleUnauthorized();
        return;
      }
      if (!builtInRes.ok || !customRes.ok) {
        throw new Error(`HTTP error ${builtInRes.status}/${customRes.status}`);
      }
      const [builtIn, custom] = await Promise.all([
        parseJsonSafely(builtInRes),
        parseJsonSafely(customRes),
      ]);
      setPersonalities(Array.isArray(builtIn) ? builtIn : []);
      setCustomPersonalities(Array.isArray(custom) ? custom : []);
    } catch (error) {
      console.error('Failed to load personalities:', error);
      setPersonalities([]);
      setCustomPersonalities([]);
    }
  };

  const handleManagePersonalities = () => {
    setShowPersonalityManager(true);
  };

  const handleCreatePersonality = async (personality: Omit<ChatPersonality, 'id'>) => {
    try {
      const res = await fetch('/api/personalities/custom', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...authService.getAuthHeader()
        },
        body: JSON.stringify(personality),
      });
      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errorText}`);
      }
      await res.json();
      await loadPersonalities();
    } catch (error) {
      console.error('Failed to create personality:', error);
      alert(`Failed to create personality: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleEditPersonality = async (personality: ChatPersonality) => {
    try {
      const res = await fetch(`/api/personalities/custom/${personality.id}`, {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
          ...authService.getAuthHeader()
        },
        body: JSON.stringify(personality),
      });
      await res.json();
      await loadPersonalities();
    } catch (error) {
      console.error('Failed to edit personality:', error);
      alert('Failed to edit personality. Please try again.');
    }
  };

  const handleDeletePersonality = async (id: string) => {
    if (!confirm('Are you sure you want to delete this personality?')) return;
    try {
      const res = await fetch(`/api/personalities/custom/${id}`, {
        method: 'DELETE',
        headers: authService.getAuthHeader()
      });
      await res.json();
      await loadPersonalities();
    } catch (error) {
      console.error('Failed to delete personality:', error);
      alert('Failed to delete personality. Please try again.');
    }
  };

    const handleModelChange = async (model: string) => {
      try {
        // Update the model in the settings
        const newSettings = {
          ...settings,
          ui: {
            ...settings.ui,
            selectedModel: model,
          },
        };
        await saveSettings(newSettings);
        
        // Update local state
        setModels((prev) => {
          const filtered = prev.filter((m) => m !== model);
          return [model, ...filtered];
        });
        
        console.log('Model changed to:', model);
      } catch (error) {
        console.error('Failed to change model:', error);
      }
    };

  const saveSettings = async (newSettings: Settings) => {
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...authService.getAuthHeader()
        },
        body: JSON.stringify(newSettings),
      });
      setSettings(newSettings);
      setShowSettings(false);
    } catch (error) {
      console.error('Failed to save settings:', error);
    }
  };

  const groupedChats = groupChatsByDate(chats);
  const currentChat = chats.find((chat) => chat.id === currentChatId) ?? null;


  const handleNewChat = () => {
    setCurrentChatId(null);
    setCurrentSandboxId(null);
    setShowTasks(false);
    setShowAgents(false);
    navigate('/');
    setShowMobileSidebar(false);
  };

  const openTasks = () => {
    setShowTasks(true);
    setShowAgents(false);
    setShowMobileSidebar(false);
  };

  const openAgents = () => {
    setShowAgents(true);
    setShowTasks(false);
    setShowMobileSidebar(false);
  };

  const openChatFromTask = (chatId: string) => {
    setShowTasks(false);
    setShowAgents(false);
    navigate(`/chat/${chatId}`);
    setShowMobileSidebar(false);
  };

  const renderChatSection = (title: string, chatList: Chat[]) => {
    if (chatList.length === 0 || searchQuery) return null;

    return (
      <div>
        <div className="eyebrow px-3 py-1.5 text-[var(--fg-3)]">{title}</div>
        <div className="space-y-0.5">
          {chatList.map((chat) => (
            <ChatListItem
              key={chat.id}
              chat={chat}
              isActive={currentChatId === chat.id}
              hasUnread={unreadChatIds.has(chat.id)}
              onSelect={() => {
                setUnreadChatIds((prev) => {
                  if (!prev.has(chat.id)) return prev;
                  const next = new Set(prev);
                  next.delete(chat.id);
                  return next;
                });
                setShowTasks(false);
                setShowAgents(false);
                navigate(`/chat/${chat.id}`);
                setShowMobileSidebar(false);
              }}
              onDelete={(e) => deleteChat(chat.id, e)}
            />
          ))}
        </div>
      </div>
    );
  };

  if (invalidChatId) {
    return (
      <div className="h-screen w-screen overflow-hidden flex bg-[var(--bg-0)] text-[var(--fg-0)] font-[var(--font-sans)] antialiased">
        <div className="flex-1 flex flex-col items-center justify-center">
          <h1 className="text-2xl font-semibold text-[var(--fg-0)] mb-4">Chat not found</h1>
          <p className="text-[var(--fg-2)] mb-6">The chat you're looking for doesn't exist.</p>
          <button onClick={() => navigate('/')} className="bg-[var(--accent)] text-[var(--accent-ink)] px-6 py-2 rounded-[var(--radius-sm)] hover:opacity-90 transition-opacity">
            Go Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden flex bg-[var(--bg-0)] text-[var(--fg-0)] font-[var(--font-sans)] antialiased">
      {/* Modals */}
      {showSettings && (
        <SettingsPanel 
          settings={settings} 
          onSave={saveSettings} 
          onClose={() => setShowSettings(false)}
          personalities={(() => {
            const all = [...personalities, ...customPersonalities];
            const seen = new Set();
            return all.filter(p => {
              if (seen.has(p.id)) return false;
              seen.add(p.id);
              return true;
            });
          })()}
          tools={landingTools}
          models={models}
          onManagePersonalities={handleManagePersonalities}
          isPersonalityManagerOpen={showPersonalityManager}
        />
      )}

      {showPersonalityManager && (
        <PersonalityManager
          isOpen={showPersonalityManager}
          customPersonalities={customPersonalities}
          onCreate={handleCreatePersonality}
          onEdit={handleEditPersonality}
          onDelete={handleDeletePersonality}
          onClose={() => setShowPersonalityManager(false)}
        />
      )}

      {/* Sidebar */}
      <aside className="w-[272px] h-full flex-shrink-0 flex flex-col bg-[var(--bg-1)] hairline hidden md:flex overflow-hidden">
        {/* Brand */}
        <div className="px-4 py-3 flex items-center gap-2.5 border-b border-[var(--line)]">
          <img src="/assets/logo-BBNd4Fk1.png" alt="" className="size-7 object-contain opacity-90" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--fg-0)', letterSpacing: '-0.012em' }}>
              Operator Chat
            </div>
          </div>
        </div>

        {/* Quick actions */}
        <div className="px-3 py-2 space-y-1">
          <button 
            onClick={handleNewChat}
            className="quick-action primary"
          >
            <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
            </svg>
            <span>{t('sidebar.newChat')}</span>
            <span className="kbd">⌘N</span>
          </button>
          <button
            onClick={openTasks}
            className={`quick-action ${showTasks ? '' : ''}`}
          >
            <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3M4 11h16M5 5h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z" />
            </svg>
            <span>{t('scheduler.tasks')}</span>
          </button>
          <button
            onClick={openAgents}
            className="quick-action"
          >
            <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l3 3-3 3m5 0h3M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" />
            </svg>
            <span>Agents</span>
          </button>
        </div>

        {/* Search */}
        <div className="px-3 pb-2">
          <div className="search-input">
            <svg className="size-3.5 text-[var(--fg-3)] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder={t('sidebar.searchChats')}
              value={searchQuery}
              onChange={handleSearchChange}
              className="text-sm flex-1"
            />
          </div>
        </div>

        {/* Chat list */}
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-5">
          {searchQuery && searchResults.length > 0 && (
            <div>
              <div className="eyebrow px-3 py-1.5 text-[var(--fg-3)]">{t('sidebar.searchResults')}</div>
              <div className="space-y-0.5">
                {searchResults.map((result) => (
                  <button
                    key={result.chatId}
                    onClick={() => {
                      setUnreadChatIds((prev) => {
                        if (!prev.has(result.chatId)) return prev;
                        const next = new Set(prev);
                        next.delete(result.chatId);
                        return next;
                      });
                      setShowTasks(false);
                      setShowAgents(false);
                      navigate(`/chat/${result.chatId}?msg=${result.matchingMessages[0]?.messageIndex ?? 0}`);
                      setShowMobileSidebar(false);
                    }}
                    className={`task-item ${currentChatId === result.chatId ? 'active' : ''}`}
                  >
                    <span style={{ position: 'relative', flexShrink: 0, marginTop: 4 }}>
                      <span style={{
                        display: 'block', width: 8, height: 8, borderRadius: 999,
                        background: currentChatId === result.chatId ? 'var(--accent)' : 'var(--fg-3)',
                      }} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                      <span style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        fontSize: 12.5, fontWeight: currentChatId === result.chatId ? 600 : 500,
                        color: currentChatId === result.chatId ? 'var(--fg-0)' : 'var(--fg-1)',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>
                        {result.name}
                      </span>
                    </span>
                    <span style={{
                      fontSize: 10.5, color: 'var(--fg-3)', flexShrink: 0,
                      alignSelf: 'flex-start', marginTop: 4, fontVariantNumeric: 'tabular-nums',
                    }}>
                      {result.updatedAt}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {searchQuery && searchResults.length === 0 && (
            <div className="rounded-[var(--radius)] hairline bg-[rgba(255,255,255,.02)] px-4 py-5 text-sm text-[var(--fg-3)]">
              {t('sidebar.noChatsMatched', { query: searchQuery })}
            </div>
          )}

          {!searchQuery && chats.length === 0 && (
            <div className="rounded-[var(--radius)] hairline bg-[rgba(255,255,255,.02)] px-4 py-5 text-sm text-[var(--fg-3)]">
              {t('sidebar.noChatsYet')}
            </div>
          )}

          {renderChatSection(t('sidebar.today'), groupedChats.today)}
          {renderChatSection(t('sidebar.previous7Days'), groupedChats.previous7Days)}
          {renderChatSection(t('sidebar.older'), groupedChats.older)}
        </div>

        {/* Footer */}
        <div className="px-3 py-2 border-t border-[var(--line)]">
          <button
            onClick={() => setShowMemoryManager(true)}
            className="w-full flex items-center gap-2 bg-transparent hover:bg-[rgba(255,255,255,.03)] text-[var(--fg-1)] hover:text-[var(--fg-0)] rounded-[var(--radius-sm)] px-3 py-2 transition-colors text-sm"
          >
            <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .52 8.105 4 4 0 0 0 7.327-2.258 M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.52 8.105 4 4 0 0 1-.52 8.105 4 4 0 0 1-7.327-2.258 M12 5v17 M9 13a4.5 4.5 0 0 0 3-4 M15 13a4.5 4.5 0 0 1-3-4" />
            </svg>
            <span>{t('sidebar.memoryManager')}</span>
          </button>
        </div>
      </aside>

      {/* Mobile Sidebar Overlay */}
      {showMobileSidebar && (
        <div 
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setShowMobileSidebar(false)}
        />
      )}

      {/* Mobile Sidebar */}
      <aside className={`fixed md:hidden inset-y-0 left-0 w-[272px] max-w-[85vw] h-full flex-shrink-0 flex flex-col bg-[var(--bg-1)] hairline z-50 transition-transform overflow-hidden ${showMobileSidebar ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="px-4 py-3 flex items-center gap-2.5 border-b border-[var(--line)]">
          <div className="brand-tile">
            <img src={operatorLogo} alt="" className="size-4 object-contain opacity-90" />
          </div>
          <span className="text-sm font-medium tracking-tight text-[var(--fg-0)]">Operator Chat</span>
        </div>
        <div className="px-3 py-2 space-y-1">
          <button 
            onClick={handleNewChat}
            className="w-full flex items-center gap-2.5 rounded-[var(--radius-sm)] px-3 py-2 text-sm transition-colors hover:bg-[rgba(255,255,255,.03)] text-[var(--fg-1)]"
          >
            <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
            </svg>
            <span className="font-medium">{t('sidebar.newChat')}</span>
          </button>
          <button
            onClick={openTasks}
            className={`w-full flex items-center gap-2.5 rounded-[var(--radius-sm)] px-3 py-2 text-sm transition-colors ${
              showTasks
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'text-[var(--fg-1)] hover:bg-[rgba(255,255,255,.03)]'
            }`}
          >
            <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3M4 11h16M5 5h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z" />
            </svg>
            <span className="font-medium">{t('scheduler.tasks')}</span>
          </button>
          <button
            onClick={openAgents}
            className={`w-full flex items-center gap-2.5 rounded-[var(--radius-sm)] px-3 py-2 text-sm transition-colors ${
              showAgents
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'text-[var(--fg-1)] hover:bg-[rgba(255,255,255,.03)]'
            }`}
          >
            <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l3 3-3 3m5 0h3M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" />
            </svg>
            <span className="font-medium">Agents</span>
          </button>
        </div>
        <div className="px-3 pb-2">
          <div className="relative">
            <input
              type="text"
              placeholder={t('sidebar.searchChats')}
              value={searchQuery}
              onChange={handleSearchChange}
              className="w-full px-3 py-1.5 pl-8.5 bg-[rgba(255,255,255,.03)] text-[var(--fg-0)] rounded-[var(--radius-sm)] text-sm focus:outline-none border border-[var(--line)] placeholder-[var(--fg-3)] transition-all"
              style={{ boxShadow: 'var(--ring)' }}
            />
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-[var(--fg-3)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            {searchQuery && (
              <button onClick={clearSearch} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--fg-3)] hover:text-[var(--fg-1)]">×</button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-5">
          {searchQuery && searchResults.length > 0 && (
            <div>
              <div className="eyebrow px-3 py-1.5 text-[var(--fg-3)]">{t('sidebar.searchResults')}</div>
              <div className="space-y-0.5">
                {searchResults.map((result) => (
                  <button
                    key={result.chatId}
                    onClick={() => {
                      setUnreadChatIds((prev) => {
                        if (!prev.has(result.chatId)) return prev;
                        const next = new Set(prev);
                        next.delete(result.chatId);
                        return next;
                      });
                      setShowTasks(false);
                      setShowAgents(false);
                      navigate(`/chat/${result.chatId}?msg=${result.matchingMessages[0]?.messageIndex ?? 0}`);
                      setShowMobileSidebar(false);
                    }}
                    className={`w-full flex items-center gap-2 rounded-[var(--radius-sm)] px-3 py-1.5 text-left text-sm transition-colors ${
                      currentChatId === result.chatId ? 'bg-[rgba(255,255,255,.04)] text-[var(--fg-0)] hairline' : 'text-[var(--fg-1)] hover:bg-[rgba(255,255,255,.03)]'
                    }`}
                  >
                    <span className="truncate">{result.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {searchQuery && searchResults.length === 0 && (
            <div className="rounded-[var(--radius)] hairline bg-[rgba(255,255,255,.02)] px-4 py-5 text-sm text-[var(--fg-3)]">
              {t('sidebar.noChatsMatched', { query: searchQuery })}
            </div>
          )}
          {!searchQuery && chats.length === 0 && (
            <div className="rounded-[var(--radius)] hairline bg-[rgba(255,255,255,.02)] px-4 py-5 text-sm text-[var(--fg-3)]">
              {t('sidebar.noChatsYet')}
            </div>
          )}
          {renderChatSection(t('sidebar.today'), groupedChats.today)}
          {renderChatSection(t('sidebar.previous7Days'), groupedChats.previous7Days)}
          {renderChatSection(t('sidebar.older'), groupedChats.older)}
        </div>
        <div className="px-3 py-2 border-t border-[var(--line)]">
          <button
            onClick={() => setShowMemoryManager(true)}
            className="w-full flex items-center gap-2 bg-transparent hover:bg-[rgba(255,255,255,.03)] text-[var(--fg-1)] hover:text-[var(--fg-0)] rounded-[var(--radius-sm)] px-3 py-2 transition-colors text-sm"
          >
            <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .52 8.105 4 4 0 0 0 7.327-2.258 M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.52 8.105 4 4 0 0 1-7.327-2.258 M12 5v17 M9 13a4.5 4.5 0 0 0 3-4 M15 13a4.5 4.5 0 0 1-3-4" />
            </svg>
            <span>{t('sidebar.memoryManager')}</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-full relative">
        {/* Header */}
        <header className="sticky top-0 z-30 h-[52px] flex-shrink-0 flex items-center border-b border-[var(--line)] px-4 gap-3 relative" style={{
          background: 'linear-gradient(180deg, rgba(255,255,255,0.018), transparent 60%), color-mix(in oklch, var(--bg-0) 80%, transparent)',
          backdropFilter: 'blur(10px)',
        }}>
          {/* Mobile menu */}
          <button
            onClick={() => setShowMobileSidebar(true)}
            className="icon-btn md:hidden"
            aria-label="Open chats"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M3 5h10M3 8h10M3 11h10" />
            </svg>
          </button>

          {/* Model dropdown - left */}
          <div className="relative">
            <button
              onClick={(e) => { e.stopPropagation(); setShowModelDropdown(!showModelDropdown); }}
              className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium text-[var(--fg-1)] hover:bg-[rgba(255,255,255,.04)] transition-colors"
              title={currentModel || 'Choose model'}
            >
              <span>{currentModel || 'Select model'}</span>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M5 6l3 3 3-3" />
              </svg>
            </button>
            {showModelDropdown && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowModelDropdown(false)} />
                <div className="absolute left-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-[var(--radius)] hairline bg-[var(--bg-elev)] shadow-2">
                  <div className="py-1">
                    {models.length > 0 ? (
                      models.map((model) => (
                        <button
                          key={model}
                          onClick={() => { handleModelChange(model); setShowModelDropdown(false); }}
                          className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors ${
                            currentModel === model ? 'text-[var(--fg-0)]' : 'text-[var(--fg-1)] hover:bg-[rgba(255,255,255,.03)]'
                          }`}
                        >
                          {currentModel === model && (
                            <svg className="size-4 text-[var(--accent)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                          <span className={currentModel === model ? '' : 'ml-0.5'}>{model}</span>
                        </button>
                      ))
                    ) : (
                      <div className="px-3 py-1.5 text-sm text-[var(--fg-3)]">No models available</div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Spacer */}
          <span style={{ flex: 1 }} />

          {/* Env tabs for sandbox/remote */}
          {currentChat && !showAgents && !showTasks && (
            <div className="env-tabs">
              <button
                className={`env-tab ${showSandbox ? 'active' : ''}`}
                onClick={() => { setShowSandbox(true); setShowRemoteWorkspace(false); }}
              >
                <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 999, background: 'var(--accent)', marginRight: 6, verticalAlign: 1 }} />
                Sandbox
              </button>
              <button
                className={`env-tab ${showRemoteWorkspace ? 'active' : ''}`}
                onClick={() => { setShowRemoteWorkspace(true); setShowSandbox(false); }}
              >
                <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 999, background: '#5e9bff', marginRight: 6, verticalAlign: 1 }} />
                Remote
              </button>
            </div>
          )}

          {/* Settings */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="icon-btn"
            title="Settings"
            aria-label="Settings"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
            </svg>
          </button>

          {/* Logout */}
          <button
            onClick={logout}
            className="icon-btn"
            title={`Logout (${user.username})`}
            aria-label="Logout"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 3h3v10H9" />
              <path d="M3 8h7M7.5 5.5L10 8l-2.5 2.5" />
            </svg>
          </button>
        </header>

  

        {/* Chat Content */}
        {showAgents ? (
          <AgentManager onOpenChat={openChatFromTask} />
        ) : showTasks ? (
          <ScheduledTaskManager
            socket={socket}
            currentChatId={currentChatId}
            currentModel={currentModel}
            onOpenChat={openChatFromTask}
          />
        ) : currentChatId && currentSandboxId ? (
            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <div className="flex min-h-0 flex-1 flex-col">
              <ChatInterface 
                key={currentChatId}
                socket={socket}
                chatId={currentChatId}
                sandboxId={currentSandboxId}
                models={models}
                currentModel={currentModel}
                onModelChange={handleModelChange}
                onChatNameChange={handleChatNameChange}
                showStats={settings.ui.showStats}
              />
            </div>
            {showSandbox && (
              <>
                <div
                  className="fixed inset-0 z-20 bg-black/50 md:hidden"
                  onClick={() => setShowSandbox(false)}
                />
                <div className="fixed inset-x-0 bottom-0 top-24 z-30 flex flex-col rounded-t-[var(--radius-lg)] border-t hairline bg-[var(--bg-1)] shadow-2 md:static md:inset-auto md:w-full md:max-w-[400px] md:flex-shrink-0 md:rounded-none md:border-l md:border-t-0 md:shadow-none">
                  <div className="relative flex items-center justify-between border-b border-[var(--line)] bg-[var(--bg-1)] p-3">
                    <div className="absolute left-1/2 top-2 h-1.5 w-12 -translate-x-1/2 rounded-full bg-[var(--line-3)] md:hidden" />
                    <h3 className="font-medium text-[var(--fg-0)]">{t('sandbox.title')}</h3>
                    <button
                      onClick={() => setShowSandbox(false)}
                      className="rounded-[var(--radius-sm)] p-2 transition-colors hover:bg-[rgba(255,255,255,.03)]"
                      aria-label="Close sandbox"
                    >
                      <svg className="size-5 text-[var(--fg-2)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  <SandboxExplorer sandboxId={currentSandboxId} />
                </div>
              </>
            )}
            {showRemoteWorkspace && (
              <>
                <div
                  className="fixed inset-0 z-20 bg-black/50 md:hidden"
                  onClick={() => setShowRemoteWorkspace(false)}
                />
                <div className="fixed inset-x-0 bottom-0 top-24 z-30 flex flex-col rounded-t-[var(--radius-lg)] border-t hairline bg-[var(--bg-1)] shadow-2 md:static md:inset-auto md:w-full md:max-w-[480px] md:flex-shrink-0 md:rounded-none md:border-l md:border-t-0 md:shadow-none">
                  <div className="relative flex items-center justify-between border-b border-[var(--line)] bg-[var(--bg-1)] p-3">
                    <div className="absolute left-1/2 top-2 h-1.5 w-12 -translate-x-1/2 rounded-full bg-[var(--line-3)] md:hidden" />
                    <h3 className="font-medium text-[var(--fg-0)]">Remote workspace</h3>
                    <button
                      onClick={() => setShowRemoteWorkspace(false)}
                      className="rounded-[var(--radius-sm)] p-2 transition-colors hover:bg-[rgba(255,255,255,.03)]"
                      aria-label="Close remote workspace"
                    >
                      <svg className="size-5 text-[var(--fg-2)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  <RemoteWorkspaceExplorer socket={socket} />
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 sm:px-6">
            <div className="w-full max-w-content studio-card px-5 py-8 text-center sm:px-8 sm:py-10 animate-fade-up">
              <div className="brand-tile mx-auto mb-4" style={{width: 64, height: 64, borderRadius: 'var(--radius)', boxShadow: `0 0 0 6px color-mix(in oklch, var(--accent) 8%, transparent)`}}>
                <img src={operatorLogo} alt="" className="size-10 object-contain opacity-90" />
              </div>
              <h1 className="mb-2 text-2xl font-medium text-[var(--fg-0)] sm:text-3xl">{t('chat.welcomeTitle')}</h1>
              <p className="mb-6 text-sm leading-6 text-[var(--fg-1)]">{t('chat.welcomeDescription')}</p>
              <div className="mx-auto max-w-2xl">
                <div className="input-glow relative rounded-[var(--radius-lg)] hairline bg-[rgba(255,255,255,.03)] text-left shadow-2 transition-all duration-200 sm:rounded-[16px]">
                  <input
                    ref={landingFileInputRef}
                    type="file"
                    onChange={(e) => setLandingFile(e.target.files?.[0] || null)}
                    className="hidden"
                  />
                  <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] px-3 pb-2 pt-3 sm:px-4">
                    <div className="relative" ref={landingToolPickerRef}>
                      <button
                        type="button"
                        onClick={() => setShowLandingToolPicker((prev) => !prev)}
                        className="inline-flex h-8 items-center gap-2 rounded-pill hairline bg-[rgba(255,255,255,.04)] px-3 text-xs font-medium text-[var(--fg-1)] hover:bg-[rgba(255,255,255,.06)] transition-colors"
                      >
                        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.5 6h9m-9 6h9m-9 6h9M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
                        </svg>
                        <span>{t('chat.tools')}</span>
                        <span className="text-[var(--fg-3)]">{landingToolsLabel}</span>
                      </button>

                      {showLandingToolPicker && (
                        <div className="absolute bottom-full left-0 z-30 mb-2 w-[26rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-[var(--radius-lg)] hairline bg-[var(--bg-elev)] shadow-2">
                          <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
                            <div>
                              <div className="text-sm font-medium text-[var(--fg-0)]">{t('chat.enabledTools')}</div>
                              <div className="text-xs text-[var(--fg-3)]">{t('chat.landingToolsDescription')}</div>
                            </div>
                            <div className="flex items-center gap-2 text-xs">
                              <button type="button" onClick={enableAllLandingTools} className="text-[var(--fg-1)] hover:text-[var(--fg-0)]">{t('common.all')}</button>
                              <button type="button" onClick={disableAllLandingTools} className="text-[var(--fg-1)] hover:text-[var(--fg-0)]">{t('common.none')}</button>
                            </div>
                          </div>
                          <div className="max-h-80 overflow-y-auto p-2.5">
                            {landingTools.map((tool) => {
                              const preference = landingToolPreferences[tool.name] ?? {
                                enabled: true,
                                autoApprove: !tool.policy.requiresApproval,
                              };
                              const riskClass =
                                tool.policy.riskLevel === 'high'
                                  ? 'border-[var(--rose-line)] bg-[var(--rose-soft)] text-[var(--rose)]'
                                  : tool.policy.riskLevel === 'medium'
                                    ? 'border-[var(--amber-line)] bg-[var(--amber-soft)] text-[var(--amber)]'
                                    : 'border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent)]';
                              return (
                                <div key={tool.name} className="rounded-[var(--radius)] hairline bg-[rgba(255,255,255,.02)] p-3 transition-colors hover:bg-[rgba(255,255,255,.04)]">
                                  <label className="flex cursor-pointer items-start gap-3">
                                    <input
                                      type="checkbox"
                                      checked={preference.enabled}
                                      onChange={() => toggleLandingTool(tool.name)}
                                      className="mt-0.5 h-4 w-4 rounded hairline bg-[rgba(255,255,255,.06)] text-[var(--accent)] focus:ring-[var(--accent-soft)]"
                                    />
                                    <div className="min-w-0 flex-1 space-y-2">
                                      <div className="flex items-center gap-2">
                                        <div className="truncate text-sm font-medium text-[var(--fg-0)]">{tool.name}</div>
                                        <span className={`rounded-pill border px-2 py-0.5 text-[10px] uppercase font-mono ${riskClass}`}>
                                          {tool.policy.riskLevel}
                                        </span>
                                      </div>
                                      <div className="text-xs leading-5 text-[var(--fg-2)]">{tool.description}</div>
                                      <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono">
                                        <span className="rounded-pill hairline bg-[rgba(255,255,255,.04)] px-2 py-0.5 text-[var(--fg-1)]">
                                          sandbox: {tool.policy.sandboxPolicy}
                                        </span>
                                        {tool.policy.capabilities.map((capability) => (
                                          <span key={`${tool.name}-${capability}`} className="rounded-pill hairline bg-[rgba(255,255,255,.04)] px-2 py-0.5 text-[var(--fg-2)]">
                                            {capability}
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  </label>
                                  <div className="mt-3 ml-7 flex items-center justify-between rounded-[var(--radius-sm)] hairline bg-[rgba(255,255,255,.02)] px-2.5 py-2">
                                    <span className="text-[11px] text-[var(--fg-3)]">{t('chat.autoApprove')}</span>
                                    {tool.policy.supportsAutoApprove ? (
                                      <label className="flex items-center gap-2 text-[11px] text-[var(--fg-1)]">
                                        <input
                                          type="checkbox"
                                          checked={preference.autoApprove}
                                          onChange={() => toggleLandingAutoApprove(tool.name)}
                                          disabled={!preference.enabled}
                                          className="h-4 w-4 rounded hairline bg-[rgba(255,255,255,.06)] text-[var(--accent)] focus:ring-[var(--accent-soft)] disabled:opacity-50"
                                        />
                                        <span>{tool.policy.requiresApproval ? t('chat.skipPromptForTool') : t('chat.alwaysAllowed')}</span>
                                      </label>
                                    ) : (
                                      <span className="text-[11px] text-[var(--fg-3)]">{t('chat.disabledForHighRisk')}</span>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="ml-auto flex items-center gap-2">
                      <span className="text-xs font-medium text-[var(--fg-1)]">Reasoning:</span>
                      <select
                        value={landingReasoningEffort}
                        onChange={(e) => setLandingReasoningEffort(e.target.value as 'low' | 'medium' | 'high')}
                        className="h-8 rounded-pill hairline bg-[rgba(255,255,255,.04)] px-3 text-xs font-medium text-[var(--fg-1)] hover:bg-[rgba(255,255,255,.06)] focus:outline-none focus:ring-2 transition-all"
                        style={{ boxShadow: 'var(--ring)' }}
                      >
                        <option value="low">{t('chat.reasoningEffortLow')}</option>
                        <option value="medium">{t('chat.reasoningEffortMedium')}</option>
                        <option value="high">{t('chat.reasoningEffortHigh')}</option>
                      </select>
                    </div>
                  </div>
                  <textarea
                    value={landingInput}
                    onChange={(e) => setLandingInput(e.target.value)}
                    onKeyDown={handleLandingKeyDown}
                    placeholder={t('chat.messageAssistant')}
                    rows={1}
                    className="w-full min-h-[72px] max-h-[200px] resize-none bg-transparent px-4 pb-14 pt-3.5 text-sm leading-6 text-[var(--fg-0)] outline-none placeholder:text-[var(--fg-3)]"
                    disabled={creatingChat}
                  />
                  {landingFile && (
                    <div className="px-4 pb-1 text-xs text-[var(--fg-2)]">
                      Attached: <span className="text-[var(--fg-0)]">{landingFile.name}</span>
                    </div>
                  )}
                  <div className="absolute bottom-2 right-2 flex items-center gap-2">
                    <button
                      onClick={triggerLandingFileInput}
                      disabled={creatingChat}
                      className="flex size-9 items-center justify-center rounded-[var(--radius)] text-[var(--fg-2)] transition-colors hover:bg-[rgba(255,255,255,.06)] hover:text-[var(--fg-0)] disabled:opacity-50"
                      aria-label="Attach file"
                    >
                      <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                      </svg>
                    </button>
                    <button
                      onClick={handleLandingSubmit}
                      disabled={(!landingInput.trim() && !landingFile) || creatingChat}
                      className="flex size-9 items-center justify-center rounded-[var(--radius)] bg-[var(--accent)] text-[var(--accent-ink)] shadow-1 transition-all disabled:opacity-50 hover:opacity-90"
                      aria-label="Start chat"
                    >
                      <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div className="mt-3 text-center text-[11px] font-medium text-[var(--fg-3)] sm:text-xs">
                  {t('chat.aiDisclaimer')}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      <MemoryManagerModal
        isOpen={showMemoryManager}
        onClose={() => setShowMemoryManager(false)}
      />
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<MainAppWrapper />} />
          <Route path="/chat/:chatId" element={<MainAppWrapper />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;

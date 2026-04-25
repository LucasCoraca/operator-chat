import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { io, Socket } from 'socket.io-client';
import { BrowserRouter, Routes, Route, useParams, useNavigate } from 'react-router-dom';
import ChatInterface from './components/ChatInterface';
import SettingsPanel from './components/SettingsPanel';
import SandboxExplorer from './components/SandboxExplorer';
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
  onSelect,
  onDelete,
}: {
  chat: Chat;
  isActive: boolean;
  onSelect: () => void;
  onDelete: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div
      className={`group flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
        isActive
          ? 'border-white/10 bg-surface-100/70 text-zinc-100 shadow-sm'
          : 'border-transparent text-zinc-400 hover:border-white/5 hover:bg-surface-100'
      }`}
    >
      <button
        onClick={onSelect}
        className="min-w-0 flex-1 truncate text-left focus:outline-none"
        title={chat.name}
      >
        {chat.name}
      </button>
      <button
        onClick={onDelete}
        className="rounded p-1 text-zinc-500 opacity-0 transition-all hover:bg-white/10 hover:text-white focus:opacity-100 group-hover:opacity-100"
        aria-label={`Delete ${chat.name}`}
      >
        <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      </button>
    </div>
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
  });
  const [chats, setChats] = useState<Chat[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [currentSandboxId, setCurrentSandboxId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showSandbox, setShowSandbox] = useState(false);
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
  const landingFileInputRef = useRef<HTMLInputElement>(null);
  const landingToolPickerRef = useRef<HTMLDivElement>(null);

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

    setSocket(newSocket);

    return () => {
      newSocket.off('authenticated');
      newSocket.off('error');
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
      <div className="h-screen w-screen flex items-center justify-center bg-[#141415] text-zinc-300">
        <div className="flex flex-col items-center gap-4">
          <svg className="animate-spin h-8 w-8 text-brand" fill="none" viewBox="0 0 24 24">
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
    navigate('/');
    setShowMobileSidebar(false);
  };

  const renderChatSection = (title: string, chatList: Chat[]) => {
    if (chatList.length === 0 || searchQuery) return null;

    return (
      <div>
        <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">{title}</div>
        <div className="space-y-1">
          {chatList.map((chat) => (
            <ChatListItem
              key={chat.id}
              chat={chat}
              isActive={currentChatId === chat.id}
              onSelect={() => {
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
      <div className="h-screen w-screen overflow-hidden flex bg-[#141415] text-zinc-300 font-sans antialiased">
        <div className="flex-1 flex flex-col items-center justify-center">
          <h1 className="text-2xl font-semibold text-zinc-100 mb-4">Chat not found</h1>
          <p className="text-zinc-400 mb-6">The chat you're looking for doesn't exist.</p>
          <button onClick={() => navigate('/')} className="bg-brand text-white px-6 py-2 rounded-lg hover:bg-brand-dark">
            Go Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden flex bg-[#141415] text-zinc-300 font-sans antialiased">
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
      <aside className="w-[280px] h-full flex-shrink-0 flex flex-col bg-[#111111] border-r border-white/5 hidden md:flex overflow-hidden">
        <div className="p-4">
          <button 
            onClick={handleNewChat}
            className="w-full flex items-center gap-3 bg-surface-100 hover:bg-surface-200 text-zinc-100 border border-white/10 rounded-xl px-4 py-3 transition-all shadow-sm"
          >
            <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            <span className="font-medium text-sm">{t('sidebar.newChat')}</span>
          </button>
        </div>

        <div className="px-3 pb-3">
          <div className="relative">
            <input
              type="text"
              placeholder={t('sidebar.searchChats')}
              value={searchQuery}
              onChange={handleSearchChange}
              className="w-full px-3 py-2 pl-9 bg-surface-100 text-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/50 placeholder-zinc-500 border border-white/5"
            />
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            {searchQuery && (
              <button onClick={clearSearch} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300">×</button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-6">
          {searchQuery && searchResults.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-zinc-500 px-3 py-2 uppercase tracking-wider">{t('sidebar.searchResults')}</div>
              <div className="space-y-1">
                {searchResults.map((result) => (
                  <button
                    key={result.chatId}
                    onClick={() => {
                      navigate(`/chat/${result.chatId}?msg=${result.matchingMessages[0]?.messageIndex ?? 0}`);
                      setShowMobileSidebar(false);
                    }}
                    className={`w-full flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      currentChatId === result.chatId ? 'bg-surface-100/50 text-zinc-100 border border-white/5' : 'hover:bg-surface-100 text-zinc-400'
                    }`}
                  >
                    <span className="truncate">{result.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {searchQuery && searchResults.length === 0 && (
            <div className="rounded-xl border border-dashed border-white/10 bg-surface-100/30 px-4 py-5 text-sm text-zinc-500">
              {t('sidebar.noChatsMatched', { query: searchQuery })}
            </div>
          )}

          {!searchQuery && chats.length === 0 && (
            <div className="rounded-xl border border-dashed border-white/10 bg-surface-100/30 px-4 py-5 text-sm text-zinc-500">
              {t('sidebar.noChatsYet')}
            </div>
          )}

          {renderChatSection(t('sidebar.today'), groupedChats.today)}
          {renderChatSection(t('sidebar.previous7Days'), groupedChats.previous7Days)}
          {renderChatSection(t('sidebar.older'), groupedChats.older)}
        </div>

        <div className="p-4 border-t border-white/5">
          <button
            onClick={() => setShowMemoryManager(true)}
            className="w-full flex items-center gap-3 bg-transparent hover:bg-surface-100 text-zinc-400 hover:text-zinc-100 rounded-xl px-4 py-2.5 transition-all text-sm"
          >
            <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .52 8.105 4 4 0 0 0 7.327-2.258 M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.52 8.105 4 4 0 0 1-7.327-2.258 M12 5v17 M9 13a4.5 4.5 0 0 0 3-4 M15 13a4.5 4.5 0 0 1-3-4" />
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
      <aside className={`fixed md:hidden inset-y-0 left-0 w-[280px] max-w-[85vw] h-full flex-shrink-0 flex flex-col bg-[#111111] border-r border-white/5 z-50 transition-transform overflow-hidden ${showMobileSidebar ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="p-4">
          <button 
            onClick={handleNewChat}
            className="w-full flex items-center gap-3 bg-surface-100 hover:bg-surface-200 text-zinc-100 border border-white/10 rounded-xl px-4 py-3 transition-all shadow-sm"
          >
            <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            <span className="font-medium text-sm">{t('sidebar.newChat')}</span>
          </button>
        </div>

        <div className="px-3 pb-3">
          <div className="relative">
            <input
              type="text"
              placeholder={t('sidebar.searchChats')}
              value={searchQuery}
              onChange={handleSearchChange}
              className="w-full px-3 py-2 pl-9 bg-surface-100 text-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/50 placeholder-zinc-500 border border-white/5"
            />
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            {searchQuery && (
              <button onClick={clearSearch} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300">×</button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-6">
          {searchQuery && searchResults.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-zinc-500 px-3 py-2 uppercase tracking-wider">{t('sidebar.searchResults')}</div>
              <div className="space-y-1">
                {searchResults.map((result) => (
                  <button
                    key={result.chatId}
                    onClick={() => {
                      navigate(`/chat/${result.chatId}?msg=${result.matchingMessages[0]?.messageIndex ?? 0}`);
                      setShowMobileSidebar(false);
                    }}
                    className={`w-full flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      currentChatId === result.chatId ? 'bg-surface-100/50 text-zinc-100 border border-white/5' : 'hover:bg-surface-100 text-zinc-400'
                    }`}
                  >
                    <span className="truncate">{result.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {searchQuery && searchResults.length === 0 && (
            <div className="rounded-xl border border-dashed border-white/10 bg-surface-100/30 px-4 py-5 text-sm text-zinc-500">
              {t('sidebar.noChatsMatched', { query: searchQuery })}
            </div>
          )}

          {!searchQuery && chats.length === 0 && (
            <div className="rounded-xl border border-dashed border-white/10 bg-surface-100/30 px-4 py-5 text-sm text-zinc-500">
              {t('sidebar.noChatsYet')}
            </div>
          )}

          {renderChatSection(t('sidebar.today'), groupedChats.today)}
          {renderChatSection(t('sidebar.previous7Days'), groupedChats.previous7Days)}
          {renderChatSection(t('sidebar.older'), groupedChats.older)}
        </div>

        <div className="p-4 border-t border-white/5">
          <button
            onClick={() => setShowMemoryManager(true)}
            className="w-full flex items-center gap-3 bg-transparent hover:bg-surface-100 text-zinc-400 hover:text-zinc-100 rounded-xl px-4 py-2.5 transition-all text-sm"
          >
            <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .52 8.105 4 4 0 0 0 7.327-2.258 M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.52 8.105 4 4 0 0 1-7.327-2.258 M12 5v17 M9 13a4.5 4.5 0 0 0 3-4 M15 13a4.5 4.5 0 0 1-3-4" />
            </svg>
            <span>{t('sidebar.memoryManager')}</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-full bg-[#141415] relative overflow-hidden">
        {/* Header */}
        <header className="sticky top-0 z-30 border-b border-white/5 bg-[#141415]/80 px-3 py-2 backdrop-blur-md md:h-14 md:px-4 md:py-0">
          <div className="flex items-center justify-between gap-2">
            <div className="relative flex min-w-0 items-center gap-2">
              <button
                onClick={() => setShowMobileSidebar(true)}
                className="rounded-lg p-2 transition-colors hover:bg-surface-100 md:hidden"
                aria-label="Open chats"
              >
                <svg className="size-5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              <div className="min-w-0 md:hidden">
                <div className="flex min-w-0 items-center gap-2">
                  <img
                    src={operatorLogo}
                    alt="Operator Chat logo"
                    className="size-8 object-contain"
                  />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-zinc-100">
                      {currentChat?.name ?? 'Operator Chat'}
                    </div>
                    <div className="truncate text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                      {currentModel || 'No model'}
                    </div>
                  </div>
                </div>
              </div>
              <div className="relative">
                <button
                  onClick={() => setShowModelDropdown(!showModelDropdown)}
                  className="hidden items-center gap-2 rounded-lg px-3 py-1.5 transition-colors hover:bg-surface-100 md:flex"
                >
                  <img
                    src={operatorLogo}
                    alt="Operator Chat logo"
                    className="size-8 object-contain"
                  />
                  <span className="max-w-[10rem] truncate text-lg font-semibold text-zinc-100 md:max-w-[16rem]">{currentModel || 'No model'}</span>
                  <svg className="size-4 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {showModelDropdown && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setShowModelDropdown(false)}
                    />
                    <div className="absolute left-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-xl border border-white/10 bg-[#1e1e20] shadow-lg">
                      <div className="py-1">
                        {models.length > 0 ? (
                          models.map((model) => (
                            <button
                              key={model}
                              onClick={() => {
                                handleModelChange(model);
                                setShowModelDropdown(false);
                              }}
                              className={`w-full flex items-center gap-3 px-4 py-2 text-left text-sm transition-colors ${
                                currentModel === model
                                  ? 'bg-brand/20 text-zinc-100'
                                  : 'text-zinc-300 hover:bg-surface-100'
                              }`}
                            >
                              {currentModel === model && (
                                <svg className="size-4 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                              <span className={currentModel === model ? '' : 'ml-1'}>{model}</span>
                            </button>
                          ))
                        ) : (
                          <div className="px-4 py-2 text-sm text-zinc-500">No models available</div>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1.5 md:gap-2">
              <button
                onClick={logout}
                className="rounded-lg p-2 transition-colors hover:bg-surface-100 text-zinc-400 hover:text-red-400"
                aria-label="Logout"
                title={`Logout (${user.username})`}
              >
                <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </button>
              <button
                onClick={() => setShowModelDropdown(!showModelDropdown)}
                className="flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-100 md:hidden"
                aria-label="Choose model"
              >
                <span className="max-w-[6.5rem] truncate">{currentModel || 'No model'}</span>
                <svg className="size-3.5 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              <button
                onClick={() => setShowSandbox(!showSandbox)}
                className={`rounded-lg border border-white/10 px-2.5 py-2 text-xs font-medium transition-colors md:px-3 md:py-1.5 md:text-sm ${showSandbox ? 'bg-brand text-white' : 'text-zinc-300 hover:bg-surface-100'}`}
              >
                Sandbox
              </button>
              <button
                onClick={() => setShowSettings(true)}
                className="rounded-lg p-2 transition-colors hover:bg-surface-100"
                aria-label="Open settings"
              >
                <svg className="size-5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
            </div>
          </div>
        </header>

        {/* Chat Content */}
        {currentChatId && currentSandboxId ? (
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
                <div className="fixed inset-x-0 bottom-0 top-24 z-30 flex flex-col rounded-t-[28px] border-t border-white/10 bg-[#111111] shadow-2xl shadow-black/40 md:static md:inset-auto md:w-full md:max-w-[400px] md:flex-shrink-0 md:rounded-none md:border-l md:border-t-0 md:border-white/5 md:shadow-none">
                  <div className="relative flex items-center justify-between border-b border-white/5 bg-[#111111] p-3">
                    <div className="absolute left-1/2 top-2 h-1.5 w-12 -translate-x-1/2 rounded-full bg-white/10 md:hidden" />
                    <h3 className="font-semibold text-zinc-100">{t('sandbox.title')}</h3>
                    <button
                      onClick={() => setShowSandbox(false)}
                      className="rounded-lg p-2 transition-colors hover:bg-surface-100"
                      aria-label="Close sandbox"
                    >
                      <svg className="size-5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  <SandboxExplorer sandboxId={currentSandboxId} />
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 sm:px-6">
            <div className="w-full max-w-3xl rounded-[28px] border border-white/10 bg-[radial-gradient(circle_at_top,_rgba(16,163,127,0.18),_transparent_55%),linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.01))] px-5 py-8 text-center shadow-2xl shadow-black/20 sm:px-8 sm:py-10">
              <img
                src={operatorLogo}
                alt="Operator Chat logo"
                className="mx-auto mb-4 size-20 object-contain"
              />
              <h1 className="mb-2 text-2xl font-semibold text-zinc-100">{t('chat.welcomeTitle')}</h1>
              <p className="mb-6 text-sm leading-6 text-zinc-400">{t('chat.welcomeDescription')}</p>
              <div className="mx-auto max-w-2xl">
                <div className="input-glow relative rounded-[22px] border border-white/10 bg-surface-100 text-left shadow-lg transition-all duration-200 sm:rounded-[24px]">
                  <input
                    ref={landingFileInputRef}
                    type="file"
                    onChange={(e) => setLandingFile(e.target.files?.[0] || null)}
                    className="hidden"
                  />
                  <div className="flex flex-wrap items-center gap-2 border-b border-white/5 px-3 pb-2 pt-3 sm:px-4">
                    <div className="relative" ref={landingToolPickerRef}>
                      <button
                        type="button"
                        onClick={() => setShowLandingToolPicker((prev) => !prev)}
                        className="inline-flex h-8 items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 text-xs font-medium text-zinc-200 hover:bg-surface-200"
                      >
                        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.5 6h9m-9 6h9m-9 6h9M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
                        </svg>
                        <span>{t('chat.tools')}</span>
                        <span className="text-zinc-500">{landingToolsLabel}</span>
                      </button>

                      {showLandingToolPicker && (
                        <div className="absolute bottom-full left-0 z-30 mb-2 w-[26rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-white/10 bg-[#1b1b1d] shadow-2xl shadow-black/40">
                          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                            <div>
                              <div className="text-sm font-semibold text-zinc-100">{t('chat.enabledTools')}</div>
                              <div className="text-xs text-zinc-500">{t('chat.landingToolsDescription')}</div>
                            </div>
                            <div className="flex items-center gap-2 text-xs">
                              <button type="button" onClick={enableAllLandingTools} className="text-zinc-400 hover:text-zinc-200">{t('common.all')}</button>
                              <button type="button" onClick={disableAllLandingTools} className="text-zinc-400 hover:text-zinc-200">{t('common.none')}</button>
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
                                  ? 'border-red-500/30 bg-red-500/10 text-red-200'
                                  : tool.policy.riskLevel === 'medium'
                                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                                    : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
                              return (
                                <div key={tool.name} className="rounded-xl border border-white/10 bg-black/20 p-3 transition-colors hover:border-white/20">
                                  <label className="flex cursor-pointer items-start gap-3">
                                    <input
                                      type="checkbox"
                                      checked={preference.enabled}
                                      onChange={() => toggleLandingTool(tool.name)}
                                      className="mt-0.5 h-4 w-4 rounded border-white/10 bg-[#27272a] text-brand focus:ring-brand/50"
                                    />
                                    <div className="min-w-0 flex-1 space-y-2">
                                      <div className="flex items-center gap-2">
                                        <div className="truncate text-sm font-semibold text-zinc-100">{tool.name}</div>
                                        <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase ${riskClass}`}>
                                          {tool.policy.riskLevel}
                                        </span>
                                      </div>
                                      <div className="text-xs leading-5 text-zinc-400">{tool.description}</div>
                                      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                                        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-zinc-300">
                                          sandbox: {tool.policy.sandboxPolicy}
                                        </span>
                                        {tool.policy.capabilities.map((capability) => (
                                          <span key={`${tool.name}-${capability}`} className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-zinc-400">
                                            {capability}
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  </label>
                                  <div className="mt-3 ml-7 flex items-center justify-between rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2">
                                    <span className="text-[11px] text-zinc-500">{t('chat.autoApprove')}</span>
                                    {tool.policy.supportsAutoApprove ? (
                                      <label className="flex items-center gap-2 text-[11px] text-zinc-300">
                                        <input
                                          type="checkbox"
                                          checked={preference.autoApprove}
                                          onChange={() => toggleLandingAutoApprove(tool.name)}
                                          disabled={!preference.enabled}
                                          className="h-4 w-4 rounded border-white/10 bg-[#27272a] text-brand focus:ring-brand/50 disabled:opacity-50"
                                        />
                                        <span>{tool.policy.requiresApproval ? t('chat.skipPromptForTool') : t('chat.alwaysAllowed')}</span>
                                      </label>
                                    ) : (
                                      <span className="text-[11px] text-zinc-600">{t('chat.disabledForHighRisk')}</span>
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
                      <span className="text-xs font-medium text-zinc-300">Reasoning:</span>
                      <select
                        value={landingReasoningEffort}
                        onChange={(e) => setLandingReasoningEffort(e.target.value as 'low' | 'medium' | 'high')}
                        className="h-8 rounded-full border border-white/10 bg-black/20 px-3 text-xs font-medium text-zinc-200 hover:bg-surface-200 focus:outline-none focus:ring-2 focus:ring-brand/50"
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
                    className="w-full min-h-[72px] max-h-[200px] resize-none bg-transparent px-4 pb-14 pt-3.5 text-sm leading-6 text-zinc-100 outline-none placeholder:text-zinc-500"
                    disabled={creatingChat}
                  />
                  {landingFile && (
                    <div className="px-4 pb-1 text-xs text-zinc-400">
                      Attached: <span className="text-zinc-200">{landingFile.name}</span>
                    </div>
                  )}
                  <div className="absolute bottom-2 right-2 flex items-center gap-2">
                    <button
                      onClick={triggerLandingFileInput}
                      disabled={creatingChat}
                      className="flex size-9 items-center justify-center rounded-xl text-zinc-400 transition-colors hover:bg-surface-200 hover:text-zinc-200 disabled:opacity-50"
                      aria-label="Attach file"
                    >
                      <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                      </svg>
                    </button>
                    <button
                      onClick={handleLandingSubmit}
                      disabled={(!landingInput.trim() && !landingFile) || creatingChat}
                      className="flex size-9 items-center justify-center rounded-xl bg-brand text-white shadow-md shadow-brand/20 transition-all hover:scale-105 hover:bg-brand-dark disabled:opacity-50 disabled:hover:scale-100"
                      aria-label="Start chat"
                    >
                      <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div className="mt-3 text-center text-[11px] font-medium text-zinc-500 sm:text-xs">
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

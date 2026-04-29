import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { Socket } from 'socket.io-client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { PluggableList } from 'unified';
import 'katex/dist/katex.min.css';
import { getAuthHeader } from '../services/auth';
import { generateUUID } from '../utils/uuid';
import CodeBlock, { PreBlock } from './CodeBlock';
import operatorLogo from '../assets/logo.png';

interface AgentStep {
  type: 'thought' | 'action' | 'observation' | 'mode_transition' | 'final_answer';
  content: string;
  actionName?: string;
  actionArgs?: Record<string, any>;
}

interface ChatTimings {
  prompt_n?: number;
  prompt_ms?: number;
  prompt_per_token_ms?: number;
  prompt_per_second?: number;
  predicted_n?: number;
  predicted_ms?: number;
  predicted_per_token_ms?: number;
  predicted_per_second?: number;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  agentSteps?: AgentStep[];
}

interface FinalAnswerTokenPayload {
  token: string;
  model?: string;
}

interface ChatInterfaceProps {
  socket: Socket | null;
  chatId: string;
  sandboxId: string;
  models: string[];
  currentModel: string;
  onModelChange: (model: string) => void;
  onChatNameChange: (chatId: string, name: string) => void;
  showStats: boolean;
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

interface ToolApprovalRequest {
  chatId: string;
  approvalId: string;
  toolName: string;
  toolArgs: Record<string, any>;
  policy: Tool['policy'];
}

interface ChatRouteState {
  initialMessage?: string;
  initialToolPreferences?: Record<string, ToolPreference>;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

interface ApprovalMode {
  alwaysApprove: boolean;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  model?: string;
}

function isInvalidAgentObservation(step: AgentStep) {
  return step.type === 'observation' && step.content.includes('Invalid agent turn:');
}

function normalizeAgentSteps(steps: AgentStep[], hasResolvedAssistantResponse: boolean) {
  const normalized: AgentStep[] = [];

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];

    if (isInvalidAgentObservation(step)) {
      let recoveryIndex = -1;
      for (let lookahead = index + 1; lookahead < steps.length; lookahead++) {
        const nextStep = steps[lookahead];
        if (isInvalidAgentObservation(nextStep)) {
          break;
        }
        if (nextStep.type === 'action' || nextStep.type === 'final_answer') {
          recoveryIndex = lookahead;
          break;
        }
      }

      if (recoveryIndex !== -1) {
        while (normalized.length > 0 && normalized[normalized.length - 1].type === 'thought') {
          normalized.pop();
        }
        index = recoveryIndex - 1;
        continue;
      }

      if (hasResolvedAssistantResponse) {
        while (normalized.length > 0 && normalized[normalized.length - 1].type === 'thought') {
          normalized.pop();
        }
        continue;
      }
    }

    normalized.push(step);
  }

  return normalized;
}

// Virtual scrolling configuration
const SCROLL_THRESHOLD = 300; // Pixels from bottom to show jump button
const markdownRemarkPlugins: PluggableList = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]];
const markdownRehypePlugins: PluggableList = [rehypeKatex];
const markdownComponents = { code: CodeBlock, pre: PreBlock };

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

function ChatInterface({ socket, chatId, sandboxId, models, currentModel, onModelChange, onChatNameChange, showStats }: ChatInterfaceProps) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [currentAgentSteps, setCurrentAgentSteps] = useState<AgentStep[]>([]);
  const [stats, setStats] = useState({ tokensPerSec: 0, contextSize: 0, promptTokensPerSec: 0 });
  const [startTime, setStartTime] = useState<number | null>(null);
  const [tokenCount, setTokenCount] = useState(0);
  const [serverTimings, setServerTimings] = useState<ChatTimings | null>(null);
  const [expandedThoughts, setExpandedThoughts] = useState<Set<number>>(new Set());
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingMessageIndex, setProcessingMessageIndex] = useState<number | null>(null);
  const [streamingThoughtContent, setStreamingThoughtContent] = useState('');
  const [currentStepType, setCurrentStepType] = useState<'thought' | 'action' | 'observation' | 'mode_transition' | 'final_answer' | null>(null);
  const [streamingContent, setStreamingContent] = useState('');
  const [uploading, setUploading] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [editingMessageIndex, setEditingMessageIndex] = useState<number | null>(null);
  const [editContent, setEditContent] = useState('');
  const [showRetryConfirm, setShowRetryConfirm] = useState<number | null>(null);
  const [showRetryDropdown, setShowRetryDropdown] = useState<number | null>(null);
  const [pendingRetryMessage, setPendingRetryMessage] = useState<{ content: string; idx: number } | null>(null);
  const [pendingRetryModel, setPendingRetryModel] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [highlightedMessage, setHighlightedMessage] = useState<number | null>(null);
  const [availableTools, setAvailableTools] = useState<Tool[]>([]);
  const [toolPreferences, setToolPreferences] = useState<Record<string, ToolPreference>>({});
  const [toolsLoaded, setToolsLoaded] = useState(false);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>({ alwaysApprove: false });
  const [showToolPicker, setShowToolPicker] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<ToolApprovalRequest | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<'low' | 'medium' | 'high'>('medium');
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Map<number, HTMLDivElement | null>>(new Map());
  const jumpButtonRef = useRef<HTMLButtonElement>(null);
  const distanceFromBottomRef = useRef(0);
  const toolPickerRef = useRef<HTMLDivElement>(null);
  
  // Refs for socket event handlers to avoid re-registering callbacks
  const messagesRef = useRef<ChatMessage[]>([]);
  const pendingRetryMessageRef = useRef<{ content: string; idx: number } | null>(null);
  const currentAgentStepsRef = useRef<AgentStep[]>([]);
  const showStatsRef = useRef(false);
  const serverTimingsRef = useRef<ChatTimings | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const tokenCountRef = useRef(0);
  const statsRef = useRef({ tokensPerSec: 0, contextSize: 0, promptTokensPerSec: 0 });
  const streamingChatIdRef = useRef<string | null>(null);
  const streamingThoughtContentRef = useRef('');
  const currentStepTypeRef = useRef<'thought' | 'action' | 'observation' | 'mode_transition' | 'final_answer' | null>(null);

  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const initialMessageSentRef = useRef(false);
  const initialRouteState = (location.state as ChatRouteState | null) ?? null;
  const enabledTools = availableTools.filter((tool) => toolPreferences[tool.name]?.enabled);
  const allToolsEnabled = availableTools.length > 0 && enabledTools.length === availableTools.length;
  const enabledToolCountLabel = availableTools.length === 0
    ? t('chat.noTools')
    : allToolsEnabled
      ? t('chat.allTools')
      : t('chat.toolCount', { count: enabledTools.length });

  const appendPendingThoughtToSteps = useCallback((steps: AgentStep[]): AgentStep[] => {
    const thought = streamingThoughtContentRef.current.trim();
    if (!thought || currentStepTypeRef.current !== 'thought') {
      return steps;
    }

    const lastStep = steps[steps.length - 1];
    if (lastStep?.type === 'thought' && lastStep.content.trim() === thought) {
      return steps;
    }

    return [...steps, { type: 'thought', content: thought }];
  }, []);

  const mergeToolPreferences = useCallback((
    tools: Tool[],
    incoming?: Record<string, ToolPreference>
  ): Record<string, ToolPreference> => {
    return tools.reduce((acc, tool) => {
      const preference = incoming?.[tool.name];
      acc[tool.name] = {
        enabled: preference?.enabled ?? true,
        autoApprove: tool.policy.supportsAutoApprove
          ? (preference?.autoApprove ?? !tool.policy.requiresApproval)
          : false,
      };
      return acc;
    }, {} as Record<string, ToolPreference>);
  }, []);

  // Handle scroll events - use ref to avoid re-renders
  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current) return;
    
    const scrollTop = scrollContainerRef.current.scrollTop;
    const viewportHeight = scrollContainerRef.current.clientHeight;
    const scrollHeight = scrollContainerRef.current.scrollHeight;
    
    // Calculate if we should show jump to bottom button
    distanceFromBottomRef.current = scrollHeight - scrollTop - viewportHeight;
    
    // Directly manipulate DOM to avoid re-render
    if (jumpButtonRef.current) {
      jumpButtonRef.current.style.display = distanceFromBottomRef.current > SCROLL_THRESHOLD ? 'flex' : 'none';
    }
  }, []);

  // Jump to bottom function
  const jumpToBottom = useCallback(() => {
    if (!scrollContainerRef.current) return;
    
    scrollContainerRef.current.scrollTo({
      top: scrollContainerRef.current.scrollHeight,
      behavior: 'smooth'
    });
    
    // Hide button after jumping
    if (jumpButtonRef.current) {
      jumpButtonRef.current.style.display = 'none';
    }
  }, []);

  // Socket event handlers - use refs to avoid re-registering callbacks
  useEffect(() => {
    if (!socket) return;

    const onMessage = (data: Message) => {
      if (data.role === 'user') {
        if (pendingRetryMessageRef.current) {
          setMessages((_prev) => {
            const updated = [..._prev];
            const idx = pendingRetryMessageRef.current!.idx;
            if (idx >= 0 && idx < updated.length) {
              updated[idx] = { ...updated[idx], agentSteps: [] };
            }
            return updated;
          });
          setProcessingMessageIndex(pendingRetryMessageRef.current!.idx);
          setPendingRetryMessage(null);
        } else {
          const newIndex = messagesRef.current.length;
          setMessages((prev) => [...prev, { ...data, id: generateUUID(), agentSteps: [] }]);
          setProcessingMessageIndex(newIndex);
        }
        if (showStatsRef.current) {
          setStartTime(null);
          setTokenCount(0);
        }
      } else {
        setMessages((prev) => {
          const updated = [...prev];
          const persistedSteps = appendPendingThoughtToSteps(currentAgentStepsRef.current);
          currentAgentStepsRef.current = persistedSteps;
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].role === 'user') {
              updated[i] = { ...updated[i], agentSteps: [...persistedSteps] };
              break;
            }
          }
          // Check if an assistant message already exists (created during streaming)
          let existingAssistantIndex = -1;
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].role === 'assistant') {
              existingAssistantIndex = i;
              break;
            }
          }
          // If assistant message exists, update it with the server's content
          if (existingAssistantIndex >= 0) {
            updated[existingAssistantIndex] = { ...updated[existingAssistantIndex], ...data, agentSteps: [] };
          } else {
            updated.push({ ...data, model: data.model ?? currentModel, id: generateUUID(), agentSteps: [] });
          }

          const latestAssistantIndex = existingAssistantIndex >= 0 ? existingAssistantIndex : updated.length - 1;
          const latestAssistant = updated[latestAssistantIndex];
          if (latestAssistant && latestAssistant.role === 'assistant') {
            updated[latestAssistantIndex] = {
              ...latestAssistant,
              model: data.model ?? latestAssistant.model ?? currentModel,
            };
          }
          return updated;
        });
        setProcessingMessageIndex(null);
        setStreamingContent('');
      }
    };

    const onAgentStep = (data: AgentStep) => {
      setCurrentAgentSteps((prev) => {
        const withPersistedThought = appendPendingThoughtToSteps(prev);
        const next = [...withPersistedThought, data];
        currentAgentStepsRef.current = next;
        return next;
      });
      setStreamingThoughtContent('');
      streamingThoughtContentRef.current = '';
      setCurrentStepType(null);
      currentStepTypeRef.current = null;
    };

    const onThoughtToken = (token: string) => {
      // Only process tokens for the currently active streaming chat
      if (streamingChatIdRef.current !== chatId) {
        return;
      }
      
      setCurrentStepType('thought');
      currentStepTypeRef.current = 'thought';
      setStreamingThoughtContent((prev) => {
        const next = prev + token;
        streamingThoughtContentRef.current = next;
        return next;
      });
      if (showStatsRef.current && !serverTimingsRef.current) {
        setTokenCount(prev => prev + Math.ceil(token.length / 4));
        if (!startTimeRef.current) setStartTime(Date.now());
      }
    };

    const onFinalAnswerToken = (data: FinalAnswerTokenPayload | string) => {
      // Only process tokens for the currently active streaming chat
      if (streamingChatIdRef.current !== chatId) {
        console.log(`Ignoring final-answer-token for chat ${streamingChatIdRef.current}, current chat is ${chatId}`);
        return;
      }
      
      const token = typeof data === 'string' ? data : data.token;
      const model = typeof data === 'string' ? undefined : data.model;
      // Stream final answer tokens directly to the assistant message content
      // This ensures the final answer appears outside the reasoning block
      setMessages((prev) => {
        const updated = [...prev];
        const targetUserIndex = processingMessageIndex ?? (() => {
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].role === 'user') return i;
          }
          return -1;
        })();

        if (targetUserIndex !== -1) {
          const nextMessage = updated[targetUserIndex + 1];
          if (nextMessage?.role === 'assistant') {
            updated[targetUserIndex + 1] = {
              ...nextMessage,
              content: nextMessage.content + token,
              model: nextMessage.model ?? model,
            };
          } else {
            updated.splice(targetUserIndex + 1, 0, {
              role: 'assistant',
              content: token,
              model,
              id: generateUUID(),
              agentSteps: [],
            });
          }
        }
        return updated;
      });
      if (showStatsRef.current && !serverTimingsRef.current) {
        setTokenCount(prev => prev + Math.ceil(token.length / 4));
        if (!startTimeRef.current) setStartTime(Date.now());
      }
    };

    const onAgentComplete = () => {
      const persistedSteps = appendPendingThoughtToSteps(currentAgentStepsRef.current);
      if (persistedSteps !== currentAgentStepsRef.current) {
        currentAgentStepsRef.current = persistedSteps;
        setCurrentAgentSteps(persistedSteps);
      }

      setMessages((prev) => {
        const updated = [...prev];
        const targetUserIndex = processingMessageIndex ?? (() => {
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].role === 'user') return i;
          }
          return -1;
        })();

        if (targetUserIndex !== -1 && updated[targetUserIndex]?.role === 'user') {
          updated[targetUserIndex] = {
            ...updated[targetUserIndex],
            agentSteps: [...persistedSteps],
          };
        }
        return updated;
      });

      setIsProcessing(false);
      setPendingApproval(null);
      setCurrentAgentSteps([]);
      setStreamingThoughtContent('');
      streamingThoughtContentRef.current = '';
      setStreamingContent('');
      streamingChatIdRef.current = null;
      currentStepTypeRef.current = null;
      if (showStatsRef.current) {
        if (serverTimingsRef.current?.predicted_per_second) {
          setStats({
            tokensPerSec: Math.round(serverTimingsRef.current.predicted_per_second),
            contextSize: serverTimingsRef.current.predicted_n || 0,
            promptTokensPerSec: serverTimingsRef.current.prompt_per_second ? Math.round(serverTimingsRef.current.prompt_per_second) : 0,
          });
        } else if (startTimeRef.current) {
          const elapsed = (Date.now() - startTimeRef.current) / 1000;
          if (elapsed > 0) {
            setStats({ tokensPerSec: Math.round(tokenCountRef.current / elapsed), contextSize: statsRef.current.contextSize, promptTokensPerSec: 0 });
          }
        }
        setStartTime(null);
        setTokenCount(0);
        setServerTimings(null);
      }
    };

    const onError = (data: { message: string }) => {
      console.error('Error:', data.message);
      setIsProcessing(false);
      setIsStopping(false);
      setCurrentAgentSteps([]);
      setProcessingMessageIndex(null);
      setStreamingThoughtContent('');
      streamingThoughtContentRef.current = '';
      setStreamingContent('');
      setPendingApproval(null);
      streamingChatIdRef.current = null;
      currentStepTypeRef.current = null;
    };

    const onAgentStopped = () => {
      setIsProcessing(false);
      setIsStopping(false);
      setStreamingThoughtContent('');
      streamingThoughtContentRef.current = '';
      setServerTimings(null);
      setPendingApproval(null);
      streamingChatIdRef.current = null;
      currentStepTypeRef.current = null;
    };

    const handleTimings = (timings: ChatTimings) => {
      if (showStatsRef.current) {
        setServerTimings(timings);
        if (timings.predicted_per_second) {
          setStats({
            tokensPerSec: Math.round(timings.predicted_per_second),
            contextSize: timings.predicted_n || 0,
            promptTokensPerSec: timings.prompt_per_second ? Math.round(timings.prompt_per_second) : 0,
          });
        }
      }
    };

    const handleToolApprovalRequired = (request: ToolApprovalRequest) => {
      if (request.chatId !== chatId) return;
      setPendingApproval(request);
    };

    const handleToolApprovalResolved = (data: { chatId: string; approvalId: string }) => {
      if (data.chatId !== chatId) return;
      setPendingApproval((current) => current?.approvalId === data.approvalId ? null : current);
    };

    const handleToolPreferencesUpdated = (data: { toolPreferences: Record<string, ToolPreference> }) => {
      setToolPreferences((current) => mergeToolPreferences(availableTools, { ...current, ...data.toolPreferences }));
    };

    const handleStepSaved = (data: { step: AgentStep; allSteps: AgentStep[] }) => {
      // Update current agent steps when a step is saved
      setCurrentAgentSteps(data.allSteps);
      // Also update the ref for consistency
      currentAgentStepsRef.current = data.allSteps;
    };

    const handleAgentState = (data: { steps: AgentStep[]; isComplete: boolean; finalAnswer?: string; model?: string; partialFinalAnswer?: string }) => {
      // Handle agent-state event emitted when client joins a chat with an active agent
      if (!data.isComplete && data.steps && data.steps.length > 0) {
        // Find the last user message that has agent steps (this is the message being processed)
        const messages = messagesRef.current;
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg?.role === 'user' && msg?.agentSteps && msg.agentSteps.length > 0) {
            // Check if there's an assistant message after this user message
            const nextMsg = messages[i + 1];
            const hasAssistantResponse = nextMsg?.role === 'assistant';
            if (!hasAssistantResponse) {
              // This is an ongoing response - restore processing state
              setIsProcessing(true);
              setProcessingMessageIndex(i);
              setCurrentAgentSteps(data.steps);
              currentAgentStepsRef.current = data.steps;
              
              // Restore partial final answer content if available
              if (data.partialFinalAnswer) {
                setStreamingContent(data.partialFinalAnswer);
                setCurrentStepType('final_answer');
                // Also restore to the assistant message if it exists
                setMessages((prev) => {
                  const updated = [...prev];
                  const nextMessage = updated[i + 1];
                  if (nextMessage?.role === 'assistant') {
                    updated[i + 1] = {
                      ...nextMessage,
                      content: data.partialFinalAnswer || '',
                    };
                  } else {
                    updated.splice(i + 1, 0, {
                      role: 'assistant',
                      content: data.partialFinalAnswer || '',
                      model: data.model,
                      id: generateUUID(),
                      agentSteps: [],
                    });
                  }
                  return updated;
                });
              }
              
              console.log(`Restored processing state from agent-state event for message index ${i} with ${data.steps.length} steps${data.partialFinalAnswer ? ' and partial final answer' : ''}`);
              break;
            }
          }
        }
      }
    };

    // Register all event handlers
    socket.on('message', onMessage);
    socket.on('agent-state', handleAgentState);
    socket.on('agent-step', onAgentStep);
    socket.on('thought-token', onThoughtToken);
    socket.on('final-answer-token', onFinalAnswerToken);
    socket.on('agent-complete', onAgentComplete);
    socket.on('error', onError);
    socket.on('agent-stopped', onAgentStopped);
    socket.on('timings', handleTimings);
    socket.on('tool-approval-required', handleToolApprovalRequired);
    socket.on('tool-approval-resolved', handleToolApprovalResolved);
    socket.on('tool-preferences-updated', handleToolPreferencesUpdated);
    socket.on('step-saved', handleStepSaved);

    // Join the chat room AFTER handlers are registered
    socket.emit('join-chat', chatId);
    console.log(`Joined chat room ${chatId} via WebSocket`);

    return () => {
      socket.off('message', onMessage);
      socket.off('agent-state', handleAgentState);
      socket.off('agent-step', onAgentStep);
      socket.off('thought-token', onThoughtToken);
      socket.off('final-answer-token', onFinalAnswerToken);
      socket.off('agent-complete', onAgentComplete);
      socket.off('error', onError);
      socket.off('agent-stopped', onAgentStopped);
      socket.off('timings', handleTimings);
      socket.off('tool-approval-required', handleToolApprovalRequired);
      socket.off('tool-approval-resolved', handleToolApprovalResolved);
      socket.off('tool-preferences-updated', handleToolPreferencesUpdated);
      socket.off('step-saved', handleStepSaved);
    };
  }, [appendPendingThoughtToSteps, availableTools, chatId, currentModel, mergeToolPreferences, processingMessageIndex, socket]);

  // Load messages from server (separate effect to avoid re-fetching on socket/tool changes)
  useEffect(() => {
    let isActive = true;

    const loadMessages = async () => {
      try {
        const res = await fetch(`/api/chat/${chatId}/messages`, {
          headers: getAuthHeader()
        });
        const data = await res.json();
        if (!isActive) return;

        console.log('Loaded messages:', {
          messageCount: data.messages?.length,
          agentState: data.agentState,
          hasAgentState: !!(data.agentState && data.agentState.steps && data.agentState.steps.length > 0),
          isComplete: data.agentState?.isComplete,
        });

        if (data.messages) {
          // Check if there's an ongoing response BEFORE setting messages state
          let processingIndex = null;
          let agentStepsToRestore: AgentStep[] = [];
          
          if (data.agentState && data.agentState.steps && data.agentState.steps.length > 0 && !data.agentState.isComplete) {
            // Find the last user message that has agent steps (this is the message being processed)
            const messages = data.messages;
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].role === 'user' && messages[i].agentSteps && messages[i].agentSteps.length > 0) {
                // Check if there's an assistant message after this user message
                const nextMessage = messages[i + 1];
                const hasAssistantResponse = nextMessage?.role === 'assistant';
                if (!hasAssistantResponse) {
                  // This is an ongoing response - restore processing state
                  processingIndex = i;
                  // Use agentState.steps from the server if available, otherwise use message's agentSteps
                  agentStepsToRestore = data.agentState.steps.length > messages[i].agentSteps.length 
                    ? data.agentState.steps 
                    : messages[i].agentSteps;
                  console.log(`Found ongoing response at message index ${i}, restoring with ${agentStepsToRestore.length} steps`);
                  break;
                }
              }
            }
          }
          
          // Set all state at once to ensure consistency
          setMessages(data.messages);
          setPendingApproval(data.pendingApproval?.chatId === chatId ? data.pendingApproval : null);
          if (processingIndex !== null) {
            setIsProcessing(true);
            setProcessingMessageIndex(processingIndex);
            setCurrentAgentSteps(agentStepsToRestore);
            
            // Restore partial final answer content if available
            if (data.agentState?.partialFinalAnswer) {
              setStreamingContent(data.agentState.partialFinalAnswer);
              setCurrentStepType('final_answer');
              console.log(`Restored processing state: isProcessing=true, processingMessageIndex=${processingIndex}, agentSteps=${agentStepsToRestore.length}, partialFinalAnswer length=${data.agentState.partialFinalAnswer.length}`);
            } else {
              console.log(`Restored processing state: isProcessing=true, processingMessageIndex=${processingIndex}, agentSteps=${agentStepsToRestore.length}`);
            }
          }
        }
      } catch (error) {
        if (!isActive) return;
        console.error('Failed to load messages:', error);
      }
    };

    loadMessages();

    // Scroll to bottom after messages are loaded
    const timer = setTimeout(() => {
      if (!isActive) return;
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTo({
          top: scrollContainerRef.current.scrollHeight,
          behavior: 'smooth'
        });
      }
    }, 100);
    
    return () => {
      isActive = false;
      clearTimeout(timer);
    };
  }, [chatId]);

  useEffect(() => {
    let isActive = true;
    setToolsLoaded(false);

    const loadTools = async () => {
      try {
        const res = await fetch('/api/tools', {
          headers: getAuthHeader()
        });
        const data = await res.json();
        if (!isActive) return;

        const tools = Array.isArray(data) ? data : [];
        setAvailableTools(tools);
        const prefsRes = await fetch(`/api/chat/${chatId}/messages`, {
          headers: getAuthHeader()
        });
        const prefsData = await prefsRes.json();
        if (!isActive) return;
        setToolPreferences(mergeToolPreferences(tools, prefsData.toolPreferences));
        setToolsLoaded(true);
      } catch (error) {
        if (!isActive) return;
        console.error('Failed to load tools:', error);
        setAvailableTools([]);
        setToolPreferences({});
        setToolsLoaded(true);
      }
    };

    loadTools();

    return () => {
      isActive = false;
    };
  }, [chatId, mergeToolPreferences]);

  useEffect(() => {
    if (!initialRouteState?.initialToolPreferences || availableTools.length === 0) {
      return;
    }

    setToolPreferences((current) => {
      const nextPreferences = mergeToolPreferences(availableTools, initialRouteState.initialToolPreferences);
      return JSON.stringify(current) === JSON.stringify(nextPreferences) ? current : nextPreferences;
    });
  }, [availableTools, initialRouteState?.initialToolPreferences, mergeToolPreferences]);

  // Load initial reasoning effort from route state or localStorage
  useEffect(() => {
    if (initialRouteState?.reasoningEffort) {
      setReasoningEffort(initialRouteState.reasoningEffort);
    } else {
      const stored = window.localStorage.getItem(`chat-reasoning-effort:${chatId}`);
      if (stored === 'low' || stored === 'medium' || stored === 'high') {
        setReasoningEffort(stored);
      }
    }
  }, [chatId, initialRouteState?.reasoningEffort]);

  // Persist reasoning effort to localStorage
  useEffect(() => {
    window.localStorage.setItem(`chat-reasoning-effort:${chatId}`, reasoningEffort);
  }, [chatId, reasoningEffort]);

  useEffect(() => {
    if (!showToolPicker) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (toolPickerRef.current && !toolPickerRef.current.contains(event.target as Node)) {
        setShowToolPicker(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowToolPicker(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [showToolPicker]);

  // Handle msg parameter for highlighting
  useEffect(() => {
    const msgParam = searchParams.get('msg');
    if (msgParam !== null) {
      const targetIndex = parseInt(msgParam, 10);
      if (!isNaN(targetIndex)) {
        setHighlightedMessage(targetIndex);
        setTimeout(() => {
          const targetRef = messageRefs.current.get(targetIndex);
          if (targetRef) {
            targetRef.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => setHighlightedMessage(null), 2000);
          }
        }, 100);
      }
    }
  }, [chatId, searchParams]);

  // Auto-scroll to bottom on new messages (only if already at bottom)
  useEffect(() => {
    if (!scrollContainerRef.current) return;
    
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 300;
    
    if (isNearBottom) {
      scrollContainerRef.current.scrollTo({ top: scrollContainerRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages]);

  // Update refs when state changes
  useEffect(() => {
    messagesRef.current = messages;
    pendingRetryMessageRef.current = pendingRetryMessage;
    currentAgentStepsRef.current = currentAgentSteps;
    showStatsRef.current = showStats;
    serverTimingsRef.current = serverTimings;
    startTimeRef.current = startTime;
    tokenCountRef.current = tokenCount;
    statsRef.current = stats;
    streamingThoughtContentRef.current = streamingThoughtContent;
    currentStepTypeRef.current = currentStepType;
  });

  // Clear streaming state when switching chats
  useEffect(() => {
    // If we're switching to a different chat and there's an active stream for a different chat,
    // clear the streaming state to prevent stale data
    if (streamingChatIdRef.current && streamingChatIdRef.current !== chatId) {
      console.log(`Switching from chat ${streamingChatIdRef.current} to ${chatId}, clearing streaming state`);
      streamingChatIdRef.current = null;
      setStreamingThoughtContent('');
      streamingThoughtContentRef.current = '';
      setStreamingContent('');
      setCurrentStepType(null);
      currentStepTypeRef.current = null;
    }
  }, [chatId]);

  useEffect(() => {
    if (!textareaRef.current) return;

    textareaRef.current.style.height = '0px';
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
  }, [input]);

  const sendMessageContent = useCallback((
    message: string,
    overrides?: {
      toolPreferences?: Record<string, ToolPreference>;
      reasoningEffort?: 'low' | 'medium' | 'high';
    }
  ) => {
    if (!message.trim() || !socket) return false;
    if (!messagesRef.current.some((existingMessage) => existingMessage.role === 'user')) {
      onChatNameChange(chatId, getChatNameFromQuery(message));
    }
    setIsProcessing(true);
    setIsStopping(false);
    setCurrentAgentSteps([]);
    setStreamingThoughtContent('');
    streamingThoughtContentRef.current = '';
    setStreamingContent('');
    currentStepTypeRef.current = null;
    streamingChatIdRef.current = chatId;
    if (showStats) {
      setStartTime(null);
      setTokenCount(0);
    }
    const language = i18n.language || 'en';
    socket.emit('send-message', {
      chatId,
      message: message.trim(),
      model: currentModel,
      toolPreferences: overrides?.toolPreferences ?? toolPreferences,
      approvalMode,
      language,
      reasoningEffort: overrides?.reasoningEffort ?? reasoningEffort,
    });
    return true;
  }, [approvalMode, chatId, currentModel, onChatNameChange, showStats, socket, toolPreferences, reasoningEffort]);

  useEffect(() => {
    const initialMessage = initialRouteState?.initialMessage;
    if (!initialMessage || !socket || initialMessageSentRef.current) return;
    if (!toolsLoaded) return;

    const initialToolPreferences = initialRouteState?.initialToolPreferences
      ? mergeToolPreferences(availableTools, initialRouteState.initialToolPreferences)
      : toolPreferences;
    if (availableTools.length > 0 && Object.keys(initialToolPreferences).length === 0) return;

    setToolPreferences((current) =>
      JSON.stringify(current) === JSON.stringify(initialToolPreferences)
        ? current
        : initialToolPreferences
    );

    const sent = sendMessageContent(initialMessage, {
      toolPreferences: initialToolPreferences,
      reasoningEffort: initialRouteState?.reasoningEffort,
    });
    if (!sent) return;

    initialMessageSentRef.current = true;
    navigate(location.pathname, { replace: true, state: null });
  }, [availableTools, initialRouteState, location.pathname, mergeToolPreferences, navigate, sendMessageContent, socket, toolPreferences, toolsLoaded]);


  const startEditing = (idx: number, content: string) => {
    setEditingMessageIndex(idx);
    setEditContent(content);
  };

  const cancelEditing = () => {
    setEditingMessageIndex(null);
    setEditContent('');
  };

  const saveEdit = async (idx: number) => {
    if (!editContent.trim()) return;

    try {
      const retryRes = await fetch(`/api/chat/${chatId}/retry-from/${idx}`, { 
        method: 'POST',
        headers: getAuthHeader()
      });
      const retryData = await retryRes.json();
      if (!retryData.success) {
        alert('Rollback failed: ' + retryData.error);
        return;
      }

      const editRes = await fetch(`/api/chat/${chatId}/messages/${idx}`, {
        method: 'PATCH',
        headers: { 
          'Content-Type': 'application/json',
          ...getAuthHeader()
        },
        body: JSON.stringify({ content: editContent }),
      });

      const editData = await editRes.json();
      if (!editData.success) {
        alert('Edit failed: ' + editData.error);
        return;
      }

      setMessages(_ => {
        const updated = [...retryData.messages];
        updated[idx] = { ...updated[idx], content: editContent };
        return updated;
      });
      setEditingMessageIndex(null);
      setEditContent('');
      setPendingRetryMessage({ content: editContent, idx });

      if (socket && !isProcessing) {
        setIsProcessing(true);
        setIsStopping(false);
        setCurrentAgentSteps([]);
        setStreamingThoughtContent('');
        setStreamingContent('');
        socket.emit('send-message', { chatId, message: editContent, toolPreferences, approvalMode });
      }
    } catch (error) {
      console.error('Failed to edit message:', error);
    }
  };

  const confirmRetry = (idx: number, model: string = currentModel) => {
    setShowRetryConfirm(idx);
    setPendingRetryModel(model);
  };
  const cancelRetry = () => {
    setShowRetryConfirm(null);
    setPendingRetryModel(null);
  };

  const executeRetry = async (idx: number, model: string) => {
    try {
      const res = await fetch(`/api/chat/${chatId}/retry-from/${idx}`, { 
        method: 'POST',
        headers: getAuthHeader()
      });
      const data = await res.json();
      if (!data.success) {
        alert('Rollback failed: ' + data.error);
        return;
      }
      if (model !== currentModel) {
        onModelChange(model);
      }
      setMessages(data.messages);
      setShowRetryConfirm(null);
      setPendingRetryModel(null);
      setPendingRetryMessage({ content: data.message.content, idx });
      if (socket && !isProcessing) {
        setIsProcessing(true);
        setIsStopping(false);
        setCurrentAgentSteps([]);
        setStreamingThoughtContent('');
        setStreamingContent('');
        socket.emit('send-message', { chatId, message: data.message.content, toolPreferences, approvalMode });
      }
    } catch (error) {
      console.error('Failed to retry:', error);
    }
  };

  const toggleRetryDropdown = (idx: number) => {
    setShowRetryDropdown(prev => prev === idx ? null : idx);
  };
  const closeRetryDropdown = () => setShowRetryDropdown(null);

  const copyToClipboard = async (content: string, messageId: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessageId(messageId);
      setTimeout(() => setCopiedMessageId(null), 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/sandbox/${sandboxId}/upload`, { 
        method: 'POST', 
        headers: getAuthHeader(),
        body: formData 
      });
      const data = await res.json();
      if (data.success) {
        const notification = `📁 File uploaded: ${data.filename} (${(data.size / 1024).toFixed(2)} KB)`;
        setInput((prev) => prev + notification);
      } else {
        alert('Upload failed: ' + data.error);
      }
    } catch (error) {
      console.error('Failed to upload file:', error);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const triggerFileInput = () => fileInputRef.current?.click();

  const toggleTool = (toolName: string) => {
    setToolPreferences((prev) => ({
      ...prev,
      [toolName]: {
        enabled: !(prev[toolName]?.enabled ?? true),
        autoApprove: prev[toolName]?.autoApprove ?? false,
      },
    }));
  };

  const toggleAutoApprove = (toolName: string) => {
    setToolPreferences((prev) => ({
      ...prev,
      [toolName]: {
        enabled: prev[toolName]?.enabled ?? true,
        autoApprove: !(prev[toolName]?.autoApprove ?? false),
      },
    }));
  };

  const enableAllTools = () => {
    setToolPreferences((prev) => mergeToolPreferences(
      availableTools,
      Object.fromEntries(
        availableTools.map((tool) => [
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

  const disableAllTools = () => {
    setToolPreferences((prev) => mergeToolPreferences(
      availableTools,
      Object.fromEntries(
        availableTools.map((tool) => [
          tool.name,
          {
            enabled: false,
            autoApprove: tool.policy.supportsAutoApprove ? (prev[tool.name]?.autoApprove ?? false) : false,
          },
        ])
      )
    ));
  };

  const respondToApproval = (approved: boolean, rememberAutoApprove: boolean = false) => {
    if (!socket || !pendingApproval) return;

    if (approved && rememberAutoApprove) {
      setToolPreferences((prev) => ({
        ...prev,
        [pendingApproval.toolName]: {
          enabled: prev[pendingApproval.toolName]?.enabled ?? true,
          autoApprove: true,
        },
      }));
    }

    socket.emit('tool-approval-response', {
      chatId: pendingApproval.chatId,
      approvalId: pendingApproval.approvalId,
      approved,
      reason: approved ? 'approved' : 'denied',
      rememberAutoApprove,
      toolName: pendingApproval.toolName,
    });
    setPendingApproval(null);
  };

  const sendMessage = () => {
    if (!input.trim() || !socket || isProcessing) return;
    const message = input;
    setInput('');
    sendMessageContent(message);
  };

  const stopAgent = () => {
    if (!socket || !isProcessing || isStopping) return;
    setIsStopping(true);
    socket.emit('stop-agent', chatId);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const toggleThoughts = (idx: number) => {
    setExpandedThoughts((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(idx)) newSet.delete(idx);
      else newSet.add(idx);
      return newSet;
    });
  };

  const formatToolLabel = (value: string) =>
    value
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());

  const tryParseJson = (value: string) => {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  const renderStructuredValue = (value: unknown): React.ReactNode => {
    if (value === null || value === undefined || value === '') {
      return <span className="text-zinc-500">Empty</span>;
    }

    if (Array.isArray(value)) {
      return (
        <div className="flex flex-wrap gap-2">
          {value.map((item, index) => (
            <span
              key={`${String(item)}-${index}`}
              className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[11px] text-zinc-300"
            >
              {typeof item === 'object' ? JSON.stringify(item) : String(item)}
            </span>
          ))}
        </div>
      );
    }

    if (typeof value === 'object') {
      return (
        <div className="overflow-hidden rounded-xl border border-white/5 bg-black/20">
          <div className="max-h-64 overflow-auto p-3">
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-zinc-300">
              {JSON.stringify(value, null, 2)}
            </pre>
          </div>
        </div>
      );
    }

    const stringValue = String(value);
    if (stringValue.includes('\n')) {
      return (
        <div className="overflow-hidden rounded-xl border border-white/5 bg-black/20">
          <div className="max-h-64 overflow-auto p-3">
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-zinc-300">
              {stringValue}
            </pre>
          </div>
        </div>
      );
    }

    return <span className="text-zinc-200">{stringValue}</span>;
  };

  const renderActionArgs = (args?: Record<string, any>) => {
    if (!args || Object.keys(args).length === 0) {
      return null;
    }

    return (
      <div className="mt-3 grid gap-2">
        {Object.entries(args).map(([key, value]) => (
          <div
            key={key}
            className="rounded-xl border border-white/5 bg-black/20 px-3 py-2.5"
          >
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
              {formatToolLabel(key)}
            </div>
            {renderStructuredValue(value)}
          </div>
        ))}
      </div>
    );
  };

  const renderObservationContent = (content: string) => {
    const trimmed = content.trim();
    const parsedJson = tryParseJson(trimmed);

    if (parsedJson) {
      return renderStructuredValue(parsedJson);
    }

    const searchResultPattern = /^\d+\.\s/m.test(trimmed) && /URL:\s+/m.test(trimmed);
    if (searchResultPattern) {
      const chunks = trimmed.split(/\n\s*\n/).filter(Boolean);
      return (
        <div className="mt-3 space-y-3">
          {chunks.map((chunk, index) => {
            const lines = chunk.split('\n');
            const heading = lines[0] ?? '';
            const urlLine = lines.find((line) => line.trim().startsWith('URL:'));
            const contentLine = lines.find((line) => line.trim().startsWith('Content:'));
            return (
              <div key={`${heading}-${index}`} className="rounded-xl border border-white/5 bg-black/20 p-3">
                <div className="text-sm font-medium text-zinc-100">{heading.replace(/^\d+\.\s*/, '')}</div>
                {urlLine && <div className="mt-1 text-xs text-brand">{urlLine.replace(/^URL:\s*/, '').trim()}</div>}
                {contentLine && <div className="mt-2 text-xs leading-5 text-zinc-400">{contentLine.replace(/^Content:\s*/, '').trim()}</div>}
              </div>
            );
          })}
        </div>
      );
    }

    const prefixedBlock = trimmed.match(/^(Contents of|File contents of|Result:|Tool result:|Successfully .+?:?|Directory .+? is empty\.|Awaiting user approval.+?|Tool execution denied.+?)([\s\S]*)$/i);
    if (prefixedBlock) {
      const heading = prefixedBlock[1].trim();
      const rest = prefixedBlock[2].trim();
      return (
        <div className="mt-3 rounded-xl border border-white/5 bg-black/20 px-3 py-3">
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">
            {heading}
          </div>
          {rest ? (
            <div className="mt-2 text-sm text-zinc-300">
              <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>
                {rest}
              </ReactMarkdown>
            </div>
          ) : null}
        </div>
      );
    }

    return (
      <div className="mt-3 rounded-xl border border-white/5 bg-black/20 px-3 py-3">
        <div className="text-sm prose prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>
            {trimmed}
          </ReactMarkdown>
        </div>
      </div>
    );
  };

  const renderAgentStep = (step: AgentStep, idx: number) => {
    if (step.type === 'thought') {
      return (
        <div key={idx} className="rounded-2xl border border-white/5 bg-black/20 p-3">
          <span className="font-medium text-xs uppercase tracking-wide text-zinc-400">{t('chat.thought')}</span>
          <div className="mt-3 text-sm prose prose-invert max-w-none text-zinc-300">
            <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>{step.content}</ReactMarkdown>
          </div>
        </div>
      );
    }
    if (step.type === 'action') {
      return (
        <div key={idx} className="rounded-2xl border border-white/5 bg-black/20 p-3">
          <div className="flex items-center gap-2">
            <span className="font-medium text-xs uppercase tracking-wide text-zinc-400">{t('chat.toolCall')}</span>
            {step.actionName && (
              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-zinc-200">
                {step.actionName}
              </span>
            )}
          </div>
          {renderActionArgs(step.actionArgs)}
        </div>
      );
    }
    if (step.type === 'observation') {
      return (
        <div key={idx} className="rounded-2xl border border-white/5 bg-black/20 p-3">
          <span className="font-medium text-xs uppercase tracking-wide text-zinc-400">{t('chat.observation')}</span>
          {renderObservationContent(step.content)}
        </div>
      );
    }
    if (step.type === 'mode_transition') {
      return (
        <div key={idx} className="rounded-2xl border border-blue-500/30 bg-blue-500/10 p-3">
          <div className="flex items-center gap-2">
            <svg className="size-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
            <span className="font-medium text-xs uppercase tracking-wide text-blue-400">{t('chat.modeTransition')}</span>
          </div>
          <div className="mt-2 text-sm text-zinc-300">
            Switched to <span className="font-semibold text-blue-300">{step.content}</span>
          </div>
        </div>
      );
    }
    if (step.type === 'final_answer') {
      return (
        <div key={idx} className="border-l-2 border-purple-500/50 pl-3 py-2">
          <span className="text-purple-400 font-medium text-xs uppercase tracking-wide">{t('chat.finalAnswer')}</span>
          <div className="text-zinc-100 mt-1 prose prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>{step.content}</ReactMarkdown>
          </div>
        </div>
      );
    }
    return null;
  };

  const renderReasoningLog = (idx: number) => {
    const msg = messages[idx];
    const isProcessingMsg = idx === processingMessageIndex;
    
    const allSteps = isProcessingMsg ? currentAgentSteps : (msg?.agentSteps || []);
    const hasResolvedAssistantResponse = !isProcessingMsg && messages[idx + 1]?.role === 'assistant';
    const stepsToDisplay = normalizeAgentSteps(allSteps, hasResolvedAssistantResponse).filter(step => step.type !== 'final_answer');
    const hasSteps = stepsToDisplay.length > 0;
    
    if (!msg || msg.role !== 'user' && !isProcessingMsg) return null;
    
    const thoughtsExpanded = expandedThoughts.has(idx);
    const currentStep = stepsToDisplay.length > 0 ? stepsToDisplay[stepsToDisplay.length - 1] : null;
    const hasStreaming = isProcessingMsg && (streamingThoughtContent || streamingContent);
    
    let truncatedContent = '';
    let truncatedType = '';
    
    if (hasStreaming) {
      if (currentStepType === 'thought') {
        truncatedContent = streamingThoughtContent;
        truncatedType = 'Thought';
      } else if (currentStepType === 'observation') {
        truncatedContent = streamingContent;
        truncatedType = 'Observation';
      }
    } else if (currentStep) {
      truncatedContent = currentStep.content;
      truncatedType = currentStep.type === 'thought' ? 'Thought' : 
                       currentStep.type === 'action' ? 'Tool Call' :
                       currentStep.type === 'observation' ? 'Observation' : 'Final Answer';
    }

    if (!hasSteps && !hasStreaming) return null;

    if (!thoughtsExpanded) {
      return (
        <div key={`reasoning-${idx}`} className="max-w-3xl mx-auto">
          <div className="bg-surface-100/50 rounded-xl p-3 border border-white/5 max-w-full">
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-zinc-400">
                <svg className="size-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                <span className="text-xs font-medium uppercase tracking-wide">{truncatedType}</span>
                {hasStreaming && <span className="inline-block w-1.5 h-1.5 bg-current rounded-full animate-pulse" />}
              </div>
              <div className="relative max-h-[3.75rem] overflow-hidden">
                <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent via-[rgba(24,24,27,0.45)] to-[rgba(24,24,27,0.92)] pointer-events-none z-10" />
                <div className="text-zinc-400 text-xs">
                  <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>{truncatedContent}</ReactMarkdown>
                </div>
              </div>
            </div>
            <button
              onClick={() => toggleThoughts(idx)}
              className="flex items-center gap-1.5 text-zinc-500 hover:text-zinc-300 text-xs mt-2 transition-colors"
            >
              <svg className="size-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
              {t('chat.showAllSteps', { count: stepsToDisplay.length, plural: stepsToDisplay.length !== 1 ? 's' : '' })}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div key={`reasoning-${idx}`} className="max-w-3xl mx-auto space-y-2">
        <div className="max-w-full break-words space-y-2 rounded-xl border border-white/5 bg-surface-100/50 p-3 sm:max-w-full sm:p-4">
          {stepsToDisplay.map((step, stepIdx) => renderAgentStep(step, stepIdx))}
          {isProcessingMsg && streamingThoughtContent && currentStepType === 'thought' && (
            <div className="rounded-2xl border border-white/5 bg-black/20 p-3">
              <span className="font-medium text-xs uppercase tracking-wide text-zinc-400">{t('chat.thought')}</span>
              <div className="mt-3 text-sm prose prose-invert max-w-none text-zinc-300">
                <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>{streamingThoughtContent}</ReactMarkdown>
                <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-zinc-400" />
              </div>
            </div>
          )}
          {isProcessingMsg && streamingContent && currentStepType === 'observation' && (
            <div className="rounded-2xl border border-white/5 bg-black/20 p-3">
              <span className="font-medium text-xs uppercase tracking-wide text-zinc-400">{t('chat.observation')}</span>
              <div className="mt-3 text-sm prose prose-invert max-w-none text-zinc-300">
                <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>{streamingContent}</ReactMarkdown>
                <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-zinc-400" />
              </div>
            </div>
          )}
          <button
            onClick={() => toggleThoughts(idx)}
            className="flex items-center gap-2 pt-1 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 15l-7-7-7 7" />
            </svg>
            {t('chat.hideSteps')}
          </button>
        </div>
      </div>
    );
  };

  const renderMessage = (msg: ChatMessage, idx: number) => {
    const isUser = msg.role === 'user';
    const isProcessingMsg = idx === processingMessageIndex;
    const isEditing = editingMessageIndex === idx;
    const isHighlighted = highlightedMessage === idx;
    const isFirstMessage = idx === 0;
    const assistantModel = !isUser
      ? (msg.model ?? (processingMessageIndex !== null && idx === processingMessageIndex + 1 ? currentModel : undefined))
      : undefined;

    return (
      <div
        key={msg.id || idx}
        ref={(el) => messageRefs.current.set(idx, el)}
        className={`mx-auto flex max-w-3xl gap-3 transition-colors sm:gap-4 ${isHighlighted ? 'bg-brand/10 -mx-2 rounded-2xl px-2 py-2 ring-1 ring-brand/20 sm:-mx-4 sm:px-4' : ''} ${isFirstMessage ? 'pt-8' : ''}`}
        style={isFirstMessage ? { paddingTop: '1rem', marginTop: '20px' } : {}}
      >
        <div className="flex-1 min-w-0 space-y-4 text-zinc-300 text-sm leading-relaxed mt-1">
          {isEditing ? (
            <div>
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="w-full bg-surface-200 text-zinc-100 p-3 rounded-xl border border-white/10 focus:outline-none focus:ring-2 focus:ring-brand/50 min-h-[100px]"
              />
              <div className="flex gap-2 mt-2">
                <button onClick={() => saveEdit(idx)} className="bg-brand text-white px-4 py-2 rounded-lg text-sm hover:bg-brand-dark">{t('common.save')}</button>
                <button onClick={cancelEditing} className="bg-surface-200 text-zinc-300 px-4 py-2 rounded-lg text-sm hover:bg-surface-300">{t('common.cancel')}</button>
              </div>
            </div>
          ) : (
            <div className={`w-fit min-w-0 max-w-full break-words rounded-2xl px-4 py-3 shadow-sm word-break max-w-full sm:px-5 sm:py-3.5 ${
              isUser ? 'bg-surface-200 text-zinc-100' : 'bg-transparent text-zinc-100 rounded-tl-sm'
            }`}>
              {isUser ? (
                <div className="max-w-full min-w-0 whitespace-pre-wrap break-words">
                  {msg.content}
                </div>
              ) : (
                <div className="max-w-full min-w-0">
                  {assistantModel && (
                    <div className="mb-3 flex items-center">
                      <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
                        {assistantModel}
                      </span>
                    </div>
                  )}
                  <div className="prose prose-invert max-w-full break-words min-w-0">
                    <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>{msg.content}</ReactMarkdown>
                  </div>
                  {!assistantModel && !msg.content && processingMessageIndex !== null && idx === processingMessageIndex + 1 && (
                    <div className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
                      {currentModel}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {!isEditing && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <button
                onClick={() => copyToClipboard(msg.content, msg.id || `msg-${idx}`)}
                className="text-zinc-500 hover:text-zinc-300 text-xs flex items-center gap-1"
              >
                {copiedMessageId === msg.id ? t('common.copied') : t('common.copy')}
              </button>
              <button
                onClick={() => startEditing(idx, msg.content)}
                className="text-zinc-500 hover:text-zinc-300 text-xs flex items-center gap-1"
              >
                {t('common.edit')}
              </button>
              <div className="relative">
                <button
                  onClick={() => toggleRetryDropdown(idx)}
                  className="text-zinc-500 hover:text-zinc-300 text-xs flex items-center gap-1"
                >
                  {t('common.retry')}
                  <svg className="size-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {showRetryDropdown === idx && (
                  <>
                    <div 
                      className="fixed inset-0 z-40"
                      onClick={closeRetryDropdown}
                    />
                    <div className="absolute bottom-full left-0 mb-2 w-64 bg-[#1e1e20] border border-white/10 rounded-lg shadow-lg z-50 overflow-hidden">
                      <div className="py-1 max-h-64 overflow-y-auto">
                        <button
                          onClick={() => {
                            confirmRetry(idx, currentModel);
                            setShowRetryDropdown(null);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors text-zinc-300 hover:bg-surface-100"
                        >
                          <svg className="size-4 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                          <span>{t('chat.retryWith', { model: currentModel })}</span>
                        </button>
                        {models.filter(m => m !== currentModel).map((model) => (
                          <button
                            key={model}
                            onClick={() => {
                              confirmRetry(idx, model);
                              setShowRetryDropdown(null);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors text-zinc-300 hover:bg-surface-100"
                          >
                            <svg className="size-4 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                            <span>{t('chat.retryWith', { model })}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {isProcessingMsg && (
            <div className="flex items-center gap-2 text-zinc-500 text-xs">
              <div className="w-2 h-2 bg-brand rounded-full animate-pulse" />
              {t('common.processing')}
            </div>
          )}
        </div>
      </div>
    );
  };

  // Memoize rendered messages
  const renderedMessages = useMemo(() => {
    return messages.map((msg, idx) => (
      <React.Fragment key={msg.id || idx}>
        {renderMessage(msg, idx)}
        {renderReasoningLog(idx)}
      </React.Fragment>
    ));
  }, [messages, currentAgentSteps, processingMessageIndex, expandedThoughts, streamingThoughtContent, 
      streamingContent, currentStepType, editingMessageIndex, editContent, showRetryDropdown,
      copiedMessageId, highlightedMessage, isProcessing]);

  const isEmptyState = messages.length === 0 && !isProcessing;

  const renderComposer = (extraClassName = '') => (
    <div className={`input-glow relative rounded-[22px] border border-white/10 bg-surface-100 shadow-lg transition-all duration-200 sm:rounded-[24px] ${extraClassName}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-white/5 px-3 pb-2 pt-3 sm:px-4">
        <div className="relative" ref={toolPickerRef}>
          <button
            type="button"
            onClick={() => setShowToolPicker((prev) => !prev)}
            className="inline-flex h-8 items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 text-xs font-medium text-zinc-200 hover:bg-surface-200"
          >
            <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.5 6h9m-9 6h9m-9 6h9M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
            </svg>
            <span>{t('chat.tools')}</span>
            <span className="text-zinc-500">{enabledToolCountLabel}</span>
          </button>

          {showToolPicker && (
            <div className="absolute bottom-full left-0 z-30 mb-2 w-[26rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-white/10 bg-[#1b1b1d] shadow-2xl shadow-black/40">
              <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                <div>
                  <div className="text-sm font-semibold text-zinc-100">{t('chat.enabledTools')}</div>
                  <div className="text-xs text-zinc-500">{t('chat.toolsDescription')}</div>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <button type="button" onClick={enableAllTools} className="text-zinc-400 hover:text-zinc-200">{t('common.all')}</button>
                  <button type="button" onClick={disableAllTools} className="text-zinc-400 hover:text-zinc-200">{t('common.none')}</button>
                </div>
              </div>
              <div className="border-b border-white/10 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-zinc-100">{t('chat.alwaysApproveForChat')}</div>
                    <div className="mt-1 text-xs leading-5 text-zinc-500">
                      {t('chat.skipApprovalPrompts')}
                    </div>
                  </div>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={approvalMode.alwaysApprove}
                      onChange={(event) => setApprovalMode({ alwaysApprove: event.target.checked })}
                      className="h-4 w-4 rounded border-white/10 bg-[#27272a] text-brand focus:ring-brand/50"
                    />
                  </label>
                </div>
              </div>
              <div className="max-h-80 overflow-y-auto p-2.5">
                {availableTools.map((tool) => {
                  const preference = toolPreferences[tool.name] ?? {
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
                    <div
                      key={tool.name}
                      className="rounded-xl border border-white/10 bg-black/20 p-3 transition-colors hover:border-white/20"
                    >
                      <label className="flex cursor-pointer items-start gap-3">
                        <input
                          type="checkbox"
                          checked={preference.enabled}
                          onChange={() => toggleTool(tool.name)}
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
                              onChange={() => toggleAutoApprove(tool.name)}
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
                {availableTools.length === 0 && (
                  <div className="px-3 py-4 text-sm text-zinc-500">{t('chat.noTools')}</div>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs font-medium text-zinc-300">Reasoning:</span>
          <select
            value={reasoningEffort}
            onChange={(e) => setReasoningEffort(e.target.value as 'low' | 'medium' | 'high')}
            className="h-8 rounded-full border border-white/10 bg-black/20 px-3 text-xs font-medium text-zinc-200 hover:bg-surface-200 focus:outline-none focus:ring-2 focus:ring-brand/50"
          >
            <option value="low">{t('chat.reasoningEffortLow')}</option>
            <option value="medium">{t('chat.reasoningEffortMedium')}</option>
            <option value="high">{t('chat.reasoningEffortHigh')}</option>
          </select>
        </div>
      </div>
      <textarea
        ref={textareaRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('chat.messageAssistant')}
        rows={1}
        className="w-full max-h-[200px] min-h-[64px] resize-none bg-transparent px-4 pb-14 pt-3 text-sm leading-6 text-zinc-100 outline-none placeholder:text-zinc-500 sm:min-h-[72px] sm:px-4 sm:pt-3.5"
      />
      <div className="absolute bottom-2 right-2 flex items-center gap-1.5 sm:gap-2">
        <input
          ref={fileInputRef}
          type="file"
          onChange={handleFileUpload}
          className="hidden"
        />
        <button
          onClick={triggerFileInput}
          disabled={uploading || isProcessing}
          className="flex size-9 items-center justify-center rounded-xl text-zinc-400 transition-colors hover:bg-surface-200 hover:text-zinc-200 disabled:opacity-50"
          aria-label={t('common.attachFile')}
          title={uploading ? t('common.processing') : t('common.attachFile')}
        >
          <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
        </button>
        {isProcessing ? (
          <button
            onClick={stopAgent}
            className="flex size-9 items-center justify-center rounded-xl bg-red-500 text-white transition-all hover:bg-red-600"
            aria-label="Stop"
          >
            <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
            </svg>
          </button>
        ) : (
          <button
            onClick={sendMessage}
            disabled={!input.trim() || isProcessing}
            className="flex size-9 items-center justify-center rounded-xl bg-brand text-white shadow-md shadow-brand/20 transition-all hover:scale-105 hover:bg-brand-dark disabled:opacity-50 disabled:hover:scale-100"
            aria-label="Send message"
          >
            <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="relative flex-1 overflow-y-auto px-3 pb-4 pt-5 sm:px-4 sm:pt-6 md:px-8 md:pb-8 md:pt-8"
        style={{ scrollPaddingTop: '2rem', scrollPaddingBottom: '6rem' }}
      >
        {isEmptyState ? (
          <div className="flex min-h-full items-center justify-center py-6 sm:py-10">
            <div className="w-full max-w-3xl rounded-[28px] border border-white/10 bg-[radial-gradient(circle_at_top,_rgba(16,163,127,0.18),_transparent_55%),linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.01))] px-5 py-8 text-center shadow-2xl shadow-black/20 sm:px-8 sm:py-10">
              <img
                src={operatorLogo}
                alt="Operator Chat logo"
                className="mx-auto mb-4 size-20 object-contain"
              />
              <h1 className="mb-2 text-2xl font-semibold text-zinc-100">{t('chat.welcomeTitle')}</h1>
              <p className="mb-6 text-sm leading-6 text-zinc-400">{t('chat.welcomeDescription')}</p>
              <div className="mx-auto max-w-2xl text-left">
                {renderComposer()}
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-4 max-w-3xl mx-auto">
              {renderedMessages}
            </div>
            <div ref={messagesEndRef} />
            {messages.length > 0 && (
              <div className="pointer-events-none sticky bottom-[-120px] left-0 right-0 z-10 h-60 bg-gradient-to-t from-[#141415] via-[#141415]/95 to-transparent" />
            )}
          </>
        )}
      </div>

      {/* Jump to Bottom Button */}
      <button
        ref={jumpButtonRef}
        onClick={jumpToBottom}
        className="fixed bottom-[16rem] right-3 z-20 flex items-center gap-2 rounded-full bg-brand px-3 py-2 text-white shadow-lg transition-all hover:bg-brand-dark sm:bottom-24 sm:right-4 sm:px-4 md:right-8"
        style={{ display: 'none' }}
        aria-label="Jump to bottom"
      >
        <span className="hidden text-sm sm:inline">{t('chat.jumpToLatest')}</span>
        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
        </svg>
      </button>

      <div className="safe-bottom bg-gradient-to-t from-[#141415] via-[#141415] to-transparent px-3 pb-4 pt-3 sm:px-4 sm:pb-5 md:px-8 md:pb-6">
        <div className="max-w-3xl mx-auto">
          {showStats && (
            <div className="mb-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-zinc-500">
              {stats.tokensPerSec > 0 && (
                <span className="flex items-center gap-1">
                  <svg className="size-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  <span className="text-zinc-300">{stats.tokensPerSec}</span> tok/s
                </span>
              )}
              {stats.contextSize > 0 && (
                <span className="flex items-center gap-1">
                  <svg className="size-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
                  </svg>
                  <span className="text-zinc-300">{stats.contextSize}</span> tokens
                </span>
              )}
            </div>
          )}
          {pendingApproval && (
            <div className="mb-3 rounded-2xl border border-amber-500/25 bg-[linear-gradient(180deg,rgba(245,158,11,0.14),rgba(245,158,11,0.06))] p-4 shadow-lg shadow-amber-900/10">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="flex size-7 items-center justify-center rounded-lg bg-amber-500/15 text-amber-200">
                      <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                    </div>
                    <div className="text-sm font-semibold text-amber-100">{t('chat.toolApprovalRequired')}</div>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase ${
                      pendingApproval.policy.riskLevel === 'high'
                        ? 'border-red-500/30 bg-red-500/15 text-red-200'
                        : pendingApproval.policy.riskLevel === 'medium'
                          ? 'border-amber-500/30 bg-amber-500/15 text-amber-200'
                          : 'border-emerald-500/30 bg-emerald-500/15 text-emerald-200'
                    }`}>
                      {pendingApproval.policy.riskLevel}
                    </span>
                  </div>

                  <div className="mt-2 text-sm text-zinc-200">
                    {t('chat.toolWantsToRun', { toolName: pendingApproval.toolName, riskLevel: pendingApproval.policy.riskLevel })}
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-300">
                    <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5">
                      tool: {pendingApproval.toolName}
                    </span>
                    <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5">
                      {t('chat.sandbox')}: {pendingApproval.policy.sandboxPolicy}
                    </span>
                    {(pendingApproval.policy.capabilities.length > 0 ? pendingApproval.policy.capabilities : ['none']).map((capability) => (
                      <span key={`approval-cap-${capability}`} className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-zinc-400">
                        {capability}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              <div className="mt-3 rounded-xl border border-white/10 bg-black/25 p-2.5">
                <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-400">Arguments</div>
                <div className="max-h-60 overflow-auto rounded-lg bg-black/25 p-2">
                  {renderActionArgs(pendingApproval.toolArgs)}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => respondToApproval(false)}
                  className="rounded-lg border border-white/10 bg-surface-200 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:bg-surface-300"
                >
                  {t('common.deny')}
                </button>
                <button
                  type="button"
                  onClick={() => respondToApproval(true)}
                  className="rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white shadow shadow-brand/20 transition-colors hover:bg-brand-dark"
                >
                  {t('common.approve')}
                </button>
                {pendingApproval.policy.supportsAutoApprove && (
                  <button
                    type="button"
                    onClick={() => respondToApproval(true, true)}
                    className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:bg-surface-200"
                  >
                    {t('chat.alwaysApprove')}
                  </button>
                )}
              </div>
            </div>
          )}
          {!isEmptyState && renderComposer()}
          <div className="mt-2 px-2 text-center text-[11px] font-medium text-zinc-500 sm:mt-3 sm:text-xs">
            {t('chat.aiDisclaimer')}
          </div>
        </div>
      </div>

      {showRetryConfirm !== null && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="mx-4 w-full max-w-md rounded-2xl border border-white/10 bg-surface-100 p-6">
            <h3 className="text-lg font-semibold text-zinc-100 mb-4">{t('chat.confirmRetry')}</h3>
            <p className="text-zinc-400 text-sm mb-6">
              {t('chat.retryDescription', { model: pendingRetryModel || currentModel })}
            </p>
            <div className="flex gap-3 justify-end">
              <button onClick={cancelRetry} className="px-4 py-2 bg-surface-200 text-zinc-300 rounded-lg text-sm hover:bg-surface-300">{t('common.cancel')}</button>
              <button onClick={() => executeRetry(showRetryConfirm, pendingRetryModel || currentModel)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm hover:bg-brand-dark">{t('common.confirm')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ChatInterface;

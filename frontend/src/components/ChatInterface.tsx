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
import { UIStreamingContext } from './UIRenderer';
import { UISendToAssistantContext } from '../openui/uiActionContext';
import { AgentQuestionDialog, type AgentQuestionPayload } from './AgentQuestionDialog';
import operatorLogo from '../assets/logo.png';

// Animates its children from height 0 to their natural height on mount using
// the Web Animations API (precise onfinish callback). Calls onOpened only once
// the animation has fully completed, so scrolling waits for the reveal to end.
const CollapsibleReveal: React.FC<{ children: React.ReactNode; onOpened?: () => void }> = ({ children, onOpened }) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target = el.scrollHeight;
    const anim = el.animate(
      [{ height: '0px' }, { height: `${target}px` }],
      { duration: 300, easing: 'ease-out' }
    );
    anim.onfinish = () => {
      // Effect removed after finish (fill: none) → element settles to its
      // natural auto height. Scroll only now, when layout is final.
      requestAnimationFrame(() => onOpened?.());
    };
    return () => anim.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={ref} style={{ overflow: 'hidden' }}>
      {children}
    </div>
  );
};

interface AgentStep {
  type: 'thought' | 'action' | 'observation' | 'tool_progress' | 'mode_transition' | 'final_answer';
  content: string;
  actionName?: string;
  actionArgs?: Record<string, any>;
  // Only present on v2 SSH agent steps; links the trace entry back to the
  // v2 message that produced it so the user can rewind to that point.
  sourceMessageID?: string;
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
  agentRunId?: string;
}

interface AgentRun {
  id: string;
  chatId: string;
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

interface AgentRunTask {
  id: string;
  chatId: string;
  agentRunId: string;
  subject: string;
  description: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority?: 'high' | 'medium' | 'low';
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
}

interface AgentTerminalEntry {
  id: string;
  type: 'command' | 'tool' | 'thought' | 'system' | 'final';
  title: string;
  command?: string;
  args?: Record<string, any>;
  output?: string;
  status: 'running' | 'completed';
  // v2 message id this entry came from, when known. Drives the "rewind to
  // here" affordance — entries without it (initial prompt, steering messages)
  // are not rewindable.
  sourceMessageID?: string;
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
  agentRunId?: string;
}

function getAgentRunIdFromMessage(message: Pick<Message, 'content' | 'agentRunId'> | undefined) {
  if (!message) return undefined;
  return message.agentRunId
    || (message.content.startsWith('__operator_agent_run__:')
      ? message.content.slice('__operator_agent_run__:'.length).trim()
      : undefined);
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
const TERMINAL_OUTPUT_PREVIEW_LINES = 15;
const TERMINAL_OUTPUT_PREVIEW_CHARS = 3000;
const AGENT_TASK_PREVIEW_CHARS = 360;
const markdownRemarkPlugins: PluggableList = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]];
const markdownRehypePlugins: PluggableList = [rehypeKatex];
const markdownComponents = { code: CodeBlock, pre: PreBlock };

/**
 * Image renderer for UNTRUSTED markdown (browser-tool observation bodies).
 * Scraped pages can embed arbitrary ![](url) images; loading them directly
 * would leak the user's IP/User-Agent to attacker-chosen hosts and allow
 * tracking pixels. We route absolute http(s) images through the backend
 * /api/image-proxy (SSRF-guarded, server-side fetch) instead. data:/relative
 * srcs are left as-is. Used only via observationMarkdownComponents.
 */
function ProxiedImage({ src, alt }: { src?: string; alt?: string }) {
  if (!src) return null;
  if (!/^https?:\/\//i.test(src)) {
    return (
      <img src={src} alt={alt || ''} loading="lazy" referrerPolicy="no-referrer" style={{ maxWidth: '100%', height: 'auto' }} />
    );
  }
  const token = localStorage.getItem('token');
  const proxied = `/api/image-proxy?url=${encodeURIComponent(src)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
  return (
    <img
      src={proxied}
      alt={alt || ''}
      loading="lazy"
      referrerPolicy="no-referrer"
      style={{ maxWidth: '100%', height: 'auto', borderRadius: 6 }}
    />
  );
}

// Markdown components for untrusted observation content: same as the default
// set, but images are fetched via the SSRF-guarded backend proxy.
const observationMarkdownComponents = { code: CodeBlock, pre: PreBlock, img: ProxiedImage };

function TerminalOutput({ normalized, type }: { normalized: string; type?: AgentTerminalEntry['type'] }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const lines = normalized.split('\n');
  const isDiffLine = (line: string) => /^\s*\d+\s+[+-]\s/.test(line)
    || /^[+-](?![+-])/.test(line)
    || line.startsWith('*** ')
    || line.startsWith('@@')
    || line.startsWith('• Edited ');
  const isDiffOutput = type === 'tool' && lines.some(isDiffLine);
  const isLongOutput = lines.length > TERMINAL_OUTPUT_PREVIEW_LINES || normalized.length > TERMINAL_OUTPUT_PREVIEW_CHARS;
  const previewText = normalized.length > TERMINAL_OUTPUT_PREVIEW_CHARS
    ? isDiffOutput
      ? normalized.slice(0, TERMINAL_OUTPUT_PREVIEW_CHARS)
      : normalized.slice(-TERMINAL_OUTPUT_PREVIEW_CHARS)
    : normalized;
  const previewTextLines = previewText.split('\n');
  const previewLines = isDiffOutput
    ? previewTextLines.slice(0, TERMINAL_OUTPUT_PREVIEW_LINES)
    : previewTextLines.slice(-TERMINAL_OUTPUT_PREVIEW_LINES);
  const visible = isLongOutput && !isExpanded ? previewLines : lines;
  const hiddenLineCount = Math.max(0, lines.length - visible.length);
  const hiddenCharCount = Math.max(0, normalized.length - visible.join('\n').length);
  const hiddenSummary = hiddenLineCount > 0
    ? `${hiddenLineCount} more lines`
    : `${hiddenCharCount} more characters`;
  const previewLabel = isDiffOutput
    ? `[showing first ${visible.length} of ${lines.length} lines]`
    : `[showing last ${visible.length} of ${lines.length} lines]`;
  const toggleOutput = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsExpanded((value) => !value);
  };

  if (isDiffOutput) {
    const getDiffLineClass = (line: string) => {
      if (/^\s*\d+\s+\+\s/.test(line) || /^\+(?![+])/.test(line)) {
        return 'border-emerald-500/10 bg-emerald-500/10 text-emerald-200';
      }
      if (/^\s*\d+\s+-\s/.test(line) || /^-(?![-])/.test(line)) {
        return 'border-red-500/10 bg-red-500/10 text-red-200';
      }
      if (line.startsWith('• Edited ')) {
        return 'border-transparent text-zinc-100 font-semibold';
      }
      if (line.startsWith('*** ') || line.startsWith('@@')) {
        return 'border-transparent text-zinc-500';
      }
      return 'border-transparent text-zinc-400';
    };

    return (
      <div className="mt-2 min-w-0 rounded-lg border border-white/5 bg-black/30 p-3 font-mono text-[12px] leading-5">
        {!isExpanded && isLongOutput && (
          <div className="mb-2 whitespace-pre-wrap break-words text-zinc-500">
            {previewLabel}
          </div>
        )}
        {visible.map((line, index) => (
          <div
            key={`${index}-${line}`}
            className={`min-w-0 -mx-1 border-l-2 px-1 whitespace-pre-wrap break-words ${getDiffLineClass(line)}`}
          >
            {line || ' '}
          </div>
        ))}
        {isLongOutput && (
          <button
            type="button"
            onClick={toggleOutput}
            className="mt-3 rounded-md border border-white/10 px-2 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:border-white/20 hover:bg-white/5"
          >
            {isExpanded ? 'Show less' : `Show full output (${hiddenSummary})`}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2 min-w-0 rounded-lg border border-white/5 bg-black/30 p-3 font-mono text-[12px] leading-5 text-zinc-300">
      {!isExpanded && isLongOutput && (
        <div className="mb-2 whitespace-pre-wrap break-words text-zinc-500">
          {previewLabel}
        </div>
      )}
      <pre className="min-w-0 whitespace-pre-wrap break-words">{visible.join('\n')}</pre>
      {isLongOutput && (
        <button
          type="button"
          onClick={toggleOutput}
          className="mt-3 rounded-md border border-white/10 px-2 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:border-white/20 hover:bg-white/5"
        >
          {isExpanded ? 'Show less' : `Show full output (${hiddenSummary})`}
        </button>
      )}
    </div>
  );
}

function AgentTaskPreview({ prompt }: { prompt: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const normalized = prompt.trim();
  const isLong = normalized.length > AGENT_TASK_PREVIEW_CHARS || normalized.split('\n').length > 4;
  const preview = normalized.length > AGENT_TASK_PREVIEW_CHARS
    ? `${normalized.slice(0, AGENT_TASK_PREVIEW_CHARS).trimEnd()}...`
    : normalized.split('\n').slice(0, 4).join('\n');
  const visible = isLong && !isExpanded ? preview : normalized;

  return (
    <div className="mt-1">
      <div className="prose prose-invert max-w-none break-words min-w-0 text-sm leading-6 text-zinc-300 prose-headings:mb-2 prose-headings:mt-3 prose-headings:text-zinc-100 prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0 prose-code:text-emerald-200">
        <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>
          {visible}
        </ReactMarkdown>
      </div>
      {isLong && (
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setIsExpanded((value) => !value);
          }}
          className="mt-2 rounded-md border border-white/10 px-2 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:border-white/20 hover:bg-white/5"
        >
          {isExpanded ? 'Show less' : 'Show full task'}
        </button>
      )}
    </div>
  );
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

interface ScreenshotFrame {
  url: string;
  label: string;
}

function ScreenshotSequence({ frames }: { frames: ScreenshotFrame[] }) {
  const [currentIdx, setCurrentIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const FPS = 4;
  const intervalMs = 1000 / FPS + 100;

  useEffect(() => {
    if (playing) {
      intervalRef.current = setInterval(() => {
        setCurrentIdx((prev) => (prev + 1) % frames.length);
      }, intervalMs);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [playing, frames.length, intervalMs]);

  useEffect(() => {
    if (playing) {
      setCurrentIdx(0);
    }
  }, [playing]);

  if (frames.length === 0) return null;

  return (
    <div className="mt-2 w-full">
      <div className="relative w-full overflow-hidden rounded-lg border border-white/10 bg-black/30">
        <img
          src={frames[currentIdx].url}
          alt={frames[currentIdx].label}
          className="block h-auto w-full object-contain"
        />
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <button
          onClick={() => setPlaying(!playing)}
          className="flex h-7 w-7 items-center justify-center rounded bg-white/10 text-xs text-zinc-300 hover:bg-white/20"
          title={playing ? 'Pause' : 'Play'}
        >
          {playing ? '⏸' : '▶'}
        </button>
        <button
          onClick={() => { setPlaying(false); setCurrentIdx(0); }}
          className="h-7 rounded bg-white/10 px-2.5 text-xs text-zinc-300 hover:bg-white/20"
          title="Reset"
        >
          Reset
        </button>
        <div className="flex-1" />
        <div className="flex gap-1">
          {frames.map((_, idx) => (
            <button
              key={idx}
              onClick={() => { setPlaying(false); setCurrentIdx(idx); }}
              className={`h-1.5 w-6 rounded-full transition-all ${
                idx === currentIdx ? 'bg-blue-400' : 'bg-white/20 hover:bg-white/30'
              }`}
              title={`Frame ${idx + 1}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function BrowserToolOutput({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="mt-2 min-w-0">
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setExpanded((value) => !value);
        }}
        className="rounded-md border border-white/10 px-2 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:border-white/20 hover:bg-white/5"
      >
        {expanded ? 'Hide full output' : 'Show full output'}
      </button>
      {expanded && (
        <div className="mt-2 rounded-lg border border-white/5 bg-black/30 p-3 font-mono text-[12px] leading-5 text-zinc-300">
          <pre className="min-w-0 whitespace-pre-wrap break-words">{text}</pre>
        </div>
      )}
    </div>
  );
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
  const [expandedAgentRuns, setExpandedAgentRuns] = useState<Set<string>>(new Set());
  const reasoningCardRefs = useRef<Map<number, HTMLDivElement | null>>(new Map());
  const agentCardRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const programmaticScrollRef = useRef(false);
  const scrollRafRef = useRef<number | null>(null);
  const revealObserverRef = useRef<ResizeObserver | null>(null);
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
  const [toolSearch, setToolSearch] = useState('');
  const [pendingApproval, setPendingApproval] = useState<ToolApprovalRequest | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<'low' | 'medium' | 'high'>('medium');
  const [agentRuns, setAgentRuns] = useState<Record<string, AgentRun>>({});
  const [agentRunTasks, setAgentRunTasks] = useState<Record<string, AgentRunTask[]>>({});
  const [agentSteeringDrafts, setAgentSteeringDrafts] = useState<Record<string, string>>({});
  // Pending agent `question` tool calls awaiting a user reply.
  const [agentQuestion, setAgentQuestion] = useState<AgentQuestionPayload | null>(null);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollContentRef = useRef<HTMLDivElement | null>(null);
  const messageRefs = useRef<Map<number, HTMLDivElement | null>>(new Map());
  const jumpButtonRef = useRef<HTMLButtonElement>(null);
  const distanceFromBottomRef = useRef(0);
  const stickToBottomRef = useRef(true);
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
  const bufferedFinalAnswerRef = useRef<string>('');

  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const initialMessageSentRef = useRef(false);
  const initialRouteState = (location.state as ChatRouteState | null) ?? null;
 
  const hasRunningAgentRun = useMemo(
    () => Object.values(agentRuns).some((run) => run.chatId === chatId && run.status === 'running'),
    [agentRuns, chatId]
  );

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

    distanceFromBottomRef.current = scrollHeight - scrollTop - viewportHeight;
    stickToBottomRef.current = distanceFromBottomRef.current < SCROLL_THRESHOLD;

    if (jumpButtonRef.current) {
      jumpButtonRef.current.style.display = stickToBottomRef.current ? 'none' : 'flex';
    }
  }, []);

  // Jump to bottom function
  const jumpToBottom = useCallback(() => {
    if (!scrollContainerRef.current) return;

    scrollContainerRef.current.scrollTo({
      top: scrollContainerRef.current.scrollHeight,
      behavior: 'smooth'
    });

    stickToBottomRef.current = true;
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
        const agentRunId = getAgentRunIdFromMessage(data);
        setMessages((prev) => {
          const updated = [...prev];
          if (agentRunId) {
            const exists = updated.some((message) => getAgentRunIdFromMessage(message) === agentRunId);
            if (exists) return updated;
            // Insert agent run message right after the processing user message
            const insertIndex = processingMessageIndex != null ? processingMessageIndex + 1 : updated.length;
            updated.splice(insertIndex, 0, { ...data, agentRunId, model: data.model ?? currentModel, id: generateUUID(), agentSteps: [] });
            return updated;
          }

           const lastMsg = updated[updated.length - 1];
            if (lastMsg?.role === 'assistant' && lastMsg.content === data.content) {
              return updated;
            }
            // Also check if any message already has this exact content
            if (updated.some(m => m.role === 'assistant' && m.content === data.content)) {
              return updated;
            }

            const persistedSteps = appendPendingThoughtToSteps(currentAgentStepsRef.current);
            currentAgentStepsRef.current = persistedSteps;
            for (let i = updated.length - 1; i >= 0; i--) {
              if (updated[i].role === 'user') {
                updated[i] = { ...updated[i], agentSteps: [...persistedSteps] };
                break;
              }
            }
          const targetUserIndex = processingMessageIndex ?? (() => {
            for (let i = updated.length - 1; i >= 0; i--) {
              if (updated[i].role === 'user') return i;
            }
            return -1;
          })();
          const nextMessageIndex = targetUserIndex >= 0 ? targetUserIndex + 1 : -1;
           const existingAssistantIndex = nextMessageIndex >= 0
             && updated[nextMessageIndex]?.role === 'assistant'
             && !getAgentRunIdFromMessage(updated[nextMessageIndex])
               ? nextMessageIndex
               : -1;

         const agentRunIdAtNext = nextMessageIndex >= 0 ? getAgentRunIdFromMessage(updated[nextMessageIndex]) : null;
            let targetAssistantIndex = existingAssistantIndex;
            if (targetAssistantIndex < 0 && agentRunIdAtNext) {
              const afterAgentRun = nextMessageIndex + 1;
              if (updated[afterAgentRun]?.role === 'assistant' && !getAgentRunIdFromMessage(updated[afterAgentRun])) {
                targetAssistantIndex = afterAgentRun;
              }
            }

            const bufferedContent = bufferedFinalAnswerRef.current;
            if (targetAssistantIndex >= 0) {
              const content = bufferedContent || data.content;
              updated[targetAssistantIndex] = { ...updated[targetAssistantIndex], ...data, content, agentSteps: [] };
            } else if (!agentRunIdAtNext) {
              const content = bufferedContent || data.content;
              updated.push({ ...data, content, model: data.model ?? currentModel, id: generateUUID(), agentSteps: [] });
            }
            if (bufferedContent) {
             bufferedFinalAnswerRef.current = '';
           }

          const latestAssistantIndex = targetAssistantIndex >= 0 ? targetAssistantIndex : updated.length - 1;
          const latestAssistant = updated[latestAssistantIndex];
          if (latestAssistant && latestAssistant.role === 'assistant') {
            updated[latestAssistantIndex] = {
              ...latestAssistant,
              model: data.model ?? latestAssistant.model ?? currentModel,
            };
          }
          return updated;
         });
         if (!agentRunId) {
           setProcessingMessageIndex(null);
           setStreamingContent('');
         }
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
        return;
      }
      
     const token = typeof data === 'string' ? data : data.token;
      const model = typeof data === 'string' ? undefined : data.model;

      // Check if there's an SSH agent run message right after the user message
      // If so, buffer the tokens instead of creating a temporary message to avoid flicker
      const checkForAgentRun = () => {
        const pmIndex = processingMessageIndex ?? (() => {
          for (let i = messagesRef.current.length - 1; i >= 0; i--) {
            if (messagesRef.current[i].role === 'user') return i;
          }
          return -1;
        })();
        if (pmIndex >= 0) {
          return getAgentRunIdFromMessage(messagesRef.current[pmIndex + 1]);
        }
        return null;
      };

      if (checkForAgentRun()) {
        bufferedFinalAnswerRef.current += token;
      } else {
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
            if (nextMessage?.role === 'assistant' && !getAgentRunIdFromMessage(nextMessage)) {
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
      }
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
      bufferedFinalAnswerRef.current = '';
      if (showStatsRef.current) {
        if (serverTimingsRef.current?.predicted_per_second) {
          setStats({
            tokensPerSec: Math.round(serverTimingsRef.current.predicted_per_second),
            contextSize:
              (serverTimingsRef.current.prompt_n || 0) +
              (serverTimingsRef.current.predicted_n || 0),
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
            contextSize: (timings.prompt_n || 0) + (timings.predicted_n || 0),
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

    const handleAgentRuns = (runs: AgentRun[]) => {
      setAgentRuns(Object.fromEntries(runs.map((run) => [run.id, run])));
    };

    const handleAgentRunUpdated = (run: AgentRun) => {
      setAgentRuns((current) => ({ ...current, [run.id]: run }));
      if (run.status !== 'running') {
        setIsStopping(false);
      }
    };

    const handleAgentTasksUpdated = (data: { chatId: string; agentRunId: string; tasks: AgentRunTask[] }) => {
      if (data.chatId !== chatId) return;
      setAgentRunTasks((current) => ({ ...current, [data.agentRunId]: data.tasks }));
    };

    const handleAgentQuestionRequired = (data: AgentQuestionPayload) => {
      if (data.chatId !== chatId) return;
      setAgentQuestion(data);
    };

    const handleAgentQuestionResolved = (data: { chatId: string; agentRunId: string; questionId: string }) => {
      if (data.chatId !== chatId) return;
      setAgentQuestion((current) => (current && current.questionId === data.questionId ? null : current));
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
    socket.on('agent-cancelled', onAgentStopped);
    socket.on('timings', handleTimings);
    socket.on('tool-approval-required', handleToolApprovalRequired);
    socket.on('tool-approval-resolved', handleToolApprovalResolved);
    socket.on('tool-preferences-updated', handleToolPreferencesUpdated);
    socket.on('agent-runs', handleAgentRuns);
    socket.on('agent-run-updated', handleAgentRunUpdated);
    socket.on('agent-tasks-updated', handleAgentTasksUpdated);
    socket.on('agent-question-required', handleAgentQuestionRequired);
    socket.on('agent-question-resolved', handleAgentQuestionResolved);
    socket.on('step-saved', handleStepSaved);

    // Join the chat room AFTER handlers are registered
    socket.emit('join-chat', chatId);

    return () => {
      socket.off('message', onMessage);
      socket.off('agent-state', handleAgentState);
      socket.off('agent-step', onAgentStep);
      socket.off('thought-token', onThoughtToken);
      socket.off('final-answer-token', onFinalAnswerToken);
      socket.off('agent-complete', onAgentComplete);
      socket.off('error', onError);
      socket.off('agent-stopped', onAgentStopped);
      socket.off('agent-cancelled', onAgentStopped);
      socket.off('timings', handleTimings);
      socket.off('tool-approval-required', handleToolApprovalRequired);
      socket.off('tool-approval-resolved', handleToolApprovalResolved);
      socket.off('tool-preferences-updated', handleToolPreferencesUpdated);
      socket.off('agent-runs', handleAgentRuns);
      socket.off('agent-run-updated', handleAgentRunUpdated);
      socket.off('agent-tasks-updated', handleAgentTasksUpdated);
      socket.off('agent-question-required', handleAgentQuestionRequired);
      socket.off('agent-question-resolved', handleAgentQuestionResolved);
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

        const runs = Array.isArray(data.agentRuns) ? data.agentRuns as AgentRun[] : [];
        setAgentRuns(Object.fromEntries(runs.map((run) => [run.id, run])));

        if (data.messages) {
          const loadedMessages = [...data.messages];
          const agentMessageIds = new Set(
            loadedMessages
              .map((message) => getAgentRunIdFromMessage(message))
              .filter(Boolean)
          );
          for (const run of runs) {
            if (agentMessageIds.has(run.id)) continue;
            loadedMessages.push({
              id: generateUUID(),
              role: 'assistant',
              content: `__operator_agent_run__:${run.id}`,
              model: run.model,
              agentSteps: [],
              agentRunId: run.id,
            });
          }

          // Check if there's an ongoing response BEFORE setting messages state
          let processingIndex = null;
          let agentStepsToRestore: AgentStep[] = [];
          
          if (data.agentState && data.agentState.steps && data.agentState.steps.length > 0 && !data.agentState.isComplete) {
            // Find the last user message that has agent steps (this is the message being processed)
            const messages = loadedMessages;
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
                  break;
                }
              }
            }
          }
          
          // Set all state at once to ensure consistency
          setMessages(loadedMessages);
          setPendingApproval(data.pendingApproval?.chatId === chatId ? data.pendingApproval : null);
          if (processingIndex !== null) {
            setIsProcessing(true);
            setProcessingMessageIndex(processingIndex);
            setCurrentAgentSteps(agentStepsToRestore);
            
            // Restore partial final answer content if available
            if (data.agentState?.partialFinalAnswer) {
              setStreamingContent(data.agentState.partialFinalAnswer);
              setCurrentStepType('final_answer');
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

  // Auto-scroll: stick to bottom whenever the trace content grows (state updates,
  // streaming chunks, async screenshot loads). Stickiness is broken only by
  // genuine user scroll-up events (handleScroll), so growth alone never strands us.
  // Callback refs (re)attach the observer whenever the content/container DOM nodes
  // appear — needed because the content div is only rendered once messages exist.
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const stickToBottomNow = useCallback(() => {
    const c = scrollContainerRef.current;
    if (!c) return;
    if (programmaticScrollRef.current) return;
    if (!stickToBottomRef.current) return;
    c.scrollTop = c.scrollHeight;
    if (jumpButtonRef.current) jumpButtonRef.current.style.display = 'none';
  }, []);
  const ensureObserver = useCallback(() => {
    if (resizeObserverRef.current) return resizeObserverRef.current;
    const observer = new ResizeObserver(stickToBottomNow);
    resizeObserverRef.current = observer;
    return observer;
  }, [stickToBottomNow]);
  const setScrollContainerRef = useCallback((node: HTMLDivElement | null) => {
    if (scrollContainerRef.current && resizeObserverRef.current) {
      resizeObserverRef.current.unobserve(scrollContainerRef.current);
    }
    scrollContainerRef.current = node;
    if (node) ensureObserver().observe(node);
  }, [ensureObserver]);
  const setScrollContentRef = useCallback((node: HTMLDivElement | null) => {
    if (scrollContentRef.current && resizeObserverRef.current) {
      resizeObserverRef.current.unobserve(scrollContentRef.current);
    }
    scrollContentRef.current = node;
    if (node) {
      ensureObserver().observe(node);
      // Newly mounted (e.g. first message in an empty chat) — start at bottom.
      stickToBottomNow();
    }
  }, [ensureObserver, stickToBottomNow]);
  useEffect(() => () => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
  }, []);

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

  // Handle clicks on OpenUI buttons inside assistant replies (@ToAssistant /
  // default actions): send the button's message as a new user turn, unless the
  // agent is already busy.
  const handleUISendToAssistant = useCallback((message: string) => {
    if (isProcessing) return;
    sendMessageContent(message);
  }, [isProcessing, sendMessageContent]);

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
    if (!socket || (!isProcessing && !hasRunningAgentRun) || isStopping) return;
    setIsStopping(true);
    socket.emit('stop-agent', chatId);
  };

  const sendAgentSteering = (runId: string) => {
    if (!socket) return;
    const message = (agentSteeringDrafts[runId] || '').trim();
    if (!message) return;
    socket.emit('agent-user-message', { chatId, runId, message });
    setAgentSteeringDrafts((current) => ({ ...current, [runId]: '' }));
  };

  const resumeAgentRun = (runId: string) => {
    if (!socket) return;
    socket.emit('resume-agent-run', { chatId, runId });
  };

  const rollbackAgentRun = (runId: string, messageId: string) => {
    if (!socket) return;
    const run = agentRuns[runId];
    if (run?.status === 'running') {
      window.alert('Stop the run before rewinding it.');
      return;
    }
    const ok = window.confirm(
      'Rewind the agent to this point?\n\nEverything after this step will be discarded and the agent will replay from here. Workspace files are NOT reverted — the agent will see them as they currently are.'
    );
    if (!ok) return;
    socket.emit('rollback-agent-run', { chatId, runId, messageId });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // rAF-driven smooth scroll of the chat container. Unlike native
  // scrollTo({behavior:'smooth'}) this can't be interrupted by the
  // stick-to-bottom ResizeObserver (which we also gate via programmaticScrollRef).
  const smoothScrollContainerTo = (top: number, duration = 420) => {
    const c = scrollContainerRef.current;
    if (!c) return;
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    const start = c.scrollTop;
    const end = Math.max(0, Math.min(top, c.scrollHeight - c.clientHeight));
    if (Math.abs(end - start) < 1) {
      scrollRafRef.current = null;
      programmaticScrollRef.current = false;
      return;
    }
    const startTime = performance.now();
    programmaticScrollRef.current = true;
    const step = (now: number) => {
      const t = Math.min(1, (now - startTime) / duration);
      const ease = 1 - Math.pow(1 - t, 3); // easeOutCubic
      c.scrollTop = start + (end - start) * ease;
      if (t < 1) {
        scrollRafRef.current = requestAnimationFrame(step);
      } else {
        scrollRafRef.current = null;
        programmaticScrollRef.current = false;
      }
    };
    scrollRafRef.current = requestAnimationFrame(step);
  };

  // Scroll an element so its top or bottom edge sits just inside the viewport.
  const scrollElementEdgeIntoView = (el: HTMLElement | null | undefined, align: 'top' | 'bottom') => {
    const container = scrollContainerRef.current;
    if (!container || !el) return;
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const margin = 16;
    const delta = align === 'bottom'
      ? eRect.bottom - cRect.bottom + margin
      : eRect.top - cRect.top - margin;
    smoothScrollContainerTo(container.scrollTop + delta);
  };

  // After expanding, scroll to the element's bottom and keep re-pinning it for a
  // short window so late-loading content (screenshots, long output) that grows
  // it doesn't leave the collapse control below the fold.
  const revealScrollToBottom = (el: HTMLElement | null | undefined) => {
    if (!el) return;
    scrollElementEdgeIntoView(el, 'bottom');
    if (typeof ResizeObserver === 'undefined') return;
    revealObserverRef.current?.disconnect();
    const observer = new ResizeObserver(() => scrollElementEdgeIntoView(el, 'bottom'));
    observer.observe(el);
    revealObserverRef.current = observer;
    window.setTimeout(() => {
      if (revealObserverRef.current === observer) {
        observer.disconnect();
        revealObserverRef.current = null;
      }
    }, 1500);
  };

  const toggleAgentRunTrace = (runId: string) => {
    const expanding = !expandedAgentRuns.has(runId);
    setExpandedAgentRuns((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
    if (expanding) {
      stickToBottomRef.current = false;
    } else {
      revealObserverRef.current?.disconnect();
      revealObserverRef.current = null;
      requestAnimationFrame(() => scrollElementEdgeIntoView(agentCardRefs.current.get(runId), 'top'));
    }
  };

  const toggleThoughts = (idx: number) => {
    const expanding = !expandedThoughts.has(idx);
    setExpandedThoughts((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(idx)) newSet.delete(idx);
      else newSet.add(idx);
      return newSet;
    });
    if (expanding) {
      // Prevent the stick-to-bottom ResizeObserver from yanking the scroll
      // position while the card grows; the scroll-to-bottom happens once the
      // reveal animation finishes (CollapsibleReveal.onOpened).
      stickToBottomRef.current = false;
    } else {
      // Collapsing: stop any in-flight reveal re-pinning, then scroll back up.
      revealObserverRef.current?.disconnect();
      revealObserverRef.current = null;
      requestAnimationFrame(() => scrollElementEdgeIntoView(reasoningCardRefs.current.get(idx), 'top'));
    }
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
          <div className="max-h-64 overflow-auto">
            <pre className="min-w-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-zinc-300">
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
          <div className="max-h-64 overflow-auto">
            <pre className="min-w-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-zinc-300">
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
    const { attachments, rest } = extractAttachmentsMarker(trimmed);

    const parsedJson = tryParseJson(rest.trim());

    if (parsedJson) {
      return (
        <>
          {renderStructuredValue(parsedJson)}
          {renderAttachments(attachments)}
        </>
      );
    }

    const searchResultPattern = /^\d+\.\s/m.test(rest.trim()) && /URL:\s+/m.test(rest.trim());
    if (searchResultPattern) {
      const chunks = rest.trim().split(/\n\s*\n/).filter(Boolean);
      return (
        <>
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
          {renderAttachments(attachments)}
        </>
      );
    }

    const prefixedBlock = rest.trim().match(/^(Contents of|File contents of|Result:|Tool result:|Successfully .+?:?|Directory .+? is empty\.|Awaiting user approval.+?|Tool execution denied.+?)([\s\S]*)$/i);
    if (prefixedBlock) {
      const heading = prefixedBlock[1].trim();
      const body = prefixedBlock[2].trim();
      return (
        <>
          <div className="mt-3 rounded-xl border border-white/5 bg-black/20 px-3 py-3">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">
              {heading}
            </div>
            {body ? (
              <div className="mt-2 text-sm text-zinc-300">
                <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={observationMarkdownComponents}>
                  {body}
                </ReactMarkdown>
              </div>
            ) : null}
          </div>
          {renderAttachments(attachments)}
        </>
      );
    }

    return (
      <>
        <div className="mt-3 rounded-xl border border-white/5 bg-black/20 px-3 py-3">
          <div className="text-sm prose prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={observationMarkdownComponents}>
              {rest.trim()}
            </ReactMarkdown>
          </div>
        </div>
        {renderAttachments(attachments)}
      </>
    );
  };

  const renderAgentStep = (step: AgentStep, idx: number) => {
    if (step.type === 'thought') {
      return (
        <div key={idx} className="min-w-0 overflow-hidden rounded-2xl border border-white/5 bg-black/20 p-3">
          <span className="font-medium text-xs uppercase tracking-wide text-zinc-400">{t('chat.thought')}</span>
          <div className="mt-3 text-sm prose prose-invert max-w-none text-zinc-300">
            <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>{step.content}</ReactMarkdown>
          </div>
        </div>
      );
    }
    if (step.type === 'action') {
      return (
        <div key={idx} className="min-w-0 overflow-hidden rounded-2xl border border-white/5 bg-black/20 p-3">
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
        <div key={idx} className="min-w-0 overflow-hidden rounded-2xl border border-white/5 bg-black/20 p-3">
          <span className="font-medium text-xs uppercase tracking-wide text-zinc-400">{t('chat.observation')}</span>
          {renderObservationContent(step.content)}
        </div>
      );
    }
    if (step.type === 'mode_transition') {
      return (
        <div key={idx} className="min-w-0 overflow-hidden rounded-2xl border border-blue-500/30 bg-blue-500/10 p-3">
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

  const getTerminalCommand = (step: AgentStep) => {
    if ((step.actionName === 'shell' || step.actionName === 'bash') && typeof step.actionArgs?.command === 'string') {
      return step.actionArgs.command;
    }
    if (step.actionName === 'read' && typeof step.actionArgs?.path === 'string') {
      return `read ${step.actionArgs.path}`;
    }
    if (step.actionName === 'write' && typeof step.actionArgs?.path === 'string') {
      return `write ${step.actionArgs.path}`;
    }
    if (step.actionName === 'edit' && typeof step.actionArgs?.path === 'string') {
      return `edit ${step.actionArgs.path}`;
    }
    if (step.actionName === 'apply_patch') {
      return 'apply_patch';
    }
    if (step.actionName === 'grep' && typeof step.actionArgs?.pattern === 'string') {
      return `grep ${step.actionArgs.pattern}`;
    }
    if (step.actionName === 'glob' && typeof step.actionArgs?.pattern === 'string') {
      return `glob ${step.actionArgs.pattern}`;
    }
    if (step.actionName === 'list') {
      return `list ${typeof step.actionArgs?.path === 'string' ? step.actionArgs.path : '.'}`;
    }
    if (step.actionName === 'browser') {
      const action = typeof step.actionArgs?.action === 'string' ? step.actionArgs.action : 'visit';
      const target =
        action === 'visit' ? (step.actionArgs?.url || '') :
        action === 'click' || action === 'type' ? (step.actionArgs?.selector || '') :
        action === 'scroll' ? `${step.actionArgs?.scroll_y ?? 0}px` : '';
      return `browser ${action} ${target}`.trim();
    }
    if (step.actionName === 'todo') {
      const count = Array.isArray(step.actionArgs?.todos) ? step.actionArgs.todos.length : 0;
      return `todo (${count} item${count === 1 ? '' : 's'})`;
    }
    if (step.actionName === 'question' && typeof step.actionArgs?.question === 'string') {
      return `question: ${step.actionArgs.question}`;
    }
    if (step.actionName === 'task' && typeof step.actionArgs?.subagent_type === 'string') {
      return `task ${step.actionArgs.subagent_type}`;
    }
    return step.actionName || 'tool';
  };

  const buildAgentTerminalEntries = (steps: AgentStep[]): AgentTerminalEntry[] => {
    const entries: AgentTerminalEntry[] = [];
    let pendingActionIndex: number | null = null;
    const shouldHideObservation = (content: string) => {
      const trimmed = content.trim();
      return trimmed.startsWith('Invalid agent turn:') ||
        trimmed.startsWith('Awaiting user approval for tool') ||
        trimmed.startsWith('__agent_run_started__:') ||
        trimmed.startsWith('## RESEARCH PHASE COMPLETE') ||
        trimmed.startsWith('## COMPOSING FINAL ANSWER') ||
        trimmed.startsWith('## ITERATION LIMIT REACHED');
    };

    for (const step of steps) {
      if (step.type === 'action') {
        const id = `${entries.length}-${step.actionName || 'tool'}`;
        // shell + bash both render as a command-style entry. The other v2
        // tools (browser/question/todo/task/...) render as tool entries with
        // their own arg display.
        const isCommandLike = step.actionName === 'shell' || step.actionName === 'bash';
        entries.push({
          id,
          type: isCommandLike ? 'command' : 'tool',
          title: step.actionName || 'tool',
          command: getTerminalCommand(step),
          args: step.actionArgs,
          status: 'running',
          sourceMessageID: step.sourceMessageID,
        });
        pendingActionIndex = entries.length - 1;
        continue;
      }

      if (step.type === 'observation' && pendingActionIndex !== null) {
        if (step.content.trim().startsWith('User Message:')) {
          entries.push({
            id: `${entries.length}-user-message`,
            type: 'system',
            title: 'user message',
            output: step.content,
            status: 'completed',
          });
          continue;
        }
        if (shouldHideObservation(step.content)) {
          entries.splice(pendingActionIndex, 1);
          pendingActionIndex = null;
          continue;
        }
        const existingEntry = entries[pendingActionIndex];
        const shouldKeepProgress = existingEntry.type === 'tool'
          && ['write', 'edit', 'apply_patch'].includes(existingEntry.title);
        entries[pendingActionIndex] = {
          ...existingEntry,
          output: existingEntry.type === 'command' && existingEntry.output
            ? existingEntry.output
            : shouldKeepProgress && existingEntry.output
              ? `${existingEntry.output.trimEnd()}\n\n${step.content}`
              : step.content,
          status: 'completed',
        };
        pendingActionIndex = null;
        continue;
      }

      if (step.type === 'tool_progress' && pendingActionIndex !== null) {
        entries[pendingActionIndex] = {
          ...entries[pendingActionIndex],
          output: `${entries[pendingActionIndex].output || ''}${step.content}`,
          status: 'running',
        };
        continue;
      }

      if (step.type === 'observation') {
        if (shouldHideObservation(step.content)) {
          continue;
        }
        entries.push({
          id: `${entries.length}-observation`,
          type: 'system',
          title: 'observation',
          output: step.content,
          status: 'completed',
          sourceMessageID: step.sourceMessageID,
        });
        continue;
      }

      if (step.type === 'thought') {
        entries.push({
          id: `${entries.length}-thought`,
          type: 'thought',
          title: 'thought',
          output: step.content,
          status: 'completed',
          sourceMessageID: step.sourceMessageID,
        });
        continue;
      }

      if (step.type === 'mode_transition') {
        continue;
      }

      if (step.type === 'final_answer') {
        continue;
      }
    }

    return entries;
  };

  const formatCommandTerminalOutput = (output: string) => {
    const normalized = output
      .split('\n')
      .filter((line) => !line.includes('Warning: Permanently added') || !line.includes('known hosts'))
      .join('\n')
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/␛\[[0-?]*[ -/]*[@-~]/g, '')
      .trimEnd();

    const stdoutMatch = normalized.match(/(?:^|\n)STDOUT:\n([\s\S]*?)(?=\nSTDERR:\n|$)/);
    const stderrMatch = normalized.match(/(?:^|\n)STDERR:\n([\s\S]*?)$/);
    const stdout = stdoutMatch?.[1]?.trimEnd() || '';
    const stderr = stderrMatch?.[1]?.trimEnd() || '';

    if (stdout || stderr) {
      return [stdout, stderr].filter(Boolean).join('\n');
    }

    if (normalized.includes('--- STDOUT ---') || normalized.includes('--- STDERR ---')) {
      const managedStdoutMatch = normalized.match(/(?:^|\n)--- STDOUT ---\n([\s\S]*?)(?=\n--- STDERR ---|$)/);
      const managedStderrMatch = normalized.match(/(?:^|\n)--- STDERR ---\n([\s\S]*?)$/);
      const managedStdout = managedStdoutMatch?.[1]?.trimEnd() || '';
      const managedStderr = managedStderrMatch?.[1]?.trimEnd() || '';
      return [managedStdout, managedStderr].filter(Boolean).join('\n').trimEnd();
    }

    if (normalized.includes('Status: still running in background terminal')) {
      return normalized
        .split('\n')
        .filter((line) => (
          line.startsWith('Status:') ||
          line.startsWith('PID:') ||
          line.startsWith('Use terminal_') ||
          line.startsWith('__OPERATOR_CHAT_BACKGROUND__')
        ))
        .join('\n');
    }

    if (normalized.includes('(no output)')) {
      return '';
    }

    return normalized
      .split('\n')
      .filter((line) => !/^(Command|Workspace|Exit code|Duration):/.test(line.trim()))
      .join('\n')
      .trimEnd();
  };

  const extractAttachmentsMarker = (raw: string): { attachments: Array<{ mime: string; filename?: string; url: string }>; rest: string } => {
    const re = /<!--operator:attachments=(.*?)-->\n?/g;
    let attachments: Array<{ mime: string; filename?: string; url: string }> = [];
    const rest = raw.replace(re, (_match, payload: string) => {
      try {
        const parsed = JSON.parse(payload);
        if (Array.isArray(parsed)) {
          attachments = attachments.concat(
            parsed
              .filter((a) => a && typeof a === 'object' && typeof a.url === 'string')
              .map((a) => ({ mime: String(a.mime || ''), filename: a.filename ? String(a.filename) : undefined, url: String(a.url) }))
          );
        }
      } catch {
        // ignore malformed marker
      }
      return '';
    });
    return { attachments, rest };
  };

  const renderAttachments = (attachments: Array<{ mime: string; filename?: string; url: string }>) => {
    if (attachments.length === 0) return null;
    const decorate = (url: string): string => {
      if (!url.startsWith('/api/agent-attachments/')) return url;
      const token = localStorage.getItem('token');
      if (!token) return url;
      const sep = url.includes('?') ? '&' : '?';
      return `${url}${sep}token=${encodeURIComponent(token)}`;
    };

    const isScreenshotSequence = attachments.length >= 2 &&
      attachments.every(a => a.mime === 'image/png' && a.filename && a.filename.startsWith('frame_'));

    if (isScreenshotSequence) {
      const frames = attachments.map((att, idx) => ({
        url: decorate(att.url),
        label: att.filename?.replace('.png', '') || `Frame ${idx + 1}`,
      }));
      return <ScreenshotSequence frames={frames} />;
    }

    const images = attachments.filter((a) => a.mime.startsWith('image/'));
    const nonImages = attachments.filter((a) => !a.mime.startsWith('image/'));

    return (
      <div className="mt-2 w-full space-y-2">
        {images.map((att, idx) => {
          const url = decorate(att.url);
          return (
            <a
              key={`img-${idx}`}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full overflow-hidden rounded-lg border border-white/10 bg-black/30"
            >
              <img
                src={url}
                alt={att.filename || 'screenshot'}
                className="block h-auto w-full object-contain"
              />
            </a>
          );
        })}
        {nonImages.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {nonImages.map((att, idx) => {
              const url = decorate(att.url);
              return (
                <a
                  key={`file-${idx}`}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-zinc-300 hover:border-white/30"
                >
                  {att.filename || att.url}
                </a>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const renderTerminalOutput = (output?: string, type?: AgentTerminalEntry['type'], title?: string) => {
    if (!output) return null;
    const { attachments, rest } = extractAttachmentsMarker(output);

    const normalized = (type === 'command' ? formatCommandTerminalOutput(rest) : rest)
      .split('\n')
      .filter((line) => !line.includes('Warning: Permanently added') || !line.includes('known hosts'))
      .join('\n')
      .trimEnd();
    if (!normalized && attachments.length === 0) return null;

    if (title === 'browser') {
      return (
        <>
          {renderAttachments(attachments)}
          {normalized && <BrowserToolOutput text={normalized} />}
        </>
      );
    }

    return (
      <>
        {normalized && <TerminalOutput normalized={normalized} type={type} />}
        {renderAttachments(attachments)}
      </>
    );
  };

  const renderTerminalEntry = (
    entry: AgentTerminalEntry,
    runId?: string
  ) => {
    // Show rewind whenever the entry maps to a v2 message; the backend will
    // refuse with a clear error if the run is still active so the button
    // doesn't silently no-op on running runs but is still visually present.
    const canRewind = Boolean(runId && entry.sourceMessageID);
    const rewindButton = canRewind ? (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          rollbackAgentRun(runId!, entry.sourceMessageID!);
        }}
        className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-300 transition-colors hover:border-amber-500/50 hover:bg-amber-500/10 hover:text-amber-200"
        title="Rewind the agent back to this step and replay from here"
      >
        <svg className="size-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a5 5 0 015 5v0a5 5 0 01-5 5H9" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 6l-4 4 4 4" />
        </svg>
        rewind
      </button>
    ) : null;

    // LLM narration ("thought") renders without the `$ thought` header — just
    // the text, so it reads as inline reasoning between commands.
    if (entry.type === 'thought') {
      return (
   <div key={entry.id} className="group min-w-0 border-b border-white/5 px-4 py-3 last:border-b-0">
          <div className="flex items-start gap-2">
            <div className="flex-1 text-sm leading-6 text-zinc-300 whitespace-pre-wrap">
              {entry.output || entry.title}
            </div>
            {rewindButton}
          </div>
        </div>
      );
    }

    const accent = entry.type === 'command'
      ? 'text-emerald-300'
      : entry.type === 'tool'
        ? 'text-sky-300'
        : entry.type === 'final'
          ? 'text-emerald-200'
          : 'text-zinc-300';
    const visibleArgs = entry.args && entry.type !== 'command'
      ? Object.entries(entry.args)
        .filter(([key]) => !['content', 'patchText', 'oldString', 'newString'].includes(key))
        .filter(([key]) => !(key === 'path' && entry.command?.includes(String(entry.args?.path))))
      : [];

    return (
      <div key={entry.id} className="group border-b border-white/5 px-4 py-3 last:border-b-0">
        <div className="flex min-w-0 items-center gap-2 font-mono text-xs">
          <span className={accent}>$</span>
          <span className="min-w-0 flex-1 truncate text-zinc-100">{entry.command || entry.title}</span>
          {entry.status === 'running' && (
            <span className="flex items-center gap-1 text-[11px] text-emerald-300">
              <span className="size-1.5 rounded-full bg-emerald-300 animate-pulse" />
              running
            </span>
          )}
          {rewindButton}
        </div>
        {visibleArgs.length > 0 && (
          <div className="mt-2 min-w-0 break-words rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 font-mono text-[11px] leading-5 text-zinc-500">
            {visibleArgs
              .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
              .join('\n')}
          </div>
        )}
        {renderTerminalOutput(entry.output, entry.type, entry.title)}
      </div>
    );
  };

  // Defined ABOVE renderAgentRunCard so the JSX inside the card can reference
  // these handlers without hitting a TDZ error during the useMemo render pass
  // (renderedMessages calls renderAgentRunCard before the component body has
  // finished executing).
  const handleAgentQuestionAnswer = (answer: string | string[]) => {
    if (!socket || !agentQuestion) return;
    socket.emit('agent-question-response', {
      chatId: agentQuestion.chatId,
      agentRunId: agentQuestion.agentRunId,
      questionId: agentQuestion.questionId,
      answer,
    });
    setAgentQuestion(null);
  };

  const handleAgentQuestionDismiss = () => {
    // Dismiss without sending — backend will time out or accept the next steering message.
    setAgentQuestion(null);
  };

  const renderAgentRunCard = (runId: string) => {
    const run = agentRuns[runId];
    if (!run) {
      return (
        <div className="max-w-3xl mx-auto rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-zinc-500">
          Loading agent run...
        </div>
      );
    }

    const statusClass = run.status === 'running'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
      : run.status === 'failed'
        ? 'border-red-500/30 bg-red-500/10 text-red-200'
        : 'border-white/10 bg-white/5 text-zinc-300';
    const terminalEntries = buildAgentTerminalEntries(run.steps);
    const commandCount = terminalEntries.filter((entry) => entry.type === 'command').length;

    return (
      <div ref={(el) => agentCardRefs.current.set(run.id, el)} className="max-w-4xl mx-auto min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-[#080809] shadow-2xl shadow-black/30">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 bg-[#111113] px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-zinc-100">{run.title}</div>
            <div className="mt-1 truncate font-mono text-xs text-zinc-500">
              {run.workspaceRoot} · {commandCount} command{commandCount === 1 ? '' : 's'} · {terminalEntries.length} events
            </div>
          </div>
          <span className={`rounded-full border px-2 py-0.5 text-xs uppercase ${statusClass}`}>
            {run.status}
          </span>
        </div>

        <div className="border-b border-white/5 px-4 py-3">
          <div className="font-mono text-xs text-zinc-500">task</div>
          <AgentTaskPreview prompt={run.prompt} />
        </div>

        <div>
          {terminalEntries.length === 0 ? (
            <div className="px-4 py-5 font-mono text-sm text-zinc-500">
              Waiting for the agent to start...
            </div>
          ) : (() => {
            const COLLAPSE_THRESHOLD = 3;
            const collapsible = terminalEntries.length > COLLAPSE_THRESHOLD;
            const expanded = !collapsible || expandedAgentRuns.has(run.id);
            const lastEntry = terminalEntries[terminalEntries.length - 1];
            return (
              <>
                {collapsible && (
                  <button
                    type="button"
                    onClick={() => toggleAgentRunTrace(run.id)}
                    className="flex w-full items-center gap-2 border-b border-white/5 px-4 py-2.5 text-left font-mono text-xs text-zinc-400 transition-colors hover:bg-white/[0.02] hover:text-zinc-200"
                  >
                    <svg className={`size-3.5 shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                    <span>
                      {expanded
                        ? t('chat.agentTraceCollapse')
                        : t('chat.agentTraceExpand', { commands: commandCount, events: terminalEntries.length })}
                    </span>
                  </button>
                )}
                {expanded ? (
                  collapsible ? (
                    <CollapsibleReveal onOpened={() => revealScrollToBottom(agentCardRefs.current.get(run.id))}>
                      {terminalEntries.map((entry) => renderTerminalEntry(entry, run.id))}
                      <button
                        type="button"
                        onClick={() => toggleAgentRunTrace(run.id)}
                        className="flex w-full items-center gap-2 border-t border-white/5 px-4 py-2.5 text-left font-mono text-xs text-zinc-400 transition-colors hover:bg-white/[0.02] hover:text-zinc-200"
                      >
                        <svg className="size-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                        </svg>
                        <span>{t('chat.agentTraceCollapse')}</span>
                      </button>
                    </CollapsibleReveal>
                  ) : (
                    terminalEntries.map((entry) => renderTerminalEntry(entry, run.id))
                  )
                ) : (
                  <>
                    <div className="px-4 py-2 font-mono text-[11px] text-zinc-600">
                      {t('chat.agentTraceHidden', { count: terminalEntries.length - 1 })}
                    </div>
                    {renderTerminalEntry(lastEntry, run.id)}
                  </>
                )}
              </>
            );
          })()}
          {run.status === 'running' && (
            <div className="flex items-center gap-2 px-4 py-3 font-mono text-sm text-emerald-300">
              <span className="text-zinc-500">$</span>
              <span className="h-4 w-2 animate-pulse bg-emerald-300" aria-label="Agent is working" />
            </div>
          )}
        </div>

        {run.status === 'running' && (
          <div className="border-t border-white/10 bg-[#0d0d0f] px-4 py-3">
            <div className="flex items-end gap-2">
              <textarea
                value={agentSteeringDrafts[run.id] || ''}
                onChange={(event) => setAgentSteeringDrafts((current) => ({ ...current, [run.id]: event.target.value }))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    sendAgentSteering(run.id);
                  }
                }}
                rows={1}
                placeholder="Send a message to this running agent"
                className="min-h-9 flex-1 resize-none rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 focus:border-emerald-500/40"
              />
              <button
                type="button"
                onClick={() => sendAgentSteering(run.id)}
                disabled={!(agentSteeringDrafts[run.id] || '').trim()}
                className="flex size-9 items-center justify-center rounded-lg bg-emerald-500 text-black transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Send message to agent"
                title="Send message to agent"
              >
                <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        )}

        {agentQuestion && agentQuestion.agentRunId === run.id && (
          <AgentQuestionDialog
            question={agentQuestion}
            onAnswer={handleAgentQuestionAnswer}
            onDismiss={handleAgentQuestionDismiss}
          />
        )}

        {run.error && (
          <div className="border-t border-red-500/20 bg-red-500/10 px-4 py-3 font-mono text-sm text-red-200">
            {run.error}
          </div>
        )}

        {(run.status === 'cancelled' || run.status === 'failed') && (
          <div className="flex items-center justify-between gap-3 border-t border-white/10 bg-[#0d0d0f] px-4 py-3">
            <div className="text-xs text-zinc-400">
              This run stopped before finishing. You can resume from where it left off.
            </div>
            <button
              type="button"
              onClick={() => resumeAgentRun(run.id)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 transition-colors hover:bg-emerald-500/20"
            >
              <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Resume
            </button>
          </div>
        )}

        {(agentRunTasks[run.id]?.length ?? 0) > 0 && (
          <div className="border-t border-white/10 bg-[#0a0a0c] px-4 py-3">
            <div className="mb-2 font-mono text-xs uppercase tracking-wide text-zinc-500">tasks</div>
            <ul className="space-y-1.5">
              {agentRunTasks[run.id]!.map((task) => {
                const priorityClass =
                  task.priority === 'high' ? 'border-red-500/40 text-red-200' :
                  task.priority === 'low' ? 'border-zinc-600 text-zinc-400' :
                  'border-amber-500/40 text-amber-200';
                const titleClass =
                  task.status === 'completed' ? 'text-zinc-500 line-through' :
                  task.status === 'cancelled' ? 'text-zinc-600 line-through' :
                  'text-zinc-200';
                return (
                  <li key={task.id} className="flex items-start gap-2 text-sm">
                    <span aria-hidden className="mt-0.5 flex-shrink-0">
                      {task.status === 'completed' ? (
                        <svg className="size-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : task.status === 'cancelled' ? (
                        <svg className="size-4 text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 6l12 12M6 18L18 6" />
                        </svg>
                      ) : task.status === 'in_progress' ? (
                        <svg className="size-4 animate-spin text-amber-400" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
                          <path d="M22 12a10 10 0 01-10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      ) : (
                        <svg className="size-4 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <circle cx="12" cy="12" r="9" strokeWidth="2" />
                        </svg>
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className={titleClass}>{task.subject}</div>
                        {task.priority && (
                          <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${priorityClass}`}>
                            {task.priority}
                          </span>
                        )}
                      </div>
                      {task.description && (
                        <div className="mt-0.5 text-xs text-zinc-500">{task.description}</div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {run.status === 'completed' && run.finalAnswer && (
          <div className="border-t border-white/10 bg-[#0a0a0c] px-4 py-4">
            <div className="mb-2 font-mono text-xs uppercase tracking-wide text-zinc-500">answer</div>
            <div className="prose prose-invert max-w-full break-words min-w-0 text-sm text-zinc-200">
              <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>{run.finalAnswer}</ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    );
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
        <div key={`reasoning-${idx}`} ref={(el) => reasoningCardRefs.current.set(idx, el)} className="max-w-3xl mx-auto">
          <div className="mt-2 mb-2 bg-surface-100/50 rounded-xl p-3 border border-white/5 max-w-full">
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-zinc-400">
                <svg className="size-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                <span className="text-xs font-medium uppercase tracking-wide">{truncatedType}</span>
                {hasStreaming && <span className="inline-block w-1.5 h-1.5 bg-current rounded-full animate-pulse" />}
              </div>
              <div className="relative max-h-[3.75rem] overflow-hidden">
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
      <div key={`reasoning-${idx}`} ref={(el) => reasoningCardRefs.current.set(idx, el)} className="mx-auto space-y-2 mt-2 mb-2">
        <CollapsibleReveal onOpened={() => revealScrollToBottom(reasoningCardRefs.current.get(idx))}>
        <div className="min-w-0 max-w-full break-words space-y-2 overflow-hidden rounded-xl border border-white/5 bg-surface-100/50 p-3 sm:max-w-full sm:p-4">
          {stepsToDisplay.map((step, stepIdx) => renderAgentStep(step, stepIdx))}
          {isProcessingMsg && streamingThoughtContent && currentStepType === 'thought' && (
            <div className="min-w-0 overflow-hidden rounded-2xl border border-white/5 bg-black/20 p-3">
              <span className="font-medium text-xs uppercase tracking-wide text-zinc-400">{t('chat.thought')}</span>
              <div className="mt-3 text-sm prose prose-invert max-w-none text-zinc-300">
                <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>{streamingThoughtContent}</ReactMarkdown>
                <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-zinc-400" />
              </div>
            </div>
          )}
  {isProcessingMsg && streamingContent && currentStepType === 'observation' && (
             <div className="min-w-0 overflow-hidden rounded-2xl border border-white/5 bg-black/20 p-3">
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
        </CollapsibleReveal>
      </div>
    );
  };

  const renderMessage = (msg: ChatMessage, idx: number) => {
    const agentRunId = getAgentRunIdFromMessage(msg);
    if (agentRunId) {
      return (
        <React.Fragment key={msg.id || idx}>
           <div
             ref={(el) => messageRefs.current.set(idx, el)}
             className={`${idx === 0 ? 'pt-8' : ''}`}
           >
             {renderAgentRunCard(agentRunId)}
           </div>
         </React.Fragment>
      );
    }

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
        className={`mx-auto flex max-w-3xl min-w-0 gap-3 transition-colors sm:gap-4 ${isHighlighted ? 'bg-brand/10 -mx-2 rounded-2xl px-2 py-2 ring-1 ring-brand/20 sm:-mx-4 sm:px-4' : ''} ${isFirstMessage ? 'pt-8' : ''}`}
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
                 <div className="max-w-full min-w-0">
                   <div className="mb-2 flex items-center">
                     <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
                       You
                     </span>
                   </div>
                   <div className="max-w-full min-w-0 whitespace-pre-wrap break-words">
                     {msg.content}
                   </div>
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
                    <UIStreamingContext.Provider value={isProcessing && processingMessageIndex !== null && idx === processingMessageIndex + 1}>
                      <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>{msg.content}</ReactMarkdown>
                    </UIStreamingContext.Provider>
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
                    <div className="absolute bottom-full left-0 mb-2 w-64 max-w-[calc(100vw-2rem)] bg-[#1e1e20] border border-white/10 rounded-lg shadow-lg z-50 overflow-hidden">
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
  }, [messages, agentRuns, currentAgentSteps, processingMessageIndex, expandedThoughts, expandedAgentRuns, streamingThoughtContent,
      streamingContent, currentStepType, editingMessageIndex, editContent, showRetryDropdown,
      copiedMessageId, highlightedMessage, isProcessing, agentSteeringDrafts]);

  const isEmptyState = messages.length === 0 && !isProcessing;

  const renderComposer = (extraClassName = '') => (
    <div className={`input-glow relative rounded-lg border border-[var(--line)] bg-[var(--bg-0)]/80 backdrop-blur-xl transition-all duration-200 ${extraClassName}`}>
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5">
        <div className="relative" ref={toolPickerRef}>
          <button
            type="button"
            onClick={() => { setToolSearch(''); setShowToolPicker((prev) => !prev); }}
            className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-sm font-medium text-[var(--fg-2)] hover:bg-[rgba(255,255,255,.04)] transition-colors"
          >
            <svg className="size-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.5 6h9m-9 6h9m-9 6h9M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
            </svg>
            <span>Tools</span>
          </button>

          {showToolPicker && (
            <div className="absolute bottom-full left-0 z-30 mb-2 w-[calc(100vw-1.5rem)] max-w-[calc(100vw-1.5rem)] sm:w-[48rem] sm:max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-white/10 bg-[#1b1b1d] shadow-2xl shadow-black/40">
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
              <div className="border-b border-white/10 px-3 py-2.5">
                <input
                  type="text"
                  value={toolSearch}
                  onChange={(event) => setToolSearch(event.target.value)}
                  placeholder={t('chat.searchTools')}
                  className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-white/20"
                />
              </div>
              <div className="max-h-[60vh] overflow-y-auto overflow-x-hidden p-2.5">
                <div className="columns-1 sm:columns-2 gap-2.5">
                {availableTools
                  .filter((tool) => {
                    const q = toolSearch.trim().toLowerCase();
                    if (!q) return true;
                    return tool.name.toLowerCase().includes(q) || tool.description.toLowerCase().includes(q);
                  })
                  .map((tool) => {
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
                      className="mb-2.5 break-inside-avoid rounded-xl border border-white/10 bg-black/20 p-3 transition-colors hover:border-white/20"
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
                {availableTools.length > 0 &&
                  toolSearch.trim() &&
                  !availableTools.some((tool) => {
                    const q = toolSearch.trim().toLowerCase();
                    return tool.name.toLowerCase().includes(q) || tool.description.toLowerCase().includes(q);
                  }) && (
                    <div className="px-3 py-4 text-sm text-zinc-500">{t('chat.noToolsMatch')}</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="flex flex-1 items-center justify-center">
        {showStats && (
          <div className="flex items-center gap-3 text-[10px] text-[var(--fg-3)]">
            {stats.tokensPerSec > 0 && (
              <span className="flex items-center gap-1">
                <svg className="size-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                <span className="text-[var(--fg-2)]">{stats.tokensPerSec}</span> tok/s
              </span>
            )}
            {stats.contextSize > 0 && (
              <span className="flex items-center gap-1">
                <svg className="size-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
                </svg>
                <span className="text-[var(--fg-2)]">{stats.contextSize}</span> tokens
              </span>
            )}
          </div>
        )}
      </div>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-sm text-[var(--fg-2)]">Reasoning:</span>
          <select
            value={reasoningEffort}
            onChange={(e) => setReasoningEffort(e.target.value as 'low' | 'medium' | 'high')}
            className="rounded border border-[var(--line)] bg-transparent px-2 py-1 text-sm text-[var(--fg-2)] hover:bg-[rgba(255,255,255,.04)] focus:outline-none focus:border-[var(--line-3)]"
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
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
        className="w-full max-h-[160px] min-h-[32px] resize-none bg-transparent px-3 py-2 text-base leading-6 text-[var(--fg-0)] outline-none placeholder:text-[var(--fg-3)] sm:min-h-[32px] sm:px-3 sm:py-2"
      />
      <div className="absolute bottom-2 right-2 flex items-center gap-1">
        <input
          ref={fileInputRef}
          type="file"
          onChange={handleFileUpload}
          className="hidden"
        />
        <button
          onClick={triggerFileInput}
          disabled={uploading || isProcessing}
          className="flex size-8 items-center justify-center rounded-lg text-[var(--fg-3)] transition-colors hover:bg-[rgba(255,255,255,.04)] hover:text-[var(--fg-1)] disabled:opacity-50"
          aria-label={t('common.attachFile')}
          title={uploading ? t('common.processing') : t('common.attachFile')}
        >
          <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
        </button>
        {isProcessing || hasRunningAgentRun ? (
          <button
            onClick={stopAgent}
            disabled={isStopping}
            className="flex size-8 items-center justify-center rounded-lg bg-rose text-white transition-colors hover:bg-rose/80 disabled:opacity-60"
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
            className="flex size-8 items-center justify-center rounded-lg bg-[var(--accent)] text-[var(--accent-ink)] transition-colors hover:opacity-80 disabled:opacity-50"
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
    <div className="relative flex min-h-0 flex-1 flex-col min-w-0">
      <div
        ref={setScrollContainerRef}
        onScroll={handleScroll}
        className="relative flex min-w-0 flex-1 flex-col overflow-y-auto px-3 pb-4 pt-5 sm:px-4 sm:pt-6 md:px-6 md:pb-4 md:pt-5 safe-bottom"
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
            <div ref={setScrollContentRef} className="max-w-3xl mx-auto w-full">
              <UISendToAssistantContext.Provider value={handleUISendToAssistant}>
                {renderedMessages}
              </UISendToAssistantContext.Provider>
            </div>
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Jump to Bottom Button */}
      <button
        ref={jumpButtonRef}
        onClick={jumpToBottom}
        className="fixed bottom-24 right-3 z-20 flex items-center gap-2 rounded-full bg-brand px-3 py-2 text-white shadow-lg transition-all hover:bg-brand-dark sm:bottom-24 sm:right-4 sm:px-4 md:right-8"
        style={{ display: 'none' }}
        aria-label="Jump to bottom"
      >
        <span className="hidden text-sm sm:inline">{t('chat.jumpToLatest')}</span>
        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
        </svg>
      </button>

      <div className="px-2 pb-2 sm:px-3 sm:pb-3 md:px-5 md:pb-4">
        <div className="max-w-3xl mx-auto">
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
                  className="rounded-lg border border-white/10 bg-[var(--bg-2)] px-3 py-2 text-xs font-medium text-[var(--fg-2)] transition-colors hover:bg-[var(--bg-3)]"
                >
                  {t('common.deny')}
                </button>
                <button
                  type="button"
                  onClick={() => respondToApproval(true)}
                  className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--accent-ink)] transition-colors hover:opacity-80"
                >
                  {t('common.approve')}
                </button>
                {pendingApproval.policy.supportsAutoApprove && (
                  <button
                    type="button"
                    onClick={() => respondToApproval(true, true)}
                    className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs font-medium text-[var(--fg-2)] transition-colors hover:bg-[var(--bg-2)]"
                  >
                    {t('chat.alwaysApprove')}
                  </button>
                )}
              </div>
            </div>
          )}
          {!isEmptyState && renderComposer()}
          <div className="mt-2 px-2 text-center text-[11px] font-medium text-[var(--fg-3)] sm:mt-3 sm:text-xs">
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

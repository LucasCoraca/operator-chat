import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import type { ToolDefinition } from '../../services/llamaClient';
import type { WorkspaceConfig, WorkspaceRuntime } from '../../services/workspaceRuntime';
import { WorkspaceRuntimeFactory } from '../../services/workspaceRuntime';
import type { SandboxManager } from '../../services/sandboxManager';
import { BrowserClient, BrowserSessionResult } from '../../services/browserClient';
import type { AgentSessionRepository } from '../../repositories/agentSessionRepository';
import type {
  AgentRunTaskRepository,
  AgentRunTask,
  AgentRunTaskStatus,
  AgentRunTaskPriority,
  TodoListItem,
} from '../../repositories/agentRunTaskRepository';
import { capOutput, MAX_BYTES, MAX_LINES, TMP_ROOT } from './outputCap';
import { isToolPart, ToolPart } from './message';

// The SSH agent's tool surface, aligned 1:1 with the spec (spec section
// "Tools only visible to the SSH Agent"):
//   shell, read, write, edit, glob, grep, task, browser, todo, question, invalid
//
// This module owns the LLM-facing definitions AND the executors. The executors
// route to the SSH workspace runtime for filesystem/process tools, the
// agentRunTaskRepository for `todo`, and the host application for the
// interactive tools (`task`, `browser`, `question`).

export const SSH_AGENT_TOOLS = [
  'shell',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'task',
  'browser',
  'todo',
  'question',
  'invalid',
] as const;

export type SshAgentToolName = (typeof SSH_AGENT_TOOLS)[number];

export interface SshAgentToolPolicy {
  /** Show an approval prompt before running this tool. */
  requiresApproval: boolean;
  /** Risk shown in the approval card. */
  riskLevel: 'low' | 'medium' | 'high';
}

export interface SshAgentToolContext {
  chatId: string;
  agentRunId: string;
  sessionId: string;
  userId: string;
  sandboxId: string;
  workspace: WorkspaceConfig;
  modelID: string;
  /** Streaming progress emitter (UI shows live tail). */
  emitToolProgress?: (content: string) => void;
  /** Notify the host that the tasks list changed. */
  emitTasksUpdated?: (chatId: string, agentRunId: string, tasks: AgentRunTask[]) => void;
  /** Used by `question` to ask the host to surface a UI prompt. */
  askUserQuestion?: (request: QuestionRequest) => Promise<QuestionResponse | null>;
  /** Used by `task` to spawn a sub-agent. */
  launchSubagent?: (request: SubagentRequest) => Promise<SubagentLaunchResult>;
}

export interface SshAgentToolResult {
  /** Output the LLM will see, already capped. */
  output: string;
  /** Set when the tool failed (still produces a string the LLM can read). */
  isError: boolean;
  /** True when the original output exceeded the cap. */
  truncated: boolean;
  /** When `truncated`, points to the file holding the full output. */
  fullPath?: string;
  /** Optional FilePart-style attachments (images/PDFs/screenshots). */
  attachments?: Array<{ mime: string; filename?: string; url: string }>;
}

export interface SshAgentTool {
  name: SshAgentToolName;
  description: string;
  parameters: ToolDefinition['function']['parameters'];
  policy: SshAgentToolPolicy;
  execute: (
    args: Record<string, any>,
    context: SshAgentToolContext,
    sessions: AgentSessionRepository,
    tasks: AgentRunTaskRepository
  ) => Promise<SshAgentToolResult>;
}

// ── Question / task plumbing types ──────────────────────────────────────────

export interface QuestionRequest {
  questionId: string;
  question: string;
  options?: Array<{ value: string; label: string; recommended?: boolean }>;
  multiple?: boolean;
  allowCustomAnswer?: boolean;
  timeoutMs?: number;
}

export interface QuestionResponse {
  /** One of the option values, or a custom string if allowCustomAnswer is true. */
  answer: string | string[];
  /** True if the user answered the dialog rather than ignoring it. */
  answered: boolean;
}

export interface SubagentRequest {
  subagentType: 'explore' | 'build' | 'plan' | string;
  prompt: string;
  parentSessionId: string;
  /** Resume an existing subagent run; if absent, a new one is created. */
  taskId?: string;
}

export interface SubagentLaunchResult {
  taskId: string;
  status: 'running' | 'completed' | 'failed';
  result?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const IMAGE_MIME = (ext: string): string | undefined => {
  switch (ext.toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.svg': return 'image/svg+xml';
    case '.bmp': return 'image/bmp';
    case '.pdf': return 'application/pdf';
    default: return undefined;
  }
};

function ensureTmpRoot(): void {
  try {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
  } catch {
    // best-effort
  }
}

async function readFilesAlreadyRead(
  sessions: AgentSessionRepository,
  sessionId: string
): Promise<Set<string>> {
  const messages = await sessions.listMessagesWithParts(sessionId);
  const paths = new Set<string>();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (!isToolPart(part)) continue;
      if (part.tool !== 'read') continue;
      const p = part.state.input?.path;
      if (typeof p === 'string' && p.length > 0) {
        paths.add(normalizeForCompare(p));
      }
    }
  }
  return paths;
}

function normalizeForCompare(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

// One BrowserClient per backend process so all SSH agent runs share the same
// Puppeteer instance. Sessions are keyed by agent run id below so each run
// has its own page.
let _browserClient: BrowserClient | null = null;
function getBrowserClient(): BrowserClient {
  if (!_browserClient) _browserClient = new BrowserClient();
  return _browserClient;
}

function getRuntime(workspace: WorkspaceConfig): WorkspaceRuntime {
  // Lazily build a single SshWorkspaceRuntime per call. The runtime is
  // stateless aside from optional terminal bookkeeping; there's no benefit
  // to caching it across tool calls.
  const sandboxManager = undefined as unknown as SandboxManager; // not used by ssh path
  const factory = new WorkspaceRuntimeFactory(sandboxManager);
  return factory.createRemote(workspace);
}

/** Cap a tool's textual output and return a SshAgentToolResult-shaped object. */
function capResult(name: string, raw: string, isError: boolean): SshAgentToolResult {
  const capped = capOutput(raw, { maxLines: MAX_LINES, maxBytes: MAX_BYTES, label: name });
  return {
    output: capped.text,
    isError,
    truncated: capped.truncated,
    fullPath: capped.fullPath,
  };
}

// ── Tool implementations ────────────────────────────────────────────────────

const shellTool: SshAgentTool = {
  name: 'shell',
  description:
    'Execute a shell command on the remote workspace host. Supports git, npm, docker, and any terminal operation. Output is streamed and capped at 2,000 lines or 50KB. Use working_dir to run relative to a subdirectory.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute.' },
      working_dir: { type: 'string', description: 'Optional path relative to the workspace root.' },
      timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds. Defaults to 120000.' },
      description: { type: 'string', description: 'Short human description of what this command does.' },
    },
    required: ['command'],
  },
  policy: { requiresApproval: true, riskLevel: 'high' },
  execute: async (args, context) => {
    const command = String(args.command || '').trim();
    if (!command) return capResult('shell', 'Error: command is required', true);
    try {
      const runtime = getRuntime(context.workspace);
      const result = await runtime.exec({
        command,
        workdir: typeof args.working_dir === 'string' ? args.working_dir : undefined,
        timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
        onStdout: (chunk) => context.emitToolProgress?.(chunk),
        onStderr: (chunk) => context.emitToolProgress?.(`[stderr]\n${chunk}`),
      });
      const sections: string[] = [
        `Command: ${command}`,
        `Exit code: ${result.exitCode ?? 'unknown'}`,
        `Duration: ${result.durationMs}ms`,
      ];
      if (result.timedOut) sections.push('Status: timed out and was terminated');
      if (result.stdout.trim()) sections.push(`\nSTDOUT:\n${result.stdout.trimEnd()}`);
      if (result.stderr.trim()) sections.push(`\nSTDERR:\n${result.stderr.trimEnd()}`);
      if (!result.stdout.trim() && !result.stderr.trim()) sections.push('\n(no output)');
      const isError = result.exitCode !== 0 && result.exitCode !== null;
      return capResult('shell', sections.join('\n'), isError);
    } catch (error) {
      return capResult('shell', `Error running shell command: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  },
};

const readTool: SshAgentTool = {
  name: 'read',
  description:
    'Read a file or directory. Defaults to 2,000 lines from the start. Supports `offset` (1-indexed) and `limit`. Reads images and PDFs as file attachments. Detects and rejects binary files. Lines longer than 2,000 characters are truncated.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
      offset: { type: 'number', description: '1-indexed starting line. Defaults to 1.' },
      limit: { type: 'number', description: 'Maximum lines to read. Defaults to 2000.' },
    },
    required: ['path'],
  },
  policy: { requiresApproval: false, riskLevel: 'low' },
  execute: async (args, context) => {
    const filePath = String(args.path || '').trim();
    if (!filePath) return capResult('read', 'Error: path is required', true);
    const offset = args.offset !== undefined ? Number(args.offset) : 1;
    const limit = args.limit !== undefined ? Number(args.limit) : MAX_LINES;
    try {
      const runtime = getRuntime(context.workspace);
      const ext = path.extname(filePath);
      const mime = IMAGE_MIME(ext);

      if (mime) {
        // Image / PDF — return a FilePart attachment with the remote path. We
        // don't transfer the bytes here; the host UI pulls the file lazily if
        // needed. Output text is a stub describing the attachment.
        return {
          output: `Attached ${mime} file: ${filePath}`,
          isError: false,
          truncated: false,
          attachments: [
            {
              mime,
              filename: path.basename(filePath),
              url: `ssh://${context.workspace.ssh!.username}@${context.workspace.ssh!.host}${path.posix.isAbsolute(filePath) ? filePath : path.posix.join(context.workspace.ssh!.root, filePath)}`,
            },
          ],
        };
      }

      const content = await runtime.readFile(filePath, { offset, limit });
      return capResult('read', content, false);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const isBinary = /Cannot read binary file/i.test(msg);
      return capResult('read', `Error reading file: ${msg}${isBinary ? '\nUse a binary-safe tool such as `shell` with file or hexdump.' : ''}`, true);
    }
  },
};

const writeTool: SshAgentTool = {
  name: 'write',
  description:
    'Write a file to disk on the remote workspace. Overwrites existing files. Requires the file to have been read first in this run; prefer `edit` for changes to existing files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
      content: { type: 'string', description: 'Complete file content to write.' },
    },
    required: ['path', 'content'],
  },
  policy: { requiresApproval: true, riskLevel: 'medium' },
  execute: async (args, context, sessions) => {
    const filePath = String(args.path || '').trim();
    if (!filePath) return capResult('write', 'Error: path is required', true);
    if (args.content === undefined || args.content === null) {
      return capResult('write', 'Error: content is required', true);
    }

    const reads = await readFilesAlreadyRead(sessions, context.sessionId);
    const target = normalizeForCompare(filePath);
    const fileExistedBefore = reads.has(target);

    try {
      const runtime = getRuntime(context.workspace);
      // For new files (which the spec allows write to create), the read-first
      // requirement is waived. We probe with a read; if it fails with "File
      // not found" we treat the path as a new file.
      if (!fileExistedBefore) {
        try {
          await runtime.readFile(filePath, { offset: 1, limit: 1 });
          return capResult(
            'write',
            `Error: refusing to overwrite ${filePath} because it has not been read yet in this run. Read the file first, then call write or use edit.`,
            true
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (!/File not found/i.test(msg)) throw error;
          // file does not exist — proceed to create.
        }
      }
      const content = String(args.content);
      const result = await runtime.writeFile(filePath, content);
      return capResult('write', result, false);
    } catch (error) {
      return capResult('write', `Error writing file: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  },
};

const editTool: SshAgentTool = {
  name: 'edit',
  description:
    'Perform an exact string replacement in a file. Requires the file to have been read first. Fails if `oldString` is not present, or matches more than once unless `replaceAll` is true.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
      oldString: { type: 'string', description: 'Exact text to replace.' },
      newString: { type: 'string', description: 'Replacement text.' },
      replaceAll: { type: 'boolean', description: 'Replace all occurrences. Defaults to false.' },
    },
    required: ['path', 'oldString', 'newString'],
  },
  policy: { requiresApproval: true, riskLevel: 'medium' },
  execute: async (args, context, sessions) => {
    const filePath = String(args.path || '').trim();
    if (!filePath) return capResult('edit', 'Error: path is required', true);
    if (args.oldString === undefined || args.newString === undefined) {
      return capResult('edit', 'Error: oldString and newString are required', true);
    }

    const reads = await readFilesAlreadyRead(sessions, context.sessionId);
    if (!reads.has(normalizeForCompare(filePath))) {
      return capResult(
        'edit',
        `Error: refusing to edit ${filePath} because it has not been read yet in this run. Read the file first.`,
        true
      );
    }

    try {
      const runtime = getRuntime(context.workspace);
      const result = await runtime.editFile(
        filePath,
        String(args.oldString),
        String(args.newString),
        Boolean(args.replaceAll)
      );
      return capResult('edit', result, false);
    } catch (error) {
      return capResult('edit', `Error editing file: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  },
};

const globTool: SshAgentTool = {
  name: 'glob',
  description:
    'Find files in the workspace by glob pattern (e.g. "**/*.ts", "src/**/*.tsx"). Returns matching paths sorted by modification time.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern relative to the workspace root.' },
    },
    required: ['pattern'],
  },
  policy: { requiresApproval: false, riskLevel: 'low' },
  execute: async (args, context) => {
    const pattern = String(args.pattern || '').trim();
    if (!pattern) return capResult('glob', 'Error: pattern is required', true);
    try {
      const runtime = getRuntime(context.workspace);
      // -printf '%T@ %p\n' lets us sort by modification time desc; head caps the list.
      const result = await runtime.exec({
        command: `find . -path ${shellQuote(`./${pattern}`)} -type f -printf '%T@ %p\\n' 2>/dev/null | sort -rn | sed 's#^[^ ]* ./##' | head -200`,
      });
      if (result.exitCode !== 0 && !result.stdout.trim()) {
        return capResult('glob', `Glob failed:\n${result.stderr || result.stdout || 'Unknown error'}`, true);
      }
      return capResult('glob', result.stdout.trim() || 'No files matched.', false);
    } catch (error) {
      return capResult('glob', `Error running glob: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  },
};

const grepTool: SshAgentTool = {
  name: 'grep',
  description:
    'Fast content search using regular expressions. Searches file contents, supports full regex syntax, and filters by file pattern. Returns file paths and line numbers sorted by modification time.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      include: { type: 'string', description: 'Optional file glob to include (e.g. "*.ts").' },
    },
    required: ['pattern'],
  },
  policy: { requiresApproval: false, riskLevel: 'low' },
  execute: async (args, context) => {
    const pattern = String(args.pattern || '').trim();
    if (!pattern) return capResult('grep', 'Error: pattern is required', true);
    try {
      const runtime = getRuntime(context.workspace);
      // Prefer ripgrep when available, fall back to grep -RInE (the old behavior).
      const include = args.include ? ` --include=${shellQuote(String(args.include))}` : '';
      const cmd = `if command -v rg >/dev/null 2>&1; then rg -nH --sortr=modified ${include ? `-g ${shellQuote(String(args.include))} ` : ''}-e ${shellQuote(pattern)} . | head -200; else grep -RInE --exclude-dir=.git${include} -- ${shellQuote(pattern)} . | head -200; fi`;
      const result = await runtime.exec({ command: cmd });
      if (result.exitCode !== 0 && !result.stdout.trim()) {
        return capResult('grep', result.stderr.trim() ? `Grep failed:\n${result.stderr.trim()}` : 'No matches found.', false);
      }
      return capResult('grep', result.stdout.trim() || 'No matches found.', false);
    } catch (error) {
      return capResult('grep', `Error running grep: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  },
};

const todoTool: SshAgentTool = {
  name: 'todo',
  description:
    'Replace the entire structured todo list for this session. Pass the complete desired list. Each item has content, status (pending|in_progress|completed|cancelled), and priority (high|medium|low). The agent only sees its own todos through the tool output re-sent in the message history.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Complete replacement list of todos.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Optional id for an existing item.' },
            content: { type: 'string', description: 'What needs to be done.' },
            status: { type: 'string', description: 'pending | in_progress | completed | cancelled' },
            priority: { type: 'string', description: 'high | medium | low' },
          },
          required: ['content', 'status', 'priority'],
        },
      },
    },
    required: ['todos'],
  },
  policy: { requiresApproval: false, riskLevel: 'low' },
  execute: async (args, context, _sessions, tasks) => {
    const raw = Array.isArray(args.todos) ? args.todos : [];
    const items: TodoListItem[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const content = String(entry.content || '').trim();
      if (!content) continue;
      const status = (['pending', 'in_progress', 'completed', 'cancelled'] as AgentRunTaskStatus[])
        .includes(entry.status) ? entry.status as AgentRunTaskStatus : 'pending';
      const priority = (['high', 'medium', 'low'] as AgentRunTaskPriority[])
        .includes(entry.priority) ? entry.priority as AgentRunTaskPriority : 'medium';
      items.push({
        id: typeof entry.id === 'string' ? entry.id : undefined,
        content,
        status,
        priority,
      });
    }
    const updated = await tasks.replaceAll(context.chatId, context.agentRunId, items);
    context.emitTasksUpdated?.(context.chatId, context.agentRunId, updated);
    const lines = updated.map((task) => {
      const marker =
        task.status === 'completed' ? '[x]' :
        task.status === 'cancelled' ? '[-]' :
        task.status === 'in_progress' ? '[~]' : '[ ]';
      return `${marker} ${task.priority.toUpperCase().padEnd(6, ' ')} ${task.id}  ${task.subject}`;
    });
    return capResult('todo', lines.length ? lines.join('\n') : '(empty todo list)', false);
  },
};

const questionTool: SshAgentTool = {
  name: 'question',
  description:
    'Ask the user a question and wait for their answer. Use this to gather preferences, clarify ambiguity, or get a decision. Provide options for clickable answers; the user may also reply free-form (in which case the question is treated as ignored).',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question text shown to the user.' },
      options: {
        type: 'array',
        description: 'Optional list of predefined answers.',
        items: {
          type: 'object',
          properties: {
            value: { type: 'string', description: 'Internal value for this option.' },
            label: { type: 'string', description: 'User-visible label.' },
            recommended: { type: 'boolean', description: 'Highlight as recommended.' },
          },
          required: ['value', 'label'],
        },
      },
      multiple: { type: 'boolean', description: 'Allow selecting multiple options.' },
      allow_custom_answer: { type: 'boolean', description: 'Allow a free-form text answer.' },
      timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds.' },
    },
    required: ['question'],
  },
  policy: { requiresApproval: false, riskLevel: 'low' },
  execute: async (args, context) => {
    const question = String(args.question || '').trim();
    if (!question) return capResult('question', 'Error: question is required', true);
    if (!context.askUserQuestion) {
      return capResult(
        'question',
        'Question UI is not available in this build. Continue without user input.',
        false
      );
    }
    const request: QuestionRequest = {
      questionId: `q_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      question,
      options: Array.isArray(args.options) ? args.options : undefined,
      multiple: Boolean(args.multiple),
      allowCustomAnswer: Boolean(args.allow_custom_answer),
      timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
    };
    const response = await context.askUserQuestion(request);
    if (!response || !response.answered) {
      return capResult('question', 'User did not answer the question (likely sent a steering message instead). Continue with reasonable defaults.', false);
    }
    const answer = Array.isArray(response.answer) ? response.answer.join(', ') : response.answer;
    return capResult('question', `User answered: ${answer}`, false);
  },
};

const taskTool: SshAgentTool = {
  name: 'task',
  description:
    'Launch a subagent to handle a complex multistep task autonomously. Specify a `subagent_type` and a detailed `prompt`. Returns a task_id; pass the same id back to resume an existing subagent.',
  parameters: {
    type: 'object',
    properties: {
      subagent_type: { type: 'string', description: 'Subagent type: explore | build | plan' },
      prompt: { type: 'string', description: 'Detailed task instructions for the subagent.' },
      task_id: { type: 'string', description: 'Optional id to resume a previously launched subagent.' },
    },
    required: ['subagent_type', 'prompt'],
  },
  policy: { requiresApproval: true, riskLevel: 'medium' },
  execute: async (args, context) => {
    const subagentType = String(args.subagent_type || '').trim();
    const prompt = String(args.prompt || '').trim();
    if (!subagentType || !prompt) return capResult('task', 'Error: subagent_type and prompt are required', true);
    if (!context.launchSubagent) {
      return capResult(
        'task',
        'Subagent runner is not yet wired in this build. Reduce the work to inline tool calls or coordinate through the host agent.',
        true
      );
    }
    try {
      const result = await context.launchSubagent({
        subagentType,
        prompt,
        parentSessionId: context.sessionId,
        taskId: typeof args.task_id === 'string' ? args.task_id : undefined,
      });
      const sections = [
        `task_id: ${result.taskId}`,
        `status: ${result.status}`,
      ];
      if (result.result) sections.push(`\nResult:\n${result.result}`);
      return capResult('task', sections.join('\n'), result.status === 'failed');
    } catch (error) {
      return capResult('task', `Error launching subagent: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  },
};

const browserTool: SshAgentTool = {
  name: 'browser',
  description:
    'Open a URL or interact with a previously opened page. Returns the rendered text, plus optional screenshot, network activity, and console logs. Actions: visit | click | type | scroll | select | actions. The "select" action picks an option in a <select> dropdown by value. The "actions" batch action accepts an array of sub-actions (click, type, scroll, wait, select) to execute in a single call — use this instead of separate calls for sequences of interactions.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'visit | click | type | scroll | select | actions (batch)' },
      url: { type: 'string', description: 'URL to load (only for action=visit).' },
      selector: { type: 'string', description: 'CSS selector (for click / type / select).' },
      text: { type: 'string', description: 'Text to type (for type).' },
      scroll_y: { type: 'number', description: 'Pixels to scroll vertically (for scroll).' },
      value: { type: 'string', description: 'Option value to select (for action=select).' },
      actions: {
        type: 'array',
        description: 'Batch of sub-actions to execute in sequence (for action=actions). Each item has "action" (click/type/scroll/wait/select), and optionally "selector", "text", "scroll_y", "ms" (wait duration), or "value" (for select).',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['click', 'type', 'scroll', 'wait', 'select'] },
            selector: { type: 'string' },
            text: { type: 'string' },
            scroll_y: { type: 'number' },
            ms: { type: 'number' },
            value: { type: 'string', description: 'Option value to select (for action=select).' },
          },
          required: ['action'],
        },
      },
      include_network: { type: 'boolean', description: 'Include captured network activity.' },
      include_console: { type: 'boolean', description: 'Include captured console logs.' },
    },
    required: ['action'],
  },
  policy: { requiresApproval: true, riskLevel: 'medium' },
  execute: async (args, context) => {
    const action = String(args.action || '').trim();
    const client = getBrowserClient();
    const sessionKey = `agent_${context.agentRunId}`;

    let result: BrowserSessionResult;

    if (action === 'actions') {
      const batch = args.actions;
      if (!Array.isArray(batch) || batch.length === 0) {
        return capResult('browser', 'Error: "actions" requires an array of sub-actions', true);
      }
      result = await client.sessionActions(sessionKey, batch as any);
    } else if (!['visit', 'click', 'type', 'scroll'].includes(action)) {
      return capResult('browser', 'Error: action must be visit | click | type | scroll | actions', true);
    } else if (action === 'visit') {
      const url = String(args.url || '').trim();
      if (!url) return capResult('browser', 'Error: url is required for visit', true);
      result = await client.sessionVisit(sessionKey, url);
    } else if (action === 'click') {
      const selector = String(args.selector || '').trim();
      if (!selector) return capResult('browser', 'Error: selector is required for click', true);
      result = await client.sessionClick(sessionKey, selector);
    } else if (action === 'type') {
      const selector = String(args.selector || '').trim();
      const text = String(args.text ?? '');
      if (!selector) return capResult('browser', 'Error: selector is required for type', true);
      result = await client.sessionType(sessionKey, selector, text);
    } else if (action === 'select') {
      const selector = String(args.selector || '').trim();
      const value = String(args.value ?? '').trim();
      if (!selector) return capResult('browser', 'Error: selector is required for select', true);
      if (!value) return capResult('browser', 'Error: value is required for select', true);
      result = await client.sessionActions(sessionKey, [{ action: 'select', selector, value }]);
    } else {
      const deltaY = typeof args.scroll_y === 'number' ? args.scroll_y : 600;
      result = await client.sessionScroll(sessionKey, deltaY);
    }

    const includeNetwork = args.include_network !== false;
    const includeConsole = args.include_console !== false;

    const lines: string[] = [
      `Action: ${action}`,
      `URL: ${result.url || '(none)'}`,
      `Title: ${result.title || '(none)'}`,
    ];
    if (result.error) lines.push(`Error: ${result.error}`);
    if (result.actions && result.actions.length > 0) {
      lines.push('', '## Batch results');
      for (const r of result.actions) {
        lines.push(`- ${r.action}: ${r.success ? 'OK' : `FAIL — ${r.error}`}`);
      }
    }
    if (result.text) {
      lines.push('', '## Page text', result.text.slice(0, 8000));
    }
    if (result.html) {
      lines.push('', '## Page HTML', result.html.slice(0, 80000));
    }
    if (includeNetwork && result.network.length > 0) {
      lines.push('', `## Network (${result.network.length})`);
      for (const entry of result.network.slice(-30)) {
        const status = entry.status ?? entry.statusText ?? 'pending';
        const dur = entry.durationMs !== undefined ? ` ${entry.durationMs}ms` : '';
        lines.push(`${entry.method} ${entry.url} -> ${status}${dur}`);
      }
    }
    if (includeConsole && result.console.length > 0) {
      lines.push('', `## Console (${result.console.length})`);
      for (const entry of result.console.slice(-30)) {
        lines.push(`[${entry.type}] ${entry.text}`);
      }
    }

    const screenshotAttachment = result.screenshotPath
      ? [
          {
            mime: 'image/png',
            filename: path.basename(result.screenshotPath),
            url: `/api/agent-attachments/${path.basename(result.screenshotPath)}`,
          },
        ]
      : undefined;

    const capped = capOutput(lines.join('\n'), { maxLines: MAX_LINES, maxBytes: MAX_BYTES, label: 'browser' });
    return {
      output: capped.text,
      isError: Boolean(result.error),
      truncated: capped.truncated,
      fullPath: capped.fullPath,
      attachments: screenshotAttachment,
    };
  },
};

const invalidTool: SshAgentTool = {
  name: 'invalid',
  description: 'Internal fallback tool for invalid tool calls. Do not call this directly.',
  parameters: { type: 'object', properties: {}, required: [] },
  policy: { requiresApproval: false, riskLevel: 'low' },
  execute: async () => {
    return capResult(
      'invalid',
      'Error: this tool call was malformed. Re-emit a valid tool call from the published tool list.',
      true
    );
  },
};

// ── Registry ────────────────────────────────────────────────────────────────

const TOOLS: Record<SshAgentToolName, SshAgentTool> = {
  shell: shellTool,
  read: readTool,
  write: writeTool,
  edit: editTool,
  glob: globTool,
  grep: grepTool,
  task: taskTool,
  browser: browserTool,
  todo: todoTool,
  question: questionTool,
  invalid: invalidTool,
};

export function getSshAgentTool(name: string): SshAgentTool | undefined {
  return (TOOLS as Record<string, SshAgentTool>)[name];
}

export function getSshAgentToolDefinitions(): ToolDefinition[] {
  return SSH_AGENT_TOOLS.map((name) => {
    const tool = TOOLS[name];
    return {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    };
  });
}

export function getSshAgentToolPolicy(name: string): SshAgentToolPolicy | undefined {
  return TOOLS[name as SshAgentToolName]?.policy;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

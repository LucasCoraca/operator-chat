import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import type { ToolDefinition } from '../../services/llamaClient';
import type { WorkspaceConfig, WorkspaceRuntime } from '../../services/workspaceRuntime';
import { WorkspaceRuntimeFactory } from '../../services/workspaceRuntime';
import type { SandboxManager } from '../../services/sandboxManager';
import { BrowserClient, BrowserSessionResult, BrowserSubAction } from '../../services/browserClient';
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
  'transition_to_compose_mode',
  'invalid',
] as const;

export type SshAgentToolName = (typeof SSH_AGENT_TOOLS)[number];

// Tools the LLM is told about and offered as native function definitions.
// `task` is excluded because the host doesn't yet wire `launchSubagent`, so
// calling it always errors out and confuses the planner. `invalid` is the
// runner's internal fallback for malformed tool calls and should never be
// invoked deliberately. The full registry below still contains them for
// internal lookup (e.g. the runner adapts an unknown call to `invalid`).
const HIDDEN_FROM_LLM = new Set<SshAgentToolName>(['task', 'invalid']);
export const PUBLISHED_SSH_AGENT_TOOLS: readonly SshAgentToolName[] =
  SSH_AGENT_TOOLS.filter((name) => !HIDDEN_FROM_LLM.has(name));

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

// Map of normalized path → most recent successful `write` content for that
// path in the current run. Used by the write tool to short-circuit byte-
// identical re-writes that the LLM sometimes emits when stuck.
async function lastWrittenContentByPath(
  sessions: AgentSessionRepository,
  sessionId: string
): Promise<Map<string, string>> {
  const messages = await sessions.listMessagesWithParts(sessionId);
  const last = new Map<string, string>();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (!isToolPart(part)) continue;
      if (part.tool !== 'write') continue;
      if (part.state.status !== 'completed') continue;
      const p = part.state.input?.path;
      const c = part.state.input?.content;
      if (typeof p === 'string' && p.length > 0 && typeof c === 'string') {
        last.set(normalizeForCompare(p), c);
      }
    }
  }
  return last;
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
    'Execute a shell command on the remote workspace host (git, npm, docker, build/test/run, etc.). Each call is a FRESH shell — there is NO persistent cwd, exported variables, or shell state between calls. Use the `working_dir` parameter (or chain `cd … && …` inline) to run somewhere other than the workspace root. Both stdout and stderr are captured and returned automatically, so do NOT add `2>&1` or pipe to `tail`/`head` — the runner already truncates output (2,000 lines / 50KB) and persists overflow to a file you can re-read. Default timeout is 120s; bump `timeout_ms` for installs/builds (npm install, docker build, large test suites). For pure file/dir operations, prefer the dedicated tools: `read` (file or dir listing), `glob` (find files by pattern), `grep` (search file contents), `edit`/`write` (modify files) — they return structured, capped output and are faster than shelling out to `cat`/`ls`/`find`/`grep`.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute. Stderr is already captured — do not append `2>&1`.' },
      working_dir: { type: 'string', description: 'Optional path relative to the workspace root. Equivalent to running `cd <working_dir> && <command>` for this single call only.' },
      timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds. Defaults to 120000 (2 min). Increase for installs/builds that may take longer.' },
      description: { type: 'string', description: 'Short human description of what this command does (shown in the trace).' },
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
    'Read a file (text source, JSON, etc.) or list a directory. Defaults to 2,000 lines from the start; supports `offset` (1-indexed) and `limit`. Output is line-numbered. Lines longer than 2,000 chars are truncated mid-line. Images and PDFs are returned as file attachments (you will see the rendered image). Binary files are rejected — use `shell` with `file`/`hexdump` if you really need the bytes. THIS is how you read source files — never fetch them through `browser evaluate`.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to a file OR a directory, relative to the workspace root (or absolute).' },
      offset: { type: 'number', description: '1-indexed starting line. Defaults to 1. Use to page through large files.' },
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
    'Create a new file or completely replace an existing file with `content`. For brand-new files (does not exist yet) just call write directly. For EXISTING files you must first call `read` on the same path in this run — write will refuse otherwise. For surgical changes to an existing file, prefer `edit` (sends only the diff) over re-sending the entire file. Re-writing the same path with byte-identical content is a silent no-op (anti-loop guard) — do not retry; move on.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root (or absolute).' },
      content: { type: 'string', description: 'Complete file content to write. The whole file is replaced.' },
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

    const content = String(args.content);
    const reads = await readFilesAlreadyRead(sessions, context.sessionId);
    const writes = await lastWrittenContentByPath(sessions, context.sessionId);
    const target = normalizeForCompare(filePath);
    const fileExistedBefore = reads.has(target) || writes.has(target);

    // Short-circuit byte-identical re-writes. The LLM sometimes loops on the
    // same file with the same content (especially after a tool error elsewhere).
    // Returning a no-op stops the loop without corrupting the file.
    const previouslyWritten = writes.get(target);
    if (previouslyWritten !== undefined && previouslyWritten === content) {
      return capResult(
        'write',
        `(no change — ${filePath} was already written with identical content earlier in this run; do not re-write the same file. Move on to the next step.)`,
        false
      );
    }

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
    'PREFERRED tool for changing an existing file: an exact-string find-and-replace. Requires the file to have been read first in this run. `oldString` must appear verbatim and exactly once unless `replaceAll: true` (then it must appear at least once). Include enough surrounding context in `oldString` to make the match unique — do not pass a single line that occurs many times. Preserve indentation/whitespace exactly. For multi-occurrence find-and-replace (rename a variable etc.), use `replaceAll: true`. Reach for `write` only when re-creating the file from scratch.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root (or absolute). REQUIRED.' },
      oldString: { type: 'string', description: 'Exact text to find. Must include enough context to be unique unless `replaceAll` is true.' },
      newString: { type: 'string', description: 'Replacement text. Must differ from `oldString`.' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one match. Defaults to false.' },
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
    'Find files by glob pattern. The pattern is matched RELATIVE to the workspace root (do NOT pass an absolute path like `/home/user/project/...` — use `src/**/*.ts`, `**/*.tsx`, `**/Dockerfile*`, etc.). Supports `**` for recursive matches and `{a,b,c}` brace expansion. Returns up to 200 paths sorted by modification time (newest first). Excludes nothing automatically — combine with a more specific pattern if you want to skip `node_modules`/`dist`/etc.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern RELATIVE to the workspace root. Examples: `src/**/*.tsx`, `**/*.{js,ts}`, `backend/**/Dockerfile*`.' },
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
    'Fast content search across the workspace using regex (ripgrep when available, else `grep -RInE`). Returns up to 200 `path:line: text` matches, sorted by modification time. Use `include` to narrow by file glob (e.g. `*.ts`, `src/**/*.tsx`). Always preferred over `shell` + `grep`/`rg` — output is structured and capped. Use this to locate symbols, callers, error messages, or config keys before reading files.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for (extended/PCRE-ish). Anchor with `\\b` for word boundaries.' },
      include: { type: 'string', description: 'Optional file glob filter. Examples: `*.ts`, `*.{js,jsx}`, `backend/**/*.py`.' },
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
    'Your structured plan for this run. Each call REPLACES the entire list — always send the full intended list, not a delta. Use it to (a) lay out the plan up front for multi-step tasks and (b) flip an item to `in_progress` before starting it and `completed` immediately after. Skip the tool entirely for trivial single-step requests. Do NOT re-submit a byte-identical list on every turn — only call when the plan or a status actually changes.',
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

    // Short-circuit when the requested list matches the persisted state — the
    // model often re-emits an unchanged todo block while spinning. Returning
    // a brief no-op observation skips the DB write, the socket emit, and (most
    // importantly) avoids piling another full snapshot into the prompt history.
    const existing = await tasks.listByRun(context.chatId, context.agentRunId);
    if (todoListMatches(existing, items)) {
      return capResult(
        'todo',
        '(no change — todo list already matches the requested state; do real work before updating todos again)',
        false
      );
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

function todoListMatches(existing: AgentRunTask[], desired: TodoListItem[]): boolean {
  if (existing.length !== desired.length) return false;
  for (let i = 0; i < existing.length; i++) {
    const a = existing[i];
    const b = desired[i];
    if (a.subject !== b.content) return false;
    if (a.status !== b.status) return false;
    if (a.priority !== b.priority) return false;
  }
  return true;
}

const questionTool: SshAgentTool = {
  name: 'question',
  description:
    'BLOCKING: pauses the agent and waits for the human. Use only when you genuinely cannot proceed — e.g. an irreversible decision, a credential the user must paste, or a fork in the requirements that has no defensible default. Do NOT use it for: status updates ("what did we do so far"), tool-choice decisions you should make yourself ("should I install puppeteer?", "should I use docker-compose v1 or v2?"), permission for routine actions, or anything you can resolve by reading code/docs. Make a sensible default choice and keep going; only ask when stopping is genuinely cheaper than guessing wrong. Provide concrete `options` whenever possible so the user clicks instead of typing.',
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
    'Launch a subagent to handle a complex multistep task autonomously. Each subagent starts with a cold context, so the `prompt` must be SELF-CONTAINED — include the goal, every relevant file path, what has already been tried, and the exact form of the result you want back. `subagent_type`: `explore` (read-only research/search), `build` (implementation), `plan` (design without writing code). Returns a `task_id` — pass it back later to resume an existing subagent rather than spawning a fresh one.',
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

const BROWSER_DIRECT_ACTIONS = [
  'visit', 'click', 'type', 'scroll', 'select',
  'press', 'hover', 'focus', 'clear', 'evaluate',
  'back', 'forward', 'reload', 'wait_for', 'screenshot',
  'batch',
] as const;

const browserTool: SshAgentTool = {
  name: 'browser',
  description:
    'Drive a headless Chromium page. **EVERY call already returns**: current page URL, title, rendered body text, a fresh PNG screenshot, recent network entries, and console logs. So: do NOT use `evaluate` to read `window.location` / `document.title` / `document.body.innerText` — that data is already in the response. Do NOT use `evaluate` to draw a canvas screenshot — every action returns one. Do NOT use `evaluate(fetch(...))` to read source files from the dev server — use the `read` tool on the actual file path on the SSH host instead. PREFER action="batch" with a steps[] array whenever you have more than one step in mind (visit → type → click → wait_for): one call, one round-trip, one animated screenshot sequence. Only fall back to a single-step call when the next step genuinely depends on what you observe. Example: action="batch", steps=[{"action":"visit","url":"http://host:3000"},{"action":"type","selector":"#q","text":"hello","submit":true},{"action":"wait_for","selector":".results"}]. Single-step actions: visit | click | type (submit:true presses Enter) | clear | press (any key) | hover | focus | scroll | select (<select> by value) | wait_for (selector visible/hidden) | screenshot (just refresh the current frame, no navigation) | evaluate (async JS for things the other actions cannot do — computed styles, localStorage, dispatching custom events; returns the serialized return value) | back | forward | reload.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: BROWSER_DIRECT_ACTIONS.join(' | ') },
      steps: {
        type: 'array',
        description: 'Used with action="batch". Ordered list of sub-steps executed in sequence; one screenshot is captured per step and returned as an animated sequence. STRONGLY PREFERRED over multiple single-step calls whenever you can plan the next 2+ steps without needing to read intermediate output.',
        items: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['visit', 'click', 'type', 'scroll', 'wait', 'select', 'screenshot', 'press', 'hover', 'focus', 'clear', 'evaluate', 'back', 'forward', 'reload', 'wait_for'],
            },
            url: { type: 'string', description: 'For sub-action=visit: URL to load.' },
            selector: { type: 'string' },
            text: { type: 'string' },
            submit: { type: 'boolean' },
            scroll_y: { type: 'number' },
            ms: { type: 'number', description: 'Sleep duration for sub-action=wait.' },
            value: { type: 'string' },
            key: { type: 'string' },
            script: { type: 'string' },
            timeout_ms: { type: 'number' },
            hidden: { type: 'boolean' },
            bypass_cache: { type: 'boolean', description: 'For sub-action=reload: hard refresh ignoring HTTP cache.' },
          },
          required: ['action'],
        },
      },
      url: { type: 'string', description: 'URL to load (action=visit).' },
      selector: { type: 'string', description: 'CSS selector (click/type/select/press/hover/focus/clear/wait_for).' },
      text: { type: 'string', description: 'Text to type (action=type).' },
      submit: { type: 'boolean', description: 'After typing, press Enter (action=type).' },
      scroll_y: { type: 'number', description: 'Pixels to scroll vertically (action=scroll). Negative scrolls up.' },
      value: { type: 'string', description: 'Option value (action=select).' },
      key: { type: 'string', description: 'Key to press, e.g. Enter | Tab | Escape | ArrowDown (action=press).' },
      script: { type: 'string', description: 'Async JS body to evaluate; the return value is JSON-serialized (action=evaluate).' },
      timeout_ms: { type: 'number', description: 'Wait timeout in milliseconds (action=wait_for, default 10000).' },
      hidden: { type: 'boolean', description: 'For wait_for: wait until the element is hidden/removed instead of visible.' },
      bypass_cache: { type: 'boolean', description: 'For visit/reload: hard refresh — disable HTTP cache for this navigation so JS/CSS/HTML are re-fetched fresh. Use after editing files when a normal reload still serves stale code. Default false (use cache, faster).' },
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

    if (action === 'batch') {
      const steps = args.steps;
      if (!Array.isArray(steps) || steps.length === 0) {
        return capResult('browser', 'Error: "batch" requires a steps[] array of sub-actions', true);
      }
      result = await client.sessionActions(sessionKey, steps as BrowserSubAction[], true);
    } else if (!BROWSER_DIRECT_ACTIONS.includes(action as any)) {
      return capResult('browser', `Error: action must be one of ${BROWSER_DIRECT_ACTIONS.join(' | ')}`, true);
    } else if (action === 'visit') {
      const url = String(args.url || '').trim();
      if (!url) return capResult('browser', 'Error: url is required for visit', true);
      result = await client.sessionVisit(sessionKey, url, { bypassCache: Boolean(args.bypass_cache) });
    } else if (action === 'screenshot') {
      // No-op action: just refresh the page state and capture a screenshot.
      // sessionActions with an empty list still goes through finalizeAction.
      result = await client.sessionActions(sessionKey, []);
    } else {
      const sub = buildSubActionFromArgs(action, args);
      if ('error' in sub) return capResult('browser', `Error: ${sub.error}`, true);
      result = await client.sessionActions(sessionKey, [sub.action]);
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
        const status = r.success ? 'OK' : `FAIL — ${r.error}`;
        const tail = r.success && r.result ? ` → ${r.result}` : '';
        lines.push(`- ${r.action}: ${status}${tail}`);
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

    const sequenceAttachments = result.screenshotPaths
      ? result.screenshotPaths.map((p, i) => ({
          mime: 'image/png' as const,
          filename: `frame_${String(i + 1).padStart(3, '0')}_${path.basename(p)}`,
          url: `/api/agent-attachments/${path.basename(p)}`,
        }))
      : undefined;

    const attachments = sequenceAttachments && sequenceAttachments.length > 1
      ? sequenceAttachments
      : screenshotAttachment;

    const capped = capOutput(lines.join('\n'), { maxLines: MAX_LINES, maxBytes: MAX_BYTES, label: 'browser' });
    return {
      output: capped.text,
      isError: Boolean(result.error),
      truncated: capped.truncated,
      fullPath: capped.fullPath,
      attachments,
    };
  },
};

const transitionToComposeModeTool: SshAgentTool = {
  name: 'transition_to_compose_mode',
  description:
    'Call this exactly once, after every Success Criterion is met and Required Verification has passed, to switch from RESEARCH mode to COMPOSE mode. The next turn will be in COMPOSE mode where you write the final answer to the user as plain assistant text. Do NOT call this while implementation, file edits, builds, tests, browser checks, or any other verification still need to happen — keep calling tools instead.',
  parameters: { type: 'object', properties: {}, required: [] },
  policy: { requiresApproval: false, riskLevel: 'low' },
  // Intercepted by the runner before this executor runs. The body here is a
  // safety net in case the interception path is ever bypassed.
  execute: async () => {
    return capResult(
      'transition_to_compose_mode',
      'Mode transition acknowledged. The next turn is COMPOSE mode — write the final answer as plain assistant text without calling tools.',
      false
    );
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
  transition_to_compose_mode: transitionToComposeModeTool,
  invalid: invalidTool,
};

export function getSshAgentTool(name: string): SshAgentTool | undefined {
  return (TOOLS as Record<string, SshAgentTool>)[name];
}

export function getSshAgentToolDefinitions(): ToolDefinition[] {
  return PUBLISHED_SSH_AGENT_TOOLS.map((name) => {
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

function buildSubActionFromArgs(
  action: string,
  args: Record<string, any>,
): { action: BrowserSubAction } | { error: string } {
  const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
  const need = (val: string, name: string) => (val ? null : `${name} is required for ${action}`);

  switch (action) {
    case 'click': {
      const e = need(selector, 'selector'); if (e) return { error: e };
      return { action: { action: 'click', selector } };
    }
    case 'type': {
      const e = need(selector, 'selector'); if (e) return { error: e };
      return { action: { action: 'type', selector, text: String(args.text ?? ''), submit: Boolean(args.submit) } };
    }
    case 'scroll': {
      return { action: { action: 'scroll', scroll_y: typeof args.scroll_y === 'number' ? args.scroll_y : 600 } };
    }
    case 'select': {
      const e = need(selector, 'selector'); if (e) return { error: e };
      const value = String(args.value ?? '').trim();
      if (!value) return { error: 'value is required for select' };
      return { action: { action: 'select', selector, value } };
    }
    case 'press': {
      const key = String(args.key ?? '').trim();
      if (!key) return { error: 'key is required for press' };
      return { action: { action: 'press', key, selector: selector || undefined } };
    }
    case 'hover': {
      const e = need(selector, 'selector'); if (e) return { error: e };
      return { action: { action: 'hover', selector } };
    }
    case 'focus': {
      const e = need(selector, 'selector'); if (e) return { error: e };
      return { action: { action: 'focus', selector } };
    }
    case 'clear': {
      const e = need(selector, 'selector'); if (e) return { error: e };
      return { action: { action: 'clear', selector } };
    }
    case 'evaluate': {
      const script = String(args.script ?? '').trim();
      if (!script) return { error: 'script is required for evaluate' };
      return { action: { action: 'evaluate', script } };
    }
    case 'back':    return { action: { action: 'back' } };
    case 'forward': return { action: { action: 'forward' } };
    case 'reload':  return { action: { action: 'reload', bypass_cache: Boolean(args.bypass_cache) } };
    case 'wait_for': {
      const e = need(selector, 'selector'); if (e) return { error: e };
      return {
        action: {
          action: 'wait_for',
          selector,
          timeout_ms: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
          hidden: Boolean(args.hidden),
        },
      };
    }
    default:
      return { error: `unsupported action: ${action}` };
  }
}

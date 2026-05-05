import type { ChatMessage } from '../../services/llamaClient';
import type { WorkspaceConfig } from '../../services/workspaceRuntime';
import type { AgentRunTask } from '../../repositories/agentRunTaskRepository';
import {
  WithParts,
  Part,
  ToolPart,
  AssistantMessage,
  isCompactionPart,
  isTextPart,
  isToolPart,
} from './message';
import { PRUNED_TOOL_OUTPUT_MARKER } from './outputCap';
import { SSH_AGENT_TOOL_NAMES } from './tools';

// Compose the full ChatMessage[] sequence the LLM sees on every iteration.
//
// Pipeline (matches the spec under "The Loop"):
//   1. Filter out compaction-pruned history. If the messages contain a
//      `summary: true` assistant message, only the messages from that point
//      onward are kept. The summary itself is injected as an assistant turn
//      preceded by a synthetic "What did we do so far?" user message — this
//      mirrors opencode's compaction surface exactly.
//   2. Convert each remaining message+parts to OpenAI-style messages:
//      - user TextPart -> { role: 'user', content }
//      - assistant TextPart (no tool) -> { role: 'assistant', content }
//      - assistant ToolPart -> { role: 'assistant', tool_calls: [...] }
//        followed by { role: 'tool', tool_call_id, content }
//      - CompactionPart on a user message -> handled in step 1 (it's a marker)
//   3. Tool outputs that have been pruned (state.time.compacted set) appear
//      with PRUNED_TOOL_OUTPUT_MARKER instead of their original output.
//
// Prompt caching strategy:
//   The system prompt is split into static and dynamic sections. The static
//   portion (identity, tone, tool policy, workspace config, project
//   instructions, agent task) is returned separately so the caller can
//   memoize it across iterations. Dynamic content (date/time, task list) is
//   injected as trailing user messages so they do not invalidate the cached
//   KV-prefix on llama.cpp.
//
//   Resulting message order sent to llama.cpp:
//     [system] static prompt (cacheable, never changes)
//     [system] dynamic prompt (date, tasks — short, changes every iteration)
//     [user] compaction summary (stable until next compaction)
//     [user/assistant/tool] conversation history (old parts cached)
//     [user] dynamic state block (date, tasks — short, volatile)
//     [user] current user message / system-reminder (volatile)

export interface SshAgentPromptInput {
  /** Stored history loaded from the DB on this iteration. */
  messages: WithParts[];
  /** The agent's high-level instructions (Success Criteria etc). */
  agentPrompt: string;
  /** SSH workspace this run operates against. */
  workspace?: WorkspaceConfig;
  /** Live task checklist. */
  tasks: AgentRunTask[];
  /** ISO instant for "current date/time" in env block. */
  now?: Date;
  /** User-defined "instruction files" content (e.g. AGENTS.md). */
  instructionFiles?: string;
}

export interface BuiltPrompt {
  /** Static system prompt — identical across all iterations for KV-cache hit. */
  staticSystemPrompt: string;
  messages: ChatMessage[];
}

const SYNTHETIC_COMPACT_PROMPT = 'What did we do so far?';

/**
 * Step 1: filter out everything before the most recent compaction marker
 * (assistant message with `summary: true`). Returns the suffix and, if any,
 * the summary text + the pre-summary "compaction marker" user message.
 */
function applyCompactionFilter(messages: WithParts[]): {
  suffix: WithParts[];
  summary?: string;
} {
  let summaryIndex = -1;
  let summaryText: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info.role !== 'assistant') continue;
    const am = msg.info as AssistantMessage;
    if (am.summary === true) {
      summaryIndex = i;
      summaryText = msg.parts
        .filter(isTextPart)
        .map((p) => p.text.trim())
        .filter(Boolean)
        .join('\n\n')
        .trim();
      break;
    }
  }
  if (summaryIndex < 0) {
    return { suffix: messages };
  }
  const suffix = messages.slice(summaryIndex + 1);
  return { suffix, summary: summaryText };
}

function toolCallId(part: ToolPart): string {
  return part.callID || `call_${part.id}`;
}

function toolOutputForLLM(part: ToolPart): string {
  if (part.state.status === 'completed') {
    if (part.state.time.compacted) {
      return PRUNED_TOOL_OUTPUT_MARKER;
    }
    return part.state.output || '';
  }
  if (part.state.status === 'error') {
    return `Error: ${part.state.error}`;
  }
  if (part.state.status === 'running') {
    return '[Tool still running]';
  }
  return '[Tool pending]';
}

function partsToMessages(messages: WithParts[]): ChatMessage[] {
  const out: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.info.role === 'user') {
      // A compaction marker on a user message is invisible to the LLM —
      // we already replaced the entire pre-summary head with the summary.
      if (msg.parts.some(isCompactionPart)) continue;

      const text = msg.parts
        .filter(isTextPart)
        .map((p) => p.text)
        .join('\n')
        .trim();
      if (text) {
        out.push({ role: 'user', content: text });
      }
      continue;
    }

    // assistant: emit one message per "shape" of contents.
    // OpenAI's contract: tool_calls always live on an assistant message; the
    // matching tool result is a separate `role: 'tool'` message. We can only
    // attach text content alongside tool calls if present (some providers
    // accept that).
    let pendingText = '';
    const pendingToolCalls: Array<{ id: string; name: string; args: string; tool: ToolPart }> = [];

    const flushAssistantTurn = () => {
      if (pendingText.trim() || pendingToolCalls.length > 0) {
        out.push({
          role: 'assistant',
          content: pendingText.trim(),
          ...(pendingToolCalls.length > 0
            ? {
                tool_calls: pendingToolCalls.map((c) => ({
                  id: c.id,
                  type: 'function' as const,
                  function: { name: c.name, arguments: c.args },
                })),
              }
            : {}),
        });
        // tool results follow, in the same order as the tool calls.
        for (const c of pendingToolCalls) {
          out.push({
            role: 'tool',
            tool_call_id: c.id,
            content: toolOutputForLLM(c.tool),
          });
        }
      }
      pendingText = '';
      pendingToolCalls.length = 0;
    };

    for (const part of msg.parts) {
      if (isTextPart(part)) {
        const trimmed = part.text;
        if (trimmed) pendingText += (pendingText ? '\n' : '') + trimmed;
        continue;
      }
      if (isToolPart(part)) {
        pendingToolCalls.push({
          id: toolCallId(part),
          name: part.tool,
          args: JSON.stringify(part.state.input || {}),
          tool: part,
        });
        continue;
      }
      // ignore reasoning/file/agent/etc for the v1 prompt mapping — they're
      // not useful for the LLM in our current setup.
    }

    flushAssistantTurn();
  }

  return out;
}

function dateTimeBlock(now: Date = new Date()): string {
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });
  return `${dateStr}, ${timeStr}`;
}

function workspaceBlock(workspace?: WorkspaceConfig): string {
  if (!workspace?.ssh?.enabled) {
    return '## ACTIVE WORKSPACE\nSSH agent mode is not available because no remote workspace is configured. Stop and ask the user to configure an SSH host, username, key, and workspace root in Settings.';
  }
  const ssh = workspace.ssh;
  const hostUrl = `http://${ssh.host}`;
  return [
    '## ACTIVE WORKSPACE',
    `You are the SSH coding agent for a remote environment.`,
    `- SSH host: ${ssh.username}@${ssh.host}:${ssh.port || 22}`,
    `- Public host address (use this to reach web servers you start): ${ssh.host}`,
    `- Workspace root: ${ssh.root}`,
    `- Your enabled tools are: ${SSH_AGENT_TOOL_NAMES.join(', ')}`,
    '- Use the tools to inspect files, run commands, edit files, and verify the task. Do not tell the user to run commands manually when a tool can do it.',
    '- Use `glob`, `grep`, and `read` for inspection. Use `edit` and `write` for file modifications. Use `shell` for builds, tests, and commands.',
    '- Keep changes minimal and reviewable. Verify with a bounded check (build, lint, focused test) before declaring success.',
    '',
    '## NETWORKING — IMPORTANT FOR ANY WEB APP',
    `- The \`browser\` tool runs from THIS backend, not from the SSH host. \`http://localhost:<port>\` reaches the backend, not the remote dev server. ALWAYS use the host's external address: \`${hostUrl}:<port>\`.`,
    `- When you start a dev server (Next.js, Vite, Express, Django, etc.) bind it to \`0.0.0.0\` (or \`-H 0.0.0.0\` / \`--host 0.0.0.0\` / \`HOST=0.0.0.0\`), never the implicit \`127.0.0.1\`. A server bound only to localhost on the SSH host is unreachable from the browser tool.`,
    '- Document the exact URL you used in your final answer so the user can open it in their own browser.',
    '',
    '## VERIFY WEB APPS WITH THE BROWSER TOOL',
    `- After bringing a web app up, ALWAYS verify it with \`browser visit ${hostUrl}:<port>\` and inspect the screenshot, page text, network entries (look for non-2xx responses), and console messages.`,
    '- A successful `curl` is necessary but not sufficient. Pages can return 200 with broken hydration, missing assets, or runtime JS errors only visible in a real browser.',
    '- For UIs that depend on user interaction, follow up with `browser click`, `browser type`, `browser press`, `browser hover`, `browser scroll`, etc. to exercise the golden path before declaring the task done.',
    '- For `<select>` dropdown menus, use `browser select` with the selector of the `<select>` element and the `value` of the option to pick — do NOT try to click the dropdown and then click an option (headless Puppeteer cannot render native dropdowns).',
    '- Available actions: visit, click, type (with optional submit:true), clear, press (any keyboard key — Enter/Tab/Escape/ArrowDown/etc), hover, focus, scroll, select, wait_for (selector to appear/disappear), evaluate (run async JS, returns serialized value), back, forward, reload. Use `browser actions` with a batch of sub-actions for sequences — avoids an LLM round-trip per step and captures a screenshot per sub-action shown as an animated sequence.',
    '- Reach for `browser evaluate` when no built-in action covers what you need (read computed styles, inspect localStorage, dispatch a custom event, etc.). Use `browser wait_for` instead of fixed `wait` sleeps when waiting for content to appear.',
    '- If the browser visit returns a screenshot or console errors, treat that as the source of truth. Fix any console/network errors you see before reporting success.',
  ].join('\n');
}

function taskBlock(tasks: AgentRunTask[]): string {
  if (tasks.length === 0) return '';
  const lines = tasks.map((task) => {
    const marker =
      task.status === 'completed' ? '[x]' : task.status === 'in_progress' ? '[~]' : '[ ]';
    const desc = task.description ? `\n      ${task.description.split('\n').join('\n      ')}` : '';
    return `${marker} ${task.id}  ${task.subject}${desc}`;
  });
  return [
    '## TASK LIST (live)',
    'This checklist is persisted in the database and visible to the user. Mark items in_progress with task_update before starting them; mark them completed when finished.',
    lines.join('\n'),
  ].join('\n');
}

/**
 * Build the static portion of the system prompt — content that never changes
 * across iterations of the same agent run. This is the longest stable prefix
 * and should be memoized by the caller so llama.cpp can cache it.
 */
export function buildStaticSystemPrompt(input: SshAgentPromptInput): string {
  const sections: string[] = [];
  sections.push('You are Operator SSH Agent, a coding agent that operates over SSH on a remote workspace.');
  sections.push('You are an interactive tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.');
  sections.push('IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming.');

  sections.push([
    '# Tone and style',
    '- Only use emojis if the user explicitly requests it.',
    '- Your output is rendered in a chat UI alongside a live trace of your tool calls. Be terse.',
    '- Prefer doing the work over describing it. The user can read your tool calls.',
  ].join('\n'));

  sections.push([
    '# Professional objectivity',
    'Prioritize technical accuracy and truthfulness over validating the user\'s beliefs.',
  ].join('\n'));

  sections.push([
    '# Task management',
    'For non-trivial multi-step work, use task_create / task_update / task_list. Mark each task in_progress before starting and completed when done. Do not abandon in_progress tasks; pick them back up after detours.',
  ].join('\n'));

  sections.push([
    '# Tool usage policy',
    '- Prefer read/edit/write/apply_patch for file work. Reach for bash only when you actually need shell semantics (builds, tests, git, package managers).',
    '- After modifying files, verify with a bounded check (build, lint, or a focused test) before declaring success.',
    '- The backend persists tool overflow files and browser screenshots under `data/agent-attachments` (or the path in `OPERATOR_ATTACHMENTS_DIR`); use that directory for any auxiliary scratch files referenced from tool output.',
  ].join('\n'));

  sections.push(workspaceBlock(input.workspace));

  if (input.instructionFiles?.trim()) {
    sections.push(['# Project Instructions', input.instructionFiles.trim()].join('\n'));
  }

  if (input.agentPrompt?.trim()) {
    sections.push([
      '# Agent task',
      input.agentPrompt.trim(),
    ].join('\n'));
  }

  return sections.join('\n\n');
}

/**
 * Build the dynamic portion of the system prompt — content that changes every
 * iteration. This is short and placed after the static prefix so it doesn't
 * invalidate the llama.cpp KV-cache.
 */
export function buildDynamicSystemPrompt(now?: Date): string {
  return `# Environment\nCurrent date/time: ${dateTimeBlock(now)}`;
}

/**
 * Build a trailing user message containing dynamic state (date, task list).
 * This goes at the END of the message sequence so the static system prompt
 * and conversation history remain cached. Returns null if there is nothing
 * to report.
 */
export function buildDynamicStateBlock(input: SshAgentPromptInput): ChatMessage | null {
  const parts: string[] = [];

  const dt = dateTimeBlock(input.now);
  parts.push(`Current date/time: ${dt}`);

  const tb = taskBlock(input.tasks || []);
  if (tb) {
    parts.push(tb);
  }

  if (parts.length === 0) return null;

  return {
    role: 'user',
    content: parts.join('\n\n'),
  };
}

export function buildPrompt(input: SshAgentPromptInput): BuiltPrompt {
  const staticSystemPrompt = buildStaticSystemPrompt(input);
  const { suffix, summary } = applyCompactionFilter(input.messages);

  // The system prompt is purely static — identical across all iterations.
  // This gives llama.cpp f_keep = 1.000 (full context preserved) so it
  // only ever needs to process the NEW tokens appended each iteration.
  // Dynamic content (date, tasks) is sent as a trailing user message
  // via buildDynamicStateBlock() so it doesn't invalidate the cache.
  const messages: ChatMessage[] = [];
  if (summary && summary.length > 0) {
    // Inject the synthetic compaction surface that mirrors opencode's contract.
    messages.push({ role: 'user', content: SYNTHETIC_COMPACT_PROMPT });
    messages.push({ role: 'assistant', content: summary });
  }
  messages.push(...partsToMessages(suffix));

  return { staticSystemPrompt, messages };
}

/**
 * Wrap the latest user message in a system-reminder envelope on iterations
 * after the first, mirroring the spec example. The caller decides when to
 * apply this; we expose it as a helper here to keep the logic in one place.
 */
export function wrapTrailingUserAsSystemReminder(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (last.role !== 'user') return messages;
  const wrapped: ChatMessage = {
    role: 'user',
    content: `<system-reminder>\nThe user sent the following message:\n\n${last.content}\n</system-reminder>`,
  };
  return [...messages.slice(0, -1), wrapped];
}

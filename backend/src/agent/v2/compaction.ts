import {
  WithParts,
  Info,
  Part,
  TextPart,
  ToolPart,
  CompactionPart,
  UserMessage,
  AssistantMessage,
  isCompactionPart,
  isTextPart,
  isToolPart,
  isMedia,
} from './message';
import { MessageID, PartID } from './ids';
import { CompactionConfig, ModelLimits, usable } from './tokenBudget';
import { estimate } from './tokenEstimate';

// 1:1 port of opencode's `session/compaction.ts`, expressed in idiomatic TS.
// Algorithms (turn detection, tail-budget split, prune walk, completedCompactions
// hidden-set) match upstream byte-for-byte; only the runtime/IO shape differs:
// instead of Effect generators with a Session.Service, we accept a small
// `Backend` interface that the caller wires to whatever persistence + LLM glue
// is available. This keeps compaction deterministic and unit-testable.

export const PRUNE_MINIMUM = 20_000;
export const PRUNE_PROTECT = 40_000;
export const TOOL_OUTPUT_MAX_CHARS = 2_000;
export const PRUNE_PROTECTED_TOOLS = ['skill'];
export const DEFAULT_TAIL_TURNS = 2;
export const MIN_PRESERVE_RECENT_TOKENS = 2_000;
export const MAX_PRESERVE_RECENT_TOKENS = 8_000;

export const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

interface Turn {
  start: number;
  end: number;
  id: MessageID;
}

interface Tail {
  start: number;
  id: MessageID;
}

interface CompletedCompaction {
  userIndex: number;
  assistantIndex: number;
  summary: string | undefined;
}

export function summaryText(message: WithParts): string | undefined {
  const text = message.parts
    .filter(isTextPart)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
  return text || undefined;
}

/**
 * Walk through messages and find user→assistant pairs whose assistant message
 * is marked `summary: true` and finished cleanly. Used to skip already-summarized
 * turns when building the next compaction.
 */
export function completedCompactions(messages: WithParts[]): CompletedCompaction[] {
  const users = new Map<MessageID, number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.info.role !== 'user') continue;
    if (!msg.parts.some(isCompactionPart)) continue;
    users.set(msg.info.id, i);
  }

  const result: CompletedCompaction[] = [];
  for (let assistantIndex = 0; assistantIndex < messages.length; assistantIndex++) {
    const msg = messages[assistantIndex];
    if (msg.info.role !== 'assistant') continue;
    const a = msg.info as AssistantMessage;
    if (!a.summary || !a.finish || a.error) continue;
    const userIndex = users.get(a.parentID);
    if (userIndex === undefined) continue;
    result.push({ userIndex, assistantIndex, summary: summaryText(msg) });
  }
  return result;
}

export function buildPrompt(input: { previousSummary?: string; context: string[] }): string {
  const anchor = input.previousSummary
    ? [
        'Update the anchored summary below using the conversation history above.',
        'Preserve still-true details, remove stale details, and merge in the new facts.',
        '<previous-summary>',
        input.previousSummary,
        '</previous-summary>',
      ].join('\n')
    : 'Create a new anchored summary from the conversation history above.';
  return [anchor, SUMMARY_TEMPLATE, ...input.context].join('\n\n');
}

export function preserveRecentBudget(input: { cfg: { compaction?: CompactionConfig }; model: ModelLimits }): number {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  );
}

/**
 * Identify each user-led turn (user message → next user message). Turns whose
 * user message contains a CompactionPart are skipped because they're synthetic
 * compaction markers, not real prompts.
 */
export function turns(messages: WithParts[]): Turn[] {
  const result: Turn[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.info.role !== 'user') continue;
    if (msg.parts.some(isCompactionPart)) continue;
    result.push({ start: i, end: messages.length, id: msg.info.id });
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start;
  }
  return result;
}

/**
 * Within a single turn, find the latest message index where slicing from there
 * to the end of the turn fits inside `budget`. Used as the fallback when an
 * entire turn is too large to keep verbatim.
 */
export async function splitTurn(input: {
  messages: WithParts[];
  turn: Turn;
  budget: number;
  estimateTokens: (msgs: WithParts[]) => Promise<number>;
}): Promise<Tail | undefined> {
  if (input.budget <= 0) return undefined;
  if (input.turn.end - input.turn.start <= 1) return undefined;
  for (let start = input.turn.start + 1; start < input.turn.end; start++) {
    const size = await input.estimateTokens(input.messages.slice(start, input.turn.end));
    if (size > input.budget) continue;
    return { start, id: input.messages[start]!.info.id };
  }
  return undefined;
}

/**
 * Choose how to split the conversation into a compactable head and a verbatim
 * tail. Returns the head slice and the message id at which the tail starts
 * (undefined if no split — the whole conversation gets summarized).
 */
export async function select(input: {
  messages: WithParts[];
  cfg: { compaction?: CompactionConfig };
  model: ModelLimits;
  estimateTokens: (msgs: WithParts[]) => Promise<number>;
}): Promise<{ head: WithParts[]; tail_start_id: MessageID | undefined }> {
  const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS;
  if (limit <= 0) return { head: input.messages, tail_start_id: undefined };
  const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model });
  const all = turns(input.messages);
  if (!all.length) return { head: input.messages, tail_start_id: undefined };
  const recent = all.slice(-limit);
  const sizes: number[] = [];
  for (const turn of recent) {
    sizes.push(await input.estimateTokens(input.messages.slice(turn.start, turn.end)));
  }

  let total = 0;
  let keep: Tail | undefined;
  for (let i = recent.length - 1; i >= 0; i--) {
    const turn = recent[i]!;
    const size = sizes[i];
    if (total + size <= budget) {
      total += size;
      keep = { start: turn.start, id: turn.id };
      continue;
    }
    const remaining = budget - total;
    const split = await splitTurn({
      messages: input.messages,
      turn,
      budget: remaining,
      estimateTokens: input.estimateTokens,
    });
    if (split) keep = split;
    break;
  }

  if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined };
  return {
    head: input.messages.slice(0, keep.start),
    tail_start_id: keep.id,
  };
}

/**
 * Walk backwards through messages, marking the *output* of older completed
 * tool parts as compacted (`state.time.compacted`) once we've already protected
 * `PRUNE_PROTECT` tokens of recent tool output. Stops at the first assistant
 * message that already holds a summary (no further pruning needed beyond that).
 *
 * Returns the array of parts that were marked. Caller is responsible for
 * persisting the updated parts via `updatePart`.
 */
export function planPrune(input: {
  messages: WithParts[];
  protectTokens?: number;
  minimumPrunedTokens?: number;
  protectedTools?: string[];
}): { toPrune: ToolPart[]; pruned: number; total: number } {
  const protectTokens = input.protectTokens ?? PRUNE_PROTECT;
  const minimumPrunedTokens = input.minimumPrunedTokens ?? PRUNE_MINIMUM;
  const protectedTools = input.protectedTools ?? PRUNE_PROTECTED_TOOLS;

  let total = 0;
  let pruned = 0;
  const toPrune: ToolPart[] = [];
  let userTurnsSeen = 0;

  loop: for (let msgIndex = input.messages.length - 1; msgIndex >= 0; msgIndex--) {
    const msg = input.messages[msgIndex];
    if (msg.info.role === 'user') userTurnsSeen++;
    if (userTurnsSeen < 2) continue;
    if (msg.info.role === 'assistant' && (msg.info as AssistantMessage).summary) break loop;

    for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
      const part = msg.parts[partIndex];
      if (!isToolPart(part)) continue;
      if (part.state.status !== 'completed') continue;
      if (protectedTools.includes(part.tool)) continue;
      if (part.state.time.compacted) break loop;
      const size = estimate(part.state.output);
      total += size;
      if (total <= protectTokens) continue;
      pruned += size;
      toPrune.push(part);
    }
  }

  if (pruned <= minimumPrunedTokens) {
    return { toPrune: [], pruned: 0, total };
  }
  return { toPrune, pruned, total };
}

/**
 * Hide indices of already-completed compactions when building the head for the
 * next compaction summary. Mirrors opencode's `hidden` Set.
 */
export function buildCompactionInputs(input: {
  messages: WithParts[];
  parentID: MessageID;
}): {
  history: WithParts[];
  visibleHead: WithParts[];
  previousSummary: string | undefined;
} {
  let last: WithParts | undefined;
  for (let i = input.messages.length - 1; i >= 0; i--) {
    if (input.messages[i].info.id === input.parentID) {
      last = input.messages[i];
      break;
    }
  }
  const trailingIsParent = last !== undefined;
  const compactionPart = trailingIsParent
    ? (last!.parts.find((p: Part) => p.type === 'compaction') as CompactionPart | undefined)
    : undefined;
  const history =
    compactionPart && input.messages.at(-1)?.info.id === input.parentID
      ? input.messages.slice(0, -1)
      : input.messages;
  const prior = completedCompactions(history);
  const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]));
  const previousSummary = prior.at(-1)?.summary;
  const visibleHead = history.filter((_, index) => !hidden.has(index));
  return { history, visibleHead, previousSummary };
}

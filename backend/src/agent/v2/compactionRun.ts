import type { LlamaClient, ChatMessage } from '../../services/llamaClient';
import type { AgentSessionRepository } from '../../repositories/agentSessionRepository';
import {
  WithParts,
  Part,
  TextPart,
  CompactionPart,
  UserMessage,
  AssistantMessage,
  isTextPart,
  isToolPart,
  ToolPart,
} from './message';
import { MessageID, PartID, SessionID } from './ids';
import {
  SUMMARY_TEMPLATE,
  buildCompactionInputs,
  planPrune,
  preserveRecentBudget,
  select,
  summaryText,
  PRUNE_MINIMUM,
  PRUNE_PROTECT,
} from './compaction';
import { CompactionConfig, ModelLimits, isOverflow, usable } from './tokenBudget';
import { estimate } from './tokenEstimate';
import { PRUNED_TOOL_OUTPUT_MARKER } from './outputCap';

// The compaction runner persists three things when it runs:
//   1. A synthetic UserMessage carrying a CompactionPart marker. This sits
//      between the head we want to discard and the tail we want to keep.
//   2. An AssistantMessage with `summary: true`, holding a single TextPart
//      with the SUMMARY_TEMPLATE-shaped Markdown summary.
//   3. (Optional) A prune walk that flips old completed ToolPart outputs to
//      `[Old tool result content cleared]` and stamps `state.time.compacted`.
//
// Subsequent loop iterations call `applyCompactionFilter` in promptBuilder.ts
// which slices the visible history at the most recent summary, so the LLM only
// sees the summary + the tail.

export interface CompactionContext {
  sessionId: string;
  parentMessageId?: string;
  agent: string;
  modelId: string;
  providerID: string;
  cwd: string;
  root: string;
  cfg: { compaction?: CompactionConfig };
  model: ModelLimits;
}

export interface CompactionRunResult {
  /** True if a new summary was written. */
  compacted: boolean;
  /** Number of tool parts that were pruned. */
  pruned: number;
  /** The summary text that was persisted, if any. */
  summary?: string;
}

export interface CompactionRunner {
  shouldCompact(messages: WithParts[], context: CompactionContext): boolean;
  run(messages: WithParts[], context: CompactionContext): Promise<CompactionRunResult>;
}

/**
 * Build the LLM prompt that asks for an anchored summary covering the
 * head section. The previous summary, if any, is supplied so the model
 * can update it incrementally rather than rewriting from scratch.
 */
function buildSummaryPrompt(input: {
  head: WithParts[];
  previousSummary?: string;
}): ChatMessage[] {
  const messages: ChatMessage[] = [];
  // Replay the head as if it were the conversation, so the summarizer can
  // see what's being compacted.
  for (const msg of input.head) {
    if (msg.info.role === 'user') {
      const text = msg.parts
        .filter(isTextPart)
        .map((p) => p.text)
        .join('\n')
        .trim();
      if (text) messages.push({ role: 'user', content: text });
      continue;
    }
    // assistant
    const parts: string[] = [];
    for (const part of msg.parts) {
      if (isTextPart(part)) {
        const t = part.text.trim();
        if (t) parts.push(t);
        continue;
      }
      if (isToolPart(part)) {
        const args = JSON.stringify(part.state.input || {}).slice(0, 1000);
        const out = part.state.status === 'completed'
          ? (part.state.time.compacted ? PRUNED_TOOL_OUTPUT_MARKER : (part.state.output || '').slice(0, 4000))
          : part.state.status === 'error'
            ? `Error: ${part.state.error}`
            : `(${part.state.status})`;
        parts.push(`tool_call ${part.tool}(${args}) -> ${out}`);
      }
    }
    if (parts.length) messages.push({ role: 'assistant', content: parts.join('\n\n') });
  }

  const anchor = input.previousSummary
    ? [
        'Update the anchored summary below using the conversation history above.',
        'Preserve still-true details, remove stale details, and merge in the new facts.',
        '<previous-summary>',
        input.previousSummary,
        '</previous-summary>',
      ].join('\n')
    : 'Create a new anchored summary from the conversation history above.';

  messages.push({ role: 'user', content: [anchor, SUMMARY_TEMPLATE].join('\n\n') });
  return messages;
}

export class LlmCompactionRunner implements CompactionRunner {
  constructor(
    private readonly llama: LlamaClient,
    private readonly repo: AgentSessionRepository,
    /** Forwarded to chatStream to pick the summarizer model. */
    private readonly options: { model?: string; maxOutputTokens?: number } = {}
  ) {}

  shouldCompact(messages: WithParts[], context: CompactionContext): boolean {
    const { cfg, model } = context;
    if (model.context === 0) return false;
    // If we just compacted, don't do it again immediately.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.info.role !== 'assistant') continue;
      const a = msg.info as AssistantMessage;
      if (a.summary) return false;
      return isOverflow({ cfg, tokens: a.tokens, model });
    }
    return false;
  }

  async run(messages: WithParts[], context: CompactionContext): Promise<CompactionRunResult> {
    const sel = await select({
      messages,
      cfg: context.cfg,
      model: context.model,
      estimateTokens: async (msgs) => estimateMessages(msgs),
    });
    if (!sel.tail_start_id || sel.head.length === 0) {
      return { compacted: false, pruned: 0 };
    }

    // The "parentID" anchor for buildCompactionInputs is the last message in
    // the head — the caller mirrors opencode's contract by using that as the
    // synthetic user message id when invoking compaction.
    const parentID = sel.head[sel.head.length - 1]?.info.id ?? '';

    const { visibleHead, previousSummary } = buildCompactionInputs({
      messages: sel.head,
      parentID,
    });
    if (visibleHead.length === 0) {
      return { compacted: false, pruned: 0 };
    }

    // 3. Run the LLM to get the summary text.
    const summary = await this.summarize(visibleHead, previousSummary);
    if (!summary) {
      return { compacted: false, pruned: 0 };
    }

    // 4. Persist: create a synthetic User message + CompactionPart, then an
    //    Assistant message with summary=true and a TextPart holding the
    //    summary body. The assistant message's parentID points to the user.
    const now = Date.now();
    const userMessageId: string = MessageID.ascending();
    const assistantMessageId: string = MessageID.ascending();

    const userMsg: UserMessage = {
      id: userMessageId,
      sessionID: context.sessionId,
      role: 'user',
      time: { created: now },
      agent: context.agent,
      model: { providerID: context.providerID, modelID: context.modelId },
    };
    await this.repo.upsertMessage(userMsg);

    const compactionPart: CompactionPart = {
      id: PartID.ascending(),
      sessionID: context.sessionId,
      messageID: userMessageId,
      type: 'compaction',
      auto: true,
      tail_start_id: sel.tail_start_id,
    };
    await this.repo.upsertPart(compactionPart);

    const assistantMsg: AssistantMessage = {
      id: assistantMessageId,
      sessionID: context.sessionId,
      role: 'assistant',
      time: { created: now, completed: now },
      parentID: userMessageId,
      modelID: context.modelId,
      providerID: context.providerID,
      mode: 'summary',
      agent: context.agent,
      path: { cwd: context.cwd, root: context.root },
      summary: true,
      cost: 0,
      tokens: { input: 0, output: estimate(summary), reasoning: 0, cache: { read: 0, write: 0 } },
      finish: 'stop',
    };
    await this.repo.upsertMessage(assistantMsg);

    const summaryPart: TextPart = {
      id: PartID.ascending(),
      sessionID: context.sessionId,
      messageID: assistantMessageId,
      type: 'text',
      text: summary,
      time: { start: now, end: now },
    };
    await this.repo.upsertPart(summaryPart);

    // 5. Optional prune of older tool outputs in the tail.
    let prunedCount = 0;
    if (context.cfg.compaction?.prune !== false) {
      const updatedMessages = await this.reloadVisibleAfterCompaction(messages, sel.tail_start_id);
      const prunePlan = planPrune({ messages: updatedMessages });
      for (const tool of prunePlan.toPrune) {
        const updated: ToolPart = {
          ...tool,
          state: {
            ...tool.state,
            status: 'completed',
            output: PRUNED_TOOL_OUTPUT_MARKER,
            time: {
              ...(tool.state as any).time,
              compacted: Date.now(),
            },
          } as ToolPart['state'],
        };
        await this.repo.upsertPart(updated);
        prunedCount++;
      }
    }

    return { compacted: true, pruned: prunedCount, summary };
  }

  private async summarize(head: WithParts[], previousSummary: string | undefined): Promise<string | undefined> {
    const messages = buildSummaryPrompt({ head, previousSummary });
    try {
      const result = await this.llama.chatStream(
        messages,
        undefined,
        undefined,
        undefined,
        { model: this.options.model }
      );
      const text = (result.finalContent || '').trim();
      if (!text) {
        console.warn(
          `[compaction] Summarizer returned empty content (head=${head.length} msgs, prompt=${messages.length} msgs).`
        );
        return undefined;
      }
      return text;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(
        `[compaction] Summarizer threw (head=${head.length} msgs, prompt=${messages.length} msgs): ${msg}`
      );
      return undefined;
    }
  }

  private async reloadVisibleAfterCompaction(messages: WithParts[], tailStartId: string): Promise<WithParts[]> {
    const idx = messages.findIndex((m) => m.info.id === tailStartId);
    return idx >= 0 ? messages.slice(idx) : messages;
  }
}

function estimateMessages(messages: WithParts[]): number {
  let total = 0;
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === 'text') total += estimate(part.text);
      else if (part.type === 'tool') {
        total += estimate(JSON.stringify(part.state.input || {}));
        if (part.state.status === 'completed') total += estimate(part.state.output || '');
        if (part.state.status === 'error') total += estimate(part.state.error || '');
      }
    }
  }
  return total;
}

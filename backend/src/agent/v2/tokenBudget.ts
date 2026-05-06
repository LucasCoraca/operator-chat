import { AssistantMessage } from './message';

// 1:1 port of opencode's `session/overflow.ts`. The compaction subsystem uses
// `usable()` to decide how many tokens to keep before triggering compaction,
// and `isOverflow()` to detect when we're already past that.
//
// `Provider.Model` upstream is the ai-sdk model object; we only need a couple
// of fields, so we accept a structural subset.

const COMPACTION_BUFFER = 20_000;

export interface ModelLimits {
  /** Total context window, in tokens. 0 means unknown / not enforced. */
  context: number;
  /** Max input tokens, if the provider exposes a separate input cap. */
  input?: number;
  /** Max output tokens we plan to reserve for the assistant response. */
  maxOutputTokens: number;
}

export interface CompactionConfig {
  /**
   * If false, auto-compaction is disabled and `isOverflow` always returns false.
   * Defaults to true.
   */
  auto?: boolean;
  /** Tokens reserved for output / safety buffer. Defaults to min(20_000, maxOutputTokens). */
  reserved?: number;
  /** Override for `select()`'s recent-tail token budget. */
  preserve_recent_tokens?: number;
  /** Number of trailing user-led turns to consider for the tail budget. */
  tail_turns?: number;
  /** When true, `prune()` may reclaim old tool outputs by marking them compacted. */
  prune?: boolean;
}

export function usable(input: { cfg: { compaction?: CompactionConfig }; model: ModelLimits }): number {
  const context = input.model.context;
  if (context === 0) return 0;
  const reserved =
    input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, input.model.maxOutputTokens);
  // Always honor `reserved` — when a caller derives it from a user-facing
  // autoCompactThreshold (e.g. `context * (1 - 0.82)`), falling back to
  // `maxOutputTokens` would silently ignore the threshold.
  if (input.model.input) {
    return Math.max(0, input.model.input - reserved);
  }
  return Math.max(0, context - reserved);
}

export function isOverflow(input: {
  cfg: { compaction?: CompactionConfig };
  tokens: AssistantMessage['tokens'];
  model: ModelLimits;
}): boolean {
  if (input.cfg.compaction?.auto === false) return false;
  if (input.model.context === 0) return false;
  const t = input.tokens;
  const count = t.total ?? t.input + t.output + t.cache.read + t.cache.write;
  return count >= usable(input);
}

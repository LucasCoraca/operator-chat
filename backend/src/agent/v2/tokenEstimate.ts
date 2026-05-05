// 1:1 port of opencode's `util/token.ts`. The 4-chars-per-token heuristic is
// load-bearing for compaction budgets; do not change without re-tuning the
// PRUNE/PRESERVE constants in compaction.ts.

const CHARS_PER_TOKEN = 4;

export function estimate(input: string): number {
  return Math.max(0, Math.round((input || '').length / CHARS_PER_TOKEN));
}

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Real-time tool-output truncation, ported from the spec:
//   - keep the output if it fits in MAX_LINES and MAX_BYTES
//   - otherwise, write the full output to a temp file under TMP_ROOT
//     and replace the visible content with the head plus an overflow hint.
//
// The spec's exact thresholds are 2_000 lines and 50KB; we use those as
// the defaults and let callers override per-tool if necessary (e.g. shell
// vs read).

export const MAX_LINES = 2_000;
export const MAX_BYTES = 50 * 1024;
// Persistent storage for tool overflow files and browser screenshots. Defaults
// to <cwd>/data/agent-attachments — in Docker that's /app/data/... which is
// already covered by the backend_data volume; in local dev it's
// backend/data/agent-attachments. /tmp would be wiped on container restart.
export const TMP_ROOT = process.env.OPERATOR_ATTACHMENTS_DIR
  || path.resolve(process.cwd(), 'data', 'agent-attachments');

export interface CapResult {
  /** Possibly-truncated text that the LLM will see. */
  text: string;
  /** True if the original was truncated. */
  truncated: boolean;
  /** Path to the file holding the full output, if truncation happened. */
  fullPath?: string;
  /** Size in bytes of the original (uncapped) output. */
  originalBytes: number;
  /** Line count of the original output. */
  originalLines: number;
}

export interface CapOptions {
  maxLines?: number;
  maxBytes?: number;
  /** Optional human label folded into the overflow file name. */
  label?: string;
}

function ensureTmpRoot(): void {
  try {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
  } catch {
    // Best-effort — if the directory can't be created, the caller silently
    // loses the overflow file but still gets the truncated preview.
  }
}

function safeLabel(label?: string): string {
  if (!label) return 'tool';
  return label.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 32) || 'tool';
}

/**
 * Cap an output string. If it's within both limits, returned untouched. Otherwise
 * the full text is written to a file under /tmp/operatorchat and the returned
 * `text` shows the first MAX_BYTES with a banner pointing at the overflow file.
 */
export function capOutput(input: string, options: CapOptions = {}): CapResult {
  const text = typeof input === 'string' ? input : String(input ?? '');
  const maxLines = options.maxLines ?? MAX_LINES;
  const maxBytes = options.maxBytes ?? MAX_BYTES;

  const originalBytes = Buffer.byteLength(text, 'utf8');
  // Counting lines naively is fine — even a 50MB log returns in <50ms.
  const originalLines = text === '' ? 0 : text.split('\n').length;

  if (originalLines <= maxLines && originalBytes <= maxBytes) {
    return { text, truncated: false, originalBytes, originalLines };
  }

  ensureTmpRoot();
  const id = crypto.randomBytes(6).toString('hex');
  const filename = `tool_${safeLabel(options.label)}_${Date.now()}_${id}.txt`;
  const fullPath = path.join(TMP_ROOT, filename);
  let savedPath: string | undefined;
  try {
    fs.writeFileSync(fullPath, text, 'utf8');
    savedPath = fullPath;
  } catch {
    savedPath = undefined;
  }

  // Build the visible preview: prefer head-by-bytes since the model usually
  // wants to read forward. We trim to a UTF-8 safe boundary.
  const headBuf = Buffer.from(text, 'utf8').subarray(0, Math.min(maxBytes, originalBytes));
  // Trim incomplete trailing UTF-8.
  let cut = headBuf.length;
  while (cut > 0 && (headBuf[cut - 1] & 0xc0) === 0x80) {
    cut--;
  }
  let head = headBuf.subarray(0, cut).toString('utf8');

  // If the line count was the offender (not bytes), also clip to maxLines lines.
  const headLines = head.split('\n');
  if (headLines.length > maxLines) {
    head = headLines.slice(0, maxLines).join('\n');
  }

  const banner = [
    '...output truncated...',
    '',
    savedPath
      ? `Full output saved to: ${savedPath}`
      : `Full output exceeded ${maxBytes} bytes / ${maxLines} lines (overflow file unavailable)`,
    `Original size: ${originalBytes} bytes, ${originalLines} lines.`,
    '',
  ].join('\n');

  return {
    text: `${banner}${head}`,
    truncated: true,
    fullPath: savedPath,
    originalBytes,
    originalLines,
  };
}

/**
 * The marker stored in pruned tool parts. Matches the spec exactly so the
 * LLM's prompt builder can substitute it in place of the original output.
 */
export const PRUNED_TOOL_OUTPUT_MARKER = '[Old tool result content cleared]';

import crypto from 'crypto';
import type { AgentStep } from './ReActAgent';

const READ_LINE_RE = /^(\d+): (.*)$/;
const MUTATION_TOOL_NAMES = new Set(['write', 'edit', 'apply_patch']);
const PATCH_PATH_RE = /^(?:\*\*\* (?:Update|Add|Delete) File: |\+\+\+ b\/|--- a\/)(.+)$/gm;

export interface ParsedReadObservation {
  path: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
  lineMap: Map<number, string>;
  contentHash: string;
}

export function parseReadObservation(observation: string): ParsedReadObservation | null {
  if (!observation) return null;
  const lines = observation.split('\n');
  if (lines.length < 3) return null;
  if (lines[1] !== 'file') return null;
  const path = lines[0];

  const lineMap = new Map<number, string>();
  let truncated = false;

  for (let i = 3; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('(Output truncated')) {
      truncated = true;
      continue;
    }
    const match = line.match(READ_LINE_RE);
    if (!match) continue;
    lineMap.set(parseInt(match[1], 10), match[2]);
  }

  if (lineMap.size === 0) return null;

  const lineNumbers = [...lineMap.keys()].sort((a, b) => a - b);
  const startLine = lineNumbers[0];
  const endLine = lineNumbers[lineNumbers.length - 1];
  const contentText = lineNumbers.map((n) => `${n}:${lineMap.get(n) ?? ''}`).join('\n');
  const contentHash = crypto.createHash('sha1').update(contentText).digest('hex').slice(0, 12);

  return { path, startLine, endLine, truncated, lineMap, contentHash };
}

export interface CachedRange {
  startLine: number;
  endLine: number;
  truncated: boolean;
  hash: string;
  lineMap: Map<number, string>;
  canonicalStepIndex: number;
}

export interface CachedFile {
  path: string;
  revision: number;
  ranges: CachedRange[];
  invalidated: boolean;
  invalidatedByAction?: string;
}

export type ReadStepReplacement =
  | { kind: 'pointer'; path: string; reason: string }
  | {
      kind: 'wrap';
      path: string;
      revision: number;
      rangeLabel: string;
      truncated: boolean;
      hash: string;
    };

export interface FileViewAnalysis {
  files: Map<string, CachedFile>;
  replacements: Map<number, ReadStepReplacement>;
}

export interface FileViewAnalysisOptions {
  normalizePath: (rawPath: string) => string;
}

function rangesOverlap(a: { startLine: number; endLine: number }, b: { startLine: number; endLine: number }): boolean {
  return !(a.endLine < b.startLine || b.endLine < a.startLine);
}

function rangeFullyContains(outer: { startLine: number; endLine: number }, inner: { startLine: number; endLine: number }): boolean {
  return outer.startLine <= inner.startLine && outer.endLine >= inner.endLine;
}

function overlapMatches(a: CachedRange, b: ParsedReadObservation): boolean {
  const start = Math.max(a.startLine, b.startLine);
  const end = Math.min(a.endLine, b.endLine);
  if (start > end) return true;
  for (let n = start; n <= end; n++) {
    const av = a.lineMap.get(n);
    const bv = b.lineMap.get(n);
    if (av === undefined || bv === undefined) continue;
    if (av !== bv) return false;
  }
  return true;
}

function extractMutationPaths(actionName: string, args: Record<string, any> | undefined): string[] {
  const out: string[] = [];
  if (!args) return out;
  if (actionName === 'apply_patch') {
    const text = String(args.patchText || args.patch || '');
    const matches = text.matchAll(PATCH_PATH_RE);
    for (const m of matches) {
      const p = m[1]?.trim();
      if (p) out.push(p);
    }
    return out;
  }
  const p = String(args.path || args.filePath || '').trim();
  if (p) out.push(p);
  return out;
}

export function analyzeReadCache(steps: AgentStep[], options: FileViewAnalysisOptions): FileViewAnalysis {
  const { normalizePath } = options;
  const files = new Map<string, CachedFile>();
  const replacements = new Map<number, ReadStepReplacement>();

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (step.type !== 'action' || !step.actionName) continue;

    if (MUTATION_TOOL_NAMES.has(step.actionName)) {
      const targetPaths = extractMutationPaths(step.actionName, step.actionArgs);
      for (const raw of targetPaths) {
        const norm = normalizePath(raw);
        if (!norm) continue;
        const existing = files.get(norm);
        if (!existing) continue;
        existing.invalidated = true;
        existing.invalidatedByAction = step.actionName;
      }
      continue;
    }

    if (step.actionName !== 'read') continue;

    const obsStep = steps[index + 1];
    if (!obsStep || obsStep.type !== 'observation') continue;

    const parsed = parseReadObservation(obsStep.content);
    if (!parsed) continue;

    const norm = normalizePath(parsed.path);
    if (!norm) continue;

    const obsIndex = index + 1;
    let file = files.get(norm);
    if (!file) {
      file = {
        path: norm,
        revision: 1,
        ranges: [],
        invalidated: false,
      };
      files.set(norm, file);
    }

    if (file.invalidated) {
      file.revision = Math.max(1, file.revision) + 1;
      for (const range of file.ranges) {
        replacements.set(range.canonicalStepIndex, {
          kind: 'pointer',
          path: norm,
          reason: file.invalidatedByAction
            ? `superseded — file was modified by ${file.invalidatedByAction} after this read`
            : 'superseded by a later read',
        });
      }
      file.ranges = [];
      file.invalidated = false;
      file.invalidatedByAction = undefined;
    }

    let canonicalRange: CachedRange = {
      startLine: parsed.startLine,
      endLine: parsed.endLine,
      truncated: parsed.truncated,
      hash: parsed.contentHash,
      lineMap: parsed.lineMap,
      canonicalStepIndex: obsIndex,
    };

    let newReadIsCanonical = true;
    let externalChangeDetected = false;
    const survivingRanges: CachedRange[] = [];

    for (const existing of file.ranges) {
      if (!rangesOverlap(existing, canonicalRange)) {
        survivingRanges.push(existing);
        continue;
      }

      if (!overlapMatches(existing, parsed)) {
        externalChangeDetected = true;
        continue;
      }

      if (rangeFullyContains(canonicalRange, existing)) {
        replacements.set(existing.canonicalStepIndex, {
          kind: 'pointer',
          path: norm,
          reason: `subsumed by later read of lines ${canonicalRange.startLine}-${canonicalRange.endLine}`,
        });
        continue;
      }

      if (rangeFullyContains(existing, canonicalRange)) {
        replacements.set(obsIndex, {
          kind: 'pointer',
          path: norm,
          reason: `already covered by earlier read of lines ${existing.startLine}-${existing.endLine}`,
        });
        newReadIsCanonical = false;
        survivingRanges.push(existing);
        canonicalRange = existing;
        continue;
      }

      survivingRanges.push(existing);
    }

    if (externalChangeDetected) {
      file.revision += 1;
      for (const range of file.ranges) {
        if (replacements.get(range.canonicalStepIndex)?.kind !== 'pointer') {
          replacements.set(range.canonicalStepIndex, {
            kind: 'pointer',
            path: norm,
            reason: 'superseded — file content changed since this read (detected via overlap-hash mismatch)',
          });
        }
      }
      survivingRanges.length = 0;
      newReadIsCanonical = true;
      canonicalRange = {
        startLine: parsed.startLine,
        endLine: parsed.endLine,
        truncated: parsed.truncated,
        hash: parsed.contentHash,
        lineMap: parsed.lineMap,
        canonicalStepIndex: obsIndex,
      };
    }

    if (newReadIsCanonical) {
      replacements.set(obsIndex, {
        kind: 'wrap',
        path: norm,
        revision: file.revision,
        rangeLabel: `${canonicalRange.startLine}-${canonicalRange.endLine}${canonicalRange.truncated ? '+' : ''}`,
        truncated: canonicalRange.truncated,
        hash: canonicalRange.hash,
      });
      survivingRanges.push(canonicalRange);
    }

    survivingRanges.sort((a, b) => a.startLine - b.startLine);
    file.ranges = survivingRanges;
  }

  return { files, replacements };
}

export function formatFileIndex(files: Map<string, CachedFile>): string | null {
  if (files.size === 0) return null;
  const entries: string[] = [];
  const sortedPaths = [...files.keys()].sort();
  for (const path of sortedPaths) {
    const file = files.get(path);
    if (!file) continue;
    if (file.ranges.length === 0 && !file.invalidated) continue;
    if (file.ranges.length === 0 && file.invalidated) {
      entries.push(`- ${path} — modified by ${file.invalidatedByAction || 'edit'}; not yet re-read`);
      continue;
    }
    const rangeText = file.ranges
      .map((r) => `${r.startLine}-${r.endLine}${r.truncated ? '+' : ''}`)
      .join(', ');
    const staleNote = file.invalidated
      ? ` — STALE: modified by ${file.invalidatedByAction || 'edit'} after these reads; re-read before relying on this content`
      : '';
    entries.push(`- ${path} (rev ${file.revision}, lines ${rangeText})${staleNote}`);
  }
  if (entries.length === 0) return null;
  return entries.join('\n');
}

export function formatPointerObservation(replacement: Extract<ReadStepReplacement, { kind: 'pointer' }>): string {
  return `[earlier read of ${replacement.path} omitted from prompt — ${replacement.reason}. Consult <file_index> for current cached ranges of this file.]`;
}

export function wrapObservationWithFileView(
  observation: string,
  replacement: Extract<ReadStepReplacement, { kind: 'wrap' }>
): string {
  return `<file_view path="${replacement.path}" revision="${replacement.revision}" lines="${replacement.rangeLabel}" hash="${replacement.hash}">
${observation}
</file_view>`;
}

export interface CoverageQuery {
  path: string;
  offset: number;
  limit: number;
}

export interface CoverageHit {
  range: { startLine: number; endLine: number };
  revision: number;
  canonicalStepIndex: number;
}

export function findCachedCoverage(
  query: CoverageQuery,
  files: Map<string, CachedFile>
): CoverageHit | null {
  const file = files.get(query.path);
  if (!file || file.invalidated) return null;
  const requestStart = query.offset;
  const requestEnd = query.offset + query.limit - 1;
  for (const range of file.ranges) {
    if (range.startLine <= requestStart && range.endLine >= requestEnd) {
      return {
        range: { startLine: range.startLine, endLine: range.endLine },
        revision: file.revision,
        canonicalStepIndex: range.canonicalStepIndex,
      };
    }
  }
  return null;
}

export function isRequestCoveredByCache(
  query: CoverageQuery,
  files: Map<string, CachedFile>
): { covered: true; range: { startLine: number; endLine: number }; revision: number } | null {
  const hit = findCachedCoverage(query, files);
  if (!hit) return null;
  return { covered: true, range: hit.range, revision: hit.revision };
}

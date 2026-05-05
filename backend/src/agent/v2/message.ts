import { z } from 'zod';
import { SessionID, MessageID, PartID } from './ids';

// 1:1 port of opencode's `session/message-v2.ts` data model. Effect Schema → zod;
// Snapshot.FileDiff is replaced with a structural placeholder and LSP.Range is
// deferred until/if we port the LSP integration. All semantic invariants
// (discriminator field, optionality, allowed value sets) match upstream.

// ── Errors ──────────────────────────────────────────────────────────────────

export const APIErrorSchema = z.object({
  name: z.literal('APIError'),
  data: z.object({
    message: z.string(),
    statusCode: z.number().int().nonnegative().optional(),
    isRetryable: z.boolean(),
    responseHeaders: z.record(z.string(), z.string()).optional(),
    responseBody: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  }),
});
export type APIError = z.infer<typeof APIErrorSchema>;

export const AssistantErrorSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('ProviderAuthError'), data: z.object({ providerID: z.string(), message: z.string() }) }),
  z.object({ name: z.literal('UnknownError'), data: z.object({ message: z.string() }) }),
  z.object({ name: z.literal('MessageOutputLengthError'), data: z.object({}).passthrough() }),
  z.object({ name: z.literal('MessageAbortedError'), data: z.object({ message: z.string() }) }),
  z.object({
    name: z.literal('StructuredOutputError'),
    data: z.object({ message: z.string(), retries: z.number().int().nonnegative() }),
  }),
  z.object({
    name: z.literal('ContextOverflowError'),
    data: z.object({ message: z.string(), responseBody: z.string().optional() }),
  }),
  APIErrorSchema,
]);
export type AssistantError = z.infer<typeof AssistantErrorSchema>;

// ── Output formats ──────────────────────────────────────────────────────────

export const OutputFormatSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text') }),
  z.object({
    type: z.literal('json_schema'),
    schema: z.record(z.string(), z.any()),
    retryCount: z.number().int().nonnegative().optional(),
  }),
]);
export type OutputFormat = z.infer<typeof OutputFormatSchema>;

// ── Part sources (used by FilePart) ─────────────────────────────────────────

const filePartSourceText = z.object({
  text: z.object({
    value: z.string(),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  }),
});

export const FileSourceSchema = filePartSourceText.extend({
  type: z.literal('file'),
  path: z.string(),
});

// LSP.Range placeholder — keep the field, validate loosely until LSP is ported
const lspRangeSchema = z.object({
  start: z.object({ line: z.number().int(), character: z.number().int() }),
  end: z.object({ line: z.number().int(), character: z.number().int() }),
});

export const SymbolSourceSchema = filePartSourceText.extend({
  type: z.literal('symbol'),
  path: z.string(),
  range: lspRangeSchema,
  name: z.string(),
  kind: z.number().int().nonnegative(),
});

export const ResourceSourceSchema = filePartSourceText.extend({
  type: z.literal('resource'),
  clientName: z.string(),
  uri: z.string(),
});

export const FilePartSourceSchema = z.discriminatedUnion('type', [
  FileSourceSchema,
  SymbolSourceSchema,
  ResourceSourceSchema,
]);
export type FilePartSource = z.infer<typeof FilePartSourceSchema>;

// ── Parts ───────────────────────────────────────────────────────────────────

const partBase = {
  id: PartID.zod,
  sessionID: SessionID.zod,
  messageID: MessageID.zod,
};

export const TextPartSchema = z.object({
  ...partBase,
  type: z.literal('text'),
  text: z.string(),
  synthetic: z.boolean().optional(),
  ignored: z.boolean().optional(),
  time: z
    .object({
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative().optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});
export type TextPart = z.infer<typeof TextPartSchema>;

export const ReasoningPartSchema = z.object({
  ...partBase,
  type: z.literal('reasoning'),
  text: z.string(),
  metadata: z.record(z.string(), z.any()).optional(),
  time: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative().optional(),
  }),
});
export type ReasoningPart = z.infer<typeof ReasoningPartSchema>;

export const FilePartSchema = z.object({
  ...partBase,
  type: z.literal('file'),
  mime: z.string(),
  filename: z.string().optional(),
  url: z.string(),
  source: FilePartSourceSchema.optional(),
});
export type FilePart = z.infer<typeof FilePartSchema>;

export const AgentPartSchema = z.object({
  ...partBase,
  type: z.literal('agent'),
  name: z.string(),
  source: z
    .object({
      value: z.string(),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    })
    .optional(),
});
export type AgentPart = z.infer<typeof AgentPartSchema>;

export const SubtaskPartSchema = z.object({
  ...partBase,
  type: z.literal('subtask'),
  prompt: z.string(),
  description: z.string(),
  agent: z.string(),
  model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
  command: z.string().optional(),
});
export type SubtaskPart = z.infer<typeof SubtaskPartSchema>;

export const CompactionPartSchema = z.object({
  ...partBase,
  type: z.literal('compaction'),
  auto: z.boolean(),
  overflow: z.boolean().optional(),
  tail_start_id: MessageID.zod.optional(),
});
export type CompactionPart = z.infer<typeof CompactionPartSchema>;

export const RetryPartSchema = z.object({
  ...partBase,
  type: z.literal('retry'),
  attempt: z.number().int().nonnegative(),
  error: APIErrorSchema,
  time: z.object({ created: z.number().int().nonnegative() }),
});
export type RetryPart = z.infer<typeof RetryPartSchema>;

export const StepStartPartSchema = z.object({
  ...partBase,
  type: z.literal('step-start'),
  snapshot: z.string().optional(),
});
export type StepStartPart = z.infer<typeof StepStartPartSchema>;

export const StepFinishPartSchema = z.object({
  ...partBase,
  type: z.literal('step-finish'),
  reason: z.string(),
  snapshot: z.string().optional(),
  cost: z.number().finite(),
  tokens: z.object({
    total: z.number().int().nonnegative().optional(),
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative(),
    cache: z.object({
      read: z.number().int().nonnegative(),
      write: z.number().int().nonnegative(),
    }),
  }),
});
export type StepFinishPart = z.infer<typeof StepFinishPartSchema>;

export const SnapshotPartSchema = z.object({
  ...partBase,
  type: z.literal('snapshot'),
  snapshot: z.string(),
});
export type SnapshotPart = z.infer<typeof SnapshotPartSchema>;

export const PatchPartSchema = z.object({
  ...partBase,
  type: z.literal('patch'),
  hash: z.string(),
  files: z.array(z.string()),
});
export type PatchPart = z.infer<typeof PatchPartSchema>;

// ── Tool state ──────────────────────────────────────────────────────────────

export const ToolStatePendingSchema = z.object({
  status: z.literal('pending'),
  input: z.record(z.string(), z.any()),
  raw: z.string(),
});
export type ToolStatePending = z.infer<typeof ToolStatePendingSchema>;

export const ToolStateRunningSchema = z.object({
  status: z.literal('running'),
  input: z.record(z.string(), z.any()),
  title: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  time: z.object({ start: z.number().int().nonnegative() }),
});
export type ToolStateRunning = z.infer<typeof ToolStateRunningSchema>;

export const ToolStateCompletedSchema = z.object({
  status: z.literal('completed'),
  input: z.record(z.string(), z.any()),
  output: z.string(),
  title: z.string(),
  metadata: z.record(z.string(), z.any()),
  time: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    compacted: z.number().int().nonnegative().optional(),
  }),
  attachments: z.array(FilePartSchema).optional(),
});
export type ToolStateCompleted = z.infer<typeof ToolStateCompletedSchema>;

export const ToolStateErrorSchema = z.object({
  status: z.literal('error'),
  input: z.record(z.string(), z.any()),
  error: z.string(),
  metadata: z.record(z.string(), z.any()).optional(),
  time: z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  }),
});
export type ToolStateError = z.infer<typeof ToolStateErrorSchema>;

export const ToolStateSchema = z.discriminatedUnion('status', [
  ToolStatePendingSchema,
  ToolStateRunningSchema,
  ToolStateCompletedSchema,
  ToolStateErrorSchema,
]);
export type ToolState = z.infer<typeof ToolStateSchema>;

export const ToolPartSchema = z.object({
  ...partBase,
  type: z.literal('tool'),
  callID: z.string(),
  tool: z.string(),
  state: ToolStateSchema,
  metadata: z.record(z.string(), z.any()).optional(),
});
export type ToolPart = z.infer<typeof ToolPartSchema>;

// ── Part union ──────────────────────────────────────────────────────────────

export const PartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ReasoningPartSchema,
  FilePartSchema,
  AgentPartSchema,
  SubtaskPartSchema,
  ToolPartSchema,
  StepStartPartSchema,
  StepFinishPartSchema,
  SnapshotPartSchema,
  PatchPartSchema,
  RetryPartSchema,
  CompactionPartSchema,
]);
export type Part = z.infer<typeof PartSchema>;

// ── Messages ────────────────────────────────────────────────────────────────

const messageBase = {
  id: MessageID.zod,
  sessionID: SessionID.zod,
};

export const UserMessageSchema = z.object({
  ...messageBase,
  role: z.literal('user'),
  time: z.object({ created: z.number().int().nonnegative() }),
  format: OutputFormatSchema.optional(),
  summary: z
    .object({
      title: z.string().optional(),
      body: z.string().optional(),
      diffs: z.array(z.any()),
    })
    .optional(),
  agent: z.string(),
  model: z.object({
    providerID: z.string(),
    modelID: z.string(),
    variant: z.string().optional(),
  }),
  system: z.string().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
});
export type UserMessage = z.infer<typeof UserMessageSchema>;

export const AssistantMessageSchema = z.object({
  ...messageBase,
  role: z.literal('assistant'),
  time: z.object({
    created: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative().optional(),
  }),
  error: AssistantErrorSchema.optional(),
  parentID: MessageID.zod,
  modelID: z.string(),
  providerID: z.string(),
  /** @deprecated retained for compatibility */
  mode: z.string(),
  agent: z.string(),
  path: z.object({ cwd: z.string(), root: z.string() }),
  summary: z.boolean().optional(),
  cost: z.number().finite(),
  tokens: z.object({
    total: z.number().int().nonnegative().optional(),
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative(),
    cache: z.object({
      read: z.number().int().nonnegative(),
      write: z.number().int().nonnegative(),
    }),
  }),
  structured: z.any().optional(),
  variant: z.string().optional(),
  finish: z.string().optional(),
});
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

export const InfoSchema = z.discriminatedUnion('role', [UserMessageSchema, AssistantMessageSchema]);
export type Info = z.infer<typeof InfoSchema>;

export interface WithParts {
  info: Info;
  parts: Part[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function isMedia(mime: string): boolean {
  return mime.startsWith('image/') || mime === 'application/pdf';
}

export function isTextPart(p: Part): p is TextPart {
  return p.type === 'text';
}
export function isToolPart(p: Part): p is ToolPart {
  return p.type === 'tool';
}
export function isCompactionPart(p: Part): p is CompactionPart {
  return p.type === 'compaction';
}
export function isReasoningPart(p: Part): p is ReasoningPart {
  return p.type === 'reasoning';
}

import crypto from 'crypto';
import { execute, query, queryOne } from '../db';
import { WorkspaceConfig } from './workspaceRuntime';

export type AgentMemoryKind =
  | 'project_overview'
  | 'active_context'
  | 'progress'
  | 'todo'
  | 'decision'
  | 'file_state'
  | 'file_summary'
  | 'command'
  | 'error'
  | 'terminal'
  | 'dependency'
  | 'test_result';

export type AgentMemorySource = 'system' | 'agent';
export type AgentMemoryConfidence = 'observed' | 'inferred' | 'agent_claim';

export interface AgentMemoryScope {
  chatId: string;
  workspace?: WorkspaceConfig;
  agentRunId?: string;
}

export interface AgentMemoryRecord {
  id: string;
  chat_id: string;
  workspace_host: string;
  workspace_root: string;
  agent_run_id?: string | null;
  kind: AgentMemoryKind;
  memory_key: string;
  content: string;
  source: AgentMemorySource;
  confidence: AgentMemoryConfidence;
  metadata?: any;
  expires_at?: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AgentMemoryUpsert {
  kind: AgentMemoryKind;
  key: string;
  content: string;
  source: AgentMemorySource;
  confidence: AgentMemoryConfidence;
  metadata?: Record<string, any>;
  expiresAt?: Date | null;
}

function parseJson(value: unknown): any {
  if (!value || typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function normalizeMemoryPath(filePath: string, workspace?: WorkspaceConfig): string {
  let normalized = String(filePath || '').trim().replaceAll('\\', '/').replace(/\/+/g, '/');
  const root = workspace?.ssh?.root?.trim().replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/$/, '');
  if (root && normalized.startsWith(`${root}/`)) {
    normalized = normalized.slice(root.length + 1);
  }
  return normalized.replace(/^\.\//, '').replace(/^\/+/, '');
}

function getWorkspaceIdentity(workspace?: WorkspaceConfig): { host: string; root: string } {
  if (workspace?.ssh?.enabled) {
    return {
      host: `${workspace.ssh.username}@${workspace.ssh.host}:${workspace.ssh.port || 22}`,
      root: workspace.ssh.root,
    };
  }
  return { host: 'local', root: workspace?.ssh?.root || 'sandbox' };
}

export function agentMemoryContentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function summarizeText(content: string, maxChars = 1600): string {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}\n[truncated]`;
}

export class AgentMemoryService {
  async upsert(scope: AgentMemoryScope, memory: AgentMemoryUpsert): Promise<AgentMemoryRecord> {
    const workspaceIdentity = getWorkspaceIdentity(scope.workspace);
    const existing = await queryOne<AgentMemoryRecord>(
      `SELECT * FROM agent_memories
       WHERE chat_id = ? AND workspace_host = ? AND workspace_root = ? AND kind = ? AND memory_key = ?`,
      [scope.chatId, workspaceIdentity.host, workspaceIdentity.root, memory.kind, memory.key]
    );
    const id = existing?.id || crypto.randomUUID();
    const beforeJson = existing ? JSON.stringify(existing) : null;
    const metadataJson = JSON.stringify(memory.metadata || {});

    await execute(
      `INSERT INTO agent_memories (
        id, chat_id, workspace_host, workspace_root, agent_run_id, kind, memory_key,
        content, source, confidence, metadata, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        agent_run_id = VALUES(agent_run_id),
        content = VALUES(content),
        source = VALUES(source),
        confidence = VALUES(confidence),
        metadata = VALUES(metadata),
        expires_at = VALUES(expires_at),
        updated_at = CURRENT_TIMESTAMP`,
      [
        id,
        scope.chatId,
        workspaceIdentity.host,
        workspaceIdentity.root,
        scope.agentRunId || null,
        memory.kind,
        memory.key,
        memory.content,
        memory.source,
        memory.confidence,
        metadataJson,
        memory.expiresAt || null,
      ]
    );

    const record = await this.get(scope, memory.kind, memory.key);
    await execute(
      `INSERT INTO agent_memory_events (
        id, memory_id, chat_id, agent_run_id, event_type, before_json, after_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        id,
        scope.chatId,
        scope.agentRunId || null,
        existing ? 'update' : 'create',
        beforeJson,
        JSON.stringify(record || memory),
      ]
    );

    return record!;
  }

  async get(scope: AgentMemoryScope, kind: AgentMemoryKind, key: string): Promise<AgentMemoryRecord | null> {
    const workspaceIdentity = getWorkspaceIdentity(scope.workspace);
    const record = await queryOne<AgentMemoryRecord>(
      `SELECT * FROM agent_memories
       WHERE chat_id = ? AND workspace_host = ? AND workspace_root = ? AND kind = ? AND memory_key = ?`,
      [scope.chatId, workspaceIdentity.host, workspaceIdentity.root, kind, key]
    );
    if (record) {
      record.metadata = parseJson(record.metadata);
    }
    return record;
  }

  async list(scope: AgentMemoryScope, kinds?: AgentMemoryKind[], limit = 80): Promise<AgentMemoryRecord[]> {
    const workspaceIdentity = getWorkspaceIdentity(scope.workspace);
    const params: any[] = [scope.chatId, workspaceIdentity.host, workspaceIdentity.root];
    let kindClause = '';
    if (kinds?.length) {
      kindClause = ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }
    params.push(Math.max(1, Math.min(200, limit)));

    const records = await query<AgentMemoryRecord>(
      `SELECT * FROM agent_memories
       WHERE chat_id = ? AND workspace_host = ? AND workspace_root = ?${kindClause}
       ORDER BY updated_at DESC
       LIMIT ?`,
      params
    );
    return records.map((record) => ({ ...record, metadata: parseJson(record.metadata) }));
  }

  async search(scope: AgentMemoryScope, queryText: string, limit = 20): Promise<AgentMemoryRecord[]> {
    const workspaceIdentity = getWorkspaceIdentity(scope.workspace);
    const like = `%${queryText}%`;
    const records = await query<AgentMemoryRecord>(
      `SELECT * FROM agent_memories
       WHERE chat_id = ? AND workspace_host = ? AND workspace_root = ?
         AND (content LIKE ? OR memory_key LIKE ?)
       ORDER BY updated_at DESC
       LIMIT ?`,
      [scope.chatId, workspaceIdentity.host, workspaceIdentity.root, like, like, Math.max(1, Math.min(50, limit))]
    );
    return records.map((record) => ({ ...record, metadata: parseJson(record.metadata) }));
  }

  async recordFileRead(scope: AgentMemoryScope, filePath: string, content: string, offset?: number, limit?: number): Promise<void> {
    const normalizedPath = normalizeMemoryPath(filePath, scope.workspace);
    const lines = content.split('\n');
    const lineStart = Number.isFinite(Number(offset)) ? Number(offset) : 1;
    const lineEnd = lineStart + Math.max(0, lines.length - 1);
    const hash = agentMemoryContentHash(content);

    await this.upsert(scope, {
      kind: 'file_state',
      key: `file:${normalizedPath}`,
      source: 'system',
      confidence: 'observed',
      content: `Read ${normalizedPath} lines ${lineStart}-${lineEnd}. Hash ${hash.slice(0, 12)}.`,
      metadata: {
        path: normalizedPath,
        lineStart,
        lineEnd,
        readHash: hash,
        lastReadAt: new Date().toISOString(),
        stale: false,
      },
    });

    await this.upsert(scope, {
      kind: 'file_summary',
      key: `file:${normalizedPath}`,
      source: 'system',
      confidence: 'observed',
      content: `Latest observed content for ${normalizedPath}:\n${summarizeText(content)}`,
      metadata: {
        path: normalizedPath,
        lineStart,
        lineEnd,
        contentHash: hash,
      },
    });
  }

  async recordFileWrite(scope: AgentMemoryScope, filePath: string, content: string, operation: 'write' | 'edit' | 'apply_patch'): Promise<void> {
    const normalizedPath = normalizeMemoryPath(filePath, scope.workspace);
    const hash = agentMemoryContentHash(content);
    await this.upsert(scope, {
      kind: 'file_state',
      key: `file:${normalizedPath}`,
      source: 'system',
      confidence: 'observed',
      content: `${operation} updated ${normalizedPath}. Hash ${hash.slice(0, 12)}.`,
      metadata: {
        path: normalizedPath,
        contentHash: hash,
        lastWriteAt: new Date().toISOString(),
        operation,
        stale: false,
      },
    });

    await this.upsert(scope, {
      kind: 'file_summary',
      key: `file:${normalizedPath}`,
      source: 'system',
      confidence: 'observed',
      content: `${operation} produced latest known content for ${normalizedPath}:\n${summarizeText(content)}`,
      metadata: {
        path: normalizedPath,
        contentHash: hash,
        operation,
      },
    });
  }

  async recordFilePatch(scope: AgentMemoryScope, filePath: string, patchText: string): Promise<void> {
    const normalizedPath = normalizeMemoryPath(filePath, scope.workspace);
    await this.upsert(scope, {
      kind: 'file_state',
      key: `file:${normalizedPath}`,
      source: 'system',
      confidence: 'observed',
      content: `apply_patch modified ${normalizedPath}. Previous read memory for this file may be stale until the file is read or tested again.`,
      metadata: {
        path: normalizedPath,
        lastWriteAt: new Date().toISOString(),
        operation: 'apply_patch',
        stale: true,
      },
    });

    await this.upsert(scope, {
      kind: 'file_summary',
      key: `file:${normalizedPath}`,
      source: 'system',
      confidence: 'observed',
      content: `Patch applied to ${normalizedPath}:\n${summarizeText(patchText, 1600)}`,
      metadata: {
        path: normalizedPath,
        operation: 'apply_patch',
        stale: true,
      },
    });
  }

  extractPatchPaths(patchText: string): string[] {
    const paths = new Set<string>();
    for (const line of patchText.split('\n')) {
      const update = line.match(/^\*\*\* Update File:\s+(.+)$/);
      const add = line.match(/^\*\*\* Add File:\s+(.+)$/);
      const del = line.match(/^\*\*\* Delete File:\s+(.+)$/);
      const match = update || add || del;
      if (match?.[1]) {
        paths.add(match[1].trim());
      }
    }
    return Array.from(paths);
  }

  async recordCommand(scope: AgentMemoryScope, command: string, result: { exitCode: number | null; stdout: string; stderr: string; durationMs?: number }): Promise<void> {
    const key = `cmd:${agentMemoryContentHash(command).slice(0, 16)}`;
    const output = [result.stdout && `STDOUT:\n${result.stdout}`, result.stderr && `STDERR:\n${result.stderr}`]
      .filter(Boolean)
      .join('\n\n');
    await this.upsert(scope, {
      kind: result.exitCode === 0 ? 'command' : 'error',
      key,
      source: 'system',
      confidence: 'observed',
      content: `Command: ${command}\nExit code: ${result.exitCode}\n${summarizeText(output || '(no output)', 1800)}`,
      metadata: {
        command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      },
    });
  }

  async buildContextPacket(scope: AgentMemoryScope): Promise<string> {
    const memories = await this.list(scope, [
      'active_context',
      'progress',
      'todo',
      'decision',
      'file_state',
      'file_summary',
      'command',
      'error',
      'terminal',
      'test_result',
    ], 100);

    if (memories.length === 0) {
      return '';
    }

    const groups = new Map<string, AgentMemoryRecord[]>();
    for (const memory of memories) {
      const group = groups.get(memory.kind) || [];
      group.push(memory);
      groups.set(memory.kind, group);
    }

    const sections: string[] = [];
    for (const [kind, records] of groups) {
      sections.push(`## ${kind.replaceAll('_', ' ').toUpperCase()}`);
      sections.push(records.slice(0, kind === 'file_summary' ? 30 : 15).map((record) => (
        `- ${record.memory_key}: ${record.content.replace(/\n/g, '\n  ')}`
      )).join('\n'));
    }

    return sections.join('\n\n');
  }
}

export const agentMemoryService = new AgentMemoryService();

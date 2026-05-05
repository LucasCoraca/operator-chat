import { query, queryOne, execute } from '../db';
import {
  Info,
  Part,
  WithParts,
  UserMessage,
  AssistantMessage,
  PartSchema,
  InfoSchema,
} from '../agent/v2/message';
import { SessionID, MessageID, PartID } from '../agent/v2/ids';

// Persistence layer for the v2 agent's sessions / messages / parts.
// Mirrors opencode's session.sql.ts shape (id + JSON-blob data column per row),
// translated to MariaDB JSON columns so we don't add SQLite as a dependency.

export interface AgentSession {
  id: SessionID;
  chatId: string;
  agentRunId: string | null;
  parentSessionId: SessionID | null;
  directory: string;
  title: string;
  agent: string;
  model: { providerID: string; modelID: string; variant?: string } | null;
  revert: unknown | null;
  permission: unknown | null;
  timeCompacting: number | null;
  timeArchived: number | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RawSessionRow {
  id: string;
  chat_id: string;
  agent_run_id: string | null;
  parent_session_id: string | null;
  directory: string;
  title: string;
  agent: string;
  model_data: unknown;
  revert_data: unknown;
  permission_data: unknown;
  time_compacting: number | null;
  time_archived: number | null;
  created_at: Date;
  updated_at: Date;
}

interface RawMessageRow {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  time_created: number;
  data: unknown;
  created_at: Date;
  updated_at: Date;
}

interface RawPartRow {
  id: string;
  message_id: string;
  session_id: string;
  type: string;
  data: unknown;
  created_at: Date;
  updated_at: Date;
}

function parseJson(value: unknown): any {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function normalizeSession(row: RawSessionRow | null): AgentSession | null {
  if (!row) return null;
  return {
    id: row.id as SessionID,
    chatId: row.chat_id,
    agentRunId: row.agent_run_id,
    parentSessionId: row.parent_session_id as SessionID | null,
    directory: row.directory,
    title: row.title,
    agent: row.agent,
    model: parseJson(row.model_data),
    revert: parseJson(row.revert_data),
    permission: parseJson(row.permission_data),
    timeCompacting: row.time_compacting,
    timeArchived: row.time_archived,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeMessage(row: RawMessageRow): Info {
  const data = parseJson(row.data) ?? {};
  // Restore ID/sessionID fields stripped at write time.
  return InfoSchema.parse({ ...data, id: row.id, sessionID: row.session_id, role: row.role });
}

function normalizePart(row: RawPartRow): Part {
  const data = parseJson(row.data) ?? {};
  return PartSchema.parse({
    ...data,
    id: row.id,
    sessionID: row.session_id,
    messageID: row.message_id,
    type: row.type,
  });
}

export class AgentSessionRepository {
  async createSession(input: {
    chatId: string;
    agentRunId?: string | null;
    parentSessionId?: SessionID | null;
    directory: string;
    title: string;
    agent: string;
    model?: AgentSession['model'];
  }): Promise<AgentSession> {
    const id = SessionID.descending();
    await execute(
      `INSERT INTO agent_sessions (id, chat_id, agent_run_id, parent_session_id, directory, title, agent, model_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.chatId,
        input.agentRunId ?? null,
        input.parentSessionId ?? null,
        input.directory,
        input.title,
        input.agent,
        input.model ? JSON.stringify(input.model) : null,
      ]
    );
    const row = await queryOne<RawSessionRow>('SELECT * FROM agent_sessions WHERE id = ?', [id]);
    const session = normalizeSession(row);
    if (!session) throw new Error('Failed to create agent session');
    return session;
  }

  async findSession(id: SessionID): Promise<AgentSession | null> {
    const row = await queryOne<RawSessionRow>('SELECT * FROM agent_sessions WHERE id = ?', [id]);
    return normalizeSession(row);
  }

  async listSessionsForChat(chatId: string): Promise<AgentSession[]> {
    const rows = await query<RawSessionRow>(
      'SELECT * FROM agent_sessions WHERE chat_id = ? ORDER BY created_at DESC',
      [chatId]
    );
    return rows.map((r) => normalizeSession(r)).filter((s): s is AgentSession => s !== null);
  }

  async updateSession(
    id: SessionID,
    patch: Partial<{
      title: string;
      agent: string;
      model: AgentSession['model'];
      revert: unknown;
      permission: unknown;
      timeCompacting: number | null;
      timeArchived: number | null;
    }>
  ): Promise<AgentSession | null> {
    const fields: string[] = [];
    const values: any[] = [];
    if (patch.title !== undefined) {
      fields.push('title = ?');
      values.push(patch.title);
    }
    if (patch.agent !== undefined) {
      fields.push('agent = ?');
      values.push(patch.agent);
    }
    if (patch.model !== undefined) {
      fields.push('model_data = ?');
      values.push(patch.model ? JSON.stringify(patch.model) : null);
    }
    if (patch.revert !== undefined) {
      fields.push('revert_data = ?');
      values.push(patch.revert == null ? null : JSON.stringify(patch.revert));
    }
    if (patch.permission !== undefined) {
      fields.push('permission_data = ?');
      values.push(patch.permission == null ? null : JSON.stringify(patch.permission));
    }
    if (patch.timeCompacting !== undefined) {
      fields.push('time_compacting = ?');
      values.push(patch.timeCompacting);
    }
    if (patch.timeArchived !== undefined) {
      fields.push('time_archived = ?');
      values.push(patch.timeArchived);
    }
    if (fields.length === 0) return this.findSession(id);
    values.push(id);
    await execute(`UPDATE agent_sessions SET ${fields.join(', ')} WHERE id = ?`, values);
    return this.findSession(id);
  }

  async deleteSession(id: SessionID): Promise<boolean> {
    const result = await execute('DELETE FROM agent_sessions WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  async upsertMessage(message: Info): Promise<Info> {
    const { id, sessionID, role, time, ...rest } = message as any;
    const data = JSON.stringify({ ...rest, time });
    const timeCreated = time?.created ?? Date.now();
    await execute(
      `INSERT INTO agent_session_messages (id, session_id, role, time_created, data)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE data = VALUES(data), time_created = VALUES(time_created)`,
      [id, sessionID, role, timeCreated, data]
    );
    return message;
  }

  async deleteMessage(id: MessageID): Promise<boolean> {
    const result = await execute('DELETE FROM agent_session_messages WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  async findMessage(id: MessageID): Promise<Info | null> {
    const row = await queryOne<RawMessageRow>('SELECT * FROM agent_session_messages WHERE id = ?', [id]);
    return row ? normalizeMessage(row) : null;
  }

  // ── Parts ─────────────────────────────────────────────────────────────────

  async upsertPart(part: Part): Promise<Part> {
    const { id, sessionID, messageID, type, ...rest } = part as any;
    const data = JSON.stringify(rest);
    await execute(
      `INSERT INTO agent_session_parts (id, message_id, session_id, type, data)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE data = VALUES(data), type = VALUES(type)`,
      [id, messageID, sessionID, type, data]
    );
    return part;
  }

  async deletePart(id: PartID): Promise<boolean> {
    const result = await execute('DELETE FROM agent_session_parts WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  // ── WithParts hydration ───────────────────────────────────────────────────

  async listMessagesWithParts(sessionId: SessionID): Promise<WithParts[]> {
    const messageRows = await query<RawMessageRow>(
      'SELECT * FROM agent_session_messages WHERE session_id = ? ORDER BY time_created ASC, id ASC',
      [sessionId]
    );
    if (messageRows.length === 0) return [];

    const partRows = await query<RawPartRow>(
      'SELECT * FROM agent_session_parts WHERE session_id = ? ORDER BY message_id ASC, id ASC',
      [sessionId]
    );

    const partsByMessage = new Map<string, Part[]>();
    for (const row of partRows) {
      const part = normalizePart(row);
      const list = partsByMessage.get(row.message_id);
      if (list) list.push(part);
      else partsByMessage.set(row.message_id, [part]);
    }

    return messageRows.map((row) => ({
      info: normalizeMessage(row),
      parts: partsByMessage.get(row.id) ?? [],
    }));
  }

  async deleteAllForChat(chatId: string): Promise<number> {
    const result = await execute('DELETE FROM agent_sessions WHERE chat_id = ?', [chatId]);
    return result.affectedRows;
  }
}

export const agentSessionRepository = new AgentSessionRepository();

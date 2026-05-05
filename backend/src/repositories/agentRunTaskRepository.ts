import { query, queryOne, execute, transaction } from '../db';
import crypto from 'crypto';

function toMysqlDateTime(date: Date = new Date()): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export type AgentRunTaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type AgentRunTaskPriority = 'high' | 'medium' | 'low';

export interface AgentRunTask {
  id: string;
  chatId: string;
  agentRunId: string;
  subject: string;
  description: string | null;
  status: AgentRunTaskStatus;
  priority: AgentRunTaskPriority;
  orderIndex: number;
  createdAt: Date;
  updatedAt: Date;
}

interface RawAgentRunTaskRow {
  id: string;
  chat_id: string;
  agent_run_id: string;
  subject: string;
  description: string | null;
  status: AgentRunTaskStatus;
  priority: AgentRunTaskPriority | null;
  order_index: number;
  created_at: Date;
  updated_at: Date;
}

function normalizeRow(row: RawAgentRunTaskRow | null): AgentRunTask | null {
  if (!row) return null;
  return {
    id: row.id,
    chatId: row.chat_id,
    agentRunId: row.agent_run_id,
    subject: row.subject,
    description: row.description,
    status: row.status,
    priority: row.priority || 'medium',
    orderIndex: row.order_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateAgentRunTaskInput {
  chatId: string;
  agentRunId: string;
  subject: string;
  description?: string | null;
  priority?: AgentRunTaskPriority;
}

export interface UpdateAgentRunTaskInput {
  subject?: string;
  description?: string | null;
  status?: AgentRunTaskStatus;
  priority?: AgentRunTaskPriority;
}

/** Whole-list replacement payload used by the spec's `todo` tool. */
export interface TodoListItem {
  id?: string;
  /** spec calls this `content`; we store it as `subject` in the DB. */
  content: string;
  status: AgentRunTaskStatus;
  priority: AgentRunTaskPriority;
}

export class AgentRunTaskRepository {
  async findById(id: string): Promise<AgentRunTask | null> {
    const row = await queryOne<RawAgentRunTaskRow>('SELECT * FROM agent_run_tasks WHERE id = ?', [id]);
    return normalizeRow(row);
  }

  async listByRun(chatId: string, agentRunId: string): Promise<AgentRunTask[]> {
    const rows = await query<RawAgentRunTaskRow>(
      'SELECT * FROM agent_run_tasks WHERE chat_id = ? AND agent_run_id = ? ORDER BY order_index ASC, created_at ASC',
      [chatId, agentRunId]
    );
    return rows
      .map(normalizeRow)
      .filter((t): t is AgentRunTask => t !== null);
  }

  async create(input: CreateAgentRunTaskInput): Promise<AgentRunTask> {
    const id = crypto.randomUUID();
    const now = toMysqlDateTime();
    const orderRow = await queryOne<{ next_order: number | null }>(
      'SELECT MAX(order_index) + 1 AS next_order FROM agent_run_tasks WHERE chat_id = ? AND agent_run_id = ?',
      [input.chatId, input.agentRunId]
    );
    const orderIndex = orderRow?.next_order ?? 0;

    await execute(
      `INSERT INTO agent_run_tasks (id, chat_id, agent_run_id, subject, description, status, priority, order_index, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      [id, input.chatId, input.agentRunId, input.subject, input.description ?? null, input.priority ?? 'medium', orderIndex, now, now]
    );

    const created = await this.findById(id);
    if (!created) throw new Error('Failed to create agent run task');
    return created;
  }

  /**
   * Spec contract for the `todo` tool: replace the entire task list for a run
   * with the given items. Existing rows are deleted, then the new list is
   * inserted in order. Caller may supply ids to preserve identity (useful when
   * the LLM mutates an existing list); items without ids get fresh UUIDs.
   */
  async replaceAll(chatId: string, agentRunId: string, items: TodoListItem[]): Promise<AgentRunTask[]> {
    return await transaction(async (connection) => {
      await connection.execute(
        'DELETE FROM agent_run_tasks WHERE chat_id = ? AND agent_run_id = ?',
        [chatId, agentRunId]
      );
      const now = toMysqlDateTime();
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const id = item.id || crypto.randomUUID();
        await connection.execute(
          `INSERT INTO agent_run_tasks (id, chat_id, agent_run_id, subject, description, status, priority, order_index, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, chatId, agentRunId, item.content, null, item.status, item.priority, index, now, now]
        );
      }
      const [rows] = await connection.execute(
        'SELECT * FROM agent_run_tasks WHERE chat_id = ? AND agent_run_id = ? ORDER BY order_index ASC',
        [chatId, agentRunId]
      );
      return (rows as RawAgentRunTaskRow[])
        .map(normalizeRow)
        .filter((t): t is AgentRunTask => t !== null);
    });
  }

  async update(id: string, agentRunId: string, input: UpdateAgentRunTaskInput): Promise<AgentRunTask | null> {
    const fields: string[] = [];
    const values: any[] = [];

    if (input.subject !== undefined) {
      fields.push('subject = ?');
      values.push(input.subject);
    }
    if (input.description !== undefined) {
      fields.push('description = ?');
      values.push(input.description ?? null);
    }
    if (input.status !== undefined) {
      fields.push('status = ?');
      values.push(input.status);
    }
    if (input.priority !== undefined) {
      fields.push('priority = ?');
      values.push(input.priority);
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    fields.push('updated_at = ?');
    values.push(toMysqlDateTime());
    values.push(id);
    values.push(agentRunId);

    await execute(
      `UPDATE agent_run_tasks SET ${fields.join(', ')} WHERE id = ? AND agent_run_id = ?`,
      values
    );

    return this.findById(id);
  }

  async deleteByRun(chatId: string, agentRunId: string): Promise<number> {
    const result = await execute(
      'DELETE FROM agent_run_tasks WHERE chat_id = ? AND agent_run_id = ?',
      [chatId, agentRunId]
    );
    return result.affectedRows;
  }
}

export const agentRunTaskRepository = new AgentRunTaskRepository();

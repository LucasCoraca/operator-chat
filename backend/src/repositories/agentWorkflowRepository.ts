import { query, queryOne, execute } from '../db';

export interface AgentWorkflowStep {
  agentId: string;
  /** Snapshot of the agent's name at the time the workflow was saved (display fallback if the definition is later renamed/deleted). */
  agentName: string;
}

export interface AgentWorkflow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  steps: AgentWorkflowStep[];
  created_at: Date;
  updated_at: Date;
}

export interface CreateAgentWorkflowInput {
  userId: string;
  name: string;
  description?: string | null;
  steps: AgentWorkflowStep[];
}

export interface UpdateAgentWorkflowInput {
  name?: string;
  description?: string | null;
  steps?: AgentWorkflowStep[];
}

function parseSteps(raw: unknown): AgentWorkflowStep[] {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((step): step is { agentId: unknown; agentName?: unknown } => typeof step === 'object' && step !== null)
    .map((step) => ({
      agentId: typeof step.agentId === 'string' ? step.agentId : '',
      agentName: typeof step.agentName === 'string' ? step.agentName : '',
    }))
    .filter((step) => step.agentId.length > 0);
}

function hydrate(row: any): AgentWorkflow {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    description: row.description,
    steps: parseSteps(row.steps),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function makeId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow';
  return `${slug.slice(0, 40)}-${Date.now().toString(36)}`;
}

export class AgentWorkflowRepository {
  async findById(id: string): Promise<AgentWorkflow | null> {
    const row = await queryOne<any>('SELECT * FROM agent_workflows WHERE id = ?', [id]);
    return row ? hydrate(row) : null;
  }

  async findByUserId(userId: string): Promise<AgentWorkflow[]> {
    const rows = await query<any>(
      'SELECT * FROM agent_workflows WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    return rows.map(hydrate);
  }

  async create(input: CreateAgentWorkflowInput): Promise<AgentWorkflow> {
    const id = makeId(input.name);
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await execute(
      `INSERT INTO agent_workflows (id, user_id, name, description, steps, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, input.userId, input.name, input.description ?? null, JSON.stringify(input.steps), now, now]
    );
    const created = await this.findById(id);
    if (!created) throw new Error('Failed to create agent workflow');
    return created;
  }

  async update(id: string, userId: string, input: UpdateAgentWorkflowInput): Promise<AgentWorkflow | null> {
    const existing = await this.findById(id);
    if (!existing || existing.user_id !== userId) return null;

    const fields: string[] = [];
    const values: any[] = [];

    if (input.name !== undefined) {
      fields.push('name = ?');
      values.push(input.name);
    }
    if (input.description !== undefined) {
      fields.push('description = ?');
      values.push(input.description);
    }
    if (input.steps !== undefined) {
      fields.push('steps = ?');
      values.push(JSON.stringify(input.steps));
    }

    if (fields.length === 0) return existing;

    fields.push('updated_at = ?');
    values.push(new Date().toISOString().slice(0, 19).replace('T', ' '));
    values.push(id);

    await execute(`UPDATE agent_workflows SET ${fields.join(', ')} WHERE id = ?`, values);
    return this.findById(id);
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const existing = await this.findById(id);
    if (!existing || existing.user_id !== userId) return false;
    const result = await execute('DELETE FROM agent_workflows WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }
}

export const agentWorkflowRepository = new AgentWorkflowRepository();

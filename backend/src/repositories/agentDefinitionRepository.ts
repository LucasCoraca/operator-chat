import { query, queryOne, execute } from '../db';

export interface AgentDefinition {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  prompt: string;
  allowed_tools: string[] | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateAgentDefinitionInput {
  userId: string;
  name: string;
  description?: string | null;
  prompt: string;
  allowedTools?: string[] | null;
}

export interface UpdateAgentDefinitionInput {
  name?: string;
  description?: string | null;
  prompt?: string;
  allowedTools?: string[] | null;
}

function parseAllowedTools(raw: unknown): string[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw.filter((v) => typeof v === 'string');
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : null;
    } catch {
      return null;
    }
  }
  return null;
}

function hydrate(row: any): AgentDefinition {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    allowed_tools: parseAllowedTools(row.allowed_tools),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function makeId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
  return `${slug.slice(0, 40)}-${Date.now().toString(36)}`;
}

export class AgentDefinitionRepository {
  async findById(id: string): Promise<AgentDefinition | null> {
    const row = await queryOne<any>('SELECT * FROM agent_definitions WHERE id = ?', [id]);
    return row ? hydrate(row) : null;
  }

  async findByUserId(userId: string): Promise<AgentDefinition[]> {
    const rows = await query<any>(
      'SELECT * FROM agent_definitions WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    return rows.map(hydrate);
  }

  async findByIdsForUser(userId: string, ids: string[]): Promise<AgentDefinition[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = await query<any>(
      `SELECT * FROM agent_definitions WHERE user_id = ? AND id IN (${placeholders})`,
      [userId, ...ids]
    );
    return rows.map(hydrate);
  }

  async create(input: CreateAgentDefinitionInput): Promise<AgentDefinition> {
    const id = makeId(input.name);
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const allowed = input.allowedTools && input.allowedTools.length > 0 ? JSON.stringify(input.allowedTools) : null;
    await execute(
      `INSERT INTO agent_definitions (id, user_id, name, description, prompt, allowed_tools, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.userId, input.name, input.description ?? null, input.prompt, allowed, now, now]
    );
    const created = await this.findById(id);
    if (!created) throw new Error('Failed to create agent definition');
    return created;
  }

  async update(id: string, userId: string, input: UpdateAgentDefinitionInput): Promise<AgentDefinition | null> {
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
    if (input.prompt !== undefined) {
      fields.push('prompt = ?');
      values.push(input.prompt);
    }
    if (input.allowedTools !== undefined) {
      fields.push('allowed_tools = ?');
      values.push(input.allowedTools && input.allowedTools.length > 0 ? JSON.stringify(input.allowedTools) : null);
    }

    if (fields.length === 0) return existing;

    fields.push('updated_at = ?');
    values.push(new Date().toISOString().slice(0, 19).replace('T', ' '));
    values.push(id);

    await execute(`UPDATE agent_definitions SET ${fields.join(', ')} WHERE id = ?`, values);
    return this.findById(id);
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const existing = await this.findById(id);
    if (!existing || existing.user_id !== userId) return false;
    const result = await execute('DELETE FROM agent_definitions WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }
}

export const agentDefinitionRepository = new AgentDefinitionRepository();

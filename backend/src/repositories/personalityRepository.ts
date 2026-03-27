import { query, queryOne, execute } from '../db';
import crypto from 'crypto';

export interface Personality {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  tone: string | null;
  system_prompt: string;
  is_custom: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreatePersonalityInput {
  userId: string;
  name: string;
  description?: string;
  tone?: string;
  systemPrompt: string;
}

export interface UpdatePersonalityInput {
  name?: string;
  description?: string;
  tone?: string;
  systemPrompt?: string;
}

export class PersonalityRepository {
  async findById(id: string): Promise<Personality | null> {
    return queryOne<Personality>('SELECT * FROM personalities WHERE id = ?', [id]);
  }

  async findByUserId(userId: string): Promise<Personality[]> {
    return query<Personality>(
      'SELECT * FROM personalities WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
  }

  async findCustomByUserId(userId: string): Promise<Personality[]> {
    return query<Personality>(
      'SELECT * FROM personalities WHERE user_id = ? AND is_custom = true ORDER BY created_at DESC',
      [userId]
    );
  }

  async create(input: CreatePersonalityInput): Promise<Personality> {
    // Generate unique ID from name
    const baseId = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom';
    const id = `${baseId}-${Date.now()}`;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    
    await execute(
      `INSERT INTO personalities (id, user_id, name, description, tone, system_prompt, is_custom, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, true, ?, ?)`,
      [
        id,
        input.userId,
        input.name,
        input.description || null,
        input.tone || null,
        input.systemPrompt,
        now,
        now
      ]
    );

    const personality = await this.findById(id);
    if (!personality) throw new Error('Failed to create personality');
    return personality;
  }

  async update(id: string, userId: string, input: UpdatePersonalityInput): Promise<Personality | null> {
    // Verify ownership
    const existing = await this.findById(id);
    if (!existing || existing.user_id !== userId) {
      return null;
    }

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
    if (input.tone !== undefined) {
      fields.push('tone = ?');
      values.push(input.tone);
    }
    if (input.systemPrompt !== undefined) {
      fields.push('system_prompt = ?');
      values.push(input.systemPrompt);
    }

    if (fields.length === 0) return existing;

    fields.push('updated_at = ?');
    values.push(new Date().toISOString().slice(0, 19).replace('T', ' '));
    values.push(id);

    await execute(
      `UPDATE personalities SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    return this.findById(id);
  }

  async delete(id: string, userId: string): Promise<boolean> {
    // Verify ownership
    const existing = await this.findById(id);
    if (!existing || existing.user_id !== userId) {
      return false;
    }

    const result = await execute('DELETE FROM personalities WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  async deleteByUserId(userId: string): Promise<number> {
    const result = await execute('DELETE FROM personalities WHERE user_id = ?', [userId]);
    return result.affectedRows;
  }

  async existsByName(userId: string, name: string): Promise<boolean> {
    const result = await queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM personalities WHERE user_id = ? AND name = ?',
      [userId, name]
    );
    return (result?.count || 0) > 0;
  }
}

export const personalityRepository = new PersonalityRepository();
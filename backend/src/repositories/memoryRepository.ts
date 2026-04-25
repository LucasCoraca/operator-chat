import { query, queryOne, execute } from '../db';
import crypto from 'crypto';

function toMysqlDateTime(date: Date = new Date()): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export interface Memory {
  id: string;
  user_id: string;
  content: string;
  tags: string[] | null;
  created_at: Date;
  updated_at: Date;
}

interface RawMemoryRow {
  id: string;
  user_id: string;
  content: string;
  tags: unknown;
  created_at: Date;
  updated_at: Date;
}

export interface CreateMemoryInput {
  userId: string;
  content: string;
  tags?: string[];
}

export interface UpdateMemoryInput {
  content?: string;
  tags?: string[];
}

function normalizeTags(value: unknown): string[] | null {
  if (value == null) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.filter((tag): tag is string => typeof tag === 'string');
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((tag): tag is string => typeof tag === 'string');
      }
    } catch {
      return [trimmed];
    }
  }

  return null;
}

function normalizeMemoryRow(row: RawMemoryRow | null): Memory | null {
  if (!row) {
    return null;
  }

  return {
    ...row,
    tags: normalizeTags(row.tags),
  };
}

export class MemoryRepository {
  async findById(id: string): Promise<Memory | null> {
    const row = await queryOne<RawMemoryRow>('SELECT * FROM memories WHERE id = ?', [id]);
    return normalizeMemoryRow(row);
  }

  async findByUserId(userId: string): Promise<Memory[]> {
    const rows = await query<RawMemoryRow>(
      'SELECT * FROM memories WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    return rows
      .map((row) => normalizeMemoryRow(row))
      .filter((memory): memory is Memory => memory !== null);
  }

  async create(input: CreateMemoryInput): Promise<Memory> {
    const id = crypto.randomUUID();
    const now = toMysqlDateTime();
    
    await execute(
      `INSERT INTO memories (id, user_id, content, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.userId,
        input.content,
        input.tags ? JSON.stringify(input.tags) : null,
        now,
        now
      ]
    );

    const memory = await this.findById(id);
    if (!memory) throw new Error('Failed to create memory');
    return memory;
  }

  async update(id: string, userId: string, input: UpdateMemoryInput): Promise<Memory | null> {
    const fields: string[] = [];
    const values: any[] = [];

    if (input.content !== undefined) {
      fields.push('content = ?');
      values.push(input.content);
    }
    if (input.tags !== undefined) {
      fields.push('tags = ?');
      values.push(input.tags ? JSON.stringify(input.tags) : null);
    }

    if (fields.length === 0) return this.findById(id);

    fields.push('updated_at = ?');
    values.push(toMysqlDateTime());
    values.push(id);
    values.push(userId);

    await execute(
      `UPDATE memories SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`,
      values
    );

    return this.findById(id);
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const result = await execute(
      'DELETE FROM memories WHERE id = ? AND user_id = ?',
      [id, userId]
    );
    return result.affectedRows > 0;
  }

  async deleteByUserId(userId: string): Promise<number> {
    const result = await execute('DELETE FROM memories WHERE user_id = ?', [userId]);
    return result.affectedRows;
  }

  async search(userId: string, searchTerm: string): Promise<Memory[]> {
    const searchPattern = `%${searchTerm}%`;
    const rows = await query<RawMemoryRow>(
      `SELECT * FROM memories 
       WHERE user_id = ? AND (content LIKE ? OR JSON_CONTAINS(tags, ?))
       ORDER BY created_at DESC`,
      [userId, searchPattern, JSON.stringify(searchTerm)]
    );
    return rows
      .map((row) => normalizeMemoryRow(row))
      .filter((memory): memory is Memory => memory !== null);
  }

  async findByTag(userId: string, tag: string): Promise<Memory[]> {
    const rows = await query<RawMemoryRow>(
      `SELECT * FROM memories 
       WHERE user_id = ? AND JSON_CONTAINS(tags, ?)
       ORDER BY created_at DESC`,
      [userId, JSON.stringify(tag)]
    );
    return rows
      .map((row) => normalizeMemoryRow(row))
      .filter((memory): memory is Memory => memory !== null);
  }

  async countByUserId(userId: string): Promise<number> {
    const result = await queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM memories WHERE user_id = ?',
      [userId]
    );
    return result?.count || 0;
  }
}

export const memoryRepository = new MemoryRepository();

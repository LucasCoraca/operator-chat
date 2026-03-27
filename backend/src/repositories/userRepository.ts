import { query, queryOne, execute } from '../db';
import crypto from 'crypto';

export interface User {
  id: string;
  username: string;
  password_hash: string;
  created_at: Date;
}

export interface CreateUserInput {
  username: string;
  passwordHash: string;
}

export class UserRepository {
  async findById(id: string): Promise<User | null> {
    return queryOne<User>('SELECT * FROM users WHERE id = ?', [id]);
  }

  async findByUsername(username: string): Promise<User | null> {
    return queryOne<User>('SELECT * FROM users WHERE username = ?', [username]);
  }

  async findAll(): Promise<User[]> {
    return query<User>('SELECT * FROM users ORDER BY created_at DESC');
  }

  async create(input: CreateUserInput): Promise<User> {
    const id = crypto.randomUUID();
    await execute(
      'INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)',
      [id, input.username, input.passwordHash]
    );
    const user = await this.findById(id);
    if (!user) throw new Error('Failed to create user');
    return user;
  }

  async delete(id: string): Promise<boolean> {
    const result = await execute('DELETE FROM users WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  async exists(username: string): Promise<boolean> {
    const user = await this.findByUsername(username);
    return user !== null;
  }
}

export const userRepository = new UserRepository();
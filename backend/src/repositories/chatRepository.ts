import { query, queryOne, execute, transaction } from '../db';
import crypto from 'crypto';
import { PoolConnection } from 'mysql2/promise';

function toMysqlDateTime(date: Date = new Date()): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export interface Chat {
  id: string;
  user_id: string;
  sandbox_id: string;
  name: string;
  agent_state: any;
  tool_preferences: any;
  approval_mode: any;
  created_at: Date;
  updated_at: Date;
}

export interface ChatMessage {
  id: string;
  chat_id: string;
  role: 'user' | 'assistant';
  content: string;
  model: string | null;
  agent_steps: any;
  message_index: number;
  created_at: Date;
}

export interface CreateChatInput {
  id?: string;
  userId: string;
  sandboxId: string;
  name?: string;
  toolPreferences?: any;
  approvalMode?: any;
}

export interface CreateMessageInput {
  id?: string;
  chatId: string;
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  agentSteps?: any;
  messageIndex: number;
}

export interface ChatSummary {
  id: string;
  sandbox_id: string;
  message_count: number;
  name: string;
  created_at: Date;
  updated_at: Date;
}

export class ChatRepository {
  async findAll(): Promise<Chat[]> {
    return query<Chat>('SELECT * FROM chats ORDER BY updated_at DESC');
  }

  async findById(id: string): Promise<Chat | null> {
    return queryOne<Chat>('SELECT * FROM chats WHERE id = ?', [id]);
  }

  async findByUserId(userId: string): Promise<ChatSummary[]> {
    return query<ChatSummary>(
      `SELECT c.id, c.sandbox_id, c.name, c.created_at, c.updated_at,
              COUNT(cm.id) as message_count
       FROM chats c
       LEFT JOIN chat_messages cm ON c.id = cm.chat_id
       WHERE c.user_id = ?
       GROUP BY c.id
       ORDER BY c.updated_at DESC`,
      [userId]
    );
  }

  async create(input: CreateChatInput): Promise<Chat> {
    const id = input.id || crypto.randomUUID();
    const now = toMysqlDateTime();
    
    await execute(
      `INSERT INTO chats (id, user_id, sandbox_id, name, tool_preferences, approval_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.userId,
        input.sandboxId,
        input.name || 'New Conversation',
        JSON.stringify(input.toolPreferences || {}),
        JSON.stringify(input.approvalMode || { alwaysApprove: false }),
        now,
        now
      ]
    );

    const chat = await this.findById(id);
    if (!chat) throw new Error('Failed to create chat');
    return chat;
  }

  async update(id: string, updates: Partial<Chat>): Promise<Chat | null> {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.agent_state !== undefined) {
      fields.push('agent_state = ?');
      values.push(JSON.stringify(updates.agent_state));
    }
    if (updates.tool_preferences !== undefined) {
      fields.push('tool_preferences = ?');
      values.push(JSON.stringify(updates.tool_preferences));
    }
    if (updates.approval_mode !== undefined) {
      fields.push('approval_mode = ?');
      values.push(JSON.stringify(updates.approval_mode));
    }

    if (fields.length === 0) return this.findById(id);

    fields.push('updated_at = ?');
    values.push(toMysqlDateTime());
    values.push(id);

    await execute(
      `UPDATE chats SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const result = await execute('DELETE FROM chats WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  async deleteByUserId(userId: string): Promise<number> {
    const result = await execute('DELETE FROM chats WHERE user_id = ?', [userId]);
    return result.affectedRows;
  }

  // Message operations
  async findMessagesByChatId(chatId: string): Promise<ChatMessage[]> {
    return query<ChatMessage>(
      'SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY message_index ASC',
      [chatId]
    );
  }

  async addMessage(input: CreateMessageInput): Promise<ChatMessage> {
    const id = input.id || crypto.randomUUID();
    await execute(
      `INSERT INTO chat_messages (id, chat_id, role, content, model, agent_steps, message_index)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.chatId,
        input.role,
        input.content,
        input.model || null,
        input.agentSteps ? JSON.stringify(input.agentSteps) : null,
        input.messageIndex
      ]
    );

    // Update chat's updated_at
    await execute(
      'UPDATE chats SET updated_at = ? WHERE id = ?',
      [toMysqlDateTime(), input.chatId]
    );

    const message = await queryOne<ChatMessage>('SELECT * FROM chat_messages WHERE id = ?', [id]);
    if (!message) throw new Error('Failed to create message');
    return message;
  }

  async updateMessage(id: string, updates: Partial<ChatMessage>): Promise<ChatMessage | null> {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.content !== undefined) {
      fields.push('content = ?');
      values.push(updates.content);
    }
    if (updates.agent_steps !== undefined) {
      fields.push('agent_steps = ?');
      values.push(JSON.stringify(updates.agent_steps));
    }

    if (fields.length === 0) {
      return queryOne<ChatMessage>('SELECT * FROM chat_messages WHERE id = ?', [id]);
    }

    values.push(id);
    await execute(
      `UPDATE chat_messages SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    return queryOne<ChatMessage>('SELECT * FROM chat_messages WHERE id = ?', [id]);
  }

  async deleteMessagesFromIndex(chatId: string, fromIndex: number): Promise<number> {
    const result = await execute(
      'DELETE FROM chat_messages WHERE chat_id = ? AND message_index >= ?',
      [chatId, fromIndex]
    );
    return result.affectedRows;
  }

  async searchByContent(userId: string, searchTerm: string, limit: number = 50): Promise<any[]> {
    const results = await query<any>(
      `SELECT c.id as chat_id, c.sandbox_id, c.name, c.updated_at,
              cm.id as message_id, cm.role, cm.content, cm.message_index
       FROM chats c
       JOIN chat_messages cm ON c.id = cm.chat_id
       WHERE c.user_id = ? AND (cm.content LIKE ? OR c.name LIKE ?)
       ORDER BY c.updated_at DESC, cm.message_index ASC
       LIMIT ?`,
      [userId, `%${searchTerm}%`, `%${searchTerm}%`, limit]
    );

    // Group by chat
    const chatMap = new Map<string, any>();
    for (const row of results) {
      if (!chatMap.has(row.chat_id)) {
        chatMap.set(row.chat_id, {
          chatId: row.chat_id,
          sandboxId: row.sandbox_id,
          name: row.name,
          updatedAt: row.updated_at,
          matchCount: 0,
          matchingMessages: []
        });
      }
      const chat = chatMap.get(row.chat_id);
      chat.matchCount++;
      chat.matchingMessages.push({
        id: row.message_id,
        role: row.role,
        content: row.content,
        messageIndex: row.message_index
      });
    }

    return Array.from(chatMap.values());
  }

  async getWithMessages(chatId: string): Promise<{ chat: Chat; messages: ChatMessage[] } | null> {
    const chat = await this.findById(chatId);
    if (!chat) return null;

    const messages = await this.findMessagesByChatId(chatId);
    return { chat, messages };
  }
}

export const chatRepository = new ChatRepository();

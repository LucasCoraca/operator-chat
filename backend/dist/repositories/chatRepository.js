"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.chatRepository = exports.ChatRepository = void 0;
const db_1 = require("../db");
const crypto_1 = __importDefault(require("crypto"));
function toMysqlDateTime(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}
class ChatRepository {
    async findAll() {
        return (0, db_1.query)('SELECT * FROM chats ORDER BY updated_at DESC');
    }
    async findById(id) {
        return (0, db_1.queryOne)('SELECT * FROM chats WHERE id = ?', [id]);
    }
    async findByUserId(userId) {
        return (0, db_1.query)(`SELECT c.id, c.sandbox_id, c.name, c.created_at, c.updated_at,
              COUNT(cm.id) as message_count
       FROM chats c
       LEFT JOIN chat_messages cm ON c.id = cm.chat_id
       WHERE c.user_id = ?
       GROUP BY c.id
       ORDER BY c.updated_at DESC`, [userId]);
    }
    async create(input) {
        const id = input.id || crypto_1.default.randomUUID();
        const now = toMysqlDateTime();
        await (0, db_1.execute)(`INSERT INTO chats (id, user_id, sandbox_id, name, tool_preferences, approval_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
            id,
            input.userId,
            input.sandboxId,
            input.name || 'New Conversation',
            JSON.stringify(input.toolPreferences || {}),
            JSON.stringify(input.approvalMode || { alwaysApprove: false }),
            now,
            now
        ]);
        const chat = await this.findById(id);
        if (!chat)
            throw new Error('Failed to create chat');
        return chat;
    }
    async update(id, updates) {
        const fields = [];
        const values = [];
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
        if (fields.length === 0)
            return this.findById(id);
        fields.push('updated_at = ?');
        values.push(toMysqlDateTime());
        values.push(id);
        await (0, db_1.execute)(`UPDATE chats SET ${fields.join(', ')} WHERE id = ?`, values);
        return this.findById(id);
    }
    async delete(id) {
        const result = await (0, db_1.execute)('DELETE FROM chats WHERE id = ?', [id]);
        return result.affectedRows > 0;
    }
    async deleteByUserId(userId) {
        const result = await (0, db_1.execute)('DELETE FROM chats WHERE user_id = ?', [userId]);
        return result.affectedRows;
    }
    // Message operations
    async findMessagesByChatId(chatId) {
        return (0, db_1.query)('SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY message_index ASC', [chatId]);
    }
    async addMessage(input) {
        const id = input.id || crypto_1.default.randomUUID();
        await (0, db_1.execute)(`INSERT INTO chat_messages (id, chat_id, role, content, model, agent_steps, message_index)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, [
            id,
            input.chatId,
            input.role,
            input.content,
            input.model || null,
            input.agentSteps ? JSON.stringify(input.agentSteps) : null,
            input.messageIndex
        ]);
        // Update chat's updated_at
        await (0, db_1.execute)('UPDATE chats SET updated_at = ? WHERE id = ?', [toMysqlDateTime(), input.chatId]);
        const message = await (0, db_1.queryOne)('SELECT * FROM chat_messages WHERE id = ?', [id]);
        if (!message)
            throw new Error('Failed to create message');
        return message;
    }
    async updateMessage(id, updates) {
        const fields = [];
        const values = [];
        if (updates.content !== undefined) {
            fields.push('content = ?');
            values.push(updates.content);
        }
        if (updates.agent_steps !== undefined) {
            fields.push('agent_steps = ?');
            values.push(JSON.stringify(updates.agent_steps));
        }
        if (fields.length === 0) {
            return (0, db_1.queryOne)('SELECT * FROM chat_messages WHERE id = ?', [id]);
        }
        values.push(id);
        await (0, db_1.execute)(`UPDATE chat_messages SET ${fields.join(', ')} WHERE id = ?`, values);
        return (0, db_1.queryOne)('SELECT * FROM chat_messages WHERE id = ?', [id]);
    }
    async deleteMessagesFromIndex(chatId, fromIndex) {
        const result = await (0, db_1.execute)('DELETE FROM chat_messages WHERE chat_id = ? AND message_index >= ?', [chatId, fromIndex]);
        return result.affectedRows;
    }
    async searchByContent(userId, searchTerm, limit = 50) {
        const results = await (0, db_1.query)(`SELECT c.id as chat_id, c.sandbox_id, c.name, c.updated_at,
              cm.id as message_id, cm.role, cm.content, cm.message_index
       FROM chats c
       JOIN chat_messages cm ON c.id = cm.chat_id
       WHERE c.user_id = ? AND (cm.content LIKE ? OR c.name LIKE ?)
       ORDER BY c.updated_at DESC, cm.message_index ASC
       LIMIT ?`, [userId, `%${searchTerm}%`, `%${searchTerm}%`, limit]);
        // Group by chat
        const chatMap = new Map();
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
    async getWithMessages(chatId) {
        const chat = await this.findById(chatId);
        if (!chat)
            return null;
        const messages = await this.findMessagesByChatId(chatId);
        return { chat, messages };
    }
}
exports.ChatRepository = ChatRepository;
exports.chatRepository = new ChatRepository();
//# sourceMappingURL=chatRepository.js.map
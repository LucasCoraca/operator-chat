"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.memoryRepository = exports.MemoryRepository = void 0;
const db_1 = require("../db");
const crypto_1 = __importDefault(require("crypto"));
function toMysqlDateTime(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}
class MemoryRepository {
    async findById(id) {
        return (0, db_1.queryOne)('SELECT * FROM memories WHERE id = ?', [id]);
    }
    async findByUserId(userId) {
        return (0, db_1.query)('SELECT * FROM memories WHERE user_id = ? ORDER BY created_at DESC', [userId]);
    }
    async create(input) {
        const id = crypto_1.default.randomUUID();
        const now = toMysqlDateTime();
        await (0, db_1.execute)(`INSERT INTO memories (id, user_id, content, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`, [
            id,
            input.userId,
            input.content,
            input.tags ? JSON.stringify(input.tags) : null,
            now,
            now
        ]);
        const memory = await this.findById(id);
        if (!memory)
            throw new Error('Failed to create memory');
        return memory;
    }
    async update(id, userId, input) {
        const fields = [];
        const values = [];
        if (input.content !== undefined) {
            fields.push('content = ?');
            values.push(input.content);
        }
        if (input.tags !== undefined) {
            fields.push('tags = ?');
            values.push(input.tags ? JSON.stringify(input.tags) : null);
        }
        if (fields.length === 0)
            return this.findById(id);
        fields.push('updated_at = ?');
        values.push(toMysqlDateTime());
        values.push(id);
        values.push(userId);
        await (0, db_1.execute)(`UPDATE memories SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`, values);
        return this.findById(id);
    }
    async delete(id, userId) {
        const result = await (0, db_1.execute)('DELETE FROM memories WHERE id = ? AND user_id = ?', [id, userId]);
        return result.affectedRows > 0;
    }
    async deleteByUserId(userId) {
        const result = await (0, db_1.execute)('DELETE FROM memories WHERE user_id = ?', [userId]);
        return result.affectedRows;
    }
    async search(userId, searchTerm) {
        const searchPattern = `%${searchTerm}%`;
        return (0, db_1.query)(`SELECT * FROM memories 
       WHERE user_id = ? AND (content LIKE ? OR JSON_CONTAINS(tags, ?))
       ORDER BY created_at DESC`, [userId, searchPattern, JSON.stringify(searchTerm)]);
    }
    async findByTag(userId, tag) {
        return (0, db_1.query)(`SELECT * FROM memories 
       WHERE user_id = ? AND JSON_CONTAINS(tags, ?)
       ORDER BY created_at DESC`, [userId, JSON.stringify(tag)]);
    }
    async countByUserId(userId) {
        const result = await (0, db_1.queryOne)('SELECT COUNT(*) as count FROM memories WHERE user_id = ?', [userId]);
        return result?.count || 0;
    }
}
exports.MemoryRepository = MemoryRepository;
exports.memoryRepository = new MemoryRepository();
//# sourceMappingURL=memoryRepository.js.map
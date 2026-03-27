"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.personalityRepository = exports.PersonalityRepository = void 0;
const db_1 = require("../db");
class PersonalityRepository {
    async findById(id) {
        return (0, db_1.queryOne)('SELECT * FROM personalities WHERE id = ?', [id]);
    }
    async findByUserId(userId) {
        return (0, db_1.query)('SELECT * FROM personalities WHERE user_id = ? ORDER BY created_at DESC', [userId]);
    }
    async findCustomByUserId(userId) {
        return (0, db_1.query)('SELECT * FROM personalities WHERE user_id = ? AND is_custom = true ORDER BY created_at DESC', [userId]);
    }
    async create(input) {
        // Generate unique ID from name
        const baseId = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom';
        const id = `${baseId}-${Date.now()}`;
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        await (0, db_1.execute)(`INSERT INTO personalities (id, user_id, name, description, tone, system_prompt, is_custom, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, true, ?, ?)`, [
            id,
            input.userId,
            input.name,
            input.description || null,
            input.tone || null,
            input.systemPrompt,
            now,
            now
        ]);
        const personality = await this.findById(id);
        if (!personality)
            throw new Error('Failed to create personality');
        return personality;
    }
    async update(id, userId, input) {
        // Verify ownership
        const existing = await this.findById(id);
        if (!existing || existing.user_id !== userId) {
            return null;
        }
        const fields = [];
        const values = [];
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
        if (fields.length === 0)
            return existing;
        fields.push('updated_at = ?');
        values.push(new Date().toISOString().slice(0, 19).replace('T', ' '));
        values.push(id);
        await (0, db_1.execute)(`UPDATE personalities SET ${fields.join(', ')} WHERE id = ?`, values);
        return this.findById(id);
    }
    async delete(id, userId) {
        // Verify ownership
        const existing = await this.findById(id);
        if (!existing || existing.user_id !== userId) {
            return false;
        }
        const result = await (0, db_1.execute)('DELETE FROM personalities WHERE id = ?', [id]);
        return result.affectedRows > 0;
    }
    async deleteByUserId(userId) {
        const result = await (0, db_1.execute)('DELETE FROM personalities WHERE user_id = ?', [userId]);
        return result.affectedRows;
    }
    async existsByName(userId, name) {
        const result = await (0, db_1.queryOne)('SELECT COUNT(*) as count FROM personalities WHERE user_id = ? AND name = ?', [userId, name]);
        return (result?.count || 0) > 0;
    }
}
exports.PersonalityRepository = PersonalityRepository;
exports.personalityRepository = new PersonalityRepository();
//# sourceMappingURL=personalityRepository.js.map
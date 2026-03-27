"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.userRepository = exports.UserRepository = void 0;
const db_1 = require("../db");
const crypto_1 = __importDefault(require("crypto"));
class UserRepository {
    async findById(id) {
        return (0, db_1.queryOne)('SELECT * FROM users WHERE id = ?', [id]);
    }
    async findByUsername(username) {
        return (0, db_1.queryOne)('SELECT * FROM users WHERE username = ?', [username]);
    }
    async findAll() {
        return (0, db_1.query)('SELECT * FROM users ORDER BY created_at DESC');
    }
    async create(input) {
        const id = crypto_1.default.randomUUID();
        await (0, db_1.execute)('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)', [id, input.username, input.passwordHash]);
        const user = await this.findById(id);
        if (!user)
            throw new Error('Failed to create user');
        return user;
    }
    async delete(id) {
        const result = await (0, db_1.execute)('DELETE FROM users WHERE id = ?', [id]);
        return result.affectedRows > 0;
    }
    async exists(username) {
        const user = await this.findByUsername(username);
        return user !== null;
    }
}
exports.UserRepository = UserRepository;
exports.userRepository = new UserRepository();
//# sourceMappingURL=userRepository.js.map
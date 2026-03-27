"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryManager = void 0;
const repositories_1 = require("../repositories");
class MemoryManager {
    constructor(_filePath) {
        // filePath is no longer needed as we use the database
        // Keeping parameter for backward compatibility
    }
    async getMemories(userId) {
        return repositories_1.memoryRepository.findByUserId(userId);
    }
    async addMemory(userId, content, tags) {
        const input = {
            userId,
            content,
            tags,
        };
        return repositories_1.memoryRepository.create(input);
    }
    async updateMemory(id, userId, content, tags) {
        const input = {
            content,
            tags,
        };
        return repositories_1.memoryRepository.update(id, userId, input);
    }
    async deleteMemory(id, userId) {
        return repositories_1.memoryRepository.delete(id, userId);
    }
    async searchMemories(userId, query) {
        return repositories_1.memoryRepository.search(userId, query);
    }
}
exports.MemoryManager = MemoryManager;
//# sourceMappingURL=memoryManager.js.map
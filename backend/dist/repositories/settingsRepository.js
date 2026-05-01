"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.settingsRepository = exports.SettingsRepository = void 0;
const db_1 = require("../db");
class SettingsRepository {
    normalizeUserId(userId) {
        return userId || '__global__';
    }
    async get(key, userId) {
        const setting = await (0, db_1.queryOne)('SELECT * FROM settings WHERE user_id = ? AND `key` = ?', [this.normalizeUserId(userId), key]);
        if (!setting)
            return null;
        try {
            return typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
        }
        catch {
            return setting.value;
        }
    }
    async set(key, value, userId) {
        const jsonValue = JSON.stringify(value);
        await (0, db_1.execute)(`INSERT INTO settings (user_id, \`key\`, value) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE value = ?, updated_at = CURRENT_TIMESTAMP`, [this.normalizeUserId(userId), key, jsonValue, jsonValue]);
    }
    async delete(key, userId) {
        const result = await (0, db_1.execute)('DELETE FROM settings WHERE user_id = ? AND `key` = ?', [this.normalizeUserId(userId), key]);
        return result.affectedRows > 0;
    }
    async getAll(userId) {
        const settings = await (0, db_1.query)('SELECT * FROM settings WHERE user_id = ?', [this.normalizeUserId(userId)]);
        const result = {};
        for (const setting of settings) {
            try {
                result[setting.key] = typeof setting.value === 'string'
                    ? JSON.parse(setting.value)
                    : setting.value;
            }
            catch {
                result[setting.key] = setting.value;
            }
        }
        return result;
    }
    async exists(key, userId) {
        const setting = await (0, db_1.queryOne)('SELECT COUNT(*) as count FROM settings WHERE user_id = ? AND `key` = ?', [this.normalizeUserId(userId), key]);
        return (setting?.count || 0) > 0;
    }
    // Convenience methods for common settings
    async getLlamaConfig() {
        return this.get('llama') || {
            baseUrl: 'http://localhost:8080',
            model: 'llama',
            temperature: 0.7,
            maxTokens: 2048,
            topP: 0.9,
        };
    }
    async setLlamaConfig(config) {
        await this.set('llama', config);
    }
    async getSearxngConfig() {
        return this.get('searxng') || {
            baseUrl: 'http://localhost:8080',
            safeSearch: 1,
        };
    }
    async setSearxngConfig(config) {
        await this.set('searxng', config);
    }
    async getUiSettings(userId) {
        return this.get('ui', userId) || {
            showStats: false,
            selectedPersonality: 'professional',
            defaultToolPreferences: {},
        };
    }
    async setUiSettings(settings, userId) {
        await this.set('ui', settings, userId);
    }
    async getMcpServers(userId) {
        const servers = await this.get('mcpServers', userId);
        return servers || {};
    }
    async setMcpServers(servers, userId) {
        await this.set('mcpServers', servers, userId);
    }
    async getRemoteWorkspace(userId) {
        return this.get('remoteWorkspace', userId) || {
            enabled: false,
            host: '',
            port: 22,
            username: '',
            root: '',
            privateKey: '',
            strictHostKeyChecking: true,
            approvalPolicy: 'ask',
            toolApprovals: {},
            agentModel: undefined,
            contextWindowTokens: 128000,
            reservedOutputTokens: 30000,
            autoCompactThreshold: 0.82,
        };
    }
    async setRemoteWorkspace(config, userId) {
        await this.set('remoteWorkspace', config, userId);
    }
}
exports.SettingsRepository = SettingsRepository;
exports.settingsRepository = new SettingsRepository();
//# sourceMappingURL=settingsRepository.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.settingsRepository = exports.SettingsRepository = void 0;
const db_1 = require("../db");
class SettingsRepository {
    async get(key) {
        const setting = await (0, db_1.queryOne)('SELECT * FROM settings WHERE `key` = ?', [key]);
        if (!setting)
            return null;
        try {
            return typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
        }
        catch {
            return setting.value;
        }
    }
    async set(key, value) {
        const jsonValue = JSON.stringify(value);
        await (0, db_1.execute)(`INSERT INTO settings (\`key\`, value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE value = ?, updated_at = CURRENT_TIMESTAMP`, [key, jsonValue, jsonValue]);
    }
    async delete(key) {
        const result = await (0, db_1.execute)('DELETE FROM settings WHERE `key` = ?', [key]);
        return result.affectedRows > 0;
    }
    async getAll() {
        const settings = await (0, db_1.query)('SELECT * FROM settings');
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
    async exists(key) {
        const setting = await (0, db_1.queryOne)('SELECT COUNT(*) as count FROM settings WHERE `key` = ?', [key]);
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
    async getUiSettings() {
        return this.get('ui') || {
            showStats: false,
            selectedPersonality: 'professional',
            defaultToolPreferences: {},
        };
    }
    async setUiSettings(settings) {
        await this.set('ui', settings);
    }
    async getMcpServers() {
        const servers = await this.get('mcpServers');
        return servers || {};
    }
    async setMcpServers(servers) {
        await this.set('mcpServers', servers);
    }
    async getRemoteWorkspace() {
        return this.get('remoteWorkspace') || {
            enabled: false,
            host: '',
            port: 22,
            username: '',
            root: '',
            privateKey: '',
            strictHostKeyChecking: true,
            approvalPolicy: 'ask',
            toolApprovals: {},
        };
    }
    async setRemoteWorkspace(config) {
        await this.set('remoteWorkspace', config);
    }
}
exports.SettingsRepository = SettingsRepository;
exports.settingsRepository = new SettingsRepository();
//# sourceMappingURL=settingsRepository.js.map
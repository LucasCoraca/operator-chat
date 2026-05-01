import { query, queryOne, execute } from '../db';

export interface Setting {
  user_id: string;
  key: string;
  value: any;
  updated_at: Date;
}

export class SettingsRepository {
  private normalizeUserId(userId?: string): string {
    return userId || '__global__';
  }

  async get<T>(key: string, userId?: string): Promise<T | null> {
    const setting = await queryOne<Setting>(
      'SELECT * FROM settings WHERE user_id = ? AND `key` = ?',
      [this.normalizeUserId(userId), key]
    );
    if (!setting) return null;
    
    try {
      return typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
    } catch {
      return setting.value as T;
    }
  }

  async set(key: string, value: any, userId?: string): Promise<void> {
    const jsonValue = JSON.stringify(value);
    await execute(
      `INSERT INTO settings (user_id, \`key\`, value) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE value = ?, updated_at = CURRENT_TIMESTAMP`,
      [this.normalizeUserId(userId), key, jsonValue, jsonValue]
    );
  }

  async delete(key: string, userId?: string): Promise<boolean> {
    const result = await execute('DELETE FROM settings WHERE user_id = ? AND `key` = ?', [this.normalizeUserId(userId), key]);
    return result.affectedRows > 0;
  }

  async getAll(userId?: string): Promise<Record<string, any>> {
    const settings = await query<Setting>('SELECT * FROM settings WHERE user_id = ?', [this.normalizeUserId(userId)]);
    const result: Record<string, any> = {};
    
    for (const setting of settings) {
      try {
        result[setting.key] = typeof setting.value === 'string' 
          ? JSON.parse(setting.value) 
          : setting.value;
      } catch {
        result[setting.key] = setting.value;
      }
    }
    
    return result;
  }

  async exists(key: string, userId?: string): Promise<boolean> {
    const setting = await queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM settings WHERE user_id = ? AND `key` = ?',
      [this.normalizeUserId(userId), key]
    );
    return (setting?.count || 0) > 0;
  }

  // Convenience methods for common settings
  async getLlamaConfig(): Promise<any> {
    return this.get('llama') || {
      baseUrl: 'http://localhost:8080',
      model: 'llama',
      temperature: 0.7,
      maxTokens: 2048,
      topP: 0.9,
    };
  }

  async setLlamaConfig(config: any): Promise<void> {
    await this.set('llama', config);
  }

  async getSearxngConfig(): Promise<any> {
    return this.get('searxng') || {
      baseUrl: 'http://localhost:8080',
      safeSearch: 1,
    };
  }

  async setSearxngConfig(config: any): Promise<void> {
    await this.set('searxng', config);
  }

  async getUiSettings(userId?: string): Promise<any> {
    return this.get('ui', userId) || {
      showStats: false,
      selectedPersonality: 'professional',
      defaultToolPreferences: {},
    };
  }

  async setUiSettings(settings: any, userId?: string): Promise<void> {
    await this.set('ui', settings, userId);
  }

  async getMcpServers(userId?: string): Promise<Record<string, any>> {
    const servers = await this.get<Record<string, any>>('mcpServers', userId);
    return servers || {};
  }

  async setMcpServers(servers: Record<string, any>, userId?: string): Promise<void> {
    await this.set('mcpServers', servers, userId);
  }

  async getRemoteWorkspace(userId?: string): Promise<any> {
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

  async setRemoteWorkspace(config: any, userId?: string): Promise<void> {
    await this.set('remoteWorkspace', config, userId);
  }
}

export const settingsRepository = new SettingsRepository();

import { query, queryOne, execute } from '../db';

export interface Setting {
  key: string;
  value: any;
  updated_at: Date;
}

export class SettingsRepository {
  async get<T>(key: string): Promise<T | null> {
    const setting = await queryOne<Setting>('SELECT * FROM settings WHERE `key` = ?', [key]);
    if (!setting) return null;
    
    try {
      return typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
    } catch {
      return setting.value as T;
    }
  }

  async set(key: string, value: any): Promise<void> {
    const jsonValue = JSON.stringify(value);
    await execute(
      `INSERT INTO settings (\`key\`, value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE value = ?, updated_at = CURRENT_TIMESTAMP`,
      [key, jsonValue, jsonValue]
    );
  }

  async delete(key: string): Promise<boolean> {
    const result = await execute('DELETE FROM settings WHERE `key` = ?', [key]);
    return result.affectedRows > 0;
  }

  async getAll(): Promise<Record<string, any>> {
    const settings = await query<Setting>('SELECT * FROM settings');
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

  async exists(key: string): Promise<boolean> {
    const setting = await queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM settings WHERE `key` = ?',
      [key]
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

  async getUiSettings(): Promise<any> {
    return this.get('ui') || {
      showStats: false,
      selectedPersonality: 'professional',
      defaultToolPreferences: {},
    };
  }

  async setUiSettings(settings: any): Promise<void> {
    await this.set('ui', settings);
  }

  async getMcpServers(): Promise<Record<string, any>> {
    const servers = await this.get<Record<string, any>>('mcpServers');
    return servers || {};
  }

  async setMcpServers(servers: Record<string, any>): Promise<void> {
    await this.set('mcpServers', servers);
  }
}

export const settingsRepository = new SettingsRepository();

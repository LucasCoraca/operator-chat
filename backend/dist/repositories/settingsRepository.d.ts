export interface Setting {
    user_id: string;
    key: string;
    value: any;
    updated_at: Date;
}
export declare class SettingsRepository {
    private normalizeUserId;
    get<T>(key: string, userId?: string): Promise<T | null>;
    set(key: string, value: any, userId?: string): Promise<void>;
    delete(key: string, userId?: string): Promise<boolean>;
    getAll(userId?: string): Promise<Record<string, any>>;
    exists(key: string, userId?: string): Promise<boolean>;
    getLlamaConfig(): Promise<any>;
    setLlamaConfig(config: any): Promise<void>;
    getSearxngConfig(): Promise<any>;
    setSearxngConfig(config: any): Promise<void>;
    getUiSettings(userId?: string): Promise<any>;
    setUiSettings(settings: any, userId?: string): Promise<void>;
    getMcpServers(userId?: string): Promise<Record<string, any>>;
    setMcpServers(servers: Record<string, any>, userId?: string): Promise<void>;
    getRemoteWorkspace(userId?: string): Promise<any>;
    setRemoteWorkspace(config: any, userId?: string): Promise<void>;
}
export declare const settingsRepository: SettingsRepository;
//# sourceMappingURL=settingsRepository.d.ts.map
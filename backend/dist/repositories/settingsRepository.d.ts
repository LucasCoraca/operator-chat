export interface Setting {
    key: string;
    value: any;
    updated_at: Date;
}
export declare class SettingsRepository {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: any): Promise<void>;
    delete(key: string): Promise<boolean>;
    getAll(): Promise<Record<string, any>>;
    exists(key: string): Promise<boolean>;
    getLlamaConfig(): Promise<any>;
    setLlamaConfig(config: any): Promise<void>;
    getSearxngConfig(): Promise<any>;
    setSearxngConfig(config: any): Promise<void>;
    getUiSettings(): Promise<any>;
    setUiSettings(settings: any): Promise<void>;
    getMcpServers(): Promise<Record<string, any>>;
    setMcpServers(servers: Record<string, any>): Promise<void>;
}
export declare const settingsRepository: SettingsRepository;
//# sourceMappingURL=settingsRepository.d.ts.map
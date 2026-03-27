export interface SearXNGConfig {
    baseUrl: string;
    engine?: string;
    safeSearch: number;
}
export interface SearchResult {
    title: string;
    url: string;
    content: string;
    engine: string;
    score: number;
}
export declare class SearXNGClient {
    private config;
    constructor(config: SearXNGConfig);
    updateConfig(config: Partial<SearXNGConfig>): void;
    search(query: string, maxResults?: number): Promise<SearchResult[]>;
}
//# sourceMappingURL=searxngClient.d.ts.map
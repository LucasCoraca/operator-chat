export interface BrowserContent {
    title: string;
    url: string;
    markdown: string;
    wordCount: number;
    tokenCount: number;
    truncated: boolean;
    headings: Array<{
        level: number;
        text: string;
        charStart?: number;
        charEnd?: number;
    }>;
    error?: string;
    sectionStart?: number;
    sectionEnd?: number;
}
export interface BrowserPageCache {
    url: string;
    title: string;
    markdown: string;
    wordCount: number;
    tokenCount: number;
    headings: Array<{
        level: number;
        text: string;
        charStart: number;
        charEnd: number;
    }>;
    loadedAt: Date;
}
export declare class BrowserClient {
    private browser;
    private turndown;
    private readonly MAX_TOKENS;
    private pageCache;
    private readonly CACHE_TTL_MS;
    constructor();
    initialize(): Promise<void>;
    close(): Promise<void>;
    /**
     * Visit a URL and optionally read a specific section
     * If startChar and endChar are provided, returns only that section
     * Otherwise, returns a summary with headings and structure
     */
    visit(url: string, options?: {
        startChar?: number;
        endChar?: number;
        maxTokens?: number;
    }): Promise<BrowserContent>;
    /**
     * Get a summary of the page with headings and structure (no full content)
     */
    private getSummary;
    /**
     * Get a specific section from cached content
     */
    private getSectionFromCache;
    /**
     * Get cached page content
     */
    private getCachedPage;
    /**
     * Cache page content
     */
    private cachePage;
    /**
     * Extract full content from page
     */
    private extractFullContent;
    /**
     * Extract headings with their character positions
     */
    private extractHeadings;
    /**
     * Clean up markdown content
     */
    private cleanupMarkdown;
}
//# sourceMappingURL=browserClient.d.ts.map
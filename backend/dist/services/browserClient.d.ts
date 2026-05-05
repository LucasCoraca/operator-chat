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
export interface BrowserNetworkEntry {
    method: string;
    url: string;
    status?: number;
    statusText?: string;
    durationMs?: number;
    startedAt: number;
}
export interface BrowserConsoleEntry {
    type: string;
    text: string;
    at: number;
}
export interface BrowserSessionResult {
    url: string;
    title: string;
    text: string;
    html?: string;
    screenshotPath?: string;
    network: BrowserNetworkEntry[];
    console: BrowserConsoleEntry[];
    error?: string;
    actions?: Array<{
        action: string;
        success: boolean;
        error?: string;
    }>;
}
export declare class BrowserClient {
    private browser;
    private turndown;
    private readonly MAX_TOKENS;
    private pageCache;
    private readonly CACHE_TTL_MS;
    private sessions;
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
    private ensureSession;
    private cleanupIdleSessions;
    private takeScreenshot;
    private finalizeAction;
    private resetBuffersForAction;
    sessionVisit(sessionId: string, url: string, options?: {
        timeoutMs?: number;
    }): Promise<BrowserSessionResult>;
    sessionClick(sessionId: string, selector: string, options?: {
        timeoutMs?: number;
    }): Promise<BrowserSessionResult>;
    sessionType(sessionId: string, selector: string, text: string, options?: {
        timeoutMs?: number;
        submit?: boolean;
    }): Promise<BrowserSessionResult>;
    sessionScroll(sessionId: string, deltaY: number): Promise<BrowserSessionResult>;
    closeSession(sessionId: string): Promise<void>;
    sessionActions(sessionId: string, actions: Array<{
        action: 'click';
        selector: string;
    } | {
        action: 'type';
        selector: string;
        text: string;
    } | {
        action: 'scroll';
        scroll_y?: number;
    } | {
        action: 'wait';
        ms?: number;
    } | {
        action: 'select';
        selector: string;
        value: string;
    }>): Promise<BrowserSessionResult>;
}
//# sourceMappingURL=browserClient.d.ts.map
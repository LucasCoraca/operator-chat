"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserClient = void 0;
const puppeteer_1 = __importDefault(require("puppeteer"));
const turndown_1 = __importDefault(require("turndown"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const outputCap_1 = require("../agent/v2/outputCap");
const SCREENSHOT_DIR = outputCap_1.TMP_ROOT;
const NETWORK_BUFFER_MAX = 200;
const CONSOLE_BUFFER_MAX = 200;
const SESSION_IDLE_MS = 10 * 60 * 1000;
class BrowserClient {
    browser = null;
    turndown;
    MAX_TOKENS = 4000;
    pageCache = new Map();
    CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
    // Per-session interactive pages (for the SSH agent's `browser` tool).
    sessions = new Map();
    constructor() {
        this.turndown = new turndown_1.default({
            headingStyle: 'atx',
            codeBlockStyle: 'fenced',
            bulletListMarker: '-',
        });
    }
    async initialize() {
        if (this.browser)
            return;
        this.browser = await puppeteer_1.default.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
            ],
        });
    }
    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }
    /**
     * Visit a URL and optionally read a specific section
     * If startChar and endChar are provided, returns only that section
     * Otherwise, returns a summary with headings and structure
     */
    async visit(url, options = {}) {
        try {
            await this.initialize();
            if (!this.browser) {
                throw new Error('Browser not initialized');
            }
            // Check cache first if reading a section
            if (options.startChar !== undefined || options.endChar !== undefined) {
                const cached = this.getCachedPage(url);
                if (cached) {
                    return this.getSectionFromCache(cached, options.startChar ?? 0, options.endChar ?? cached.markdown.length);
                }
            }
            const page = await this.browser.newPage();
            // Set viewport and user agent
            await page.setViewport({ width: 1280, height: 800 });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
            // Navigate with timeout
            await page.goto(url, {
                waitUntil: 'networkidle2',
                timeout: 30000,
            });
            // Wait a bit for any lazy loading
            await new Promise(resolve => setTimeout(resolve, 1000));
            // Extract full content
            const fullContent = await this.extractFullContent(page, url);
            await page.close();
            // Cache the full content
            this.cachePage(url, fullContent);
            // If reading a specific section, return just that
            if (options.startChar !== undefined || options.endChar !== undefined) {
                return this.getSectionFromCache(fullContent, options.startChar ?? 0, options.endChar ?? fullContent.markdown.length);
            }
            // Otherwise return summary with structure
            return this.getSummary(fullContent, options.maxTokens || this.MAX_TOKENS);
        }
        catch (error) {
            return {
                title: '',
                url,
                markdown: '',
                wordCount: 0,
                tokenCount: 0,
                truncated: false,
                headings: [],
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }
    /**
     * Get a summary of the page with headings and structure (no full content)
     */
    getSummary(content, _maxTokens) {
        let result = `# ${content.title}\n\n`;
        result += `URL: ${content.url}\n`;
        result += `Total Words: ${content.wordCount} | Total Tokens: ~${content.tokenCount}\n`;
        result += `\n---\n\n## Page Structure\n\n`;
        result += `Use \`browser_visit\` with \`startChar\` and \`endChar\` parameters to read specific sections.\n\n`;
        result += `### Headings:\n\n`;
        for (const heading of content.headings) {
            const markers = '#'.repeat(heading.level);
            result += `${markers} ${heading.text} (chars ${heading.charStart}-${heading.charEnd})\n`;
        }
        return {
            title: content.title,
            url: content.url,
            markdown: result,
            wordCount: content.wordCount,
            tokenCount: content.tokenCount,
            truncated: false,
            headings: content.headings,
        };
    }
    /**
     * Get a specific section from cached content
     */
    getSectionFromCache(content, startChar, endChar) {
        const actualStart = Math.max(0, startChar);
        const actualEnd = Math.min(content.markdown.length, endChar);
        const section = content.markdown.substring(actualStart, actualEnd);
        const sectionWordCount = section.trim().split(/\s+/).length;
        const sectionTokenCount = Math.ceil(sectionWordCount * 1.3);
        return {
            title: content.title,
            url: content.url,
            markdown: `## Section: Characters ${actualStart} to ${actualEnd}\n\n${section}`,
            wordCount: sectionWordCount,
            tokenCount: sectionTokenCount,
            truncated: false,
            headings: [],
            sectionStart: actualStart,
            sectionEnd: actualEnd,
        };
    }
    /**
     * Get cached page content
     */
    getCachedPage(url) {
        const cached = this.pageCache.get(url);
        if (!cached)
            return null;
        // Check if cache is expired
        if (Date.now() - cached.loadedAt.getTime() > this.CACHE_TTL_MS) {
            this.pageCache.delete(url);
            return null;
        }
        return cached;
    }
    /**
     * Cache page content
     */
    cachePage(url, content) {
        // Limit cache size to 10 pages
        if (this.pageCache.size >= 10) {
            const firstKey = this.pageCache.keys().next().value;
            this.pageCache.delete(firstKey);
        }
        this.pageCache.set(url, content);
    }
    /**
     * Extract full content from page
     */
    async extractFullContent(page, url) {
        const [title, html] = await Promise.all([
            page.title(),
            page.content(),
        ]);
        // Convert HTML to markdown
        let markdown = this.turndown.turndown(html);
        // Clean up the markdown
        markdown = this.cleanupMarkdown(markdown);
        // Count words and estimate tokens
        const wordCount = markdown.trim().split(/\s+/).length;
        const tokenCount = Math.ceil(wordCount * 1.3);
        // Extract headings with character positions
        const headings = this.extractHeadings(markdown);
        return {
            url,
            title,
            markdown,
            wordCount,
            tokenCount,
            headings,
            loadedAt: new Date(),
        };
    }
    /**
     * Extract headings with their character positions
     */
    extractHeadings(markdown) {
        const headings = [];
        const headingRegex = /^(#{1,6})\s+(.+)$/gm;
        let match;
        while ((match = headingRegex.exec(markdown)) !== null) {
            const level = match[1].length;
            const text = match[2].trim();
            const charStart = match.index;
            const charEnd = charStart + match[0].length;
            headings.push({ level, text, charStart, charEnd });
        }
        return headings;
    }
    /**
     * Clean up markdown content
     */
    cleanupMarkdown(markdown) {
        // Remove excessive whitespace
        markdown = markdown.replace(/\n{3,}/g, '\n\n');
        // Remove very long lines (likely scripts or styles)
        markdown = markdown.split('\n').filter(line => line.length < 500).join('\n');
        // Remove common noise patterns
        markdown = markdown.replace(/\[Skip to content\]/gi, '');
        markdown = markdown.replace(/\[Home\]/gi, '');
        markdown = markdown.replace(/\[Menu\]/gi, '');
        return markdown.trim();
    }
    // ── Interactive session API used by the SSH agent's `browser` tool ──────────
    // Each session keeps a single Page so visit → click → type → scroll all hit
    // the same context. Network requests and console messages are buffered into
    // ring buffers reset on every action; the action's return includes both
    // buffers so the LLM can correlate cause and effect.
    async ensureSession(sessionId) {
        await this.initialize();
        if (!this.browser)
            throw new Error('Browser not initialized');
        const existing = this.sessions.get(sessionId);
        if (existing && !existing.page.isClosed()) {
            existing.lastUsed = Date.now();
            return existing;
        }
        if (existing)
            this.sessions.delete(sessionId);
        const page = await this.browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36');
        const state = {
            page,
            network: [],
            console: [],
            pendingRequests: new Map(),
            lastUsed: Date.now(),
        };
        page.on('request', (req) => {
            const id = req._requestId || `${req.method()} ${req.url()}`;
            const entry = {
                method: req.method(),
                url: req.url(),
                startedAt: Date.now(),
            };
            state.pendingRequests.set(id, entry);
        });
        page.on('response', (res) => {
            const req = res.request();
            const id = req._requestId || `${req.method()} ${req.url()}`;
            const entry = state.pendingRequests.get(id);
            if (entry) {
                entry.status = res.status();
                entry.statusText = res.statusText();
                entry.durationMs = Date.now() - entry.startedAt;
            }
            const finalEntry = entry || {
                method: req.method(),
                url: req.url(),
                status: res.status(),
                statusText: res.statusText(),
                startedAt: Date.now(),
            };
            state.network.push(finalEntry);
            if (state.network.length > NETWORK_BUFFER_MAX)
                state.network.shift();
            state.pendingRequests.delete(id);
        });
        page.on('requestfailed', (req) => {
            const id = req._requestId || `${req.method()} ${req.url()}`;
            const entry = state.pendingRequests.get(id) || {
                method: req.method(),
                url: req.url(),
                startedAt: Date.now(),
            };
            entry.statusText = req.failure()?.errorText || 'failed';
            state.network.push(entry);
            if (state.network.length > NETWORK_BUFFER_MAX)
                state.network.shift();
            state.pendingRequests.delete(id);
        });
        page.on('console', (msg) => {
            state.console.push({ type: msg.type(), text: msg.text(), at: Date.now() });
            if (state.console.length > CONSOLE_BUFFER_MAX)
                state.console.shift();
        });
        page.on('pageerror', (err) => {
            const message = err instanceof Error ? err.message : String(err);
            state.console.push({ type: 'pageerror', text: message, at: Date.now() });
            if (state.console.length > CONSOLE_BUFFER_MAX)
                state.console.shift();
        });
        this.sessions.set(sessionId, state);
        return state;
    }
    cleanupIdleSessions() {
        const now = Date.now();
        for (const [id, state] of this.sessions.entries()) {
            if (now - state.lastUsed > SESSION_IDLE_MS) {
                state.page.close().catch(() => { });
                this.sessions.delete(id);
            }
        }
    }
    async takeScreenshot(state) {
        try {
            fs_1.default.mkdirSync(SCREENSHOT_DIR, { recursive: true });
            const filename = `screenshot_${Date.now()}_${crypto_1.default.randomBytes(3).toString('hex')}.png`;
            const fullPath = path_1.default.join(SCREENSHOT_DIR, filename);
            await state.page.screenshot({ path: fullPath, fullPage: false });
            return fullPath;
        }
        catch {
            return undefined;
        }
    }
    async finalizeAction(state) {
        let url = '';
        try {
            url = state.page.url();
        }
        catch { }
        let title = '';
        try {
            title = await state.page.title();
        }
        catch { }
        let bodyText = '';
        try {
            bodyText = await state.page.evaluate(() => (document.body?.innerText || '').slice(0, 50_000));
        }
        catch { }
        let html = '';
        try {
            html = (await state.page.evaluate(() => document.documentElement?.outerHTML || '')).slice(0, 80_000);
        }
        catch { }
        const screenshot = await this.takeScreenshot(state);
        return {
            url,
            title,
            text: bodyText,
            html,
            screenshotPath: screenshot,
            network: [...state.network],
            console: [...state.console],
        };
    }
    resetBuffersForAction(state) {
        // We keep buffers cumulative within a session but expose a copy on each
        // action. To avoid unbounded growth we cap with NETWORK_BUFFER_MAX above.
        state.lastUsed = Date.now();
    }
    async sessionVisit(sessionId, url, options = {}) {
        this.cleanupIdleSessions();
        const state = await this.ensureSession(sessionId);
        this.resetBuffersForAction(state);
        try {
            await state.page.goto(url, { waitUntil: 'networkidle2', timeout: options.timeoutMs ?? 30_000 });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const result = await this.finalizeAction(state);
            return { ...result, error: message };
        }
        return await this.finalizeAction(state);
    }
    async sessionClick(sessionId, selector, options = {}) {
        const state = this.sessions.get(sessionId);
        if (!state) {
            return {
                url: '',
                title: '',
                text: '',
                network: [],
                console: [],
                error: 'No active browser session. Call browser visit first.',
            };
        }
        this.resetBuffersForAction(state);
        try {
            await state.page.waitForSelector(selector, { timeout: options.timeoutMs ?? 10_000 });
            await state.page.click(selector);
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const result = await this.finalizeAction(state);
            return { ...result, error: message };
        }
        return await this.finalizeAction(state);
    }
    async sessionType(sessionId, selector, text, options = {}) {
        const state = this.sessions.get(sessionId);
        if (!state) {
            return {
                url: '',
                title: '',
                text: '',
                network: [],
                console: [],
                error: 'No active browser session. Call browser visit first.',
            };
        }
        this.resetBuffersForAction(state);
        try {
            await state.page.waitForSelector(selector, { timeout: options.timeoutMs ?? 10_000 });
            await state.page.click(selector, { clickCount: 3 });
            await state.page.type(selector, text, { delay: 5 });
            if (options.submit) {
                await state.page.keyboard.press('Enter');
            }
            await new Promise((resolve) => setTimeout(resolve, 300));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const result = await this.finalizeAction(state);
            return { ...result, error: message };
        }
        return await this.finalizeAction(state);
    }
    async sessionScroll(sessionId, deltaY) {
        const state = this.sessions.get(sessionId);
        if (!state) {
            return {
                url: '',
                title: '',
                text: '',
                network: [],
                console: [],
                error: 'No active browser session. Call browser visit first.',
            };
        }
        this.resetBuffersForAction(state);
        try {
            await state.page.evaluate((y) => window.scrollBy({ top: y, behavior: 'instant' }), deltaY);
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const result = await this.finalizeAction(state);
            return { ...result, error: message };
        }
        return await this.finalizeAction(state);
    }
    async closeSession(sessionId) {
        const state = this.sessions.get(sessionId);
        if (!state)
            return;
        try {
            await state.page.close();
        }
        catch { }
        this.sessions.delete(sessionId);
    }
    // ── Batch actions — execute multiple browser steps in one call ──────────────
    async sessionActions(sessionId, actions, captureScreenshots = false) {
        this.cleanupIdleSessions();
        const state = await this.ensureSession(sessionId);
        const results = [];
        const screenshotPaths = [];
        if (captureScreenshots) {
            const initial = await this.takeScreenshot(state);
            if (initial)
                screenshotPaths.push(initial);
        }
        const captureFrame = async () => {
            if (!captureScreenshots)
                return;
            const s = await this.takeScreenshot(state);
            if (s)
                screenshotPaths.push(s);
        };
        for (const a of actions) {
            try {
                switch (a.action) {
                    case 'screenshot': {
                        const s = await this.takeScreenshot(state);
                        if (s)
                            screenshotPaths.push(s);
                        results.push({ action: 'screenshot', success: true });
                        break;
                    }
                    case 'click': {
                        await state.page.waitForSelector(a.selector, { timeout: 10_000 });
                        await state.page.click(a.selector);
                        await new Promise((resolve) => setTimeout(resolve, 500));
                        results.push({ action: `click ${a.selector}`, success: true });
                        await captureFrame();
                        break;
                    }
                    case 'type': {
                        await state.page.waitForSelector(a.selector, { timeout: 10_000 });
                        await state.page.click(a.selector, { clickCount: 3 });
                        await state.page.type(a.selector, a.text, { delay: 5 });
                        if (a.submit)
                            await state.page.keyboard.press('Enter');
                        await new Promise((resolve) => setTimeout(resolve, 300));
                        results.push({ action: `type ${a.selector}${a.submit ? ' ⏎' : ''}`, success: true });
                        await captureFrame();
                        break;
                    }
                    case 'scroll': {
                        const deltaY = typeof a.scroll_y === 'number' ? a.scroll_y : 600;
                        await state.page.evaluate((y) => window.scrollBy({ top: y, behavior: 'instant' }), deltaY);
                        await new Promise((resolve) => setTimeout(resolve, 200));
                        results.push({ action: `scroll ${deltaY}px`, success: true });
                        await captureFrame();
                        break;
                    }
                    case 'wait': {
                        const ms = typeof a.ms === 'number' ? a.ms : 500;
                        await new Promise((resolve) => setTimeout(resolve, ms));
                        results.push({ action: `wait ${ms}ms`, success: true });
                        await captureFrame();
                        break;
                    }
                    case 'select': {
                        await state.page.waitForSelector(a.selector, { timeout: 10_000 });
                        const err = await state.page.evaluate(({ sel, val }) => {
                            const el = document.querySelector(sel);
                            if (!el || el.tagName !== 'SELECT')
                                return `Element is not a <select>: ${sel}`;
                            el.value = val;
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            return null;
                        }, { sel: a.selector, val: a.value });
                        if (err) {
                            results.push({ action: `select ${a.selector}`, success: false, error: err });
                        }
                        else {
                            results.push({ action: `select ${a.selector} → ${a.value}`, success: true });
                            await captureFrame();
                        }
                        break;
                    }
                    case 'press': {
                        if (a.selector) {
                            await state.page.waitForSelector(a.selector, { timeout: 10_000 });
                            await state.page.focus(a.selector);
                        }
                        await state.page.keyboard.press(a.key);
                        await new Promise((resolve) => setTimeout(resolve, 200));
                        results.push({ action: `press ${a.key}${a.selector ? ` on ${a.selector}` : ''}`, success: true });
                        await captureFrame();
                        break;
                    }
                    case 'hover': {
                        await state.page.waitForSelector(a.selector, { timeout: 10_000 });
                        await state.page.hover(a.selector);
                        await new Promise((resolve) => setTimeout(resolve, 200));
                        results.push({ action: `hover ${a.selector}`, success: true });
                        await captureFrame();
                        break;
                    }
                    case 'focus': {
                        await state.page.waitForSelector(a.selector, { timeout: 10_000 });
                        await state.page.focus(a.selector);
                        results.push({ action: `focus ${a.selector}`, success: true });
                        await captureFrame();
                        break;
                    }
                    case 'clear': {
                        await state.page.waitForSelector(a.selector, { timeout: 10_000 });
                        await state.page.evaluate((sel) => {
                            const el = document.querySelector(sel);
                            if (!el)
                                return;
                            if ('value' in el) {
                                el.value = '';
                                el.dispatchEvent(new Event('input', { bubbles: true }));
                                el.dispatchEvent(new Event('change', { bubbles: true }));
                            }
                        }, a.selector);
                        results.push({ action: `clear ${a.selector}`, success: true });
                        await captureFrame();
                        break;
                    }
                    case 'evaluate': {
                        const value = await state.page.evaluate((src) => {
                            // eslint-disable-next-line no-new-func
                            const fn = new Function(`"use strict"; return (async () => { ${src} })();`);
                            return Promise.resolve(fn()).then((v) => {
                                try {
                                    return JSON.stringify(v);
                                }
                                catch {
                                    return String(v);
                                }
                            });
                        }, a.script);
                        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
                        results.push({ action: 'evaluate', success: true, result: serialized?.slice(0, 4000) });
                        await captureFrame();
                        break;
                    }
                    case 'back': {
                        const r = await state.page.goBack({ waitUntil: 'networkidle2', timeout: 30_000 });
                        results.push({ action: 'back', success: true, result: r ? `→ ${r.url()}` : 'no history' });
                        await captureFrame();
                        break;
                    }
                    case 'forward': {
                        const r = await state.page.goForward({ waitUntil: 'networkidle2', timeout: 30_000 });
                        results.push({ action: 'forward', success: true, result: r ? `→ ${r.url()}` : 'no history' });
                        await captureFrame();
                        break;
                    }
                    case 'reload': {
                        await state.page.reload({ waitUntil: 'networkidle2', timeout: 30_000 });
                        results.push({ action: 'reload', success: true });
                        await captureFrame();
                        break;
                    }
                    case 'wait_for': {
                        await state.page.waitForSelector(a.selector, {
                            timeout: typeof a.timeout_ms === 'number' ? a.timeout_ms : 10_000,
                            hidden: a.hidden === true,
                        });
                        results.push({ action: `wait_for ${a.selector}${a.hidden ? ' (hidden)' : ''}`, success: true });
                        await captureFrame();
                        break;
                    }
                    default: {
                        const unknown = a.action;
                        results.push({ action: String(unknown), success: false, error: 'unknown action' });
                    }
                }
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                results.push({ action: a.action, success: false, error: message });
            }
        }
        // Finalize with page state after all actions
        let url = '';
        try {
            url = state.page.url();
        }
        catch { }
        let title = '';
        try {
            title = await state.page.title();
        }
        catch { }
        let bodyText = '';
        try {
            bodyText = await state.page.evaluate(() => (document.body?.innerText || '').slice(0, 50_000));
        }
        catch { }
        const trailingScreenshot = screenshotPaths.length === 0 ? await this.takeScreenshot(state) : undefined;
        // Combine network/console from all sub-actions
        const allNetwork = [...state.network];
        const allConsole = [...state.console];
        return {
            url,
            title,
            text: bodyText,
            screenshotPath: screenshotPaths.length > 0 ? screenshotPaths[screenshotPaths.length - 1] : trailingScreenshot,
            screenshotPaths: screenshotPaths.length > 1 ? screenshotPaths : undefined,
            network: allNetwork,
            console: allConsole,
            actions: results,
        };
    }
}
exports.BrowserClient = BrowserClient;
//# sourceMappingURL=browserClient.js.map
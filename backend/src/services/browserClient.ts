import puppeteer, { Browser, Page, HTTPRequest, HTTPResponse, ConsoleMessage } from 'puppeteer';
import TurndownService from 'turndown';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface BrowserContent {
  title: string;
  url: string;
  markdown: string;
  wordCount: number;
  tokenCount: number;
  truncated: boolean;
  headings: Array<{ level: number; text: string; charStart?: number; charEnd?: number }>;
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
  headings: Array<{ level: number; text: string; charStart: number; charEnd: number }>;
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
  actions?: Array<{ action: string; success: boolean; error?: string }>;
}

interface SessionState {
  page: Page;
  network: BrowserNetworkEntry[];
  console: BrowserConsoleEntry[];
  pendingRequests: Map<string, BrowserNetworkEntry>;
  lastUsed: number;
}

const SCREENSHOT_DIR = '/tmp/operatorchat';
const NETWORK_BUFFER_MAX = 200;
const CONSOLE_BUFFER_MAX = 200;
const SESSION_IDLE_MS = 10 * 60 * 1000;

export class BrowserClient {
  private browser: Browser | null = null;
  private turndown: TurndownService;
  private readonly MAX_TOKENS = 4000;
  private pageCache: Map<string, BrowserPageCache> = new Map();
  private readonly CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
  // Per-session interactive pages (for the SSH agent's `browser` tool).
  private sessions: Map<string, SessionState> = new Map();

  constructor() {
    this.turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    });
  }

  async initialize(): Promise<void> {
    if (this.browser) return;

    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
  }

  async close(): Promise<void> {
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
  async visit(
    url: string, 
    options: { 
      startChar?: number; 
      endChar?: number; 
      maxTokens?: number 
    } = {}
  ): Promise<BrowserContent> {
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

    } catch (error) {
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
  private getSummary(content: BrowserPageCache, _maxTokens: number): BrowserContent {
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
  private getSectionFromCache(
    content: BrowserPageCache, 
    startChar: number, 
    endChar: number
  ): BrowserContent {
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
  private getCachedPage(url: string): BrowserPageCache | null {
    const cached = this.pageCache.get(url);
    if (!cached) return null;

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
  private cachePage(url: string, content: BrowserPageCache): void {
    // Limit cache size to 10 pages
    if (this.pageCache.size >= 10) {
      const firstKey = this.pageCache.keys().next().value as string;
      this.pageCache.delete(firstKey);
    }
    this.pageCache.set(url, content);
  }

  /**
   * Extract full content from page
   */
  private async extractFullContent(page: Page, url: string): Promise<BrowserPageCache> {
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
  private extractHeadings(markdown: string): Array<{ level: number; text: string; charStart: number; charEnd: number }> {
    const headings: Array<{ level: number; text: string; charStart: number; charEnd: number }> = [];
    const headingRegex = /^(#{1,6})\s+(.+)$/gm;
    let match: RegExpExecArray | null;

    while ((match = headingRegex.exec(markdown)) !== null) {
      const level = match[1].length;
      const text = (match[2] as string).trim();
      const charStart = match.index;
      const charEnd = charStart + match[0].length;
      
      headings.push({ level, text, charStart, charEnd });
    }

    return headings;
  }

  /**
   * Clean up markdown content
   */
  private cleanupMarkdown(markdown: string): string {
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

  private async ensureSession(sessionId: string): Promise<SessionState> {
    await this.initialize();
    if (!this.browser) throw new Error('Browser not initialized');

    const existing = this.sessions.get(sessionId);
    if (existing && !existing.page.isClosed()) {
      existing.lastUsed = Date.now();
      return existing;
    }
    if (existing) this.sessions.delete(sessionId);

    const page = await this.browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36');

    const state: SessionState = {
      page,
      network: [],
      console: [],
      pendingRequests: new Map(),
      lastUsed: Date.now(),
    };

    page.on('request', (req: HTTPRequest) => {
      const id = (req as any)._requestId || `${req.method()} ${req.url()}`;
      const entry: BrowserNetworkEntry = {
        method: req.method(),
        url: req.url(),
        startedAt: Date.now(),
      };
      state.pendingRequests.set(id, entry);
    });
    page.on('response', (res: HTTPResponse) => {
      const req = res.request();
      const id = (req as any)._requestId || `${req.method()} ${req.url()}`;
      const entry = state.pendingRequests.get(id);
      if (entry) {
        entry.status = res.status();
        entry.statusText = res.statusText();
        entry.durationMs = Date.now() - entry.startedAt;
      }
      const finalEntry: BrowserNetworkEntry = entry || {
        method: req.method(),
        url: req.url(),
        status: res.status(),
        statusText: res.statusText(),
        startedAt: Date.now(),
      };
      state.network.push(finalEntry);
      if (state.network.length > NETWORK_BUFFER_MAX) state.network.shift();
      state.pendingRequests.delete(id);
    });
    page.on('requestfailed', (req: HTTPRequest) => {
      const id = (req as any)._requestId || `${req.method()} ${req.url()}`;
      const entry = state.pendingRequests.get(id) || {
        method: req.method(),
        url: req.url(),
        startedAt: Date.now(),
      };
      entry.statusText = req.failure()?.errorText || 'failed';
      state.network.push(entry);
      if (state.network.length > NETWORK_BUFFER_MAX) state.network.shift();
      state.pendingRequests.delete(id);
    });
    page.on('console', (msg: ConsoleMessage) => {
      state.console.push({ type: msg.type(), text: msg.text(), at: Date.now() });
      if (state.console.length > CONSOLE_BUFFER_MAX) state.console.shift();
    });
    page.on('pageerror', (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      state.console.push({ type: 'pageerror', text: message, at: Date.now() });
      if (state.console.length > CONSOLE_BUFFER_MAX) state.console.shift();
    });

    this.sessions.set(sessionId, state);
    return state;
  }

  private cleanupIdleSessions(): void {
    const now = Date.now();
    for (const [id, state] of this.sessions.entries()) {
      if (now - state.lastUsed > SESSION_IDLE_MS) {
        state.page.close().catch(() => {});
        this.sessions.delete(id);
      }
    }
  }

  private async takeScreenshot(state: SessionState): Promise<string | undefined> {
    try {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
      const filename = `screenshot_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.png`;
      const fullPath = path.join(SCREENSHOT_DIR, filename);
      await state.page.screenshot({ path: fullPath as `${string}.png`, fullPage: false });
      return fullPath;
    } catch {
      return undefined;
    }
  }

  private async finalizeAction(state: SessionState): Promise<BrowserSessionResult> {
    let url = '';
    try { url = state.page.url(); } catch {}
    let title = '';
    try { title = await state.page.title(); } catch {}
    let bodyText = '';
    try {
      bodyText = await state.page.evaluate(() => (document.body?.innerText || '').slice(0, 50_000));
    } catch {}
    let html = '';
    try {
      html = (await state.page.evaluate(() => document.documentElement?.outerHTML || '')).slice(0, 80_000);
    } catch {}
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

  private resetBuffersForAction(state: SessionState): void {
    // We keep buffers cumulative within a session but expose a copy on each
    // action. To avoid unbounded growth we cap with NETWORK_BUFFER_MAX above.
    state.lastUsed = Date.now();
  }

  async sessionVisit(sessionId: string, url: string, options: { timeoutMs?: number } = {}): Promise<BrowserSessionResult> {
    this.cleanupIdleSessions();
    const state = await this.ensureSession(sessionId);
    this.resetBuffersForAction(state);
    try {
      await state.page.goto(url, { waitUntil: 'networkidle2', timeout: options.timeoutMs ?? 30_000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = await this.finalizeAction(state);
      return { ...result, error: message };
    }
    return await this.finalizeAction(state);
  }

  async sessionClick(sessionId: string, selector: string, options: { timeoutMs?: number } = {}): Promise<BrowserSessionResult> {
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = await this.finalizeAction(state);
      return { ...result, error: message };
    }
    return await this.finalizeAction(state);
  }

  async sessionType(sessionId: string, selector: string, text: string, options: { timeoutMs?: number; submit?: boolean } = {}): Promise<BrowserSessionResult> {
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = await this.finalizeAction(state);
      return { ...result, error: message };
    }
    return await this.finalizeAction(state);
  }

  async sessionScroll(sessionId: string, deltaY: number): Promise<BrowserSessionResult> {
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
      await state.page.evaluate((y) => window.scrollBy({ top: y, behavior: 'instant' as ScrollBehavior }), deltaY);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = await this.finalizeAction(state);
      return { ...result, error: message };
    }
    return await this.finalizeAction(state);
  }

  async closeSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    try { await state.page.close(); } catch {}
    this.sessions.delete(sessionId);
  }

  // ── Batch actions — execute multiple browser steps in one call ──────────────

  async sessionActions(
    sessionId: string,
    actions: Array<{ action: 'click'; selector: string } | { action: 'type'; selector: string; text: string } | { action: 'scroll'; scroll_y?: number } | { action: 'wait'; ms?: number } | { action: 'select'; selector: string; value: string }>,
  ): Promise<BrowserSessionResult> {
    this.cleanupIdleSessions();
    const state = await this.ensureSession(sessionId);
    const results: Array<{ action: string; success: boolean; error?: string }> = [];

    for (const a of actions) {
      const actionType = a.action;
      switch (actionType) {
        case 'click': {
          const clickAction = a as { action: 'click'; selector: string };
          try {
            await state.page.waitForSelector(clickAction.selector, { timeout: 10_000 });
            await state.page.click(clickAction.selector);
            await new Promise((resolve) => setTimeout(resolve, 500));
            results.push({ action: `click ${clickAction.selector}`, success: true });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            results.push({ action: `click ${clickAction.selector}`, success: false, error: message });
          }
          break;
        }
        case 'type': {
          const typeAction = a as { action: 'type'; selector: string; text: string };
          try {
            await state.page.waitForSelector(typeAction.selector, { timeout: 10_000 });
            await state.page.click(typeAction.selector, { clickCount: 3 });
            await state.page.type(typeAction.selector, typeAction.text, { delay: 5 });
            await new Promise((resolve) => setTimeout(resolve, 300));
            results.push({ action: `type ${typeAction.selector}`, success: true });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            results.push({ action: `type ${typeAction.selector}`, success: false, error: message });
          }
          break;
        }
        case 'scroll': {
          const scrollAction = a as { action: 'scroll'; scroll_y?: number };
          try {
            const deltaY = typeof scrollAction.scroll_y === 'number' ? scrollAction.scroll_y : 600;
            await state.page.evaluate((y) => window.scrollBy({ top: y, behavior: 'instant' as ScrollBehavior }), deltaY);
            await new Promise((resolve) => setTimeout(resolve, 200));
            results.push({ action: 'scroll', success: true });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            results.push({ action: 'scroll', success: false, error: message });
          }
          break;
        }
        case 'wait': {
          const waitAction = a as { action: 'wait'; ms?: number };
          const ms = typeof waitAction.ms === 'number' ? waitAction.ms : 500;
          await new Promise((resolve) => setTimeout(resolve, ms));
          results.push({ action: `wait ${ms}ms`, success: true });
          break;
        }
        case 'select': {
          const selectAction = a as { action: 'select'; selector: string; value: string };
          try {
            await state.page.waitForSelector(selectAction.selector, { timeout: 10_000 });
            await state.page.evaluate(
              ({ sel, val }) => {
                const el = document.querySelector(sel) as HTMLSelectElement | null;
                if (!el || el.tagName !== 'SELECT') return `Element is not a <select>: ${sel}`;
                el.value = val;
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('input', { bubbles: true }));
                return null;
              },
              { sel: selectAction.selector, val: selectAction.value },
            );
            results.push({ action: `select ${selectAction.selector} → ${selectAction.value}`, success: true });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            results.push({ action: `select ${selectAction.selector}`, success: false, error: message });
          }
          break;
        }
        default:
          results.push({ action: String(actionType), success: false, error: 'unknown action' });
      }
    }

    // Finalize with page state after all actions
    let url = '';
    try { url = state.page.url(); } catch {}
    let title = '';
    try { title = await state.page.title(); } catch {}
    let bodyText = '';
    try {
      bodyText = await state.page.evaluate(() => (document.body?.innerText || '').slice(0, 50_000));
    } catch {}
    const screenshot = await this.takeScreenshot(state);

    // Combine network/console from all sub-actions
    const allNetwork = [...state.network];
    const allConsole = [...state.console];

    return {
      url,
      title,
      text: bodyText,
      screenshotPath: screenshot,
      network: allNetwork,
      console: allConsole,
      actions: results,
    };
  }
}
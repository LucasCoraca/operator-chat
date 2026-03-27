import puppeteer, { Browser, Page } from 'puppeteer';
import TurndownService from 'turndown';

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

export class BrowserClient {
  private browser: Browser | null = null;
  private turndown: TurndownService;
  private readonly MAX_TOKENS = 4000;
  private pageCache: Map<string, BrowserPageCache> = new Map();
  private readonly CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

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
}
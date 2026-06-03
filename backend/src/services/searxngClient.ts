import axios from 'axios';

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
  /** Image/thumbnail URL when the result carries one (image results, rich cards). */
  imageUrl?: string;
}

export class SearXNGClient {
  private config: SearXNGConfig;

  constructor(config: SearXNGConfig) {
    this.config = config;
  }

  updateConfig(config: Partial<SearXNGConfig>): void {
    this.config = { ...this.config, ...config };
  }

  async search(query: string, maxResults: number = 10): Promise<SearchResult[]> {
    try {
      const url = new URL(`${this.config.baseUrl}/search`);
      url.searchParams.append('q', query);
      url.searchParams.append('format', 'json');
      url.searchParams.append('pageno', '1');
      url.searchParams.append('safe_search', String(this.config.safeSearch));
      
      if (this.config.engine) {
        url.searchParams.append('categories', this.config.engine);
      }

      const response = await axios.get(url.toString());
      const data = response.data as { results: Array<Record<string, unknown>> };

      const toAbsolute = (raw: unknown, base: string): string | undefined => {
        if (typeof raw !== 'string' || !raw) return undefined;
        try {
          const abs = new URL(raw, base).toString();
          return /^https?:\/\//i.test(abs) ? abs : undefined;
        } catch {
          return undefined;
        }
      };

      return data.results.slice(0, maxResults).map(result => {
        const pageUrl = (result.url as string) || '';
        return {
          title: (result.title as string) || 'Untitled',
          url: pageUrl,
          content: (result.content as string) || '',
          engine: (result.engine as string) || 'unknown',
          score: (result.score as number) || 0,
          imageUrl:
            toAbsolute(result.img_src, pageUrl) ||
            toAbsolute(result.thumbnail_src, pageUrl) ||
            toAbsolute(result.thumbnail, pageUrl),
        };
      });
    } catch (error) {
      console.error('SearXNG search error:', error);
      throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
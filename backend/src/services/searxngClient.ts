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
      const data = response.data as { results: SearchResult[] };
      
      return data.results.slice(0, maxResults).map(result => ({
        title: result.title || 'Untitled',
        url: result.url || '',
        content: result.content || '',
        engine: result.engine || 'unknown',
        score: result.score || 0,
      }));
    } catch (error) {
      console.error('SearXNG search error:', error);
      throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
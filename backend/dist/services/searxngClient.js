"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SearXNGClient = void 0;
const axios_1 = __importDefault(require("axios"));
class SearXNGClient {
    config;
    constructor(config) {
        this.config = config;
    }
    updateConfig(config) {
        this.config = { ...this.config, ...config };
    }
    async search(query, maxResults = 10) {
        try {
            const url = new URL(`${this.config.baseUrl}/search`);
            url.searchParams.append('q', query);
            url.searchParams.append('format', 'json');
            url.searchParams.append('pageno', '1');
            url.searchParams.append('safe_search', String(this.config.safeSearch));
            if (this.config.engine) {
                url.searchParams.append('categories', this.config.engine);
            }
            const response = await axios_1.default.get(url.toString());
            const data = response.data;
            return data.results.slice(0, maxResults).map(result => ({
                title: result.title || 'Untitled',
                url: result.url || '',
                content: result.content || '',
                engine: result.engine || 'unknown',
                score: result.score || 0,
            }));
        }
        catch (error) {
            console.error('SearXNG search error:', error);
            throw new Error(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
}
exports.SearXNGClient = SearXNGClient;
//# sourceMappingURL=searxngClient.js.map
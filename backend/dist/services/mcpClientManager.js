"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCPClientManager = void 0;
const index_js_1 = require("@modelcontextprotocol/sdk/client/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/client/stdio.js");
const sse_js_1 = require("@modelcontextprotocol/sdk/client/sse.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const websocket_js_1 = require("@modelcontextprotocol/sdk/client/websocket.js");
class MCPClientManager {
    clients = new Map();
    serverConfigs = new Map();
    discoveredTools = new Map();
    onToolsChangedCallback;
    constructor() { }
    setOnToolsChangedCallback(callback) {
        this.onToolsChangedCallback = callback;
    }
    async addServer(name, config) {
        // Remove existing server if present
        if (this.clients.has(name)) {
            await this.removeServer(name);
        }
        this.serverConfigs.set(name, config);
        if (!config.enabled) {
            console.log(`MCP Server '${name}' is disabled, skipping connection`);
            return;
        }
        try {
            await this.connectServer(name, config);
        }
        catch (error) {
            console.error(`Failed to connect to MCP server '${name}':`, error);
            throw error;
        }
    }
    async connectServer(name, config) {
        let transport;
        let client;
        if (config.url) {
            // URL-based connection (remote server)
            const url = new URL(config.url);
            const transportType = config.transportType || 'sse';
            // Add API key to URL as query parameter if provided
            let serverUrl = url;
            if (config.apiKey) {
                const separator = serverUrl.search ? '&' : '?';
                serverUrl = new URL(`${serverUrl.toString()}${separator}api_key=${encodeURIComponent(config.apiKey)}`);
            }
            // Select transport based on type
            if (transportType === 'websocket' || config.url.startsWith('ws://') || config.url.startsWith('wss://')) {
                // WebSocket transport
                transport = new websocket_js_1.WebSocketClientTransport(serverUrl);
            }
            else if (transportType === 'streamable-http') {
                // Streamable HTTP transport
                transport = new streamableHttp_js_1.StreamableHTTPClientTransport(serverUrl);
            }
            else {
                // SSE transport (default)
                transport = new sse_js_1.SSEClientTransport(serverUrl);
            }
            client = new index_js_1.Client({
                name: 'operator-chat-mcp-client',
                version: '1.0.0',
            }, {
                capabilities: {},
            });
            await client.connect(transport);
            console.log(`Connected to remote MCP server '${name}' at ${config.url} via ${transportType}`);
        }
        else if (config.command) {
            // Stdio-based connection (local server)
            const env = {};
            for (const [key, value] of Object.entries(process.env)) {
                if (value !== undefined) {
                    env[key] = value;
                }
            }
            if (config.env) {
                for (const [key, value] of Object.entries(config.env)) {
                    env[key] = value;
                }
            }
            transport = new stdio_js_1.StdioClientTransport({
                command: config.command,
                args: config.args || [],
                env,
                stderr: 'pipe',
            });
            client = new index_js_1.Client({
                name: 'operator-chat-mcp-client',
                version: '1.0.0',
            }, {
                capabilities: {},
            });
            await client.connect(transport);
            console.log(`Connected to local MCP server '${name}'`);
        }
        else {
            throw new Error(`MCP server '${name}' must have either a URL or command configured`);
        }
        // Store client and transport
        this.clients.set(name, { client, transport: transport });
        // Discover tools from this server
        await this.discoverTools(name, client);
    }
    async discoverTools(serverName, client) {
        try {
            const response = await client.listTools();
            for (const tool of response.tools) {
                const toolKey = `${serverName}:${tool.name}`;
                this.discoveredTools.set(toolKey, {
                    name: tool.name,
                    description: tool.description || '',
                    inputSchema: tool.inputSchema,
                    serverName,
                });
                console.log(`Discovered MCP tool: ${toolKey}`);
            }
            console.log(`Discovered ${response.tools.length} tools from MCP server '${serverName}'`);
            // Notify that tools have changed
            if (this.onToolsChangedCallback) {
                this.onToolsChangedCallback();
            }
        }
        catch (error) {
            console.error(`Failed to discover tools from MCP server '${serverName}':`, error);
            throw error;
        }
    }
    async removeServer(name) {
        const clientData = this.clients.get(name);
        if (clientData) {
            try {
                await clientData.client.close();
            }
            catch (error) {
                console.error(`Error closing MCP server '${name}':`, error);
            }
            this.clients.delete(name);
        }
        // Remove tools from this server
        for (const [key, tool] of this.discoveredTools.entries()) {
            if (tool.serverName === name) {
                this.discoveredTools.delete(key);
            }
        }
        this.serverConfigs.delete(name);
        console.log(`Removed MCP server '${name}'`);
        // Notify that tools have changed
        if (this.onToolsChangedCallback) {
            this.onToolsChangedCallback();
        }
    }
    async executeTool(serverName, toolName, args) {
        const clientData = this.clients.get(serverName);
        if (!clientData) {
            throw new Error(`MCP server '${serverName}' not connected`);
        }
        try {
            const result = await clientData.client.callTool({
                name: toolName,
                arguments: args,
            });
            // Extract text content from result
            if (result.content && Array.isArray(result.content)) {
                const textParts = result.content
                    .filter((c) => c.type === 'text')
                    .map((c) => c.text);
                if (textParts.length > 0) {
                    return textParts.join('\n');
                }
            }
            // Fallback to JSON stringify
            return JSON.stringify(result, null, 2);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`MCP tool execution failed: ${errorMessage}`);
        }
    }
    getTools() {
        return Array.from(this.discoveredTools.values());
    }
    getTool(serverName, toolName) {
        return this.discoveredTools.get(`${serverName}:${toolName}`);
    }
    getServerStatuses() {
        const statuses = [];
        for (const [name, config] of this.serverConfigs.entries()) {
            const isConnected = this.clients.has(name);
            const tools = Array.from(this.discoveredTools.values())
                .filter(t => t.serverName === name)
                .map(t => t.name);
            statuses.push({
                name,
                connected: isConnected,
                tools,
            });
        }
        return statuses;
    }
    async disconnectAll() {
        const serverNames = Array.from(this.clients.keys());
        for (const name of serverNames) {
            await this.removeServer(name);
        }
    }
    async reconnectServer(name) {
        const config = this.serverConfigs.get(name);
        if (!config) {
            throw new Error(`MCP server '${name}' not configured`);
        }
        if (!config.enabled) {
            throw new Error(`MCP server '${name}' is disabled`);
        }
        await this.removeServer(name);
        await this.connectServer(name, config);
    }
    getServerConfig(name) {
        return this.serverConfigs.get(name);
    }
    getAllServerConfigs() {
        return new Map(this.serverConfigs);
    }
}
exports.MCPClientManager = MCPClientManager;
//# sourceMappingURL=mcpClientManager.js.map
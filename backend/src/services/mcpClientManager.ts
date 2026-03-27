import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { Tool } from '@modelcontextprotocol/sdk/types.js';

export type MCPTransportType = 'sse' | 'streamable-http' | 'websocket';

export interface MCPServerConfig {
  // For URL-based connections (remote servers)
  url?: string;
  apiKey?: string;
  transportType?: MCPTransportType;
  // For stdio-based connections (local servers)
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

export interface MCPServerStatus {
  name: string;
  connected: boolean;
  tools: string[];
  error?: string;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  serverName: string;
}

export class MCPClientManager {
  private clients: Map<string, { client: Client; transport: StdioClientTransport }> = new Map();
  private serverConfigs: Map<string, MCPServerConfig> = new Map();
  private discoveredTools: Map<string, MCPToolDefinition> = new Map();
  private onToolsChangedCallback?: () => void;

  constructor() {}

  setOnToolsChangedCallback(callback: () => void): void {
    this.onToolsChangedCallback = callback;
  }

  async addServer(name: string, config: MCPServerConfig): Promise<void> {
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
    } catch (error) {
      console.error(`Failed to connect to MCP server '${name}':`, error);
      throw error;
    }
  }

  private async connectServer(name: string, config: MCPServerConfig): Promise<void> {
    let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport | WebSocketClientTransport;
    let client: Client;

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
        transport = new WebSocketClientTransport(serverUrl);
      } else if (transportType === 'streamable-http') {
        // Streamable HTTP transport
        transport = new StreamableHTTPClientTransport(serverUrl);
      } else {
        // SSE transport (default)
        transport = new SSEClientTransport(serverUrl);
      }

      client = new Client(
        {
          name: 'operator-chat-mcp-client',
          version: '1.0.0',
        },
        {
          capabilities: {},
        }
      );

      await client.connect(transport);
      console.log(`Connected to remote MCP server '${name}' at ${config.url} via ${transportType}`);
    } else if (config.command) {
      // Stdio-based connection (local server)
      const env: Record<string, string> = {};
      
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

      transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env,
        stderr: 'pipe',
      });

      client = new Client(
        {
          name: 'operator-chat-mcp-client',
          version: '1.0.0',
        },
        {
          capabilities: {},
        }
      );

      await client.connect(transport);
      console.log(`Connected to local MCP server '${name}'`);
    } else {
      throw new Error(`MCP server '${name}' must have either a URL or command configured`);
    }

    // Store client and transport
    this.clients.set(name, { client, transport: transport as any });

    // Discover tools from this server
    await this.discoverTools(name, client);
  }

  private async discoverTools(serverName: string, client: Client): Promise<void> {
    try {
      const response = await client.listTools();
      
      for (const tool of response.tools) {
        const toolKey = `${serverName}:${tool.name}`;
        this.discoveredTools.set(toolKey, {
          name: tool.name,
          description: tool.description || '',
          inputSchema: tool.inputSchema as MCPToolDefinition['inputSchema'],
          serverName,
        });
        console.log(`Discovered MCP tool: ${toolKey}`);
      }
      
      console.log(`Discovered ${response.tools.length} tools from MCP server '${serverName}'`);
      
      // Notify that tools have changed
      if (this.onToolsChangedCallback) {
        this.onToolsChangedCallback();
      }
    } catch (error) {
      console.error(`Failed to discover tools from MCP server '${serverName}':`, error);
      throw error;
    }
  }

  async removeServer(name: string): Promise<void> {
    const clientData = this.clients.get(name);
    if (clientData) {
      try {
        await clientData.client.close();
      } catch (error) {
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

  async executeTool(
    serverName: string,
    toolName: string,
    args: Record<string, any>
  ): Promise<string> {
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
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text);
        
        if (textParts.length > 0) {
          return textParts.join('\n');
        }
      }

      // Fallback to JSON stringify
      return JSON.stringify(result, null, 2);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`MCP tool execution failed: ${errorMessage}`);
    }
  }

  getTools(): MCPToolDefinition[] {
    return Array.from(this.discoveredTools.values());
  }

  getTool(serverName: string, toolName: string): MCPToolDefinition | undefined {
    return this.discoveredTools.get(`${serverName}:${toolName}`);
  }

  getServerStatuses(): MCPServerStatus[] {
    const statuses: MCPServerStatus[] = [];
    
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

  async disconnectAll(): Promise<void> {
    const serverNames = Array.from(this.clients.keys());
    for (const name of serverNames) {
      await this.removeServer(name);
    }
  }

  async reconnectServer(name: string): Promise<void> {
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

  getServerConfig(name: string): MCPServerConfig | undefined {
    return this.serverConfigs.get(name);
  }

  getAllServerConfigs(): Map<string, MCPServerConfig> {
    return new Map(this.serverConfigs);
  }
}
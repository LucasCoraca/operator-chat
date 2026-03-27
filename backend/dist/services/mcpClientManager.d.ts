export type MCPTransportType = 'sse' | 'streamable-http' | 'websocket';
export interface MCPServerConfig {
    url?: string;
    apiKey?: string;
    transportType?: MCPTransportType;
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
export declare class MCPClientManager {
    private clients;
    private serverConfigs;
    private discoveredTools;
    private onToolsChangedCallback?;
    constructor();
    setOnToolsChangedCallback(callback: () => void): void;
    addServer(name: string, config: MCPServerConfig): Promise<void>;
    private connectServer;
    private discoverTools;
    removeServer(name: string): Promise<void>;
    executeTool(serverName: string, toolName: string, args: Record<string, any>): Promise<string>;
    getTools(): MCPToolDefinition[];
    getTool(serverName: string, toolName: string): MCPToolDefinition | undefined;
    getServerStatuses(): MCPServerStatus[];
    disconnectAll(): Promise<void>;
    reconnectServer(name: string): Promise<void>;
    getServerConfig(name: string): MCPServerConfig | undefined;
    getAllServerConfigs(): Map<string, MCPServerConfig>;
}
//# sourceMappingURL=mcpClientManager.d.ts.map
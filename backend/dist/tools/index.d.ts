import { SearXNGClient } from '../services/searxngClient';
import { SandboxManager } from '../services/sandboxManager';
import { MemoryManager } from '../services/memoryManager';
import { MCPClientManager } from '../services/mcpClientManager';
import { WorkspaceConfig } from '../services/workspaceRuntime';
import type { CreateAgentRunRequest } from '../agent/ReActAgent';
export type ToolCapability = 'filesystem' | 'network' | 'process' | 'remote' | 'browser' | 'read_chat' | 'write_chat' | 'memory' | 'schedule';
export type ToolSandboxPolicy = 'none' | 'chat_fs_only' | 'isolated_process' | 'workspace_runtime' | 'ssh_remote' | 'browser_isolated';
export type ToolRiskLevel = 'low' | 'medium' | 'high';
export interface ToolExecutionPolicy {
    requiresApproval: boolean;
    supportsAutoApprove: boolean;
    capabilities: ToolCapability[];
    sandboxPolicy: ToolSandboxPolicy;
    riskLevel: ToolRiskLevel;
}
export interface ChatToolPreference {
    enabled: boolean;
    autoApprove: boolean;
}
export interface Tool {
    name: string;
    description: string;
    parameters: Record<string, {
        type: string;
        description: string;
        required?: boolean;
    }>;
    policy: ToolExecutionPolicy;
    internal?: boolean;
    execute: (args: Record<string, any>, context: {
        sandboxId: string;
        userId: string;
        chatId?: string;
        model?: string;
        workspace?: WorkspaceConfig;
        createAgentRun?: (request: CreateAgentRunRequest) => Promise<string>;
    }) => Promise<string>;
}
export declare class ToolRegistry {
    private tools;
    private searxngClient;
    private sandboxManager;
    private workspaceRuntimeFactory;
    private memoryManager;
    private mcpClientManager?;
    constructor(searxngClient: SearXNGClient, sandboxManager: SandboxManager, memoryManager: MemoryManager, mcpClientManager?: MCPClientManager);
    private registerBuiltInTools;
    registerMCPTools(): void;
    getTools(): Tool[];
    getPublicTools(): Tool[];
    getFilteredTools(enabledToolNames?: string[]): Tool[];
    getTool(name: string): Tool | undefined;
    getToolPolicy(name: string): ToolExecutionPolicy | undefined;
    getDefaultPreferences(): Record<string, ChatToolPreference>;
    mergeWithDefaultPreferences(preferences?: Record<string, ChatToolPreference>, defaultPreferences?: Record<string, ChatToolPreference>): Record<string, ChatToolPreference>;
    executeTool(name: string, args: Record<string, any>, context: {
        sandboxId: string;
        userId: string;
        chatId?: string;
        model?: string;
        workspace?: WorkspaceConfig;
        createAgentRun?: (request: CreateAgentRunRequest) => Promise<string>;
    }, enabledToolNames?: string[]): Promise<string>;
    getToolDescriptions(enabledToolNames?: string[]): string;
    getToolDefinitions(): Array<{
        type: 'function';
        function: {
            name: string;
            description: string;
            parameters: {
                type: 'object';
                properties: Record<string, any>;
                required: string[];
            };
        };
    }>;
    getFilteredToolDefinitions(enabledToolNames?: string[]): Array<{
        type: 'function';
        function: {
            name: string;
            description: string;
            parameters: {
                type: 'object';
                properties: Record<string, any>;
                required: string[];
            };
        };
    }>;
}
//# sourceMappingURL=index.d.ts.map
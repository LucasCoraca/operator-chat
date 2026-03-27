export interface LlamaConfig {
    baseUrl: string;
    apiKey?: string;
    model: string;
    temperature: number;
    maxTokens: number;
    topP: number;
    stopSequences?: string[];
}
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}
export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}
export interface ToolDefinition {
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
}
export interface ChatTimings {
    prompt_n?: number;
    prompt_ms?: number;
    prompt_per_token_ms?: number;
    prompt_per_second?: number;
    predicted_n?: number;
    predicted_ms?: number;
    predicted_per_token_ms?: number;
    predicted_per_second?: number;
}
export interface ChatResponse {
    content: string;
    stop: boolean;
    model: string;
    tokens_evaluated: number;
    tokens_generated: number;
    timings?: ChatTimings;
    tool_calls?: ToolCall[];
}
export interface ChatStreamResult {
    finalContent: string;
    finalChunks: string[];
    reasoningContent: string;
    toolCall?: {
        name: string;
        arguments: string;
    };
}
export declare class LlamaClient {
    private client;
    private config;
    constructor(config: LlamaConfig);
    updateConfig(config: Partial<LlamaConfig>): void;
    chat(messages: ChatMessage[], options?: {
        temperature?: number;
        maxTokens?: number;
        excludeReasoning?: boolean;
    }, onToken?: (token: string) => void): Promise<ChatResponse>;
    chatStream(messages: ChatMessage[], onDone?: (timings?: ChatTimings) => void, abortController?: AbortController, tools?: ToolDefinition[], options?: {
        onReasoningToken?: (token: string) => void;
        onContentToken?: (token: string) => void;
    }): Promise<ChatStreamResult>;
    getModels(): Promise<string[]>;
}
//# sourceMappingURL=llamaClient.d.ts.map
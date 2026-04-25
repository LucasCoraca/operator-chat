"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LlamaClient = void 0;
const openai_1 = __importDefault(require("openai"));
const streamParser_1 = require("./streamParser");
class LlamaClient {
    client;
    config;
    constructor(config) {
        this.config = config;
        // Ensure baseURL ends with /v1 for OpenAI-compatible API
        const baseURL = config.baseUrl.endsWith('/v1')
            ? config.baseUrl
            : `${config.baseUrl}/v1`;
        this.client = new openai_1.default({
            baseURL,
            apiKey: config.apiKey || 'sk-no-key-required',
        });
    }
    updateConfig(config) {
        this.config = { ...this.config, ...config };
        if (config.baseUrl) {
            // Ensure baseURL ends with /v1 for OpenAI-compatible API
            const baseURL = config.baseUrl.endsWith('/v1')
                ? config.baseUrl
                : `${config.baseUrl}/v1`;
            this.client = new openai_1.default({
                baseURL,
                apiKey: this.config.apiKey || 'sk-no-key-required',
            });
        }
    }
    async chat(messages, options, onToken) {
        // Safety check: Assistant response prefill is incompatible with enable_thinking in llama.cpp
        const safeMessages = [...messages];
        if (safeMessages.length > 0 && safeMessages[safeMessages.length - 1].role === 'assistant') {
            console.warn('LLAMA CLIENT: Last message is assistant, which may cause 400 error with thinking models. Adding a dummy user message to avoid prefill.');
            safeMessages.push({
                role: 'user',
                content: 'You MUST perform exactly one tool call or provide a valid response block.',
            });
        }
        const response = await this.client.chat.completions.create({
            model: options?.model || this.config.model || '',
            messages: safeMessages.map(msg => ({
                role: msg.role,
                content: msg.content,
                ...(msg.tool_calls && { tool_calls: msg.tool_calls }),
                ...(msg.tool_call_id && { tool_call_id: msg.tool_call_id }),
            })),
            stream: false,
        });
        const message = response.choices[0]?.message;
        const content = message?.content || '';
        return {
            content,
            stop: true,
            model: this.config.model || '',
            tokens_evaluated: response.usage?.prompt_tokens || 0,
            tokens_generated: response.usage?.completion_tokens || 0,
        };
    }
    async chatStream(messages, onDone, abortController, tools, options) {
        // Safety check: Assistant response prefill is incompatible with enable_thinking in llama.cpp
        // If the last message is from assistant, we add a dummy user message to avoid the 400 error.
        const safeMessages = [...messages];
        if (safeMessages.length > 0 && safeMessages[safeMessages.length - 1].role === 'assistant') {
            console.warn('LLAMA CLIENT: Last message is assistant, which may cause 400 error with thinking models. Adding a dummy user message to avoid prefill.');
            safeMessages.push({
                role: 'user',
                content: 'You have reasoned enough. Now, you MUST perform exactly one tool call or provide a valid response block.',
            });
        }
        return new Promise((resolve, reject) => {
            const streamStartTime = Date.now(); // Track start time for manual timing calculation
            const streamBody = {
                model: options?.model || this.config.model || '',
                messages: safeMessages.map(msg => ({
                    role: msg.role,
                    content: msg.content,
                    ...(msg.tool_calls && { tool_calls: msg.tool_calls }),
                    ...(msg.tool_call_id && { tool_call_id: msg.tool_call_id }),
                })),
                stream: true,
            };
            // Add tools if provided
            if (tools && tools.length > 0) {
                streamBody.tools = tools;
                streamBody.tool_choice = 'auto';
            }
            // Add stop sequences if configured
            if (this.config.stopSequences && this.config.stopSequences.length > 0) {
                streamBody.stop = this.config.stopSequences;
            }
            // Enable usage in the final chunk (required for llama-server timing data)
            streamBody.stream_options = { include_usage: true };
            let toolCallName = '';
            let toolCallArguments = '';
            let hasToolCall = false;
            let isDone = false;
            let timings;
            let tokenCount = 0; // Count tokens manually
            const parser = new streamParser_1.StreamParser({
                onReasoningToken: options?.onReasoningToken,
                onContentToken: options?.onContentToken,
            });
            const handleDone = () => {
                if (isDone)
                    return;
                isDone = true;
                const parsedContent = parser.finalize();
                onDone?.(timings);
                resolve({
                    finalContent: parsedContent.finalContent,
                    finalChunks: parsedContent.finalChunks,
                    reasoningContent: parsedContent.reasoningContent,
                    ...(hasToolCall && toolCallName && toolCallArguments
                        ? {
                            toolCall: {
                                name: toolCallName,
                                arguments: toolCallArguments,
                            },
                        }
                        : {}),
                });
            };
            const handleError = (err) => {
                reject(err);
            };
            // Create the stream and iterate
            (async () => {
                try {
                    const stream = await this.client.chat.completions.create(streamBody, {
                        signal: abortController?.signal,
                    });
                    for await (const chunk of stream) {
                        const delta = chunk.choices?.[0]?.delta;
                        // Check for tool calls (native tool calling)
                        if (delta?.tool_calls && delta.tool_calls.length > 0) {
                            hasToolCall = true;
                            const toolCall = delta.tool_calls[0];
                            // Get tool name from the first chunk
                            if (toolCall?.function?.name && !toolCallName) {
                                toolCallName = toolCall.function.name;
                            }
                            // Accumulate arguments (do NOT stream them - they're JSON, not user-facing content)
                            const functionCall = toolCall?.function;
                            if (functionCall?.arguments) {
                                toolCallArguments += functionCall.arguments;
                            }
                            console.log('LLAMA CLIENT: Tool call detected:', toolCall);
                        }
                        // Handle reasoning_content field (for models that use it like DeepSeek via OpenRouter)
                        const reasoningContent = delta?.reasoning_content || '';
                        if (reasoningContent) {
                            tokenCount++; // Count reasoning tokens
                            parser.pushReasoningChunk(reasoningContent);
                        }
                        // Handle regular content, including <think> tags emitted inline by some models.
                        const content = delta?.content || '';
                        if (content) {
                            tokenCount++; // Keep your manual token count
                            parser.pushContentChunk(content);
                        }
                        // Count tool call tokens
                        if (delta?.tool_calls && delta.tool_calls.length > 0) {
                            const functionCall = delta.tool_calls[0]?.function;
                            if (functionCall?.arguments) {
                                tokenCount++; // Count tool call argument tokens
                            }
                        }
                        // Check for done signal and capture timing data
                        if (chunk.choices?.[0]?.finish_reason) {
                            const streamEndTime = Date.now();
                            const streamDurationMs = streamEndTime - streamStartTime;
                            // Extract timing data from the response
                            // llama.cpp server includes timing info in the usage field or as custom fields
                            const usage = chunk.usage;
                            // Check for custom timing fields that llama.cpp may include in the chunk
                            const customTimings = chunk?.timings;
                            // Log raw chunk data for debugging
                            console.log('LLAMA CLIENT: Final chunk received');
                            console.log('LLAMA CLIENT: Stream duration:', streamDurationMs, 'ms');
                            console.log('LLAMA CLIENT: Token count (manual):', tokenCount);
                            console.log('LLAMA CLIENT: Usage field:', usage);
                            console.log('LLAMA CLIENT: Custom timings field:', customTimings);
                            if (customTimings || usage) {
                                timings = {
                                    // Use custom timings from llama.cpp if available, otherwise use usage field
                                    prompt_n: customTimings?.prompt_n ?? usage?.prompt_tokens,
                                    prompt_ms: customTimings?.prompt_ms,
                                    prompt_per_token_ms: customTimings?.prompt_per_token_ms,
                                    prompt_per_second: customTimings?.prompt_per_second,
                                    predicted_n: customTimings?.predicted_n ?? usage?.completion_tokens,
                                    predicted_ms: customTimings?.predicted_ms,
                                    predicted_per_token_ms: customTimings?.predicted_per_token_ms,
                                    predicted_per_second: customTimings?.predicted_per_second,
                                };
                                // Calculate tokens per second if not provided but we have the raw data
                                if (timings.predicted_n && timings.predicted_ms && !timings.predicted_per_second) {
                                    timings.predicted_per_second = (timings.predicted_n / timings.predicted_ms) * 1000;
                                    console.log('LLAMA CLIENT: Calculated predicted_per_second from raw data:', timings.predicted_per_second);
                                }
                                if (timings.prompt_n && timings.prompt_ms && !timings.prompt_per_second) {
                                    timings.prompt_per_second = (timings.prompt_n / timings.prompt_ms) * 1000;
                                    console.log('LLAMA CLIENT: Calculated prompt_per_second from raw data:', timings.prompt_per_second);
                                }
                            }
                            else {
                                // Fallback: Calculate timing data manually from stream duration and token count
                                if (tokenCount > 0 && streamDurationMs > 0) {
                                    timings = {
                                        predicted_n: tokenCount,
                                        predicted_ms: streamDurationMs,
                                        predicted_per_second: (tokenCount / streamDurationMs) * 1000,
                                    };
                                    console.log('LLAMA CLIENT: Using manual timing calculation');
                                }
                            }
                            // Log the timing data for debugging
                            console.log('LLAMA CLIENT: Final timing data:', timings);
                            handleDone();
                            return;
                        }
                    }
                    // If we exit the loop without finish_reason, still call done
                    handleDone();
                }
                catch (err) {
                    const error = err;
                    if (error.name === 'AbortError') {
                        handleDone();
                    }
                    else {
                        handleError(error);
                    }
                }
            })().catch(handleError);
        });
    }
    async getModels() {
        try {
            const response = await this.client.models.list();
            return response.data.map(m => m.id);
        }
        catch (e) {
            return this.config.model ? [this.config.model] : [];
        }
    }
}
exports.LlamaClient = LlamaClient;
//# sourceMappingURL=llamaClient.js.map
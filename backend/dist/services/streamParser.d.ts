export interface StreamParseCallbacks {
    onReasoningToken?: (token: string) => void;
    onContentToken?: (token: string) => void;
}
export interface StreamParseResult {
    finalContent: string;
    finalChunks: string[];
    reasoningContent: string;
}
export declare class StreamParser {
    private static readonly TOOL_CALL_OPEN_TAG;
    private static readonly TOOL_CALL_CLOSE_TAG;
    private finalContent;
    private finalChunks;
    private reasoningContent;
    private reasoningBuffer;
    private inReasoningToolCall;
    private callbacks;
    constructor(callbacks?: StreamParseCallbacks);
    pushReasoningChunk(chunk: string): void;
    pushContentChunk(chunk: string): void;
    finalize(): StreamParseResult;
    private drainReasoningBuffer;
    private findPartialTagSuffix;
}
//# sourceMappingURL=streamParser.d.ts.map
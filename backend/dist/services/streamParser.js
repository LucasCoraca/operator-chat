"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamParser = void 0;
class StreamParser {
    static TOOL_CALL_OPEN_TAG = '<tool_call>';
    static TOOL_CALL_CLOSE_TAG = '</tool_call>';
    finalContent = '';
    finalChunks = [];
    reasoningContent = '';
    reasoningBuffer = '';
    inReasoningToolCall = false;
    callbacks;
    constructor(callbacks = {}) {
        this.callbacks = callbacks;
    }
    pushReasoningChunk(chunk) {
        if (!chunk) {
            return;
        }
        this.reasoningBuffer += chunk;
        const safeReasoning = this.drainReasoningBuffer(false);
        if (!safeReasoning) {
            return;
        }
        this.reasoningContent += safeReasoning;
        this.callbacks.onReasoningToken?.(safeReasoning);
    }
    pushContentChunk(chunk) {
        if (!chunk) {
            return;
        }
        // Pass through all content directly without parsing think blocks
        this.finalContent += chunk;
        this.finalChunks.push(chunk);
        this.callbacks.onContentToken?.(chunk);
    }
    finalize() {
        const safeReasoning = this.drainReasoningBuffer(true);
        if (safeReasoning) {
            this.reasoningContent += safeReasoning;
            this.callbacks.onReasoningToken?.(safeReasoning);
        }
        return {
            finalContent: this.finalContent,
            finalChunks: this.finalChunks,
            reasoningContent: this.reasoningContent,
        };
    }
    drainReasoningBuffer(isFinalFlush) {
        let output = '';
        const openTag = StreamParser.TOOL_CALL_OPEN_TAG;
        const closeTag = StreamParser.TOOL_CALL_CLOSE_TAG;
        while (this.reasoningBuffer.length > 0) {
            if (this.inReasoningToolCall) {
                const closeIndex = this.reasoningBuffer.indexOf(closeTag);
                if (closeIndex === -1) {
                    if (!isFinalFlush) {
                        const keepLength = Math.min(this.reasoningBuffer.length, closeTag.length - 1);
                        this.reasoningBuffer = this.reasoningBuffer.slice(-keepLength);
                    }
                    else {
                        this.reasoningBuffer = '';
                    }
                    break;
                }
                this.reasoningBuffer = this.reasoningBuffer.slice(closeIndex + closeTag.length);
                this.inReasoningToolCall = false;
                continue;
            }
            const openIndex = this.reasoningBuffer.indexOf(openTag);
            if (openIndex === -1) {
                if (isFinalFlush) {
                    output += this.reasoningBuffer;
                    this.reasoningBuffer = '';
                }
                else {
                    const partialLength = this.findPartialTagSuffix(this.reasoningBuffer, openTag);
                    if (partialLength > 0) {
                        const safeLength = this.reasoningBuffer.length - partialLength;
                        output += this.reasoningBuffer.slice(0, safeLength);
                        this.reasoningBuffer = this.reasoningBuffer.slice(safeLength);
                    }
                    else {
                        output += this.reasoningBuffer;
                        this.reasoningBuffer = '';
                    }
                }
                break;
            }
            if (openIndex > 0) {
                output += this.reasoningBuffer.slice(0, openIndex);
            }
            this.reasoningBuffer = this.reasoningBuffer.slice(openIndex + openTag.length);
            this.inReasoningToolCall = true;
        }
        return output;
    }
    findPartialTagSuffix(text, tag) {
        const start = Math.max(0, text.length - tag.length + 1);
        for (let index = start; index < text.length; index++) {
            if (tag.startsWith(text.slice(index))) {
                return text.length - index;
            }
        }
        return 0;
    }
}
exports.StreamParser = StreamParser;
//# sourceMappingURL=streamParser.js.map
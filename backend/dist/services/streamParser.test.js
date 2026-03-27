"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const streamParser_1 = require("./streamParser");
(0, node_test_1.default)('passes through all content directly without parsing think blocks', () => {
    const contentTokens = [];
    const parser = new streamParser_1.StreamParser({
        onContentToken: (token) => contentTokens.push(token),
    });
    parser.pushContentChunk('<thi');
    parser.pushContentChunk('nk>plan');
    parser.pushContentChunk('</th');
    parser.pushContentChunk('ink>answer');
    const result = parser.finalize();
    strict_1.default.equal(result.reasoningContent, '');
    strict_1.default.equal(result.finalContent, '<think>plan</think>answer');
    strict_1.default.deepEqual(result.finalChunks, ['<thi', 'nk>plan', '</th', 'ink>answer']);
    strict_1.default.deepEqual(contentTokens, ['<thi', 'nk>plan', '</th', 'ink>answer']);
});
(0, node_test_1.default)('keeps plain content as final answer', () => {
    const parser = new streamParser_1.StreamParser();
    parser.pushContentChunk('hello ');
    parser.pushContentChunk('world');
    const result = parser.finalize();
    strict_1.default.equal(result.reasoningContent, '');
    strict_1.default.equal(result.finalContent, 'hello world');
    strict_1.default.deepEqual(result.finalChunks, ['hello ', 'world']);
});
(0, node_test_1.default)('treats explicit reasoning chunks separately from regular content', () => {
    const reasoningTokens = [];
    const parser = new streamParser_1.StreamParser({
        onReasoningToken: (token) => reasoningTokens.push(token),
    });
    parser.pushReasoningChunk('step 1');
    parser.pushContentChunk('final');
    const result = parser.finalize();
    strict_1.default.equal(result.reasoningContent, 'step 1');
    strict_1.default.equal(result.finalContent, 'final');
    strict_1.default.deepEqual(result.finalChunks, ['final']);
    strict_1.default.deepEqual(reasoningTokens, ['step 1']);
});
(0, node_test_1.default)('passes through think tags as regular content', () => {
    const parser = new streamParser_1.StreamParser();
    parser.pushContentChunk('prefixpartial');
    const result = parser.finalize();
    strict_1.default.equal(result.finalContent, 'prefixpartial');
    strict_1.default.deepEqual(result.finalChunks, ['prefixpartial']);
    strict_1.default.equal(result.reasoningContent, '');
});
(0, node_test_1.default)('filters tool-call markup from reasoning_content', () => {
    const reasoningTokens = [];
    const parser = new streamParser_1.StreamParser({
        onReasoningToken: (token) => reasoningTokens.push(token),
    });
    parser.pushReasoningChunk('Let me check this first. ');
    parser.pushReasoningChunk('<tool_call><function=web_search><parameter=query>iran news');
    parser.pushReasoningChunk('</parameter></function></tool_call> Then summarize.');
    const result = parser.finalize();
    strict_1.default.equal(result.reasoningContent, 'Let me check this first.  Then summarize.');
    strict_1.default.deepEqual(reasoningTokens, ['Let me check this first. ', ' Then summarize.']);
});
(0, node_test_1.default)('filters split tool-call open tag in reasoning_content', () => {
    const parser = new streamParser_1.StreamParser();
    parser.pushReasoningChunk('Plan: ');
    parser.pushReasoningChunk('<tool');
    parser.pushReasoningChunk('_call>hidden</tool_call>');
    parser.pushReasoningChunk(' done');
    const result = parser.finalize();
    strict_1.default.equal(result.reasoningContent, 'Plan:  done');
});
//# sourceMappingURL=streamParser.test.js.map
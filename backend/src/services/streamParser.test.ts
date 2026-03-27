import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamParser } from './streamParser';

test('passes through all content directly without parsing think blocks', () => {
  const contentTokens: string[] = [];
  const parser = new StreamParser({
    onContentToken: (token) => contentTokens.push(token),
  });

  parser.pushContentChunk('<thi');
  parser.pushContentChunk('nk>plan');
  parser.pushContentChunk('</th');
  parser.pushContentChunk('ink>answer');

  const result = parser.finalize();

  assert.equal(result.reasoningContent, '');
  assert.equal(result.finalContent, '<think>plan</think>answer');
  assert.deepEqual(result.finalChunks, ['<thi', 'nk>plan', '</th', 'ink>answer']);
  assert.deepEqual(contentTokens, ['<thi', 'nk>plan', '</th', 'ink>answer']);
});

test('keeps plain content as final answer', () => {
  const parser = new StreamParser();

  parser.pushContentChunk('hello ');
  parser.pushContentChunk('world');

  const result = parser.finalize();

  assert.equal(result.reasoningContent, '');
  assert.equal(result.finalContent, 'hello world');
  assert.deepEqual(result.finalChunks, ['hello ', 'world']);
});

test('treats explicit reasoning chunks separately from regular content', () => {
  const reasoningTokens: string[] = [];
  const parser = new StreamParser({
    onReasoningToken: (token) => reasoningTokens.push(token),
  });

  parser.pushReasoningChunk('step 1');
  parser.pushContentChunk('final');

  const result = parser.finalize();

  assert.equal(result.reasoningContent, 'step 1');
  assert.equal(result.finalContent, 'final');
  assert.deepEqual(result.finalChunks, ['final']);
  assert.deepEqual(reasoningTokens, ['step 1']);
});

test('passes through think tags as regular content', () => {
  const parser = new StreamParser();

  parser.pushContentChunk('prefixpartial');

  const result = parser.finalize();

  assert.equal(result.finalContent, 'prefixpartial');
  assert.deepEqual(result.finalChunks, ['prefixpartial']);
  assert.equal(result.reasoningContent, '');
});

test('filters tool-call markup from reasoning_content', () => {
  const reasoningTokens: string[] = [];
  const parser = new StreamParser({
    onReasoningToken: (token) => reasoningTokens.push(token),
  });

  parser.pushReasoningChunk('Let me check this first. ');
  parser.pushReasoningChunk('<tool_call><function=web_search><parameter=query>iran news');
  parser.pushReasoningChunk('</parameter></function></tool_call> Then summarize.');

  const result = parser.finalize();

  assert.equal(result.reasoningContent, 'Let me check this first.  Then summarize.');
  assert.deepEqual(reasoningTokens, ['Let me check this first. ', ' Then summarize.']);
});

test('filters split tool-call open tag in reasoning_content', () => {
  const parser = new StreamParser();

  parser.pushReasoningChunk('Plan: ');
  parser.pushReasoningChunk('<tool');
  parser.pushReasoningChunk('_call>hidden</tool_call>');
  parser.pushReasoningChunk(' done');

  const result = parser.finalize();

  assert.equal(result.reasoningContent, 'Plan:  done');
});

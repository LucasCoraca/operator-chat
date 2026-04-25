import { LlamaClient, ChatMessage, ToolDefinition } from '../services/llamaClient';
import { ToolRegistry, ChatToolPreference, ToolExecutionPolicy } from '../tools';
import { parseAssistantMessage, ParsedBlock } from './xml-parser';
import fs from 'fs';
import path from 'path';

export type AgentMode = 'research_mode' | 'compose_reply_mode';
const TRANSITION_TO_COMPOSE_TOOL = 'transition_to_compose_mode';

export interface AgentStep {
  type: 'action' | 'observation' | 'final_answer' | 'mode_transition';
  content: string;
  actionName?: string;
  actionArgs?: Record<string, any>;
  targetMode?: AgentMode;
}

export interface AgentState {
  steps: AgentStep[];
  iteration: number;
  isComplete: boolean;
  finalAnswer: string | null;
  mode: AgentMode;
}

export interface ToolApprovalRequest {
  approvalId: string;
  toolName: string;
  toolArgs: Record<string, any>;
  policy: ToolExecutionPolicy;
}

export interface ToolApprovalResponse {
  approved: boolean;
  reason: 'approved' | 'denied' | 'cancelled';
}

export interface ChatApprovalMode {
  alwaysApprove: boolean;
}

export interface ChatPersonality {
  id: string;
  name: string;
  description: string;
  tone: string;
  systemPrompt: string;
  isCustom?: boolean;
}

import { ChatTimings } from '../services/llamaClient';

export interface AgentCallbacks {
  onStep: (step: AgentStep) => void;
  onError: (error: string) => void;
  onFinalAnswerToken?: (token: string) => void;
  onReasoningToken?: (token: string) => void;
  onDebugInfo?: (rawContent: string, parsed: any) => void;
  onCancelled?: () => void;
  onTimings?: (timings: ChatTimings) => void;
  onToolApprovalRequest?: (request: ToolApprovalRequest) => Promise<ToolApprovalResponse>;
  onStepSave?: (chatId: string, step: AgentStep, allSteps: AgentStep[]) => void;
  onPartialFinalAnswer?: (chatId: string, partialContent: string) => void;
}

interface ParsedAgentResponse {
  type: 'tool_call' | 'final_answer' | 'invalid' | 'mode_transition';
  toolName?: string;
  toolArgs?: Record<string, any>;
  finalAnswer?: string;
  targetMode?: AgentMode;
  failureReason?: string;
}

interface RetryDirective {
  requiredBlock: 'tool_call_or_final_answer' | 'tool_call' | 'final_answer';
  failureReason: string;
  retryToolName?: string;
}

interface InvalidTurnState {
  count: number;
}

class FinalAnswerStreamer {
  private inFinalAnswer = false;
  private emittedContent = '';
  private bufferedContent = ''; // Buffer content until we know it's valid
  private onToken: (token: string) => void;
  private shouldEmit: boolean = true; // Control whether to emit tokens
  private onPartialContent?: (content: string) => void;

  constructor(onToken: (token: string) => void, shouldEmit: boolean = true, onPartialContent?: (content: string) => void) {
    this.onToken = onToken;
    this.shouldEmit = shouldEmit;
    this.onPartialContent = onPartialContent;
  }

  push(chunk: string): void {
    if (!chunk) {
      return;
    }
    this.emit(chunk);
  }

  finalize(): void {
    // No-op: with native tool calling we stream plain text content directly.
  }

  getEmittedContent(): string {
    return this.emittedContent;
  }

  getBufferedContent(): string {
    return this.bufferedContent;
  }

  // Flush buffered content to the UI (call this when final_answer is validated)
  flushBufferedContent(): void {
    if (this.bufferedContent) {
      this.emittedContent += this.bufferedContent;
      this.onToken(this.bufferedContent);
      this.bufferedContent = '';
    }
  }

  private emit(text: string): void {
    if (!text) {
      return;
    }

    if (this.shouldEmit) {
      this.emittedContent += text;
      this.onToken(text);
      // Call onPartialContent callback to persist partial streaming content
      this.onPartialContent?.(this.emittedContent);
    } else {
      // Buffer the content instead of emitting
      this.bufferedContent += text;
    }
  }

  private drain(_isFinalFlush: boolean): void {}
}

export class ReActAgent {
  private llamaClient: LlamaClient;
  private toolRegistry: ToolRegistry;
  private maxIterations: number;
  private callbacks: AgentCallbacks;
  private debugLogFile: string;
  private abortController: AbortController | null = null;
  private isCancelled: boolean = false;
  private isRunning: boolean = false;
  private invalidTurnState: InvalidTurnState = { count: 0 };
  private personality: ChatPersonality | null = null;
  private currentMode: AgentMode = 'research_mode';
  private language: string = 'en';
  private model: string | undefined;

  constructor(
    llamaClient: LlamaClient,
    toolRegistry: ToolRegistry,
    maxIterations: number = 10,
    callbacks?: Partial<AgentCallbacks>,
    personality?: ChatPersonality | null,
    language?: string,
    model?: string
  ) {
    this.llamaClient = llamaClient;
    this.toolRegistry = toolRegistry;
    this.maxIterations = maxIterations;
    this.personality = personality || null;
    this.language = language || 'en';
    this.model = model;
    this.callbacks = {
      onStep: () => {},
      onError: () => {},
      onFinalAnswerToken: () => {},
      onReasoningToken: () => {},
      onDebugInfo: () => {},
      onCancelled: () => {},
      onTimings: () => {},
      ...callbacks,
    };
    
    // Create debug log file path
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.debugLogFile = path.join(__dirname, `../../debug-${timestamp}.log`);
  }

  private setMode(mode: AgentMode): void {
    this.currentMode = mode;
    this.logDebug(`Mode changed to: ${mode}`);
  }

  cancel(): void {
    this.isCancelled = true;
    this.isRunning = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.callbacks.onCancelled?.();
    this.logDebug('Agent cancelled by user');
  }

  isAgentRunning(): boolean {
    return this.isRunning;
  }

  private logDebug(message: string): void {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}`;
    console.log(logLine);
    try {
      fs.appendFileSync(this.debugLogFile, logLine + '\n');
    } catch (e) {
      // Ignore file write errors
    }
  }

  private looksLikeContinuation(content: string): boolean {
    const normalized = content.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return false;
    }

    const continuationPhrases = [
      'let me try',
      'let me check',
      'let me search',
      'let me look',
      'let me continue',
      'let me continue reading',
      'let me get more detailed information',
      'let me gather more information',
      "i'll try",
      "i will try",
      "i'll check",
      "i will check",
      "i'll search",
      "i will search",
      "i'll look",
      "i will look",
      'need more information',
      'get more information',
      'get more detailed information',
      'gather more information',
      'look for more information',
      'continue reading',
      'continue searching',
      'continue checking',
      'continue looking',
      'looking at a more comprehensive source',
      'looking at another source',
      'checking another source',
      'searching another source',
      'visiting another source',
      'more comprehensive source',
      'another source',
      'additional source',
      'try the other sources',
      'try other sources',
      'check the other sources',
      'search for more',
      'search other sources',
      'look at other sources',
      'look for other sources',
      'provide a comprehensive answer',
      'provide a complete answer',
      'to get more context',
      'to get more details',
      'to provide a better answer',
    ];

    if (continuationPhrases.some((phrase) => normalized.includes(phrase))) {
      return true;
    }

    const continuationPatterns = [
      /\blet me\b.*\b(continue|look|search|check|try|visit|read|browse|get|gather)\b/,
      /\b(i'll|i will)\b.*\b(continue|look|search|check|try|visit|read|browse|get|gather)\b/,
      /\bby (looking|searching|checking|visiting|reading|browsing)\b/,
      /\bcontinue (reading|searching|checking|looking|browsing)\b/,
      /\b(other|another|additional|more comprehensive)\s+source/,
      /\b(get|gather|find)\b.*\b(more information|more details|more context)\b/,
    ];

    // Keep the heuristic narrow: only continuation-like short responses are auto-classified.
    return normalized.length <= 300 && continuationPatterns.some((pattern) => pattern.test(normalized));
  }

  private parseTaggedResponse(content: string, forceFinalAnswer: boolean, currentIteration: number = 0): ParsedAgentResponse {
    const trimmed = content.trim();

    if (!trimmed) {
      return {
        type: 'invalid',
        failureReason: 'Your response was empty. Provide a tool call or a final answer.',
      };
    }

    const knownTools = this.toolRegistry.getTools().map(t => t.name);
    const blocks = parseAssistantMessage(trimmed, knownTools);

    const finalAnswerBlock = blocks.find(b => b.type === 'final_answer');
    const toolUseBlock = blocks.find(b => b.type === 'tool_use');

    const toolUseBlocks = blocks.filter(b => b.type === 'tool_use');
    const finalAnswerBlocks = blocks.filter(b => b.type === 'final_answer');

    if (toolUseBlocks.length > 1) {
      return {
        type: 'invalid',
        failureReason: 'Your response included multiple tool calls. Use exactly one tool call per response.',
      };
    }

    if (finalAnswerBlocks.length > 1) {
      return {
        type: 'invalid',
        failureReason: 'Your response included multiple invalid blocks. Output exactly one valid block.',
      };
    }

    if (Number(Boolean(toolUseBlock)) + Number(Boolean(finalAnswerBlock)) > 1) {
      return {
        type: 'invalid',
        failureReason: 'Your response included conflicting formats. Provide one clear response.',
      };
    }

    if (this.currentMode === 'research_mode' && finalAnswerBlock) {
      return {
        type: 'invalid',
        failureReason: `You are in research_mode. Do not answer the user yet. Continue researching with tools or call ${TRANSITION_TO_COMPOSE_TOOL} when research is complete.`,
      };
    }

    if (this.currentMode === 'compose_reply_mode' && toolUseBlock) {
      return {
        type: 'invalid',
        failureReason: 'You are in compose_reply_mode. You cannot make tool calls. Provide a direct final answer.',
      };
    }

    if (forceFinalAnswer && toolUseBlock) {
      if (this.currentMode === 'research_mode') {
        return {
          type: 'invalid',
          failureReason: 'You emitted a tool call when a response was expected.',
        };
      }
      return {
        type: 'invalid',
        failureReason: 'You emitted a tool call on a forced final-answer turn. Provide a direct final answer instead.',
      };
    }

    if (toolUseBlock) {
      return {
        type: 'tool_call',
        toolName: toolUseBlock.content,
        toolArgs: toolUseBlock.params,
      };
    }

    if (finalAnswerBlock) {
      return {
        type: 'final_answer',
        finalAnswer: finalAnswerBlock.content,
      };
    }

    if (this.currentMode === 'research_mode') {
      if (this.looksLikeContinuation(trimmed)) {
        return {
          type: 'invalid',
          failureReason: `You described more research in prose instead of taking the next action. Call the next tool directly, or call ${TRANSITION_TO_COMPOSE_TOOL} if research is complete.`,
        };
      }

      return {
        type: 'invalid',
        failureReason: `You are still in research_mode. Plain assistant text is not allowed yet. Call a tool or call ${TRANSITION_TO_COMPOSE_TOOL}.`,
      };
    }

    return {
      type: 'final_answer',
      finalAnswer: trimmed,
    };
  }

  private parseStreamedResponse(
    streamedResult: { finalContent: string; toolCall?: { name: string; arguments: string } },
    forceFinalAnswer: boolean,
    currentIteration: number = 0
  ): ParsedAgentResponse {
    if (streamedResult.toolCall?.name) {
      if (streamedResult.toolCall.name === TRANSITION_TO_COMPOSE_TOOL) {
        if (this.currentMode !== 'research_mode') {
          return {
            type: 'invalid',
            failureReason: `Tool call '${TRANSITION_TO_COMPOSE_TOOL}' is only allowed in research_mode.`,
          };
        }

        return {
          type: 'mode_transition',
          targetMode: 'compose_reply_mode',
        };
      }

      let parsedArgs: Record<string, any> = {};
      if (streamedResult.toolCall.arguments) {
        try {
          parsedArgs = JSON.parse(streamedResult.toolCall.arguments);
        } catch {
          return {
            type: 'invalid',
            failureReason: `Tool call arguments for '${streamedResult.toolCall.name}' were not valid JSON.`,
          };
        }
      }

      if (forceFinalAnswer || this.currentMode === 'compose_reply_mode') {
        return {
          type: 'invalid',
          failureReason: `Tool call '${streamedResult.toolCall.name}' is not allowed on this turn.`,
        };
      }

      return {
        type: 'tool_call',
        toolName: streamedResult.toolCall.name,
        toolArgs: parsedArgs,
      };
    }

    return this.parseTaggedResponse(streamedResult.finalContent, forceFinalAnswer, currentIteration);
  }

  private getRetryDirective(parsedResponse: ParsedAgentResponse, forceFinalAnswer: boolean): RetryDirective {
    const retryToolName = this.extractInvalidToolName(parsedResponse.failureReason);

    if (forceFinalAnswer) {
      return {
        requiredBlock: this.currentMode === 'research_mode' ? 'tool_call' : 'final_answer',
        failureReason:
          parsedResponse.failureReason ||
          (this.currentMode === 'research_mode'
            ? `This is the last research turn. Call ${TRANSITION_TO_COMPOSE_TOOL} now so the next turn can compose the answer.`
            : 'This was a forced final-answer turn, so you must provide a direct final answer.'),
        retryToolName,
      };
    }

    const failureReason = parsedResponse.failureReason || 'Your response was invalid.';

    return {
      requiredBlock: 'tool_call_or_final_answer',
      failureReason,
      retryToolName,
    };
  }

  private extractInvalidToolName(failureReason?: string): string | undefined {
    if (!failureReason) {
      return undefined;
    }

    const match = failureReason.match(/Tool call arguments for '([^']+)'/);
    return match?.[1];
  }

  private recordInvalidTurn(): number {
    this.invalidTurnState.count += 1;
    return this.invalidTurnState.count;
  }

  private resetInvalidTurnState(): void {
    this.invalidTurnState.count = 0;
  }

  private replaceLatestCorrection(state: AgentState, content: string): void {
    // Remove any previous "Invalid agent turn" observation to avoid a long chain
    // of corrections, but always ensure the NEW correction is at the very end
    // of the steps to avoid assistant prefill issues.
    for (let index = state.steps.length - 1; index >= 0; index--) {
      const step = state.steps[index];
      if (step.type === 'observation' && step.content.startsWith('Invalid agent turn:')) {
        state.steps.splice(index, 1);
        break; // Only remove the latest one to keep it simple
      }
    }

    state.steps.push({
      type: 'observation',
      content,
    });
  }

  private buildCorrectionMessage(retryDirective: RetryDirective, retryCount: number): string {
    const malformedToolRetry = retryDirective.retryToolName
      ? `Retry the native tool call \`${retryDirective.retryToolName}\` now with a valid JSON object for its arguments. Output only the tool call, no prose.`
      : null;

    if (this.currentMode === 'research_mode') {
      if (retryCount >= 3) {
        return `Invalid agent turn: ${retryDirective.failureReason}

Retry #${retryCount}: ${malformedToolRetry || `use native function calling only. Either call the next research tool, or call ${TRANSITION_TO_COMPOSE_TOOL} when research is complete.`}`;
      }

      return `Invalid agent turn: ${retryDirective.failureReason}

Retry #${retryCount}: ${malformedToolRetry || 'use native function calling only. Do not output plain assistant text in research_mode.'}`;
    } else {
      if (retryCount >= 3) {
        return `Invalid agent turn: ${retryDirective.failureReason}

Retry #${retryCount}: provide a plain final answer now. Do not call tools.`;
      }

      return `Invalid agent turn: ${retryDirective.failureReason}

Retry #${retryCount}: provide a plain final answer (normal assistant text), no tool calls.`;
    }
  }

  private async emitFinalAnswerChunks(chunks: string[]): Promise<void> {
    for (const chunk of chunks) {
      if (!chunk) {
        continue;
      }

      this.callbacks.onFinalAnswerToken!(chunk);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  private getEnabledToolNames(toolPreferences?: Record<string, ChatToolPreference>): string[] {
    if (!toolPreferences) {
      return this.toolRegistry.getTools().map((tool) => tool.name);
    }

    return Object.entries(toolPreferences)
      .filter(([, preference]) => preference.enabled)
      .map(([toolName]) => toolName);
  }

  private getToolDefinitions(toolPreferences?: Record<string, ChatToolPreference>): ToolDefinition[] {
    const enabledToolNames = this.getEnabledToolNames(toolPreferences);
    const definitions = this.toolRegistry.getFilteredToolDefinitions(enabledToolNames);

    if (this.currentMode === 'research_mode' && enabledToolNames.length > 0) {
      definitions.push({
        type: 'function',
        function: {
          name: TRANSITION_TO_COMPOSE_TOOL,
          description: 'Call this only when research is complete and you are ready to stop using tools and compose the final answer for the user.',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
      });
    }

    return definitions;
  }

  private isToolAutoApproved(
    toolName: string,
    toolPreferences?: Record<string, ChatToolPreference>
  ): boolean {
    if (!toolPreferences) {
      return false;
    }

    return Boolean(toolPreferences[toolName]?.autoApprove);
  }

  private shouldBypassApproval(
    toolName: string,
    toolPreferences?: Record<string, ChatToolPreference>,
    approvalMode?: ChatApprovalMode
  ): boolean {
    if (approvalMode?.alwaysApprove) {
      return true;
    }

    return this.isToolAutoApproved(toolName, toolPreferences);
  }

  private getLanguageInstruction(): string {
    const languageInstructions: Record<string, string> = {
      'en': 'You MUST respond in English. All your responses and thoughts must be in English.',
      'es': 'DEBES responder en español. Todas tus respuestas y pensamientos deben ser en español.',
      'fr': 'Vous DEVEZ répondre en français. Toutes vos réponses et pensées doivent être en français.',
      'de': 'Sie MÜSSEN auf Deutsch antworten. Alle Ihre Antworten und Gedanken müssen auf Deutsch sein.',
      'it': 'DEVI rispondere in italiano. Tutte le tue risposte e pensieri devono essere in italiano.',
      'pt': 'Você DEVE responder em português. Todas as suas respostas e pensamentos devem ser em português.',
      'ru': 'Вы ДОЛЖНЫ отвечать на русском языке. Все ваши ответы и мысли должны быть на русском языке.',
      'ja': '日本語で回答しなければなりません。すべての回答と思考は日本語でなければなりません。',
      'ko': '한국어로 답변해야 합니다. 모든 답변과 생각은 한국어여야 합니다.',
      'zh': '你必须用中文回答。所有回答和思考都必须用中文。'
    };

    return languageInstructions[this.language] || languageInstructions['en'];
  }

  private getSystemPrompt(
    forceFinalAnswer: boolean = false,
    toolPreferences?: Record<string, ChatToolPreference>,
    memories: string[] = [],
    currentIteration: number = 0
  ): string {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const timeStr = now.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    });
    const dateTime = `${dateStr}, ${timeStr}`;

    const enabledToolNames = this.getEnabledToolNames(toolPreferences);
    const toolsAvailable = this.toolRegistry.getFilteredTools(enabledToolNames).length > 0;

    // Build personality section
    let personalitySection = '';
    if (this.personality) {
      personalitySection = `\n\n## PERSONALITY: ${this.personality.name}\n${this.personality.systemPrompt}\n\n`;
    }

    // Build memory section
    let memorySection = '';
    if (memories.length > 0) {
      memorySection = `\n\n## MEMORY (Things you remembered from previous conversations):
${memories.map((m, i) => `${i + 1}. ${m}`).join('\n')}

Use this information to provide a more personalized experience and avoid asking for things you already know. 
IMPORTANT: These memories may contain historical dates or information. Always use the "Current Date" provided at the top of this prompt as the definitive current time.\n\n`;
    }

    const finalAnswerWarning = forceFinalAnswer
      ? this.currentMode === 'research_mode'
        ? `\n\n## URGENT\nThis is the last research turn. Do NOT provide the final answer yet. Your only valid action is to call the native tool \`${TRANSITION_TO_COMPOSE_TOOL}\` so the next turn can compose the final answer.`
        : '\n\n## URGENT\nProvide your best final answer now. Do not call tools on this turn.'
      : '';

    // Add iterations remaining context
    const iterationsRemaining = this.maxIterations - currentIteration;
    const iterationsContext = `\n\n## ITERATIONS REMAINING: ${iterationsRemaining} / ${this.maxIterations}\nUse your iterations wisely. The system will automatically transition to the next phase when you reach the iteration limit.`;

    return `Knowledge Cutoff: December 2023
Current Date: ${dateTime}
${iterationsContext}

${this.getLanguageInstruction()}

You are a helpful AI assistant.${toolsAvailable ? ' You have access to tools.' : ' No tools are enabled for this turn, so answer directly without tool calls.'}
${personalitySection}${memorySection}

## TOOL CALLING
- Use native function tool calling when you need tools.
- Use only structured tool calls for tools.
- Do not assume that normal assistant text is safe to emit unless the mode instructions below explicitly allow it.
- If ${forceFinalAnswer ? 'you are on a forced turn' : 'you still need more data'}, ${
      forceFinalAnswer
        ? this.currentMode === 'research_mode'
          ? `do not answer the user directly; call \`${TRANSITION_TO_COMPOSE_TOOL}\``
          : 'do not call tools'
        : 'call tools instead of describing tool usage in prose'
    }.

${this.currentMode === 'research_mode' ? `
## MODE
You are in RESEARCH_MODE.
- Your job is to gather information, inspect files, and execute tool calls.
- Do NOT provide the final answer to the user in this mode.
- Do NOT output ordinary assistant prose as your main response in this mode.
- When research is complete and you are ready to answer, call the native tool \`${TRANSITION_TO_COMPOSE_TOOL}\`.
- If you still need information, call the next tool directly using native function calling.
- On the final research turn, call \`${TRANSITION_TO_COMPOSE_TOOL}\` immediately. Do not answer in prose.

## SOURCE CITATION REQUIREMENT
When you use web_search or browser_visit tools, you must it is imperative to do so cite sources in your final response with URL and title/description.

Format citations like this at the end of your answer:

**Sources:**
- [Title or description](URL)
- [Title or description](URL)

Or inline like: "According to [Source Name](URL), ..."

This is REQUIRED for any factual claims, statistics, news, or information obtained from web searches or browsing.

## SANDBOX ENVIRONMENT
You have access to a secure sandbox environment where you can:
- Execute Python code safely using the python_execute tool
- Read, write, and modify files in the sandbox directory
- The sandbox path is available via the SANDBOX_PATH environment variable when running Python

When users ask you to modify, transform, or process files, you SHOULD use Python code to do so. This is the preferred approach for:
- Converting file formats (CSV to JSON, XML to JSON, etc.)
- Data transformation and manipulation
- Text processing and file modifications
- Any complex file operations

## FILE DOWNLOADS
When you create or modify a file that the user might want to download, you should mention the file name in your response. The user can download files from the sandbox by clicking the download button next to the file in the Sandbox Files panel.

In your response, you can reference downloadable files like this:
- "I've created output.json - you can download it from the Sandbox Files panel"
- "The converted file data.csv is ready for download"
- "Check the Sandbox Files panel to download result.txt"
` : ''}

${this.currentMode === 'compose_reply_mode' ? `
## MODE
You are in COMPOSE_REPLY_MODE.
- Do not call tools.
- Synthesize the best final answer from gathered observations.
- Output the final answer as normal assistant text.

## SOURCE CITATION REQUIREMENT
When you use web_search or browser_visit tools, you must it is imperative to do so cite sources in your final response.

Always use inline sources like this: "[Source Name](URL), ..."

This is REQUIRED for any factual claims, statistics, news, or information obtained from web searches or browsing.

` : ''}

Be helpful, thorough, and use tools effectively when needed.${finalAnswerWarning}`;
  }

  private buildConversationHistory(
    userMessage: string,
    state: AgentState,
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [],
    forceFinalAnswer: boolean = false,
    toolPreferences?: Record<string, ChatToolPreference>,
    memories: string[] = []
  ): ChatMessage[] {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: this.getSystemPrompt(forceFinalAnswer, toolPreferences, memories, state.iteration),
      },
    ];

    // Add conversation history (previous conversations)
    for (const msg of conversationHistory) {
      messages.push({
        role: msg.role,
        content: msg.content,
      });
    }

    // Add current user message
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const timeStr = now.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    });
    const dateTime = `${dateStr}, ${timeStr}`;

    messages.push({
      role: 'user',
      content: `[Current Date: ${dateTime}]\n\n${userMessage}`,
    });

    // Add conversation history from previous steps (current agent run)
    // For native tool calling, replay action/observation as assistant tool_call + tool result.
    let pendingToolCall:
      | { id: string; name: string; args: Record<string, any> }
      | null = null;
    let toolCallCounter = 0;

    for (const step of state.steps) {
      if (this.currentMode === 'compose_reply_mode') {
        if (step.type === 'observation') {
          messages.push({
            role: 'user',
            content: `Tool result:\n${step.content}`,
          });
        } else if (step.type === 'mode_transition') {
          messages.push({
            role: 'user',
            content: `Mode transition: ${step.content}`,
          });
        } else if (step.type === 'final_answer') {
          messages.push({
            role: 'assistant',
            content: step.content,
          });
        }
        continue;
      }

      if (step.type === 'action' && step.actionName && step.actionArgs) {
        toolCallCounter += 1;
        pendingToolCall = {
          id: `toolcall-${toolCallCounter}`,
          name: step.actionName,
          args: step.actionArgs,
        };
        continue;
      }

      if (step.type === 'observation' && pendingToolCall) {
        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: pendingToolCall.id,
              type: 'function',
              function: {
                name: pendingToolCall.name,
                arguments: JSON.stringify(pendingToolCall.args),
              },
            },
          ],
        });
        messages.push({
          role: 'tool',
          content: step.content,
          tool_call_id: pendingToolCall.id,
        });
        pendingToolCall = null;
        continue;
      }

      if (step.type === 'observation') {
        messages.push({
          role: 'user',
          content: `Tool result:\n${step.content}`,
        });
      } else if (step.type === 'final_answer') {
        messages.push({
          role: 'assistant',
          content: step.content,
        });
      }
    }

    return messages;
  }

  async run(
    chatId: string,
    userMessage: string,
    sandboxId: string,
    userId: string,
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [],
    memories: string[] = [],
    toolPreferences?: Record<string, ChatToolPreference>,
    approvalMode?: ChatApprovalMode
  ): Promise<AgentState> {
    const state: AgentState = {
      steps: [],
      iteration: 0,
      isComplete: false,
      finalAnswer: null,
      mode: this.getEnabledToolNames(toolPreferences).length > 0 ? 'research_mode' : 'compose_reply_mode',
    };

    this.setMode(state.mode);

    // Set running state and create AbortController for cancellation
    this.isRunning = true;
    this.abortController = new AbortController();

    try {
      this.logDebug('========================================');
      this.logDebug(`Starting agent run for: "${userMessage.substring(0, 100)}..."`);
      this.logDebug(`Sandbox: ${sandboxId}`);
      this.logDebug(`User: ${userId}`);
      this.logDebug(`Max iterations: ${this.maxIterations}`);
      this.logDebug('========================================');

      while (state.iteration < this.maxIterations && !state.isComplete && !this.isCancelled) {
        state.iteration++;

        // Check for cancellation at start of each iteration
        if (this.isCancelled) {
          this.logDebug('Agent cancelled - stopping execution');
          break;
        }

        // Force final answer on the last iteration
        const forceFinalAnswer = state.iteration >= this.maxIterations - 1;
        if (forceFinalAnswer) {
          this.logDebug(`\n--- ITERATION ${state.iteration} (FORCING FINAL ANSWER) ---`);
        } else {
          this.logDebug(`\n--- ITERATION ${state.iteration} ---`);
        }

        // Build conversation history
        const messages = this.buildConversationHistory(
          userMessage,
          state,
          conversationHistory,
          forceFinalAnswer,
          toolPreferences,
          memories
        );
        this.logDebug(`Messages count: ${messages.length}`);
        const shouldEmitFinalAnswer = this.currentMode === 'compose_reply_mode';
        const finalAnswerStreamer = new FinalAnswerStreamer((token) => {
          this.callbacks.onFinalAnswerToken!(token);
        }, shouldEmitFinalAnswer, shouldEmitFinalAnswer
          ? (partialContent) => this.callbacks.onPartialFinalAnswer?.(chatId, partialContent)
          : undefined);

        const streamedResult = await this.llamaClient.chatStream(
          messages,
          (timings) => {
            // Forward timing data to frontend
            if (timings) {
              this.callbacks.onTimings!(timings);
            }
          },
          this.abortController,
          this.currentMode === 'compose_reply_mode'
            ? undefined
            : this.getToolDefinitions(toolPreferences),
          { 
            onReasoningToken: (token) => {
              this.callbacks.onReasoningToken!(token);
            },
            onContentToken: (token) => {
              finalAnswerStreamer.push(token);
            },
            model: this.model,
          }
        );
        finalAnswerStreamer.finalize();
        const bufferedContent = streamedResult.finalContent;
        const parsedResponse = this.parseStreamedResponse(streamedResult, forceFinalAnswer, state.iteration);

        this.logDebug(`\nLLM TAGGED OUTPUT (${streamedResult.finalContent.length} chars):`);
        this.logDebug(streamedResult.finalContent.substring(0, 500) + (streamedResult.finalContent.length > 500 ? '...' : ''));
        this.logDebug(`LLM REASONING OUTPUT (${streamedResult.reasoningContent.length} chars):`);
        this.logDebug(streamedResult.reasoningContent.substring(0, 500) + (streamedResult.reasoningContent.length > 500 ? '...' : ''));

        // Emit debug info to frontend
        this.callbacks.onDebugInfo!(JSON.stringify(streamedResult), parsedResponse);

        if (streamedResult.reasoningContent.trim()) {
          // Log reasoning content but don't create a step for it
          this.logDebug(`Reasoning content: ${streamedResult.reasoningContent.substring(0, 200)}...`);
        }

        if (parsedResponse.type === 'invalid') {
          const invalidTurnThought = bufferedContent.trim();
          const retryDirective = this.getRetryDirective(parsedResponse, forceFinalAnswer);
          const retryCount = this.recordInvalidTurn();
          const correctiveObservation = this.buildCorrectionMessage(retryDirective, retryCount);

          this.logDebug(`Detected invalid agent turn; retrying with correction: ${parsedResponse.failureReason}`);

          const knownTools = this.toolRegistry.getTools().map(t => t.name);
          const hasToolTag = knownTools.some(tool => invalidTurnThought.includes(`<${tool}`));
          
          const shouldRecordInvalidOutput =
            invalidTurnThought &&
            !hasToolTag &&
            invalidTurnThought.length > 0;

          // Invalid turn thoughts are not saved as steps

          this.replaceLatestCorrection(state, correctiveObservation);
          const step: AgentStep = {
            type: 'observation',
            content: correctiveObservation,
          };
          // Add to state for agent context, but don't send to UI
          this.callbacks.onStepSave?.(chatId, step, [...state.steps]);

          // Don't count invalid turns as iterations
          state.iteration--;

          if (forceFinalAnswer) {
            // Instead of erroring, transition to compose mode
            this.logDebug('Invalid response during forceFinalAnswer - transitioning to compose_reply_mode');
            
            if (this.currentMode === 'research_mode') {
              this.setMode('compose_reply_mode');
              
              const modeStep: AgentStep = {
                type: 'mode_transition',
                content: `Unable to produce valid response. Transitioning to compose_reply_mode to provide the best answer with gathered information.`,
                targetMode: 'compose_reply_mode',
              };
              state.steps.push(modeStep);
              this.callbacks.onStep(modeStep);
              this.callbacks.onStepSave?.(chatId, modeStep, [...state.steps]);
              
              // Add summary observation
              const observations = state.steps
                .filter(step => step.type === 'observation')
                .map(step => step.content);
              
              if (observations.length > 0) {
                const summaryObservation = `## COMPOSING FINAL ANSWER

Based on the information gathered:

${observations.map((obs, idx) => `### Observation ${idx + 1}:\n${obs}`).join('\n\n')}

---
Now compose your final answer as normal assistant text.`;
                
                const summaryStep: AgentStep = {
                  type: 'observation',
                  content: summaryObservation,
                };
                state.steps.push(summaryStep);
                this.callbacks.onStep(summaryStep);
                this.callbacks.onStepSave?.(chatId, summaryStep, [...state.steps]);
              }
              
              // Force one more iteration in compose mode
              state.iteration++;
              
              const messages = this.buildConversationHistory(
                userMessage,
                state,
                conversationHistory,
                true, // forceFinalAnswer
                toolPreferences,
                memories
              );
              
              const finalAnswerStreamer = new FinalAnswerStreamer((token) => {
                this.callbacks.onFinalAnswerToken!(token);
              }, true, (partialContent) => this.callbacks.onPartialFinalAnswer?.(chatId, partialContent));

              const streamedResult = await this.llamaClient.chatStream(
                messages,
                (timings) => {
                  if (timings) {
                    this.callbacks.onTimings!(timings);
                  }
                },
                this.abortController,
                undefined,
                { 
                  onReasoningToken: (token) => {
                    this.callbacks.onReasoningToken!(token);
                  },
                  onContentToken: (token) => {
                    finalAnswerStreamer.push(token);
                  },
                  model: this.model,
                }
              );
              finalAnswerStreamer.finalize();
              
              const parsedResponse = this.parseStreamedResponse(streamedResult, true, state.iteration);
              
              if (parsedResponse.type === 'final_answer' && parsedResponse.finalAnswer) {
                state.finalAnswer = parsedResponse.finalAnswer;
                const finalStep: AgentStep = {
                  type: 'final_answer',
                  content: state.finalAnswer,
                };
                state.steps.push(finalStep);
                this.callbacks.onStep(finalStep);
                this.callbacks.onStepSave?.(chatId, finalStep, [...state.steps]);
                state.isComplete = true;
                await this.emitFinalAnswerChunks([state.finalAnswer]);
              } else {
                // Fallback
                state.finalAnswer = 'Based on my research, I was unable to provide a complete answer. Here is what I found: ' + 
                  (observations.length > 0 ? observations[observations.length - 1].substring(0, 500) : 'No information gathered.');
                const finalStep: AgentStep = {
                  type: 'final_answer',
                  content: state.finalAnswer,
                };
                state.steps.push(finalStep);
                this.callbacks.onStep(finalStep);
                this.callbacks.onStepSave?.(chatId, finalStep, [...state.steps]);
                state.isComplete = true;
                await this.emitFinalAnswerChunks([state.finalAnswer]);
              }
            } else {
              // Already in compose mode, provide fallback answer
              const observations = state.steps
                .filter(step => step.type === 'observation')
                .map(step => step.content);
              
              state.finalAnswer = 'I was unable to produce a complete answer within the iteration limit. Here is what I found: ' + 
                (observations.length > 0 ? observations[observations.length - 1].substring(0, 500) : 'No information gathered.');
              const finalStep: AgentStep = {
                type: 'final_answer',
                content: state.finalAnswer,
              };
              state.steps.push(finalStep);
              this.callbacks.onStep(finalStep);
              this.callbacks.onStepSave?.(chatId, finalStep, [...state.steps]);
              state.isComplete = true;
              await this.emitFinalAnswerChunks([state.finalAnswer]);
            }
            break;
          }

          continue;
        }


        // Handle mode transition from research_mode to compose_reply_mode
        if (parsedResponse.type === 'mode_transition') {
          this.resetInvalidTurnState();
          this.logDebug(`Mode transition detected: ${this.currentMode} -> ${parsedResponse.targetMode}`);
          
          // Change mode
          this.setMode('compose_reply_mode');
          
          // Add mode transition step
          const modeStep: AgentStep = {
            type: 'mode_transition',
            content: `Transitioning from research_mode to compose_reply_mode. All gathered information will now be used to compose the final answer.`,
            targetMode: 'compose_reply_mode',
          };
          state.steps.push(modeStep);
          this.callbacks.onStep({
            type: 'mode_transition',
            content: `Transitioning from research_mode to compose_reply_mode.`,
            targetMode: 'compose_reply_mode',
          });
          this.callbacks.onStepSave?.(chatId, modeStep, [...state.steps]);
          
          // Add observation summarizing all gathered information for compose_reply_mode
          const observations = state.steps
            .filter(step => step.type === 'observation')
            .map(step => step.content);
          
          if (observations.length > 0) {
            const summaryObservation = `## RESEARCH PHASE COMPLETE - COMPOSING FINAL ANSWER

You have gathered the following information from your research:

${observations.map((obs, idx) => `### Observation ${idx + 1}:\n${obs}`).join('\n\n')}

---
Now compose your final answer using all the information above as normal assistant text.`;
            
            const summaryStep: AgentStep = {
              type: 'observation',
              content: summaryObservation,
            };
            state.steps.push(summaryStep);
            this.callbacks.onStep(summaryStep);
            this.callbacks.onStepSave?.(chatId, summaryStep, [...state.steps]);
          }
          
          continue;
        }

        if (parsedResponse.type === 'tool_call' && parsedResponse.toolName && parsedResponse.toolArgs) {
          this.resetInvalidTurnState();
          this.logDebug(`Tool call detected: ${parsedResponse.toolName}`);
          this.logDebug(`Args: ${JSON.stringify(parsedResponse.toolArgs)}`);

          // Cast numeric/boolean arguments if model returned them as strings
          const toolDef = this.toolRegistry.getTool(parsedResponse.toolName);
          if (toolDef && toolDef.parameters) {
            for (const [key, paramDef] of Object.entries(toolDef.parameters)) {
              const value = parsedResponse.toolArgs[key];
              if (typeof value === 'string') {
                if (paramDef.type === 'number') {
                  const num = Number(value);
                  if (!isNaN(num)) {
                    parsedResponse.toolArgs[key] = num;
                  }
                } else if (paramDef.type === 'boolean') {
                   parsedResponse.toolArgs[key] = value.toLowerCase() === 'true';
                }
              }
            }
          }

          const toolPolicy = this.toolRegistry.getToolPolicy(parsedResponse.toolName);
          if (!toolPolicy) {
            const missingToolObservation = `Error: Unknown tool '${parsedResponse.toolName}'.`;
            state.steps.push({
              type: 'observation',
              content: missingToolObservation,
            });
            this.callbacks.onStep({
              type: 'observation',
              content: missingToolObservation,
            });
            continue;
          }

          const actionStep: AgentStep = {
            type: 'action',
            content: parsedResponse.toolName,
            actionName: parsedResponse.toolName,
            actionArgs: parsedResponse.toolArgs,
          };
          state.steps.push(actionStep);
          this.callbacks.onStep(actionStep);
          this.callbacks.onStepSave?.(chatId, actionStep, [...state.steps]);

          if (toolPolicy.requiresApproval && !this.shouldBypassApproval(parsedResponse.toolName, toolPreferences, approvalMode)) {
            const waitingForApprovalObservation = `Awaiting user approval for tool '${parsedResponse.toolName}' before execution.`;
            const approvalStep: AgentStep = {
              type: 'observation',
              content: waitingForApprovalObservation,
            };
            state.steps.push(approvalStep);
            this.callbacks.onStep(approvalStep);
            this.callbacks.onStepSave?.(chatId, approvalStep, [...state.steps]);

            const approvalResponse = await this.callbacks.onToolApprovalRequest?.({
              approvalId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
              toolName: parsedResponse.toolName,
              toolArgs: parsedResponse.toolArgs,
              policy: toolPolicy,
            });

            if (!approvalResponse?.approved) {
              const deniedObservation = `Tool execution denied by user for '${parsedResponse.toolName}'.`;
              this.logDebug(deniedObservation);
              const deniedStep: AgentStep = {
                type: 'observation',
                content: deniedObservation,
              };
              state.steps.push(deniedStep);
              this.callbacks.onStep(deniedStep);
              this.callbacks.onStepSave?.(chatId, deniedStep, [...state.steps]);
              continue;
            }
          }

          const observation = await this.toolRegistry.executeTool(
            parsedResponse.toolName,
            parsedResponse.toolArgs,
            { sandboxId, userId },
            this.getEnabledToolNames(toolPreferences)
          );
          this.logDebug(`\nEXECUTING TOOL: ${parsedResponse.toolName}`);
          this.logDebug(`Tool observation (${observation.length} chars): ${observation.substring(0, 300)}...`);

          const obsStep: AgentStep = {
            type: 'observation',
            content: observation,
          };
          state.steps.push(obsStep);
          this.callbacks.onStep(obsStep);
          this.callbacks.onStepSave?.(chatId, obsStep, [...state.steps]);
          continue;
        }

        if (parsedResponse.type === 'final_answer') {
          this.resetInvalidTurnState();
          const finalAnswerContent = parsedResponse.finalAnswer || '';
          const streamedFinalAnswer = finalAnswerStreamer.getEmittedContent();
          if (!streamedFinalAnswer) {
            await this.emitFinalAnswerChunks([finalAnswerContent]);
          } else if (finalAnswerContent.startsWith(streamedFinalAnswer)) {
            const remaining = finalAnswerContent.slice(streamedFinalAnswer.length);
            if (remaining) {
              await this.emitFinalAnswerChunks([remaining]);
            }
          }

          const finalStep: AgentStep = {
            type: 'final_answer',
            content: finalAnswerContent,
          };
          state.steps.push(finalStep);
          this.callbacks.onStep(finalStep);
          this.callbacks.onStepSave?.(chatId, finalStep, [...state.steps]);
          state.isComplete = true;
          state.finalAnswer = finalAnswerContent;
          this.logDebug(`Final answer received, breaking loop. isComplete=${state.isComplete}`);
          break;
        }
      }

      // Log final summary
      this.logDebug('\n========================================');
      this.logDebug(`AGENT RUN COMPLETE`);
      this.logDebug(`Iterations: ${state.iteration}`);
      this.logDebug(`Complete: ${state.isComplete}`);
      this.logDebug(`Final Answer: ${state.finalAnswer?.substring(0, 200)}...`);
      this.logDebug(`Total steps: ${state.steps.length}`);
      this.logDebug(`Debug log file: ${this.debugLogFile}`);
      this.logDebug('========================================\n');

      // Check if we hit max iterations - transition to compose mode instead of erroring
      if (!state.isComplete) {
        this.logDebug('Max iterations reached - transitioning to compose_reply_mode');
        
        // If still in research_mode, transition to compose_reply_mode
        if (this.currentMode === 'research_mode') {
          this.setMode('compose_reply_mode');
          
          // Add mode transition step
          const modeStep: AgentStep = {
            type: 'mode_transition',
            content: `Maximum iterations reached. Transitioning to compose_reply_mode to provide the best answer with gathered information.`,
            targetMode: 'compose_reply_mode',
          };
          state.steps.push(modeStep);
          this.callbacks.onStep(modeStep);
          this.callbacks.onStepSave?.(chatId, modeStep, [...state.steps]);
          
          // Add summary observation of all gathered information
          const observations = state.steps
            .filter(step => step.type === 'observation')
            .map(step => step.content);
          
          if (observations.length > 0) {
            const summaryObservation = `## ITERATION LIMIT REACHED - COMPOSING FINAL ANSWER

You have reached the maximum number of iterations. Based on the information gathered so far:

${observations.map((obs, idx) => `### Observation ${idx + 1}:\n${obs}`).join('\n\n')}

---
Now compose your final answer using all the information above as normal assistant text.`;
            
            const summaryStep: AgentStep = {
              type: 'observation',
              content: summaryObservation,
            };
            state.steps.push(summaryStep);
            this.callbacks.onStep(summaryStep);
            this.callbacks.onStepSave?.(chatId, summaryStep, [...state.steps]);
          }
          
          // Force one more iteration to get the final answer in compose mode
          state.iteration++;
          const forceFinalAnswer = true;
          
          const messages = this.buildConversationHistory(
            userMessage,
            state,
            conversationHistory,
            forceFinalAnswer,
            toolPreferences,
            memories
          );
          
          const shouldEmitFinalAnswer = true; // In compose mode, emit directly
          const finalAnswerStreamer = new FinalAnswerStreamer((token) => {
            this.callbacks.onFinalAnswerToken!(token);
          }, shouldEmitFinalAnswer, (partialContent) => this.callbacks.onPartialFinalAnswer?.(chatId, partialContent));

              const streamedResult = await this.llamaClient.chatStream(
                messages,
                (timings) => {
                  if (timings) {
                    this.callbacks.onTimings!(timings);
                  }
                },
                this.abortController,
                undefined,
                { 
                  onReasoningToken: (token) => {
                    this.callbacks.onReasoningToken!(token);
                  },
                  onContentToken: (token) => {
                    finalAnswerStreamer.push(token);
                  },
                  model: this.model,
                }
              );
          finalAnswerStreamer.finalize();
          
          const parsedResponse = this.parseStreamedResponse(streamedResult, true);
          
          if (parsedResponse.type === 'final_answer' && parsedResponse.finalAnswer) {
            state.finalAnswer = parsedResponse.finalAnswer;
            const finalStep: AgentStep = {
              type: 'final_answer',
              content: state.finalAnswer,
            };
            state.steps.push(finalStep);
            this.callbacks.onStep(finalStep);
            this.callbacks.onStepSave?.(chatId, finalStep, [...state.steps]);
            state.isComplete = true;
            await this.emitFinalAnswerChunks([state.finalAnswer]);
          } else {
            // Fallback if no valid final answer
            state.finalAnswer = 'Based on my research, I was unable to provide a complete answer within the iteration limit. Here is what I found: ' + 
              (observations.length > 0 ? observations[observations.length - 1].substring(0, 500) : 'No information gathered.');
            const finalStep: AgentStep = {
              type: 'final_answer',
              content: state.finalAnswer,
            };
            state.steps.push(finalStep);
            this.callbacks.onStep(finalStep);
            this.callbacks.onStepSave?.(chatId, finalStep, [...state.steps]);
            state.isComplete = true;
            await this.emitFinalAnswerChunks([state.finalAnswer]);
          }
        } else {
          // Already in compose mode, just force final answer
          state.finalAnswer = 'I was unable to complete the task within the maximum number of iterations. Please try rephrasing your question or breaking it into smaller parts.';
          const finalStep: AgentStep = {
            type: 'final_answer',
            content: state.finalAnswer,
          };
          state.steps.push(finalStep);
          this.callbacks.onStep(finalStep);
          this.callbacks.onStepSave?.(chatId, finalStep, [...state.steps]);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.callbacks.onError(errorMessage);
      this.isRunning = false;
      throw error;
    } finally {
      // Always reset running state when done
      this.isRunning = false;
      this.logDebug('Agent run finished, isRunning set to false');
    }

    return state;
  }
}

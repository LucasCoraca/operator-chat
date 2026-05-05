import { LlamaClient, ChatMessage, ToolDefinition } from '../services/llamaClient';
import { ToolRegistry, ChatToolPreference, ToolExecutionPolicy } from '../tools';
import { WorkspaceConfig } from '../services/workspaceRuntime';
import { parseAssistantMessage, ParsedBlock } from './xml-parser';
import {
  analyzeReadCache,
  formatFileIndex,
  formatPointerObservation,
  wrapObservationWithFileView,
  findCachedCoverage,
  FileViewAnalysis,
} from './fileViewCache';
import { AgentRunTask } from '../repositories/agentRunTaskRepository';
import fs from 'fs';
import path from 'path';

export type AgentMode = 'research_mode' | 'compose_reply_mode';
const TRANSITION_TO_COMPOSE_TOOL = 'transition_to_compose_mode';

export interface AgentStep {
  type: 'action' | 'observation' | 'tool_progress' | 'final_answer' | 'mode_transition' | 'thought';
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

export interface CreateAgentRunRequest {
  title: string;
  prompt: string;
  workspaceRoot: string;
}

export interface ReActAgentOptions {
  disableMaxIterations?: boolean;
  runId?: string;
  contextWindowTokens?: number;
  reservedOutputTokens?: number;
  autoCompactThreshold?: number;
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
  onCreateAgentRun?: (request: CreateAgentRunRequest) => Promise<string>;
  onStepSave?: (chatId: string, step: AgentStep, allSteps: AgentStep[]) => void;
  onPartialFinalAnswer?: (chatId: string, partialContent: string) => void;
  onSharedContextRequest?: (request: AgentContextRequest) => Promise<string | undefined>;
  onContextPressure?: (request: AgentContextPressureRequest) => Promise<string | undefined>;
  onAgentTasksUpdated?: (chatId: string, agentRunId: string, tasks: AgentRunTask[]) => void;
  onTasksRequest?: (chatId: string, agentRunId: string) => Promise<AgentRunTask[]>;
}

export interface AgentContextRequest {
  chatId: string;
  runId?: string;
  state: AgentState;
  tokenEstimate?: number;
}

export interface AgentContextPressureRequest extends AgentContextRequest {
  tokenEstimate: number;
  thresholdTokens: number;
  maxPromptTokens: number;
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
  private options: ReActAgentOptions;
  private activeState: AgentState | null = null;
  private activeChatId: string | null = null;
  private pendingUserMessages: string[] = [];

  constructor(
    llamaClient: LlamaClient,
    toolRegistry: ToolRegistry,
    maxIterations: number = 10,
    callbacks?: Partial<AgentCallbacks>,
    personality?: ChatPersonality | null,
    language?: string,
    model?: string,
    options: ReActAgentOptions = {}
  ) {
    this.llamaClient = llamaClient;
    this.toolRegistry = toolRegistry;
    this.maxIterations = maxIterations;
    this.personality = personality || null;
    this.language = language || 'en';
    this.model = model;
    this.options = options;
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

  public addUserMessage(message: string): boolean {
    const trimmed = message.trim();
    if (!trimmed) {
      return false;
    }

    const step: AgentStep = {
      type: 'observation',
      content: `User Message: ${trimmed}`,
    };

    if (this.activeState && this.activeChatId) {
      this.activeState.steps.push(step);
      this.callbacks.onStep(step);
      this.callbacks.onStepSave?.(this.activeChatId, step, [...this.activeState.steps]);
      return true;
    }

    this.pendingUserMessages.push(trimmed);
    return true;
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

  private truncateForPrompt(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
      return content;
    }

    return `${content.slice(0, maxLength)}\n\n[Observation truncated before composing the final answer.]`;
  }

  private compactObservationForPrompt(step: AgentStep): AgentStep {
    if (step.type !== 'observation') {
      return step;
    }

    // Canonical cached reads (already bounded by the read tool's own line/length limits)
    // must not be truncated — chopping them is what drives the model to re-read.
    if (step.content.startsWith('<file_view ')) {
      return step;
    }

    return {
      ...step,
      content: this.truncateForPrompt(step.content, 24000),
    };
  }

  private applyFileViewReplacements(steps: AgentStep[], analysis: FileViewAnalysis): AgentStep[] {
    if (analysis.replacements.size === 0) {
      return steps;
    }

    return steps.map((step, index) => {
      if (step.type !== 'observation') {
        return step;
      }
      const replacement = analysis.replacements.get(index);
      if (!replacement) {
        return step;
      }
      if (replacement.kind === 'pointer') {
        return {
          ...step,
          content: formatPointerObservation(replacement),
        };
      }
      return {
        ...step,
        content: wrapObservationWithFileView(step.content, replacement),
      };
    });
  }

  private getStepsForPrompt(state: AgentState, sharedContext?: string, analysis?: FileViewAnalysis): AgentStep[] {
    const compactedSteps = analysis
      ? this.applyFileViewReplacements(state.steps, analysis)
      : state.steps;

    if (!this.options.disableMaxIterations || !sharedContext?.trim()) {
      return compactedSteps;
    }

    const maxRawSteps = 30;
    if (compactedSteps.length <= maxRawSteps) {
      return compactedSteps;
    }

    return [
      {
        type: 'observation',
        content: `[Earlier agent steps omitted from raw replay. Use <shared_agent_context> for compacted chat-level history. Keeping the latest ${maxRawSteps} raw steps below.]`,
      },
      ...compactedSteps.slice(-maxRawSteps),
    ];
  }

  private isSyntheticSummaryObservation(content: string): boolean {
    return content.startsWith('## COMPOSING FINAL ANSWER') ||
      content.startsWith('## RESEARCH PHASE COMPLETE') ||
      content.startsWith('## ITERATION LIMIT REACHED') ||
      content.startsWith('__agent_run_started__:');
  }

  private drainPendingUserMessages(chatId: string, state: AgentState): void {
    const pendingMessages = this.pendingUserMessages.splice(0);
    for (const message of pendingMessages) {
      const step: AgentStep = {
        type: 'observation',
        content: `User Message: ${message}`,
      };
      state.steps.push(step);
      this.callbacks.onStep(step);
      this.callbacks.onStepSave?.(chatId, step, [...state.steps]);
    }
  }

  private getComposableObservations(state: AgentState): string[] {
    const observations: string[] = [];
    let totalLength = 0;
    const maxTotalLength = 24000;

    for (const step of state.steps) {
      if (step.type !== 'observation' || this.isSyntheticSummaryObservation(step.content)) {
        continue;
      }

      const observation = this.truncateForPrompt(step.content, 4000);
      if (totalLength + observation.length > maxTotalLength) {
        observations.push('[Additional observations were omitted to keep final-answer context bounded.]');
        break;
      }

      observations.push(observation);
      totalLength += observation.length;
    }

    return observations;
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

  private getToolActionIndexes(state: AgentState, toolNames?: string[]): number[] {
    return state.steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.type === 'action' && (!toolNames || toolNames.includes(step.actionName || '')))
      .map(({ index }) => index);
  }

  private getLastObservationAfter(state: AgentState, actionIndex: number): string {
    for (let index = actionIndex + 1; index < state.steps.length; index++) {
      const step = state.steps[index];
      if (step.type === 'action') {
        break;
      }
      if (step.type === 'observation') {
        return step.content;
      }
    }
    return '';
  }

  private normalizeAgentPath(filePath: string, workspace?: WorkspaceConfig): string {
    let normalized = filePath.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
    const root = workspace?.ssh?.root?.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
    if (root && normalized.startsWith(`${root}/`)) {
      normalized = normalized.slice(root.length + 1);
    }
    return normalized.replace(/^\.\//, '');
  }

  private getDuplicateReadObservation(state: AgentState, args: Record<string, any>, workspace?: WorkspaceConfig): string | null {
    const filePath = String(args.path || '').trim();
    if (!filePath) {
      return null;
    }

    const normalizedPath = this.normalizeAgentPath(filePath, workspace);
    const offset = Math.max(1, Number(args.offset || 1));
    const limit = Math.max(1, Number(args.limit || 300));

    // Exclude the just-pushed action step from analysis.
    const stepsForAnalysis = state.steps.slice(0, -1);
    const analysis = analyzeReadCache(stepsForAnalysis, {
      normalizePath: (p) => this.normalizeAgentPath(p, workspace),
    });

    const hit = findCachedCoverage(
      { path: normalizedPath, offset, limit },
      analysis.files
    );
    if (!hit) {
      return null;
    }

    const canonicalStep = state.steps[hit.canonicalStepIndex];
    if (!canonicalStep || canonicalStep.type !== 'observation' || !canonicalStep.content) {
      return null;
    }

    // Serve the cached content directly. The model gets exactly what it asked for —
    // no SSH round-trip, no truncated skip message that drives a retry loop.
    const banner = `[Cached read served for ${normalizedPath} lines ${hit.range.startLine}-${hit.range.endLine} (revision ${hit.revision}). No SSH round-trip was made; this content is identical to the earlier read.]`;
    return `${banner}\n\n${canonicalStep.content}`;
  }

  private validateComposeReadiness(
    state: AgentState,
    toolPreferences?: Record<string, ChatToolPreference>,
    workspace?: WorkspaceConfig
  ): string | null {
    const enabledToolNames = this.getEnabledToolNames(toolPreferences);
    const isSpawnedRemoteAgent = workspace?.type === 'ssh_remote'
      && workspace.ssh?.enabled
      && !enabledToolNames.includes('create_agent');
    if (!isSpawnedRemoteAgent) {
      return null;
    }

    const actionIndexes = this.getToolActionIndexes(state);
    if (actionIndexes.length === 0) {
      return 'You have not used any remote tools yet. Continue with the next concrete tool call instead of composing a final answer.';
    }

    const modificationIndexes = this.getToolActionIndexes(state, ['write', 'edit', 'apply_patch']);
    if (modificationIndexes.length > 0) {
      const lastModificationIndex = modificationIndexes[modificationIndexes.length - 1];
      const laterVerification = state.steps
        .slice(lastModificationIndex + 1)
        .some((step) => step.type === 'action' && ['bash', 'read', 'grep'].includes(step.actionName || ''));
      if (!laterVerification) {
        return 'You modified files but have not inspected or verified the result afterward. Run a bounded verification command or read/search the changed files before composing.';
      }
    }

    const bashIndexes = this.getToolActionIndexes(state, ['bash']);
    if (bashIndexes.length > 0) {
      const lastBashObservation = this.getLastObservationAfter(state, bashIndexes[bashIndexes.length - 1]);
      if (lastBashObservation.includes('Status: still running in background terminal') || lastBashObservation.includes('__OPERATOR_CHAT_BACKGROUND__')) {
        return 'The last command is still running in a managed background terminal. Use terminal_read, terminal_list, or terminal_kill as appropriate before composing.';
      }
    }

    return null;
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

 /**
   * Build the static portion of the system prompt — content that never changes
   * across iterations of the same agent run. This is the longest stable prefix
   * and should be memoized by the caller so llama.cpp can cache it.
   */
  private getStaticSystemPrompt(
    toolPreferences?: Record<string, ChatToolPreference>,
    workspace?: WorkspaceConfig
  ): string {
    const enabledToolNames = this.getEnabledToolNames(toolPreferences);
    const toolsAvailable = this.toolRegistry.getFilteredTools(enabledToolNames).length > 0;
    const canCreateAgent = enabledToolNames.includes('create_agent');
    const remoteToolNames = enabledToolNames.filter((toolName) => ['list', 'read', 'glob', 'grep', 'bash', 'terminal_list', 'terminal_read', 'terminal_kill', 'write', 'edit', 'apply_patch', 'memory_get', 'memory_set', 'memory_checkpoint', 'task_create', 'task_update', 'task_list'].includes(toolName));
    const workspaceSection = workspace?.type === 'ssh_remote' && workspace.ssh?.enabled
      ? canCreateAgent
        ? `\n\n## ACTIVE WORKSPACE\nThe system has SSH credentials for a remote environment.\n- Default host: ${workspace.ssh.username}@${workspace.ssh.host}:${workspace.ssh.port || 22}\n- Default workspace root: ${workspace.ssh.root}\n- For any request to run commands, inspect a codebase, edit files, implement changes, fix bugs, continue previous remote work, or delegate coding work, call \`create_agent\` with a title, a complete prompt, and the absolute remote workspaceRoot. Do not tell the user to run commands manually.\n- The \`create_agent\` prompt must include clear \`Success Criteria\`, \`Non-goals\`, and \`Required Verification\` sections. Define what solved means, what should not be investigated, and the bounded checks the coding agent should run before stopping.\n- The created agent is separate from this chat response and its live trace will appear in the conversation.\n- Answer directly only for conceptual questions that do not require remote workspace inspection, command execution, or file edits.\n`
        : `\n\n## ACTIVE WORKSPACE\nYou are the spawned SSH coding agent for a remote environment.\n- Host: ${workspace.ssh.username}@${workspace.ssh.host}:${workspace.ssh.port || 22}\n- Workspace root: ${workspace.ssh.root}\n- Your enabled remote tools are: ${remoteToolNames.join(', ') || 'none'}.\n- Continue using the remote tools to inspect files, run commands, edit files, and verify the task. Do not tell the user to run commands manually when a tool can do it.\n- Use \`list\`, \`glob\`, \`grep\`, and \`read\` for inspection. Use \`edit\`, \`write\`, and \`apply_patch\` for file modifications. Use \`bash\` for builds, tests, and commands.\n- Before reading a file, consult \`<file_index>\` at the end of the conversation: it lists every file already read in this run with its cached line ranges and revision number. Each cached read is preserved as a \`<file_view path="..." revision="..." lines="A-B">\` block earlier in the context — refer to that block instead of issuing a duplicate \`read\`. The runtime auto-skips reads whose range is already covered, and auto-invalidates cached views when you call \`write\`/\`edit\`/\`apply_patch\` on that file (the index marks them STALE). External content changes are detected by overlap-hash mismatch and also bump the revision. Use \`grep\` or a non-overlapping \`offset\` when you genuinely need new lines; do not re-read a range that is already in \`<file_index>\`.\n- Before starting non-trivial multi-step work, call \`task_create\` once per planned step to lay out a checklist. As you begin a task, call \`task_update\` with status="in_progress"; when finished, call again with status="completed". Use \`task_list\` to recall the plan when uncertain. The user sees this checklist live in the agent trace box, so keep subjects short and imperative ("Add migration for X", "Wire socket event"). Do not use task_create for trivial single-step requests.
- Use \`memory_get\` when you need to recall project state, file summaries, commands, errors, or prior progress. Use \`memory_checkpoint\` after major milestones, after several file edits, before compaction, and before the final answer.\n- Do not rewrite files already represented in backend memory unless you are intentionally changing their content. If you need to recall what you wrote, call \`memory_get\` instead of \`write\` or \`read\`.\n- Treat any \`User Message:\` observation in your trace as direct steering from the user for this running coding agent.\n- Follow the parent chat's \`Success Criteria\`, \`Non-goals\`, and \`Required Verification\` from your task prompt. When those success criteria are met and the required verification passes, stop tool use and compose the final answer. Do not continue investigating non-goals or unrelated anomalies.\n- Do not call \`${TRANSITION_TO_COMPOSE_TOOL}\` while implementation, file creation, file edits, dependency installation, tests, or verification remain. Keep calling tools instead.\n- If you modify files with \`write\`, \`edit\`, or \`apply_patch\`, inspect or verify afterward with \`read\`, \`grep\`, or \`bash\` before composing the final answer.\n- If a \`bash\` command starts a long-running process, it may return a background terminal id instead of blocking. Use \`terminal_read\` to inspect later output, \`terminal_list\` to find running terminals, and \`terminal_kill\` to stop a terminal when needed. Keep \`terminal_read\` bounded with tailLines/maxBytes.\n- Prefer file-editing tools over shell redirection for code changes. Pass \`workdir\` to \`bash\` instead of using \`cd\`.\n- Treat this as a real remote machine: avoid destructive commands unless explicitly needed and approved.\n`
      : `\n\n## ACTIVE WORKSPACE\nSSH agent mode is not available because no remote workspace is configured in Settings. If the user asks you to run commands, inspect a codebase, edit files, or start an agent, explain that the remote workspace must first be configured in Settings with a host/IP, username, workspace root, and SSH key.\n`;

    // Build personality section
    let personalitySection = '';
    if (this.personality) {
      personalitySection = `\n\n## PERSONALITY: ${this.personality.name}\n${this.personality.systemPrompt}\n\n`;
    }

    // Build mode-specific sections (static per mode, doesn't change within a mode)
    const modeSection = this.currentMode === 'research_mode' ? `

## MODE
You are in RESEARCH_MODE.
- Your job is to gather information, inspect files, and execute tool calls.
- Do NOT provide the final answer to the user in this mode.
- Do NOT output ordinary assistant prose as your main response in this mode.
- When research is complete and you are ready to answer, call the native tool \`${TRANSITION_TO_COMPOSE_TOOL}\`.
- If you still need information, call the next tool directly using native function calling.
- Only call \`${TRANSITION_TO_COMPOSE_TOOL}\` after the requested work is complete and any edits have been verified.

## SOURCE CITATION REQUIREMENT
When you use web_search or browser_visit tools, you must it is imperative to do so cite sources in your final response with URL and title/description.

Format citations like this at the end of your answer:

**Sources:**
- [Title or description](URL)
- [Title or description](URL)

Or inline like: "According to [Source Name](URL), ..."

This is REQUIRED for any factual claims, statistics, news, or information obtained from web searches or browsing.

${workspace?.type === 'ssh_remote' && workspace.ssh?.enabled ? '' : `## SANDBOX ENVIRONMENT
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
`}
` : '';

    const composeSection = this.currentMode === 'compose_reply_mode' ? `

## MODE
You are in COMPOSE_REPLY_MODE.
- Do not call tools.
- Synthesize the best final answer from gathered observations.
- Output the final answer as normal assistant text.

## SOURCE CITATION REQUIREMENT
When you use web_search or browser_visit tools, you must it is imperative to do so cite sources in your final response.

Always use inline sources like this: "[Source Name](URL), ..."

This is REQUIRED for any factual claims, statistics, news, or information obtained from web searches or browsing.

` : '';

    return `Knowledge Cutoff: December 2023

${this.getLanguageInstruction()}

You are a helpful AI assistant.${toolsAvailable ? ' You have access to tools.' : ' No tools are enabled for this turn, so answer directly without tool calls.'}
${workspaceSection}${personalitySection}

## TOOL CALLING
- Use native function tool calling when you need tools.
- Use only structured tool calls for tools.
- Do not assume that normal assistant text is safe to emit unless the mode instructions below explicitly allow it.
- call tools instead of describing tool usage in prose.
${modeSection}${composeSection}

Be helpful, thorough, and use tools effectively when needed.`;
  }

  /**
   * Build the dynamic portion of the system prompt — content that changes every
   * iteration (date, iteration count, force-final-answer warning). Short and
   * placed after the static prefix so it doesn't invalidate the llama.cpp KV-cache.
   */
  private getDynamicSystemPrompt(
    forceFinalAnswer: boolean = false,
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

    // Build memory section (rarely changes, but tracked as dynamic)
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

    const iterationsRemaining = this.maxIterations - currentIteration;
    const iterationsContext = this.options.disableMaxIterations
      ? `\n\n## AGENT LOOP\nIteration: ${currentIteration}. There is no automatic compose step for unfinished coding work. Continue tool execution until the requested task is actually complete, or until the user stops the agent.`
      : `\n\n## ITERATIONS REMAINING: ${iterationsRemaining} / ${this.maxIterations}\nUse your iterations wisely. The system will automatically transition to the next phase when you reach the iteration limit.`;

    return `Knowledge Cutoff: December 2023
Current Date: ${dateTime}
${iterationsContext}${memorySection}${finalAnswerWarning}`;
  }

  /**
   * Build a trailing user message containing dynamic state (date, iteration,
   * force-final-answer). Goes at the END of the message sequence so the static
   * system prompt and conversation history remain cached. Returns null if empty.
   */
  private getDynamicStateMessage(
    forceFinalAnswer: boolean = false,
    currentIteration: number = 0
  ): ChatMessage | null {
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

    const parts: string[] = [];
    parts.push(`Current date/time: ${dateTime}`);

    if (!this.options.disableMaxIterations) {
      const iterationsRemaining = this.maxIterations - currentIteration;
      parts.push(`Iterations remaining: ${iterationsRemaining} / ${this.maxIterations}`);
    } else {
      parts.push(`Iteration: ${currentIteration}. No automatic compose step.`);
    }

    if (forceFinalAnswer) {
      const warning = this.currentMode === 'research_mode'
        ? 'URGENT: This is the last research turn. Call transition_to_compose_mode now.'
        : 'URGENT: Provide your best final answer now. Do not call tools.';
      parts.push(warning);
    }

    if (parts.length === 0) return null;

    return {
      role: 'user',
      content: parts.join('\n\n'),
    };
  }

  private getSystemPrompt(
    forceFinalAnswer: boolean = false,
    toolPreferences?: Record<string, ChatToolPreference>,
    memories: string[] = [],
    currentIteration: number = 0,
    workspace?: WorkspaceConfig
  ): string {
    // Backward compatible: combines static + dynamic for any code that still
    // calls this method directly. The buildConversationHistory method now
    // uses the split approach (static in system, dynamic in trailing user msg).
    const staticPrompt = this.getStaticSystemPrompt(toolPreferences, workspace);
    const dynamicPrompt = this.getDynamicSystemPrompt(forceFinalAnswer, memories, currentIteration);
    return staticPrompt + '\n\n' + dynamicPrompt;
  }

  private buildConversationHistory(
    userMessage: string,
    state: AgentState,
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [],
    forceFinalAnswer: boolean = false,
    toolPreferences?: Record<string, ChatToolPreference>,
    memories: string[] = [],
    workspace?: WorkspaceConfig,
    sharedContext?: string,
    tasks: AgentRunTask[] = []
  ): ChatMessage[] {
    // llama.cpp requires exactly one system message at position 0.
    // Use the static system prompt (identity, tools, workspace, mode) which
    // never changes. Dynamic content (date, iteration count, force-final-
    // answer) is injected as a trailing user message so it doesn't invalidate
    // the KV-cache prefix.
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: this.getStaticSystemPrompt(toolPreferences, workspace),
      },
    ];

    // Add conversation history (previous conversations)
    for (const msg of conversationHistory) {
      messages.push({
        role: msg.role,
        content: msg.content,
      });
    }

    if (sharedContext?.trim()) {
      messages.push({
        role: 'user',
        content: `<shared_agent_context>\n${sharedContext.trim()}\n</shared_agent_context>`,
      });
    }

    // Add current user message (date moved to trailing dynamic state block)
    messages.push({
      role: 'user',
      content: userMessage,
    });

    const fileViewAnalysis = analyzeReadCache(state.steps, {
      normalizePath: (rawPath: string) => this.normalizeAgentPath(rawPath, workspace),
    });

    // Add conversation history from previous steps (current agent run)
    // For native tool calling, replay action/observation as assistant tool_call + tool result.
    let pendingToolCall:
      | { id: string; name: string; args: Record<string, any> }
      | null = null;
    let toolCallCounter = 0;

    for (const originalStep of this.getStepsForPrompt(state, sharedContext, fileViewAnalysis)) {
      const step = this.compactObservationForPrompt(originalStep);
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

    const fileIndexText = formatFileIndex(fileViewAnalysis.files);
    if (fileIndexText) {
      messages.push({
        role: 'user',
        content: `<file_index>
The following files have already been read in this run. Their content is preserved in <file_view> blocks above. Do NOT re-read these ranges; consult the existing <file_view> instead, or use grep for a targeted lookup.
${fileIndexText}
</file_index>`,
      });
    }

    if (tasks.length > 0) {
      const lines = tasks.map((task) => {
        const marker =
          task.status === 'completed' ? '[x]' : task.status === 'in_progress' ? '[~]' : '[ ]';
        const desc = task.description ? `\n      ${task.description.split('\n').join('\n      ')}` : '';
        return `${marker} ${task.id}  ${task.subject}${desc}`;
      });
      messages.push({
        role: 'user',
        content: `<task_list>
This is the live checklist for this agent run, persisted in the database and visible to the user. It is preserved across context compaction. Treat it as your source of truth for what you are doing. Mark a task in_progress with task_update before starting it; mark it completed when finished. Do not abandon in_progress tasks; pick them back up after detours.
${lines.join('\n')}
</task_list>`,
      });
    }

    // Add trailing dynamic state message (date, iteration, force-final-answer)
    // This goes at the very end so the static system prompt and conversation
    // history remain cacheable by llama.cpp.
    const dynamicState = this.getDynamicStateMessage(forceFinalAnswer, state.iteration);
    if (dynamicState) {
      messages.push(dynamicState);
    }

    return messages;
  }

  private getContextBudget(): { maxPromptTokens?: number; thresholdTokens?: number } {
    const contextWindowTokens = Number(this.options.contextWindowTokens || 0);
    if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
      return {};
    }

    const reservedOutputTokens = Math.max(0, Number(this.options.reservedOutputTokens ?? 10000));
    const maxPromptTokens = Math.max(1000, contextWindowTokens - reservedOutputTokens);
    const autoCompactThreshold = Math.min(0.98, Math.max(0.1, Number(this.options.autoCompactThreshold ?? 0.82)));
    return {
      maxPromptTokens,
      thresholdTokens: Math.floor(maxPromptTokens * autoCompactThreshold),
    };
  }

  private async buildManagedConversationHistory(
    chatId: string,
    userMessage: string,
    state: AgentState,
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [],
    forceFinalAnswer: boolean = false,
    toolPreferences?: Record<string, ChatToolPreference>,
    memories: string[] = [],
    workspace?: WorkspaceConfig
  ): Promise<ChatMessage[]> {
    let sharedContext = await this.callbacks.onSharedContextRequest?.({
      chatId,
      runId: this.options.runId,
      state,
    });

    const tasks = this.options.runId && this.callbacks.onTasksRequest
      ? await this.callbacks.onTasksRequest(chatId, this.options.runId).catch((error) => {
          this.logDebug(`onTasksRequest failed: ${error instanceof Error ? error.message : String(error)}`);
          return [] as AgentRunTask[];
        })
      : [];

    let messages = this.buildConversationHistory(
      userMessage,
      state,
      conversationHistory,
      forceFinalAnswer,
      toolPreferences,
      memories,
      workspace,
      sharedContext,
      tasks
    );

    const { maxPromptTokens, thresholdTokens } = this.getContextBudget();
    if (!maxPromptTokens || !thresholdTokens || !this.callbacks.onContextPressure) {
      return messages;
    }

    const tokenEstimate = await this.llamaClient.countChatTokens(messages);
    if (tokenEstimate < thresholdTokens) {
      return messages;
    }

    const compactedContext = await this.callbacks.onContextPressure({
      chatId,
      runId: this.options.runId,
      state,
      tokenEstimate,
      thresholdTokens,
      maxPromptTokens,
    });

    if (!compactedContext?.trim()) {
      return messages;
    }

    sharedContext = compactedContext;
    messages = this.buildConversationHistory(
      userMessage,
      state,
      conversationHistory,
      forceFinalAnswer,
      toolPreferences,
      memories,
      workspace,
      sharedContext,
      tasks
    );

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
    approvalMode?: ChatApprovalMode,
    workspace?: WorkspaceConfig
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
    this.activeState = state;
    this.activeChatId = chatId;

    try {
      this.logDebug('========================================');
      this.logDebug(`Starting agent run for: "${userMessage.substring(0, 100)}..."`);
      this.logDebug(`Sandbox: ${sandboxId}`);
      this.logDebug(`User: ${userId}`);
      this.logDebug(`Max iterations: ${this.options.disableMaxIterations ? 'disabled' : this.maxIterations}`);
      this.logDebug('========================================');

      while ((this.options.disableMaxIterations || state.iteration < this.maxIterations) && !state.isComplete && !this.isCancelled) {
        state.iteration++;
        this.drainPendingUserMessages(chatId, state);

        // Check for cancellation at start of each iteration
        if (this.isCancelled) {
          this.logDebug('Agent cancelled - stopping execution');
          break;
        }

        const forceFinalAnswer = !this.options.disableMaxIterations && state.iteration >= this.maxIterations - 1;
        if (forceFinalAnswer) {
          this.logDebug(`\n--- ITERATION ${state.iteration} (FORCING FINAL ANSWER) ---`);
        } else {
          this.logDebug(`\n--- ITERATION ${state.iteration} ---`);
        }

        // Build conversation history
        const messages = await this.buildManagedConversationHistory(
          chatId,
          userMessage,
          state,
          conversationHistory,
          forceFinalAnswer,
          toolPreferences,
          memories,
          workspace
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
              const observations = this.getComposableObservations(state);
              
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
              
              const messages = await this.buildManagedConversationHistory(
                chatId,
                userMessage,
                state,
                conversationHistory,
                true, // forceFinalAnswer
                toolPreferences,
                memories,
                workspace
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
              const observations = this.getComposableObservations(state);
              
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
          const readinessError = this.validateComposeReadiness(state, toolPreferences, workspace);
          if (readinessError) {
            const correctiveObservation = `Cannot enter compose mode yet: ${readinessError}`;
            this.logDebug(correctiveObservation);
            this.replaceLatestCorrection(state, correctiveObservation);
            const step: AgentStep = {
              type: 'observation',
              content: correctiveObservation,
            };
            this.callbacks.onStepSave?.(chatId, step, [...state.steps]);
            state.iteration--;
            continue;
          }

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
          const observations = this.getComposableObservations(state);
          
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

          const enabledToolNames = this.getEnabledToolNames(toolPreferences);
          if (!enabledToolNames.includes(parsedResponse.toolName)) {
            const availableNames = enabledToolNames.length > 0 ? enabledToolNames.join(', ') : 'none';
            const disabledToolObservation = `Error: Unknown or disabled tool '${parsedResponse.toolName}'. Available tools: ${availableNames}`;
            state.steps.push({
              type: 'observation',
              content: disabledToolObservation,
            });
            this.callbacks.onStep({
              type: 'observation',
              content: disabledToolObservation,
            });
            this.callbacks.onStepSave?.(chatId, state.steps[state.steps.length - 1], [...state.steps]);
            continue;
          }

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

          if (parsedResponse.toolName === 'read') {
            const duplicateReadObservation = this.getDuplicateReadObservation(state, parsedResponse.toolArgs, workspace);
            if (duplicateReadObservation) {
              this.logDebug(duplicateReadObservation);
              const duplicateStep: AgentStep = {
                type: 'observation',
                content: duplicateReadObservation,
              };
              state.steps.push(duplicateStep);
              this.callbacks.onStep(duplicateStep);
              this.callbacks.onStepSave?.(chatId, duplicateStep, [...state.steps]);
              continue;
            }
          }

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
            {
              sandboxId,
              userId,
              chatId,
              agentRunId: this.options.runId,
              model: this.model,
              workspace,
              agentMemory: this.toolRegistry.agentMemoryService,
              createAgentRun: this.callbacks.onCreateAgentRun,
              emitToolProgress: (content: string) => {
                this.callbacks.onStep({
                  type: 'tool_progress',
                  content,
                  actionName: parsedResponse.toolName,
                });
              },
              emitAgentTasksUpdated: this.callbacks.onAgentTasksUpdated,
            },
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
          if (parsedResponse.toolName === 'create_agent' && observation.startsWith('__agent_run_started__:')) {
            state.isComplete = true;
            state.finalAnswer = null;
            break;
          }
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

      if (!state.isComplete) {
        if (this.options.disableMaxIterations) {
          this.logDebug('Agent run exited before completion.');
        } else {
          this.logDebug('Max iterations reached - forcing final response.');
          this.setMode('compose_reply_mode');
          state.finalAnswer = 'I was unable to complete the task within the maximum number of iterations. Please try rephrasing your question or breaking it into smaller parts.';
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
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.callbacks.onError(errorMessage);
      this.isRunning = false;
      throw error;
    } finally {
      // Always reset running state when done
      this.isRunning = false;
      this.activeState = null;
      this.activeChatId = null;
      this.logDebug('Agent run finished, isRunning set to false');
    }

    return state;
  }
}

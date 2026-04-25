import { LlamaClient } from '../services/llamaClient';
import { ToolRegistry, ChatToolPreference, ToolExecutionPolicy } from '../tools';
export type AgentMode = 'research_mode' | 'compose_reply_mode';
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
export declare class ReActAgent {
    private llamaClient;
    private toolRegistry;
    private maxIterations;
    private callbacks;
    private debugLogFile;
    private abortController;
    private isCancelled;
    private isRunning;
    private invalidTurnState;
    private personality;
    private currentMode;
    private language;
    private model;
    constructor(llamaClient: LlamaClient, toolRegistry: ToolRegistry, maxIterations?: number, callbacks?: Partial<AgentCallbacks>, personality?: ChatPersonality | null, language?: string, model?: string);
    private setMode;
    cancel(): void;
    isAgentRunning(): boolean;
    private logDebug;
    private looksLikeContinuation;
    private parseTaggedResponse;
    private parseStreamedResponse;
    private getRetryDirective;
    private extractInvalidToolName;
    private recordInvalidTurn;
    private resetInvalidTurnState;
    private truncateForPrompt;
    private isSyntheticSummaryObservation;
    private getComposableObservations;
    private replaceLatestCorrection;
    private buildCorrectionMessage;
    private emitFinalAnswerChunks;
    private getEnabledToolNames;
    private getToolDefinitions;
    private isToolAutoApproved;
    private shouldBypassApproval;
    private getLanguageInstruction;
    private getSystemPrompt;
    private buildConversationHistory;
    run(chatId: string, userMessage: string, sandboxId: string, userId: string, conversationHistory?: Array<{
        role: 'user' | 'assistant';
        content: string;
    }>, memories?: string[], toolPreferences?: Record<string, ChatToolPreference>, approvalMode?: ChatApprovalMode): Promise<AgentState>;
}
//# sourceMappingURL=ReActAgent.d.ts.map
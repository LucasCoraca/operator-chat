"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReActAgent = void 0;
const xml_parser_1 = require("./xml-parser");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const TRANSITION_TO_COMPOSE_TOOL = 'transition_to_compose_mode';
class FinalAnswerStreamer {
    inFinalAnswer = false;
    emittedContent = '';
    bufferedContent = ''; // Buffer content until we know it's valid
    onToken;
    shouldEmit = true; // Control whether to emit tokens
    onPartialContent;
    constructor(onToken, shouldEmit = true, onPartialContent) {
        this.onToken = onToken;
        this.shouldEmit = shouldEmit;
        this.onPartialContent = onPartialContent;
    }
    push(chunk) {
        if (!chunk) {
            return;
        }
        this.emit(chunk);
    }
    finalize() {
        // No-op: with native tool calling we stream plain text content directly.
    }
    getEmittedContent() {
        return this.emittedContent;
    }
    getBufferedContent() {
        return this.bufferedContent;
    }
    // Flush buffered content to the UI (call this when final_answer is validated)
    flushBufferedContent() {
        if (this.bufferedContent) {
            this.emittedContent += this.bufferedContent;
            this.onToken(this.bufferedContent);
            this.bufferedContent = '';
        }
    }
    emit(text) {
        if (!text) {
            return;
        }
        if (this.shouldEmit) {
            this.emittedContent += text;
            this.onToken(text);
            // Call onPartialContent callback to persist partial streaming content
            this.onPartialContent?.(this.emittedContent);
        }
        else {
            // Buffer the content instead of emitting
            this.bufferedContent += text;
        }
    }
    drain(_isFinalFlush) { }
}
class ReActAgent {
    llamaClient;
    toolRegistry;
    maxIterations;
    callbacks;
    debugLogFile;
    abortController = null;
    isCancelled = false;
    isRunning = false;
    invalidTurnState = { count: 0 };
    personality = null;
    currentMode = 'research_mode';
    language = 'en';
    model;
    options;
    activeState = null;
    activeChatId = null;
    pendingUserMessages = [];
    constructor(llamaClient, toolRegistry, maxIterations = 10, callbacks, personality, language, model, options = {}) {
        this.llamaClient = llamaClient;
        this.toolRegistry = toolRegistry;
        this.maxIterations = maxIterations;
        this.personality = personality || null;
        this.language = language || 'en';
        this.model = model;
        this.options = options;
        this.callbacks = {
            onStep: () => { },
            onError: () => { },
            onFinalAnswerToken: () => { },
            onReasoningToken: () => { },
            onDebugInfo: () => { },
            onCancelled: () => { },
            onTimings: () => { },
            ...callbacks,
        };
        // Create debug log file path
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.debugLogFile = path_1.default.join(__dirname, `../../debug-${timestamp}.log`);
    }
    addUserMessage(message) {
        const trimmed = message.trim();
        if (!trimmed) {
            return false;
        }
        const step = {
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
    setMode(mode) {
        this.currentMode = mode;
        this.logDebug(`Mode changed to: ${mode}`);
    }
    cancel() {
        this.isCancelled = true;
        this.isRunning = false;
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.callbacks.onCancelled?.();
        this.logDebug('Agent cancelled by user');
    }
    isAgentRunning() {
        return this.isRunning;
    }
    logDebug(message) {
        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] ${message}`;
        console.log(logLine);
        try {
            fs_1.default.appendFileSync(this.debugLogFile, logLine + '\n');
        }
        catch (e) {
            // Ignore file write errors
        }
    }
    looksLikeContinuation(content) {
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
    parseTaggedResponse(content, forceFinalAnswer, currentIteration = 0) {
        const trimmed = content.trim();
        if (!trimmed) {
            return {
                type: 'invalid',
                failureReason: 'Your response was empty. Provide a tool call or a final answer.',
            };
        }
        const knownTools = this.toolRegistry.getTools().map(t => t.name);
        const blocks = (0, xml_parser_1.parseAssistantMessage)(trimmed, knownTools);
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
    parseStreamedResponse(streamedResult, forceFinalAnswer, currentIteration = 0) {
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
            let parsedArgs = {};
            if (streamedResult.toolCall.arguments) {
                try {
                    parsedArgs = JSON.parse(streamedResult.toolCall.arguments);
                }
                catch {
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
    getRetryDirective(parsedResponse, forceFinalAnswer) {
        const retryToolName = this.extractInvalidToolName(parsedResponse.failureReason);
        if (forceFinalAnswer) {
            return {
                requiredBlock: this.currentMode === 'research_mode' ? 'tool_call' : 'final_answer',
                failureReason: parsedResponse.failureReason ||
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
    extractInvalidToolName(failureReason) {
        if (!failureReason) {
            return undefined;
        }
        const match = failureReason.match(/Tool call arguments for '([^']+)'/);
        return match?.[1];
    }
    recordInvalidTurn() {
        this.invalidTurnState.count += 1;
        return this.invalidTurnState.count;
    }
    resetInvalidTurnState() {
        this.invalidTurnState.count = 0;
    }
    truncateForPrompt(content, maxLength) {
        if (content.length <= maxLength) {
            return content;
        }
        return `${content.slice(0, maxLength)}\n\n[Observation truncated before composing the final answer.]`;
    }
    compactObservationForPrompt(step) {
        if (step.type !== 'observation') {
            return step;
        }
        const maxObservationChars = this.options.disableMaxIterations ? 6000 : 12000;
        return {
            ...step,
            content: this.truncateForPrompt(step.content, maxObservationChars),
        };
    }
    compactDuplicateReadStepsForPrompt(steps) {
        const latestReadActionByPath = new Map();
        for (let index = 0; index < steps.length; index++) {
            const step = steps[index];
            if (step.type !== 'action' || step.actionName !== 'read') {
                continue;
            }
            const filePath = String(step.actionArgs?.path || '').trim();
            if (filePath) {
                latestReadActionByPath.set(filePath, index);
            }
        }
        if (latestReadActionByPath.size === 0) {
            return steps;
        }
        return steps.map((step, index) => {
            if (step.type !== 'observation') {
                return step;
            }
            const previousStep = steps[index - 1];
            if (previousStep?.type !== 'action' || previousStep.actionName !== 'read') {
                return step;
            }
            const filePath = String(previousStep.actionArgs?.path || '').trim();
            if (!filePath || latestReadActionByPath.get(filePath) === index - 1) {
                return step;
            }
            return {
                ...step,
                content: `[Earlier read of ${filePath} omitted from raw replay. The latest read of this same path is kept later in the context.]`,
            };
        });
    }
    getStepsForPrompt(state, sharedContext) {
        const compactedSteps = this.compactDuplicateReadStepsForPrompt(state.steps);
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
    isSyntheticSummaryObservation(content) {
        return content.startsWith('## COMPOSING FINAL ANSWER') ||
            content.startsWith('## RESEARCH PHASE COMPLETE') ||
            content.startsWith('## ITERATION LIMIT REACHED') ||
            content.startsWith('__agent_run_started__:');
    }
    drainPendingUserMessages(chatId, state) {
        const pendingMessages = this.pendingUserMessages.splice(0);
        for (const message of pendingMessages) {
            const step = {
                type: 'observation',
                content: `User Message: ${message}`,
            };
            state.steps.push(step);
            this.callbacks.onStep(step);
            this.callbacks.onStepSave?.(chatId, step, [...state.steps]);
        }
    }
    getComposableObservations(state) {
        const observations = [];
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
    replaceLatestCorrection(state, content) {
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
    buildCorrectionMessage(retryDirective, retryCount) {
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
        }
        else {
            if (retryCount >= 3) {
                return `Invalid agent turn: ${retryDirective.failureReason}

Retry #${retryCount}: provide a plain final answer now. Do not call tools.`;
            }
            return `Invalid agent turn: ${retryDirective.failureReason}

Retry #${retryCount}: provide a plain final answer (normal assistant text), no tool calls.`;
        }
    }
    async emitFinalAnswerChunks(chunks) {
        for (const chunk of chunks) {
            if (!chunk) {
                continue;
            }
            this.callbacks.onFinalAnswerToken(chunk);
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }
    getEnabledToolNames(toolPreferences) {
        if (!toolPreferences) {
            return this.toolRegistry.getTools().map((tool) => tool.name);
        }
        return Object.entries(toolPreferences)
            .filter(([, preference]) => preference.enabled)
            .map(([toolName]) => toolName);
    }
    getToolDefinitions(toolPreferences) {
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
    isToolAutoApproved(toolName, toolPreferences) {
        if (!toolPreferences) {
            return false;
        }
        return Boolean(toolPreferences[toolName]?.autoApprove);
    }
    shouldBypassApproval(toolName, toolPreferences, approvalMode) {
        if (approvalMode?.alwaysApprove) {
            return true;
        }
        return this.isToolAutoApproved(toolName, toolPreferences);
    }
    getToolActionIndexes(state, toolNames) {
        return state.steps
            .map((step, index) => ({ step, index }))
            .filter(({ step }) => step.type === 'action' && (!toolNames || toolNames.includes(step.actionName || '')))
            .map(({ index }) => index);
    }
    getLastObservationAfter(state, actionIndex) {
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
    normalizeAgentPath(filePath, workspace) {
        let normalized = filePath.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
        const root = workspace?.ssh?.root?.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
        if (root && normalized.startsWith(`${root}/`)) {
            normalized = normalized.slice(root.length + 1);
        }
        return normalized.replace(/^\.\//, '');
    }
    getReadKey(args, workspace) {
        const filePath = String(args.path || '').trim();
        if (!filePath) {
            return null;
        }
        const offset = args.offset === undefined || args.offset === null ? 1 : Number(args.offset);
        const limit = args.limit === undefined || args.limit === null ? 300 : Number(args.limit);
        return `${this.normalizeAgentPath(filePath, workspace)}::${Number.isFinite(offset) ? offset : 1}::${Number.isFinite(limit) ? limit : 300}`;
    }
    didFileChangeAfterRead(state, normalizedPath, readActionIndex, workspace) {
        for (let index = readActionIndex + 1; index < state.steps.length; index++) {
            const step = state.steps[index];
            if (step.type !== 'action' || !step.actionName) {
                continue;
            }
            if (['write', 'edit'].includes(step.actionName)) {
                const changedPath = this.normalizeAgentPath(String(step.actionArgs?.path || step.actionArgs?.filePath || ''), workspace);
                if (changedPath === normalizedPath) {
                    return true;
                }
            }
            if (step.actionName === 'apply_patch') {
                const patchText = String(step.actionArgs?.patchText || '');
                if (patchText.includes(normalizedPath)) {
                    return true;
                }
            }
        }
        return false;
    }
    getDuplicateReadObservation(state, args, workspace) {
        const requestedKey = this.getReadKey(args, workspace);
        if (!requestedKey) {
            return null;
        }
        const [normalizedPath] = requestedKey.split('::');
        for (let index = state.steps.length - 2; index >= 0; index--) {
            const step = state.steps[index];
            if (step.type !== 'action' || step.actionName !== 'read' || !step.actionArgs) {
                continue;
            }
            const previousKey = this.getReadKey(step.actionArgs, workspace);
            if (previousKey !== requestedKey) {
                continue;
            }
            if (this.didFileChangeAfterRead(state, normalizedPath, index, workspace)) {
                return null;
            }
            const lastObservation = this.getLastObservationAfter(state, index);
            const preview = lastObservation
                ? ` Previous read preview:\n${this.truncateForPrompt(lastObservation, 1200)}`
                : '';
            return `Duplicate read skipped for ${normalizedPath}. This exact path/range was already read and the file has not changed since. Use the previous read result in context, use grep for a targeted lookup, or request a different offset/limit if another range is needed.${preview}`;
        }
        return null;
    }
    validateComposeReadiness(state, toolPreferences, workspace) {
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
    getLanguageInstruction() {
        const languageInstructions = {
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
    getSystemPrompt(forceFinalAnswer = false, toolPreferences, memories = [], currentIteration = 0, workspace) {
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
        const canCreateAgent = enabledToolNames.includes('create_agent');
        const remoteToolNames = enabledToolNames.filter((toolName) => ['list', 'read', 'glob', 'grep', 'bash', 'terminal_list', 'terminal_read', 'terminal_kill', 'write', 'edit', 'apply_patch', 'memory_get', 'memory_set', 'memory_checkpoint'].includes(toolName));
        const workspaceSection = workspace?.type === 'ssh_remote' && workspace.ssh?.enabled
            ? canCreateAgent
                ? `\n\n## ACTIVE WORKSPACE\nThe system has SSH credentials for a remote environment.\n- Default host: ${workspace.ssh.username}@${workspace.ssh.host}:${workspace.ssh.port || 22}\n- Default workspace root: ${workspace.ssh.root}\n- For any request to run commands, inspect a codebase, edit files, implement changes, fix bugs, run tests, continue previous remote work, or delegate coding work, call \`create_agent\` with a title, a complete prompt, and the absolute remote workspaceRoot. Do not tell the user to run commands manually.\n- The \`create_agent\` prompt must include clear \`Success Criteria\`, \`Non-goals\`, and \`Required Verification\` sections. Define what solved means, what should not be investigated, and the bounded checks the coding agent should run before stopping.\n- The created agent is separate from this chat response and its live trace will appear in the conversation.\n- Answer directly only for conceptual questions that do not require remote workspace inspection, command execution, or file edits.\n`
                : `\n\n## ACTIVE WORKSPACE\nYou are the spawned SSH coding agent for a remote environment.\n- Host: ${workspace.ssh.username}@${workspace.ssh.host}:${workspace.ssh.port || 22}\n- Workspace root: ${workspace.ssh.root}\n- Your enabled remote tools are: ${remoteToolNames.join(', ') || 'none'}.\n- Continue using the remote tools to inspect files, run commands, edit files, and verify the task. Do not tell the user to run commands manually when a tool can do it.\n- Use \`list\`, \`glob\`, \`grep\`, and \`read\` for inspection. Use \`edit\`, \`write\`, and \`apply_patch\` for file modifications. Use \`bash\` for builds, tests, and commands.\n- Before reading a file, check the shared context and recent tool results. Do not repeatedly read the same file unless it changed, you need a different line range, or the previous read was insufficient. Prefer \`grep\` or targeted \`read\` offsets over re-reading whole files.\n- Use \`memory_get\` when you need to recall project state, file summaries, commands, errors, or prior progress. Use \`memory_checkpoint\` after major milestones, after several file edits, before compaction, and before the final answer.\n- Do not rewrite files already represented in backend memory unless you are intentionally changing their content. If you need to recall what you wrote, call \`memory_get\` instead of \`write\` or \`read\`.\n- Treat any \`User Message:\` observation in your trace as direct steering from the user for this running coding agent.\n- Follow the parent chat's \`Success Criteria\`, \`Non-goals\`, and \`Required Verification\` from your task prompt. When those success criteria are met and the required verification passes, stop tool use and compose the final answer. Do not continue investigating non-goals or unrelated anomalies.\n- Do not call \`${TRANSITION_TO_COMPOSE_TOOL}\` while implementation, file creation, file edits, dependency installation, tests, or verification remain. Keep calling tools instead.\n- If you modify files with \`write\`, \`edit\`, or \`apply_patch\`, inspect or verify afterward with \`read\`, \`grep\`, or \`bash\` before composing the final answer.\n- If a \`bash\` command starts a long-running process, it may return a background terminal id instead of blocking. Use \`terminal_read\` to inspect later output, \`terminal_list\` to find running terminals, and \`terminal_kill\` to stop a terminal when needed. Keep \`terminal_read\` bounded with tailLines/maxBytes.\n- Prefer file-editing tools over shell redirection for code changes. Pass \`workdir\` to \`bash\` instead of using \`cd\`.\n- Treat this as a real remote machine: avoid destructive commands unless explicitly needed and approved.\n`
            : `\n\n## ACTIVE WORKSPACE\nSSH agent mode is not available because no remote workspace is configured in Settings. If the user asks you to run commands, inspect a codebase, edit files, or start an agent, explain that the remote workspace must first be configured in Settings with a host/IP, username, workspace root, and SSH key.\n`;
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
        const iterationsRemaining = this.maxIterations - currentIteration;
        const iterationsContext = this.options.disableMaxIterations
            ? `\n\n## AGENT LOOP\nIteration: ${currentIteration}. There is no automatic compose step for unfinished coding work. Continue tool execution until the requested task is actually complete, or until the user stops the agent.`
            : `\n\n## ITERATIONS REMAINING: ${iterationsRemaining} / ${this.maxIterations}\nUse your iterations wisely. The system will automatically transition to the next phase when you reach the iteration limit.`;
        return `Knowledge Cutoff: December 2023
Current Date: ${dateTime}
${iterationsContext}

${this.getLanguageInstruction()}

You are a helpful AI assistant.${toolsAvailable ? ' You have access to tools.' : ' No tools are enabled for this turn, so answer directly without tool calls.'}
${workspaceSection}${personalitySection}${memorySection}

## TOOL CALLING
- Use native function tool calling when you need tools.
- Use only structured tool calls for tools.
- Do not assume that normal assistant text is safe to emit unless the mode instructions below explicitly allow it.
- If ${forceFinalAnswer ? 'you are on a forced turn' : 'you still need more data'}, ${forceFinalAnswer
            ? this.currentMode === 'research_mode'
                ? `do not answer the user directly; call \`${TRANSITION_TO_COMPOSE_TOOL}\``
                : 'do not call tools'
            : 'call tools instead of describing tool usage in prose'}.

${this.currentMode === 'research_mode' ? `
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
    buildConversationHistory(userMessage, state, conversationHistory = [], forceFinalAnswer = false, toolPreferences, memories = [], workspace, sharedContext) {
        const messages = [
            {
                role: 'system',
                content: this.getSystemPrompt(forceFinalAnswer, toolPreferences, memories, state.iteration, workspace),
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
        let pendingToolCall = null;
        let toolCallCounter = 0;
        for (const originalStep of this.getStepsForPrompt(state, sharedContext)) {
            const step = this.compactObservationForPrompt(originalStep);
            if (this.currentMode === 'compose_reply_mode') {
                if (step.type === 'observation') {
                    messages.push({
                        role: 'user',
                        content: `Tool result:\n${step.content}`,
                    });
                }
                else if (step.type === 'mode_transition') {
                    messages.push({
                        role: 'user',
                        content: `Mode transition: ${step.content}`,
                    });
                }
                else if (step.type === 'final_answer') {
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
            }
            else if (step.type === 'final_answer') {
                messages.push({
                    role: 'assistant',
                    content: step.content,
                });
            }
        }
        return messages;
    }
    getContextBudget() {
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
    async buildManagedConversationHistory(chatId, userMessage, state, conversationHistory = [], forceFinalAnswer = false, toolPreferences, memories = [], workspace) {
        let sharedContext = await this.callbacks.onSharedContextRequest?.({
            chatId,
            runId: this.options.runId,
            state,
        });
        let messages = this.buildConversationHistory(userMessage, state, conversationHistory, forceFinalAnswer, toolPreferences, memories, workspace, sharedContext);
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
        messages = this.buildConversationHistory(userMessage, state, conversationHistory, forceFinalAnswer, toolPreferences, memories, workspace, sharedContext);
        return messages;
    }
    async run(chatId, userMessage, sandboxId, userId, conversationHistory = [], memories = [], toolPreferences, approvalMode, workspace) {
        const state = {
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
                }
                else {
                    this.logDebug(`\n--- ITERATION ${state.iteration} ---`);
                }
                // Build conversation history
                const messages = await this.buildManagedConversationHistory(chatId, userMessage, state, conversationHistory, forceFinalAnswer, toolPreferences, memories, workspace);
                this.logDebug(`Messages count: ${messages.length}`);
                const shouldEmitFinalAnswer = this.currentMode === 'compose_reply_mode';
                const finalAnswerStreamer = new FinalAnswerStreamer((token) => {
                    this.callbacks.onFinalAnswerToken(token);
                }, shouldEmitFinalAnswer, shouldEmitFinalAnswer
                    ? (partialContent) => this.callbacks.onPartialFinalAnswer?.(chatId, partialContent)
                    : undefined);
                const streamedResult = await this.llamaClient.chatStream(messages, (timings) => {
                    // Forward timing data to frontend
                    if (timings) {
                        this.callbacks.onTimings(timings);
                    }
                }, this.abortController, this.currentMode === 'compose_reply_mode'
                    ? undefined
                    : this.getToolDefinitions(toolPreferences), {
                    onReasoningToken: (token) => {
                        this.callbacks.onReasoningToken(token);
                    },
                    onContentToken: (token) => {
                        finalAnswerStreamer.push(token);
                    },
                    model: this.model,
                });
                finalAnswerStreamer.finalize();
                const bufferedContent = streamedResult.finalContent;
                const parsedResponse = this.parseStreamedResponse(streamedResult, forceFinalAnswer, state.iteration);
                this.logDebug(`\nLLM TAGGED OUTPUT (${streamedResult.finalContent.length} chars):`);
                this.logDebug(streamedResult.finalContent.substring(0, 500) + (streamedResult.finalContent.length > 500 ? '...' : ''));
                this.logDebug(`LLM REASONING OUTPUT (${streamedResult.reasoningContent.length} chars):`);
                this.logDebug(streamedResult.reasoningContent.substring(0, 500) + (streamedResult.reasoningContent.length > 500 ? '...' : ''));
                // Emit debug info to frontend
                this.callbacks.onDebugInfo(JSON.stringify(streamedResult), parsedResponse);
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
                    const shouldRecordInvalidOutput = invalidTurnThought &&
                        !hasToolTag &&
                        invalidTurnThought.length > 0;
                    // Invalid turn thoughts are not saved as steps
                    this.replaceLatestCorrection(state, correctiveObservation);
                    const step = {
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
                            const modeStep = {
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
                                const summaryStep = {
                                    type: 'observation',
                                    content: summaryObservation,
                                };
                                state.steps.push(summaryStep);
                                this.callbacks.onStep(summaryStep);
                                this.callbacks.onStepSave?.(chatId, summaryStep, [...state.steps]);
                            }
                            // Force one more iteration in compose mode
                            state.iteration++;
                            const messages = await this.buildManagedConversationHistory(chatId, userMessage, state, conversationHistory, true, // forceFinalAnswer
                            toolPreferences, memories, workspace);
                            const finalAnswerStreamer = new FinalAnswerStreamer((token) => {
                                this.callbacks.onFinalAnswerToken(token);
                            }, true, (partialContent) => this.callbacks.onPartialFinalAnswer?.(chatId, partialContent));
                            const streamedResult = await this.llamaClient.chatStream(messages, (timings) => {
                                if (timings) {
                                    this.callbacks.onTimings(timings);
                                }
                            }, this.abortController, undefined, {
                                onReasoningToken: (token) => {
                                    this.callbacks.onReasoningToken(token);
                                },
                                onContentToken: (token) => {
                                    finalAnswerStreamer.push(token);
                                },
                                model: this.model,
                            });
                            finalAnswerStreamer.finalize();
                            const parsedResponse = this.parseStreamedResponse(streamedResult, true, state.iteration);
                            if (parsedResponse.type === 'final_answer' && parsedResponse.finalAnswer) {
                                state.finalAnswer = parsedResponse.finalAnswer;
                                const finalStep = {
                                    type: 'final_answer',
                                    content: state.finalAnswer,
                                };
                                state.steps.push(finalStep);
                                this.callbacks.onStep(finalStep);
                                this.callbacks.onStepSave?.(chatId, finalStep, [...state.steps]);
                                state.isComplete = true;
                                await this.emitFinalAnswerChunks([state.finalAnswer]);
                            }
                            else {
                                // Fallback
                                state.finalAnswer = 'Based on my research, I was unable to provide a complete answer. Here is what I found: ' +
                                    (observations.length > 0 ? observations[observations.length - 1].substring(0, 500) : 'No information gathered.');
                                const finalStep = {
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
                        else {
                            // Already in compose mode, provide fallback answer
                            const observations = this.getComposableObservations(state);
                            state.finalAnswer = 'I was unable to produce a complete answer within the iteration limit. Here is what I found: ' +
                                (observations.length > 0 ? observations[observations.length - 1].substring(0, 500) : 'No information gathered.');
                            const finalStep = {
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
                        const step = {
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
                    const modeStep = {
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
                        const summaryStep = {
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
                                }
                                else if (paramDef.type === 'boolean') {
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
                    const actionStep = {
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
                            const duplicateStep = {
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
                        const approvalStep = {
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
                            const deniedStep = {
                                type: 'observation',
                                content: deniedObservation,
                            };
                            state.steps.push(deniedStep);
                            this.callbacks.onStep(deniedStep);
                            this.callbacks.onStepSave?.(chatId, deniedStep, [...state.steps]);
                            continue;
                        }
                    }
                    const observation = await this.toolRegistry.executeTool(parsedResponse.toolName, parsedResponse.toolArgs, {
                        sandboxId,
                        userId,
                        chatId,
                        agentRunId: this.options.runId,
                        model: this.model,
                        workspace,
                        agentMemory: this.toolRegistry.agentMemoryService,
                        createAgentRun: this.callbacks.onCreateAgentRun,
                        emitToolProgress: (content) => {
                            this.callbacks.onStep({
                                type: 'tool_progress',
                                content,
                                actionName: parsedResponse.toolName,
                            });
                        },
                    }, this.getEnabledToolNames(toolPreferences));
                    this.logDebug(`\nEXECUTING TOOL: ${parsedResponse.toolName}`);
                    this.logDebug(`Tool observation (${observation.length} chars): ${observation.substring(0, 300)}...`);
                    const obsStep = {
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
                    }
                    else if (finalAnswerContent.startsWith(streamedFinalAnswer)) {
                        const remaining = finalAnswerContent.slice(streamedFinalAnswer.length);
                        if (remaining) {
                            await this.emitFinalAnswerChunks([remaining]);
                        }
                    }
                    const finalStep = {
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
                }
                else {
                    this.logDebug('Max iterations reached - forcing final response.');
                    this.setMode('compose_reply_mode');
                    state.finalAnswer = 'I was unable to complete the task within the maximum number of iterations. Please try rephrasing your question or breaking it into smaller parts.';
                    const finalStep = {
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
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.callbacks.onError(errorMessage);
            this.isRunning = false;
            throw error;
        }
        finally {
            // Always reset running state when done
            this.isRunning = false;
            this.activeState = null;
            this.activeChatId = null;
            this.logDebug('Agent run finished, isRunning set to false');
        }
        return state;
    }
}
exports.ReActAgent = ReActAgent;
//# sourceMappingURL=ReActAgent.js.map
import type { LlamaClient, ChatMessage, ChatTimings } from '../../services/llamaClient';
import type { WorkspaceConfig } from '../../services/workspaceRuntime';
import type { AgentSessionRepository } from '../../repositories/agentSessionRepository';
import type { AgentRunTaskRepository, AgentRunTask } from '../../repositories/agentRunTaskRepository';
import {
  WithParts,
  Part,
  TextPart,
  ToolPart,
  AssistantMessage,
  UserMessage,
  isToolPart,
  isTextPart,
} from './message';
import { MessageID, PartID, SessionID } from './ids';
import { buildPrompt, buildDynamicStateBlock, wrapTrailingUserAsSystemReminder } from './promptBuilder';
import {
  executeAgentTool,
  getSshAgentToolDefinitions,
  getSshAgentToolPolicy,
  type SshAgentToolContext,
  type QuestionRequest,
  type QuestionResponse,
  type SubagentRequest,
  type SubagentLaunchResult,
} from './tools';
import { CompactionRunner, LlmCompactionRunner, CompactionContext } from './compactionRun';
import { CompactionConfig, ModelLimits, usable } from './tokenBudget';
import { projectPartsToSteps, findFinalAnswer } from './partProjection';
import type { AgentStep, ToolApprovalRequest, ToolApprovalResponse } from '../ReActAgent';

// The v2 SSH agent loop.
//
// On every iteration:
//   1. Reload messages+parts from the DB.
//   2. Check if compaction is needed; if yes, run the compaction runner and
//      restart the iteration.
//   3. Build the system prompt + ChatMessage[] from the (post-compaction) history.
//   4. Stream the LLM with native tool definitions.
//   5. If the response contains a tool call, execute it (with approval if
//      required), persist a ToolPart, then loop. If it's plain text, persist
//      an assistant TextPart and exit.
//
// Throughout, the runner emits AgentStep-shaped events so the existing
// frontend (ChatInterface.tsx) renders the trace card without changes.

export interface SshAgentRunnerOptions {
  sessionId: string;
  chatId: string;
  agentRunId: string;
  userId: string;
  sandboxId: string;
  agent: string;
  workspace: WorkspaceConfig;
  agentPrompt: string;
  modelID: string;
  providerID: string;
  cwd: string;
  root: string;
  language?: string;
  contextWindowTokens?: number;
  reservedOutputTokens?: number;
  autoCompactThreshold?: number;
}

export interface SshAgentCallbacks {
  /** Emitted whenever the run's persisted parts change. The host should fan this out as agent-run-updated. */
  onPartsUpdated: (steps: AgentStep[], finalAnswer: string | null) => void;
  /** Emitted when streaming text deltas arrive. */
  onAssistantToken?: (token: string) => void;
  /** Emitted on every step append for fine-grained UI scroll tracking. */
  onStep?: (step: AgentStep) => void;
  /** Emitted when an LLM call returns timings. */
  onTimings?: (timings: ChatTimings) => void;
  /** Approval gate for tools whose policy requires it. */
  onToolApprovalRequest?: (request: ToolApprovalRequest) => Promise<ToolApprovalResponse>;
  /** Called whenever the task list changes. */
  onTasksUpdated?: (chatId: string, agentRunId: string, tasks: AgentRunTask[]) => void;
  /** Called after a tool that may have mutated workspace files. */
  onWorkspaceChanged?: (hint: { tool: string; path?: string }) => void;
  /** Bridge for the `question` tool — show the prompt in the UI and wait for the user. */
  onAskUserQuestion?: (request: QuestionRequest) => Promise<QuestionResponse | null>;
  /** Bridge for the `task` tool — launch a subagent and wait for its result. */
  onLaunchSubagent?: (request: SubagentRequest) => Promise<SubagentLaunchResult>;
  /** Called once when the run finishes. */
  onComplete?: (finalAnswer: string | null) => void;
  /** Called on uncaught errors. */
  onError?: (error: string) => void;
}

type SshAgentMode = 'research' | 'compose';

export class SshAgentRunner {
  private cancelled = false;
  private running = false;
  private abortController: AbortController | null = null;
  private pendingUserMessages: string[] = [];
  private compactionPending = false;
  // Set when a compaction attempt returns compacted=false (e.g. the summarizer
  // LLM call failed or there's no head/tail to split). Once set, the runner
  // stops re-triggering compaction and forces COMPOSE so the run can wrap up
  // gracefully instead of spinning on a no-op pre-send check.
  private compactionExhausted = false;
  // Two-mode loop, mirroring the chat ReAct agent. RESEARCH allows only tool
  // calls; COMPOSE allows only the final-answer text. The model switches by
  // calling the `transition_to_compose_mode` tool. The mode is also surfaced
  // to the LLM via the trailing dynamic-state block on every iteration.
  private currentMode: SshAgentMode = 'research';
  // Tracks consecutive turns in RESEARCH that produced no usable tool call.
  // After this many retries, the runner force-transitions to COMPOSE so the
  // user gets *some* answer instead of a stuck loop.
  private consecutiveResearchTextRetries = 0;
  private readonly MAX_RESEARCH_TEXT_RETRIES = 2;
  // Guards against the model spinning on a single tool (typically `todo` or
  // `read`) for many turns in a row without making progress. Once the streak
  // hits SAME_TOOL_STREAK_LIMIT we inject a one-shot steering reminder.
  private lastToolName: string | null = null;
  private sameToolStreak = 0;
  private sameToolReminderSent = false;
  private readonly SAME_TOOL_STREAK_LIMIT = 3;

  constructor(
    private readonly llama: LlamaClient,
    private readonly sessions: AgentSessionRepository,
    private readonly tasks: AgentRunTaskRepository,
    private readonly options: SshAgentRunnerOptions,
    private readonly callbacks: SshAgentCallbacks
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  cancel(): void {
    this.cancelled = true;
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  /** Add a user steering message that gets appended to the DB before the next iteration. */
  addUserMessage(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    this.pendingUserMessages.push(trimmed);
    return true;
  }

  async run(): Promise<void> {
    this.running = true;
    console.log(`[sshAgent] Starting SSH agent run for session ${this.options.sessionId}, run ${this.options.agentRunId}`);
    this.abortController = new AbortController();

    const compactionRunner: CompactionRunner = new LlmCompactionRunner(this.llama, this.sessions, {
      model: this.options.modelID,
      maxOutputTokens: this.options.reservedOutputTokens,
    });

    const modelLimits: ModelLimits = {
      context: this.options.contextWindowTokens || 128_000,
      maxOutputTokens: this.options.reservedOutputTokens || 8_000,
    };
    const cfg: { compaction?: CompactionConfig } = {
      compaction: {
        auto: true,
        // The user-facing autoCompactThreshold scales the usable window. Map
        // into `reserved` so opencode's `usable()` math returns the threshold
        // as a fraction of context.
        reserved: Math.floor(
          modelLimits.context * (1 - clamp(this.options.autoCompactThreshold ?? 0.82, 0.1, 0.98))
        ),
        prune: true,
      },
    };

    let iteration = 0;

    // The SSH agent runs unbounded by design — long coding tasks (multi-file
    // builds, debug-fix-verify loops) routinely take many iterations and the
    // user-cancel button is the intended off-switch. The chat ReAct agent
    // keeps its own iteration cap; this one does not.
    try {
      while (!this.cancelled) {
        iteration++;
        console.log(`[sshAgent] Iteration ${iteration} starting`);

        // Drain any user steering messages into the DB before reading.
        await this.flushPendingUserMessages();
        console.log(`[sshAgent] Pending user messages flushed`);

        const messages = await this.sessions.listMessagesWithParts(this.options.sessionId);
        console.log(`[sshAgent] Loaded ${messages.length} messages`);

        // Step 3: check compaction. Decision uses the post-filter view's last
        // assistant tokens; we let the compaction runner judge with the
        // user's autoCompactThreshold from settings.
        const compactionContext: CompactionContext = {
          sessionId: this.options.sessionId,
          agent: this.options.agent,
          modelId: this.options.modelID,
          providerID: this.options.providerID,
          cwd: this.options.cwd,
          root: this.options.root,
          cfg,
          model: modelLimits,
        };
        if (!this.compactionExhausted && compactionRunner.shouldCompact(messages, compactionContext)) {
          this.compactionPending = true;
          const result = await compactionRunner.run(messages, compactionContext);
          this.compactionPending = false;
          await this.emitProjection(); // surface the compaction marker to the UI
          if (!result.compacted) {
            this.markCompactionExhausted('shouldCompact');
            continue;
          }
          continue;
        }

        // Build prompt from the latest snapshot (may include the just-written summary).
        const refreshed = await this.sessions.listMessagesWithParts(this.options.sessionId);
        console.log(`[sshAgent] Refreshed messages: ${refreshed.length}`);
        const tasks = await this.tasks.listByRun(this.options.chatId, this.options.agentRunId);
        console.log(`[sshAgent] Tasks: ${tasks.length}`);
        const built = buildPrompt({
          messages: refreshed,
          agentPrompt: this.options.agentPrompt,
          workspace: this.options.workspace,
          tasks,
          now: new Date(),
          mode: this.currentMode,
        });

        // The static system prompt is identical across all iterations, so
        // llama.cpp keeps the full KV-cache (f_keep = 1.000) and only
        // processes the new tokens appended each iteration.
        // Dynamic state (date, tasks) is appended as a trailing user message
        // so it does not invalidate the prompt cache prefix.
        const llmMessages: ChatMessage[] = [
          { role: 'system', content: built.staticSystemPrompt },
          ...wrapTrailingUserAsSystemReminder(built.messages),
        ];

        // Append dynamic state at the end — short, volatile, but after the
        // cached prefix so it only invalidates a tiny suffix.
        const dynamicState = buildDynamicStateBlock({
          messages: refreshed,
          agentPrompt: this.options.agentPrompt,
          workspace: this.options.workspace,
          tasks,
          now: new Date(),
          mode: this.currentMode,
        });
      if (dynamicState) {
           llmMessages.push(dynamicState);
         }

        // In COMPOSE mode the LLM produces a final-answer text directly; no
        // tool surface is exposed so it can't tool-call its way out of the
        // mode. In RESEARCH mode we expose the full tool list (including
        // `transition_to_compose_mode`, which the runner intercepts below).
        const toolDefs =
          this.currentMode === 'research' ? getSshAgentToolDefinitions() : [];

        // Pre-send check: estimate the full prompt size (messages + tool
        // definitions) and trigger compaction if it crosses the threshold.
        // Tool defs go on the wire alongside the messages but aren't counted
        // by `countChatTokens`, so an estimate-by-JSON-size keeps the
        // threshold honest. Without this the compact threshold silently
        // ignores 25-40k of tool-schema tokens and the real request can
        // exceed the model's context window even when the message count
        // looks fine.
        const thresholdTokens = usable({ cfg, model: modelLimits });
        console.log(`[sshAgent] Counting tokens for ${llmMessages.length} messages`);
        const messageTokens = await this.llama.countChatTokens(llmMessages);
        const toolDefTokens = estimateToolDefTokens(toolDefs);
        const estimatedPromptTokens = messageTokens + toolDefTokens;
        console.log(
          `[sshAgent] Estimated prompt tokens: ${estimatedPromptTokens} ` +
          `(messages=${messageTokens}, tools=${toolDefTokens}), threshold: ${thresholdTokens}`
        );
        if (!this.compactionExhausted && estimatedPromptTokens >= thresholdTokens) {
          console.log(`[sshAgent] prompt tokens ${estimatedPromptTokens} >= threshold ${thresholdTokens}, triggering compaction`);
          this.compactionPending = true;
          const result = await compactionRunner.run(refreshed, compactionContext);
          this.compactionPending = false;
          await this.emitProjection();
          if (!result.compacted) {
            this.markCompactionExhausted('pre-send');
          }
          continue;
        }

        // Open an in-progress assistant message before streaming so the UI
        // sees real-time tokens flowing into a stable record.
        const assistantId: string = MessageID.ascending();
        const parentUserId = await this.findLatestUserMessageId(refreshed);
        const inProgressAssistant: AssistantMessage = {
          id: assistantId,
          sessionID: this.options.sessionId,
          role: 'assistant',
          time: { created: Date.now() },
          parentID: parentUserId,
          modelID: this.options.modelID,
          providerID: this.options.providerID,
          mode: 'agent',
          agent: this.options.agent,
          path: { cwd: this.options.cwd, root: this.options.root },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        };
        await this.sessions.upsertMessage(inProgressAssistant);

        let streamedText = '';
        let timings: ChatTimings | undefined;

        console.log(`[sshAgent] Calling chatStream with ${llmMessages.length} messages, ${toolDefs.length} tools`);
        const streamResult = await this.llama.chatStream(
          llmMessages,
          (t) => {
            if (t) {
              timings = t;
              this.callbacks.onTimings?.(t);
            }
          },
          this.abortController!,
          toolDefs,
          {
            model: this.options.modelID,
            onContentToken: (token) => {
              streamedText += token;
              // Hosts can subscribe to live token deltas via onAssistantToken
              // for status indicators. The host should NOT route them into
              // the chat bubble — intermediate narration belongs in the
              // trace, where the next emitProjection() will place it.
              this.callbacks.onAssistantToken?.(token);
            },
            onReasoningToken: () => {},
          }
        );

        console.log(`[sshAgent] chatStream returned, cancelled: ${this.cancelled}, streamedText: ${streamedText.substring(0, 100)}`);

        if (this.cancelled) break;

        const inputTokens = timings?.prompt_n ?? 0;
        const outputTokens = timings?.predicted_n ?? 0;

        // Persist whatever text was streamed (if any) as a TextPart on the
        // assistant message. This is the model's chain-of-thought / reasoning
        // text in cases where it interleaves text with a tool call.
        if (streamedText.trim()) {
          const textPart: TextPart = {
            id: PartID.ascending(),
            sessionID: this.options.sessionId,
            messageID: assistantId,
            type: 'text',
            text: streamedText,
            time: { start: Date.now(), end: Date.now() },
          };
          await this.sessions.upsertPart(textPart);
        }

        if (streamResult.toolCall) {
          this.consecutiveResearchTextRetries = 0;
          const toolName = streamResult.toolCall.name;
          let parsedArgs: Record<string, any> = {};
          try {
            parsedArgs = streamResult.toolCall.arguments
              ? JSON.parse(streamResult.toolCall.arguments)
              : {};
          } catch {
            parsedArgs = {};
          }

          // Track consecutive same-tool runs. Hitting the limit queues a
          // one-shot steering reminder for the next iteration; the streak
          // resets when the tool name changes so the reminder won't fire
          // again for the same offender.
          if (this.lastToolName === toolName) {
            this.sameToolStreak++;
          } else {
            this.lastToolName = toolName;
            this.sameToolStreak = 1;
            this.sameToolReminderSent = false;
          }
          if (
            this.sameToolStreak >= this.SAME_TOOL_STREAK_LIMIT &&
            !this.sameToolReminderSent &&
            toolName !== 'transition_to_compose_mode'
          ) {
            this.sameToolReminderSent = true;
            this.pendingUserMessages.push(
              `<system-reminder>\nYou have called \`${toolName}\` ${this.sameToolStreak} times in a row. ` +
              'If this tool is no longer making progress, switch to a different tool — try `read`, `grep`, `glob`, `shell`, or actual file edits via `write`/`edit`. ' +
              'If every Success Criterion is met and Required Verification has passed, call `transition_to_compose_mode` to finish the task.\n</system-reminder>'
            );
          }

          // The mode-transition tool is special: it doesn't run an executor,
          // it just flips the runner's mode so the next iteration produces
          // the final answer in COMPOSE. We still persist a ToolPart so the
          // trace shows the transition and the LLM sees the matching tool
          // result on the next turn.
          if (toolName === 'transition_to_compose_mode') {
            const callId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const transitionPart: ToolPart = {
              id: PartID.ascending(),
              sessionID: this.options.sessionId,
              messageID: assistantId,
              type: 'tool',
              callID: callId,
              tool: toolName,
              state: {
                status: 'completed',
                input: parsedArgs,
                output:
                  'Mode transition acknowledged. The next turn is COMPOSE mode — write the final answer as plain assistant text without calling tools.',
                title: toolName,
                metadata: {},
                time: { start: Date.now(), end: Date.now() },
              },
            };
            await this.sessions.upsertPart(transitionPart);
            await this.finalizeAssistant(assistantId, inputTokens, outputTokens, 'stop');
            this.currentMode = 'compose';
            await this.emitProjection();
            continue;
          }

          // In COMPOSE the tool surface is empty, so any tool call here is a
          // protocol violation by the model. Reject it and re-prompt.
          if (this.currentMode === 'compose') {
            await this.finalizeAssistant(assistantId, inputTokens, outputTokens, 'stop');
            this.pendingUserMessages.push(
              `You called \`${toolName}\` while in COMPOSE mode, where tool calls are not allowed. Reply with the final answer to the user as plain assistant text instead.`
            );
            await this.emitProjection();
            continue;
          }

          // Persist the ToolPart as `pending` so the UI sees the call before
          // the slow execution completes.
          const callId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const pendingPart: ToolPart = {
            id: PartID.ascending(),
            sessionID: this.options.sessionId,
            messageID: assistantId,
            type: 'tool',
            callID: callId,
            tool: toolName,
            state: {
              status: 'pending',
              input: parsedArgs,
              raw: streamResult.toolCall.arguments,
            },
          };
          await this.sessions.upsertPart(pendingPart);
          await this.emitProjection();

          // Approval gate. The v2 tool surface declares its own policy; we
          // adapt it into the legacy ToolApprovalRequest shape so existing
          // socket plumbing on the host keeps working unchanged.
          const policy = getSshAgentToolPolicy(toolName);
          const requiresApproval = Boolean(policy?.requiresApproval);
          if (requiresApproval && this.callbacks.onToolApprovalRequest) {
            const decision = await this.callbacks.onToolApprovalRequest({
              approvalId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
              toolName,
              toolArgs: parsedArgs,
              policy: {
                requiresApproval: true,
                supportsAutoApprove: true,
                capabilities: [],
                sandboxPolicy: 'ssh_remote',
                riskLevel: policy?.riskLevel ?? 'medium',
              },
            });
            if (!decision.approved) {
              const denied: ToolPart = {
                ...pendingPart,
                state: {
                  status: 'error',
                  input: parsedArgs,
                  error: `Tool execution denied by user (${decision.reason}).`,
                  time: { start: Date.now(), end: Date.now() },
                },
              };
              await this.sessions.upsertPart(denied);
              await this.finalizeAssistant(assistantId, inputTokens, outputTokens);
              await this.emitProjection();
              continue;
            }
          }

          // Mark running.
          const startedAt = Date.now();
          const runningPart: ToolPart = {
            ...pendingPart,
            state: {
              status: 'running',
              input: parsedArgs,
              time: { start: startedAt },
            },
          };
          await this.sessions.upsertPart(runningPart);
          await this.emitProjection();

          // Execute.
          const ctx: SshAgentToolContext = {
            chatId: this.options.chatId,
            agentRunId: this.options.agentRunId,
            sessionId: this.options.sessionId,
            userId: this.options.userId,
            sandboxId: this.options.sandboxId,
            modelID: this.options.modelID,
            workspace: this.options.workspace,
            emitToolProgress: (content) => {
              this.callbacks.onStep?.({
                type: 'tool_progress',
                content,
                actionName: toolName,
              });
            },
            emitTasksUpdated: this.callbacks.onTasksUpdated,
            askUserQuestion: this.callbacks.onAskUserQuestion,
            launchSubagent: this.callbacks.onLaunchSubagent,
          };

          const result = await executeAgentTool(toolName, parsedArgs, ctx, this.sessions, this.tasks);

          const completedAt = Date.now();
          const finalToolPart: ToolPart = result.isError
            ? {
                ...pendingPart,
                state: {
                  status: 'error',
                  input: parsedArgs,
                  error: result.output,
                  time: { start: startedAt, end: completedAt },
                },
              }
            : {
                ...pendingPart,
                state: {
                  status: 'completed',
                  input: parsedArgs,
                  output: result.output,
                  title: toolName,
                  metadata: {
                    truncated: result.truncated,
                    fullPath: result.fullPath,
                    attachments: result.attachments,
                  },
                  time: { start: startedAt, end: completedAt },
                },
              };
          await this.sessions.upsertPart(finalToolPart);
          await this.finalizeAssistant(assistantId, inputTokens, outputTokens);
          if (!result.isError && (toolName === 'write' || toolName === 'edit' || toolName === 'shell')) {
            const hintPath =
              typeof parsedArgs?.path === 'string' ? parsedArgs.path :
              typeof parsedArgs?.working_dir === 'string' ? parsedArgs.working_dir :
              undefined;
            this.callbacks.onWorkspaceChanged?.({ tool: toolName, path: hintPath });
          }
          await this.emitProjection();
          continue;
        }

        // No tool call.
        //
        // COMPOSE: this is the final answer. Any text the model produced has
        // already been persisted as a TextPart above; computeFinalAnswerFromDb
        // pulls it out via findFinalAnswer and we hand it to onComplete.
        //
        // RESEARCH: emitting plain text without a tool call is a protocol
        // violation under the mode contract. Re-prompt with a stricter
        // reminder. After MAX_RESEARCH_TEXT_RETRIES we force-transition to
        // COMPOSE so the user gets *some* answer (the model's text plus
        // whatever it can synthesize next turn) instead of a stuck loop.
        if (this.currentMode === 'research') {
          if (this.consecutiveResearchTextRetries < this.MAX_RESEARCH_TEXT_RETRIES) {
            this.consecutiveResearchTextRetries++;
            await this.finalizeAssistant(assistantId, inputTokens, outputTokens, 'stop');
            this.pendingUserMessages.push(
              `<system-reminder>\nYou are in RESEARCH mode. Plain assistant text is not allowed in this mode. ` +
              `If work remains, emit the next tool call (read/edit/write/shell/grep/glob/browser/todo/question/task). ` +
              `If every Success Criterion is met and Required Verification has passed, call \`transition_to_compose_mode\` and then write the final answer in COMPOSE mode on the next turn.\n</system-reminder>`
            );
            await this.emitProjection();
            continue;
          }
          // Safety valve: model can't be coaxed back into protocol. Force
          // the transition so the next iteration produces a final answer.
          console.warn(
            `[sshAgent] Forcing transition to COMPOSE after ${this.MAX_RESEARCH_TEXT_RETRIES} ` +
            'research-mode text-only turns; the model would not emit tool calls.'
          );
          await this.finalizeAssistant(assistantId, inputTokens, outputTokens, 'stop');
          this.currentMode = 'compose';
          this.consecutiveResearchTextRetries = 0;
          await this.emitProjection();
          continue;
        }

        // Final answer path (COMPOSE mode). Pass the aggregated narration
        // (every assistant TextPart, in order) to onComplete so the chat
        // bubble keeps the full transcript instead of being overwritten with
        // just the last iteration.
        await this.finalizeAssistant(assistantId, inputTokens, outputTokens, 'stop');
        await this.emitProjection();
        const aggregate = await this.computeFinalAnswerFromDb();
        this.callbacks.onComplete?.(aggregate ?? streamedText.trim() ?? null);
        return;
      }

      if (this.cancelled) {
        this.callbacks.onComplete?.(null);
      }
      // No other exit: the loop only ends via `return` from the compose
      // no-tool-call path (which already fires onComplete) or via cancel.
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.callbacks.onError?.(message);
    } finally {
      this.running = false;
    }
  }

  private async flushPendingUserMessages(): Promise<void> {
    if (this.pendingUserMessages.length === 0) return;
    while (this.pendingUserMessages.length > 0) {
      const text = this.pendingUserMessages.shift()!;
      const id: string = MessageID.ascending();
      const userMsg: UserMessage = {
        id,
        sessionID: this.options.sessionId,
        role: 'user',
        time: { created: Date.now() },
        agent: this.options.agent,
        model: { providerID: this.options.providerID, modelID: this.options.modelID },
      };
      await this.sessions.upsertMessage(userMsg);
      const textPart: TextPart = {
        id: PartID.ascending(),
        sessionID: this.options.sessionId,
        messageID: id,
        type: 'text',
        text,
      };
      await this.sessions.upsertPart(textPart);
    }
    await this.emitProjection();
  }

  private async findLatestUserMessageId(messages: WithParts[]): Promise<string> {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].info.role === 'user') return messages[i].info.id;
    }
    // Should never happen: the loop is started with the agent prompt as a user message.
    return MessageID.ascending();
  }

  private markCompactionExhausted(trigger: string): void {
    if (this.compactionExhausted) return;
    this.compactionExhausted = true;
    console.warn(
      `[sshAgent] Compaction did not reduce context (trigger=${trigger}). ` +
      'Disabling further compaction attempts and forcing COMPOSE wrap-up so the run terminates.'
    );
    if (this.currentMode === 'research') {
      this.currentMode = 'compose';
      this.pendingUserMessages.push(
        '<system-reminder>\nThe conversation context cannot be compacted further. ' +
        'Stop attempting tool calls. Compose a final answer that summarizes what was accomplished, ' +
        'what remains, any errors encountered, and what the user should do next.\n</system-reminder>'
      );
    }
  }

  private async finalizeAssistant(
    assistantId: string,
    inputTokens: number,
    outputTokens: number,
    finish?: string
  ): Promise<void> {
    const messages = await this.sessions.listMessagesWithParts(this.options.sessionId);
    const target = messages.find((m) => m.info.id === assistantId);
    if (!target) return;
    const updated: AssistantMessage = {
      ...(target.info as AssistantMessage),
      tokens: {
        input: inputTokens,
        output: outputTokens,
        reasoning: 0,
        cache: { read: 0, write: 0 },
        total: inputTokens + outputTokens,
      },
      time: {
        ...(target.info as AssistantMessage).time,
        completed: Date.now(),
      },
      finish: finish ?? (target.info as AssistantMessage).finish,
    };
    await this.sessions.upsertMessage(updated);
  }

  private async computeFinalAnswerFromDb(): Promise<string | null> {
    const messages = await this.sessions.listMessagesWithParts(this.options.sessionId);
    return findFinalAnswer(messages);
  }

  private async emitProjection(): Promise<void> {
    const messages = await this.sessions.listMessagesWithParts(this.options.sessionId);
    const steps = projectPartsToSteps(messages, { treatLastAssistantAsFinal: true });
    const finalAnswer = findFinalAnswer(messages);
    this.callbacks.onPartsUpdated(steps, finalAnswer);
    if (steps.length) {
      const last = steps[steps.length - 1];
      this.callbacks.onStep?.(last);
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

// Approximate the tokens consumed by a tool-definitions array on the wire.
// llama.cpp serializes the schemas into the function-calling system prompt;
// `countChatTokens` only sees `messages`, so without this estimate the
// threshold check undercounts by tens of thousands of tokens for the SSH
// agent's full surface. ~4 chars per token is conservative for JSON.
function estimateToolDefTokens(toolDefs: ReadonlyArray<unknown>): number {
  if (!toolDefs.length) return 0;
  return Math.ceil(JSON.stringify(toolDefs).length / 4);
}

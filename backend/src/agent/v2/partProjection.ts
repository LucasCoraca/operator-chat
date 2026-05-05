import { WithParts, isCompactionPart, isTextPart, isToolPart } from './message';
import type { AgentStep } from '../ReActAgent';

// Bridge between the v2 parts model and the legacy AgentStep[] shape that
// ChatInterface.tsx renders. The frontend keeps consuming agent-run-updated
// with `steps: AgentStep[]`; this projection makes that work without a UI
// rewrite.
//
// Mapping:
//   user TextPart                  -> { type: 'observation', content: 'User Message: …' }
//   assistant TextPart (intermediate) -> { type: 'thought', content }
//                                       Intermediate = the assistant message also
//                                       has tool parts. Renders inline in the
//                                       trace (no "Observation" label).
//   assistant TextPart (final)     -> NOT projected. Surfaced as the chat
//                                     bubble via findFinalAnswer().
//   ToolPart (tool === 'todo')     -> NOT projected. The dedicated tasks panel
//                                     (agent-tasks-updated) already renders the
//                                     same data; trace would duplicate.
//   ToolPart pending/running       -> { type: 'action', actionName, actionArgs, content }
//   ToolPart completed             -> action + { type: 'observation', content }
//   ToolPart error                 -> action + observation with the error
//   CompactionPart                 -> { type: 'mode_transition', content: '…compacted…' }

export interface ProjectionOptions {
  /**
   * If true, treat the trailing assistant TextPart as a final_answer step.
   * When the run is still active and we don't yet know whether the assistant
   * will tool-call again, callers may pass false to keep it as an interim
   * observation.
   */
  treatLastAssistantAsFinal?: boolean;
}

function describeToolForUI(toolName: string, args: Record<string, any> | undefined): string {
  if (!args) return toolName;
  // Keep the legacy contract: actionContent is just the tool name; actionArgs holds the JSON args.
  return toolName;
}

export function projectPartsToSteps(messages: WithParts[], options: ProjectionOptions = {}): AgentStep[] {
  const steps: AgentStep[] = [];
  const lastIndex = messages.length - 1;

  messages.forEach((msg, msgIndex) => {
    const isLast = msgIndex === lastIndex;

    if (msg.info.role === 'user') {
      // Compaction synthetic users carry a CompactionPart — collapse them
      // to a single mode_transition step so the UI shows the boundary.
      if (msg.parts.some(isCompactionPart)) {
        steps.push({
          type: 'mode_transition',
          content: 'Context compacted: older history replaced with an anchored summary.',
        });
        return;
      }
      const text = msg.parts
        .filter(isTextPart)
        .map((p) => p.text)
        .join('\n')
        .trim();
      if (text) {
        steps.push({ type: 'observation', content: `User Message: ${text}` });
      }
      return;
    }

    // assistant message
    const messageHasTool = msg.parts.some((p) => p.type === 'tool');
    for (const part of msg.parts) {
      if (isTextPart(part)) {
        // Final-message narration goes to the chat bubble (handled by
        // findFinalAnswer). Intermediate narration (this message also has a
        // tool call) goes into the trace as a `thought` step so the user
        // sees the LLM's reasoning inline with the commands.
        const trimmed = part.text.trim();
        if (!trimmed) continue;
        if (messageHasTool) {
          steps.push({ type: 'thought', content: trimmed });
        }
        continue;
      }

      if (isToolPart(part)) {
        // The dedicated tasks panel already shows the todo state live via
        // agent-tasks-updated. Hiding the tool entry from the trace avoids
        // showing both the JSON args ("todo (9 items)") and the formatted
        // observation alongside the panel.
        if (part.tool === 'todo') continue;
        const args = part.state.input || {};
        steps.push({
          type: 'action',
          content: describeToolForUI(part.tool, args),
          actionName: part.tool,
          actionArgs: args,
        });

        if (part.state.status === 'completed') {
          // Attachments (e.g. browser screenshots) are encoded as a leading
          // marker the frontend can parse out before rendering the body. We
          // can't extend AgentStep with arbitrary fields without breaking the
          // legacy wire shape, so we use a self-describing comment.
          const attachments = (part.state.metadata as any)?.attachments;
          const attachmentsBlock = Array.isArray(attachments) && attachments.length > 0
            ? `<!--operator:attachments=${JSON.stringify(attachments)}-->\n`
            : '';
          steps.push({
            type: 'observation',
            content: `${attachmentsBlock}${part.state.output || ''}`,
          });
        } else if (part.state.status === 'error') {
          steps.push({
            type: 'observation',
            content: `Error: ${part.state.error}`,
          });
        } else if (part.state.status === 'running') {
          steps.push({
            type: 'tool_progress',
            content: 'Running…',
            actionName: part.tool,
          });
        }
        // pending -> no observation step yet; the action alone is enough.
        continue;
      }

      if (isCompactionPart(part)) {
        steps.push({
          type: 'mode_transition',
          content: 'Context compacted.',
        });
        continue;
      }

      // Other part kinds (reasoning, file, agent, subtask, retry, step-*, snapshot, patch)
      // are ignored for the legacy UI projection — they have no AgentStep equivalent.
    }
  });

  return steps;
}

/**
 * Return the final assistant text — only when the latest assistant message
 * has NO tool parts (i.e. the LLM stopped calling tools and produced a
 * direct reply). Intermediate narration (text that sits alongside a tool
 * call) belongs in the trace as a `thought` step, not in the chat bubble.
 *
 * Returns null while the run is still pumping tools, so the bubble stays
 * empty until a real settled answer exists.
 */
export function findFinalAnswer(messages: WithParts[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info.role !== 'assistant') continue;
    const hasTool = msg.parts.some((p) => p.type === 'tool');
    if (hasTool) return null;
    const text = msg.parts
      .filter(isTextPart)
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join('\n\n')
      .trim();
    return text || null;
  }
  return null;
}

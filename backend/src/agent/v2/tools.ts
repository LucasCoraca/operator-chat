// Re-exports of the spec-compliant SSH agent tool surface. The actual
// definitions live in `sshTools.ts`; this module exists so callers (the
// runner, server.ts) can keep importing from `./tools` while the
// implementation grew large enough to deserve its own file.

export {
  PUBLISHED_SSH_AGENT_TOOLS as SSH_AGENT_TOOL_NAMES,
  getSshAgentTool,
  getSshAgentToolDefinitions,
  getSshAgentToolPolicy,
  type SshAgentTool,
  type SshAgentToolName,
  type SshAgentToolContext,
  type SshAgentToolResult,
  type SshAgentToolPolicy,
  type QuestionRequest,
  type QuestionResponse,
  type SubagentRequest,
  type SubagentLaunchResult,
} from './sshTools';

import { getSshAgentTool, type SshAgentToolContext, type SshAgentToolResult } from './sshTools';
import type { AgentSessionRepository } from '../../repositories/agentSessionRepository';
import type { AgentRunTaskRepository } from '../../repositories/agentRunTaskRepository';

/**
 * Execute a tool call from the SSH agent loop. Resolves through the v2 tool
 * surface (sshTools.ts); unknown tools are routed to the `invalid` fallback.
 */
export async function executeAgentTool(
  name: string,
  args: Record<string, any>,
  context: SshAgentToolContext,
  sessions: AgentSessionRepository,
  tasks: AgentRunTaskRepository
): Promise<SshAgentToolResult> {
  const tool = getSshAgentTool(name) || getSshAgentTool('invalid');
  if (!tool) {
    return {
      output: `Error: tool '${name}' is not available to the SSH agent.`,
      isError: true,
      truncated: false,
    };
  }
  try {
    return await tool.execute(args, context, sessions, tasks);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { output: `Error: ${message}`, isError: true, truncated: false };
  }
}

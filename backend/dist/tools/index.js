"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolRegistry = void 0;
const browserClient_1 = require("../services/browserClient");
const youtubeTranscriptClient_1 = require("../services/youtubeTranscriptClient");
const workspaceRuntime_1 = require("../services/workspaceRuntime");
const agentMemoryService_1 = require("../services/agentMemoryService");
const taskRepository_1 = require("../repositories/taskRepository");
const agentRunTaskRepository_1 = require("../repositories/agentRunTaskRepository");
const schedule_1 = require("../services/schedule");
const child_process_1 = require("child_process");
const util_1 = require("util");
const diff_1 = require("diff");
const browserClient = new browserClient_1.BrowserClient();
const youtubeTranscriptClient = new youtubeTranscriptClient_1.YouTubeTranscriptClient();
const execAsync = (0, util_1.promisify)(child_process_1.exec);
function quoteShellArg(value) {
    return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
function diffPreview(filePath, oldContent, newContent, maxLines = 220) {
    // Use a real Myers-based diff via the `diff` package instead of the
    // previous lockstep-by-index walk that produced nonsense whenever lines
    // were inserted or removed.
    const patch = (0, diff_1.createPatch)(filePath, oldContent, newContent, '', '', { context: 3 });
    const lines = patch.split('\n');
    const start = lines.findIndex((line) => line.startsWith('---'));
    const diffText = start >= 0 ? lines.slice(start).join('\n').trimEnd() : patch.trimEnd();
    // Count additions/deletions for the header
    let additions = 0;
    let deletions = 0;
    for (const line of diffText.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++'))
            additions++;
        if (line.startsWith('-') && !line.startsWith('---'))
            deletions++;
    }
    // Truncate to maxLines of diff content
    const diffLines = diffText.split('\n');
    const truncated = diffLines.length > maxLines
        ? [...diffLines.slice(0, maxLines), '[diff preview truncated]']
        : diffLines;
    const header = `• Edited ${filePath} (+${additions} -${deletions})`;
    return [header, ...truncated].join('\n');
}
function isRemoteWorkspaceContext(context) {
    return Boolean(context.workspace?.ssh?.enabled);
}
function formatTaskListForObservation(tasks) {
    if (tasks.length === 0) {
        return 'No tasks yet. Use task_create to add tasks.';
    }
    const lines = [];
    for (const task of tasks) {
        const marker = task.status === 'completed' ? '[x]' : task.status === 'in_progress' ? '[~]' : '[ ]';
        lines.push(`${marker} ${task.id}  ${task.subject}`);
        if (task.description) {
            lines.push(`     ${task.description.split('\n').join('\n     ')}`);
        }
    }
    return lines.join('\n');
}
async function emitTaskUpdate(context) {
    if (!context.chatId || !context.agentRunId)
        return [];
    const tasks = await agentRunTaskRepository_1.agentRunTaskRepository.listByRun(context.chatId, context.agentRunId);
    context.emitAgentTasksUpdated?.(context.chatId, context.agentRunId, tasks);
    return tasks;
}
class ToolRegistry {
    tools;
    searxngClient;
    sandboxManager;
    workspaceRuntimeFactory;
    memoryManager;
    agentMemoryService;
    mcpClientManager;
    constructor(searxngClient, sandboxManager, memoryManager, mcpClientManager, agentMemoryService) {
        this.tools = new Map();
        this.searxngClient = searxngClient;
        this.sandboxManager = sandboxManager;
        this.workspaceRuntimeFactory = new workspaceRuntime_1.WorkspaceRuntimeFactory(sandboxManager);
        this.memoryManager = memoryManager;
        this.agentMemoryService = agentMemoryService;
        this.mcpClientManager = mcpClientManager;
        this.registerBuiltInTools();
        // Note: MCP tools are registered dynamically via registerMCPTools() when servers connect
    }
    registerBuiltInTools() {
        this.tools.set('create_agent', {
            name: 'create_agent',
            description: 'Start a separate coding agent run in the configured SSH remote environment. Use this when the user asks to create/start/run an agent. The agent live trace will appear in the originating chat. The model must choose the workspaceRoot for the agent. The prompt must include explicit Success Criteria, Non-goals, and Required Verification sections so the coding agent knows when to stop.',
            parameters: {
                title: { type: 'string', description: 'Short title for the agent run' },
                prompt: { type: 'string', description: 'Complete task instruction for the new agent. Include explicit Success Criteria, Non-goals, and Required Verification sections. Success Criteria should define the requested outcome; Non-goals should prevent scope drift; Required Verification should be bounded and practical.' },
                workspaceRoot: { type: 'string', description: 'Absolute remote workspace path where the agent should run commands and edit files' },
            },
            policy: {
                requiresApproval: true,
                supportsAutoApprove: false,
                capabilities: ['process', 'filesystem', 'remote', 'write_chat'],
                sandboxPolicy: 'ssh_remote',
                riskLevel: 'high',
            },
            execute: async (args, context) => {
                if (!context.workspace?.ssh?.enabled) {
                    return 'Agent mode is not available. Configure the SSH remote workspace in Settings first, including host/IP, username, workspace root, and SSH key.';
                }
                if (!context.createAgentRun) {
                    return 'Error: Agent runner is not available in this context.';
                }
                const title = String(args.title || '').trim();
                const prompt = String(args.prompt || '').trim();
                const workspaceRoot = String(args.workspaceRoot || '').trim();
                if (!title || !prompt || !workspaceRoot) {
                    return 'Error: title, prompt, and workspaceRoot are required to create an agent.';
                }
                if (!workspaceRoot.startsWith('/')) {
                    return 'Error: workspaceRoot must be an absolute remote path.';
                }
                try {
                    const runId = await context.createAgentRun({ title, prompt, workspaceRoot });
                    return `__agent_run_started__:${runId}`;
                }
                catch (error) {
                    return `Error creating agent run: ${error instanceof Error ? error.message : String(error)}`;
                }
            },
        });
        this.tools.set('list', {
            name: 'list',
            internal: true,
            description: 'List files and directories in the active workspace. In SSH agent mode this lists the configured remote workspace root. Use this to explore project structure before reading files.',
            parameters: {
                path: { type: 'string', description: 'Directory path relative to the active workspace root. Use "." for the root.', required: false },
            },
            policy: {
                requiresApproval: false,
                supportsAutoApprove: true,
                capabilities: ['filesystem', 'remote'],
                sandboxPolicy: 'workspace_runtime',
                riskLevel: 'low',
            },
            execute: async (args, context) => {
                try {
                    const runtime = this.workspaceRuntimeFactory.createRemote(context.workspace);
                    return await runtime.list(args.path || '.');
                }
                catch (error) {
                    return `Error listing workspace: ${error instanceof Error ? error.message : String(error)}`;
                }
            },
        });
        this.tools.set('read', {
            name: 'read',
            internal: true,
            description: 'Read a text file from the active workspace, or list a directory if the path is a directory. Supports line offset and limit for large files.',
            parameters: {
                path: { type: 'string', description: 'File or directory path relative to the active workspace root' },
                offset: { type: 'number', description: 'Line number to start reading from, 1-indexed. Defaults to 1.', required: false },
                limit: { type: 'number', description: 'Maximum number of lines to read. Defaults to 300 and is capped at 1000.', required: false },
            },
            policy: {
                requiresApproval: false,
                supportsAutoApprove: true,
                capabilities: ['filesystem', 'remote'],
                sandboxPolicy: 'workspace_runtime',
                riskLevel: 'low',
            },
            execute: async (args, context) => {
                const filePath = args.path;
                if (!filePath) {
                    return 'Error: path is required';
                }
                try {
                    // Note: the previous "memory hit" short-circuit returned a 1600-char summary
                    // for any offset on a file that had been read once, which broke pagination
                    // (the model would loop asking for higher offsets and keep getting line 1-40).
                    // Range-aware deduplication now lives in the agent's fileViewCache layer.
                    const runtime = this.workspaceRuntimeFactory.createRemote(context.workspace);
                    const result = await runtime.readFile(filePath, {
                        offset: args.offset !== undefined ? Number(args.offset) : undefined,
                        limit: args.limit !== undefined ? Number(args.limit) : undefined,
                    });
                    if (context.agentMemory && context.chatId) {
                        await context.agentMemory.recordFileRead({ chatId: context.chatId, workspace: context.workspace, agentRunId: context.agentRunId }, filePath, result, args.offset !== undefined ? Number(args.offset) : undefined, args.limit !== undefined ? Number(args.limit) : undefined);
                    }
                    return result;
                }
                catch (error) {
                    return `Error reading workspace file: ${error instanceof Error ? error.message : String(error)}`;
                }
            },
        });
        this.tools.set('glob', {
            name: 'glob',
            internal: true,
            description: 'Find files in the active workspace by glob-like path pattern. Use this to discover files before reading them. Example patterns: "**/*.ts", "src/**/*.tsx", "README*".',
            parameters: {
                pattern: { type: 'string', description: 'Glob-like file pattern relative to the active workspace root' },
            },
            policy: {
                requiresApproval: false,
                supportsAutoApprove: true,
                capabilities: ['filesystem', 'remote'],
                sandboxPolicy: 'workspace_runtime',
                riskLevel: 'low',
            },
            execute: async (args, context) => {
                const pattern = args.pattern;
                if (!pattern) {
                    return 'Error: pattern is required';
                }
                try {
                    const runtime = this.workspaceRuntimeFactory.createRemote(context.workspace);
                    const result = await runtime.exec({
                        command: `find . -path ${quoteShellArg(`./${pattern}`)} -type f | sed 's#^./##' | sort | head -200`,
                    });
                    if (result.exitCode !== 0) {
                        return `Glob failed:\n${result.stderr || result.stdout || 'Unknown error'}`;
                    }
                    return result.stdout.trim() || 'No files matched.';
                }
                catch (error) {
                    return `Error searching workspace files: ${error instanceof Error ? error.message : String(error)}`;
                }
            },
        });
        this.tools.set('grep', {
            name: 'grep',
            internal: true,
            description: 'Search text in files in the active workspace using an extended regular expression. Use this for code search before reading or editing files.',
            parameters: {
                pattern: { type: 'string', description: 'Extended regular expression to search for' },
                include: { type: 'string', description: 'Optional file glob to include, such as "*.ts" or "*.tsx".', required: false },
            },
            policy: {
                requiresApproval: false,
                supportsAutoApprove: true,
                capabilities: ['filesystem', 'remote'],
                sandboxPolicy: 'workspace_runtime',
                riskLevel: 'low',
            },
            execute: async (args, context) => {
                const pattern = args.pattern;
                if (!pattern) {
                    return 'Error: pattern is required';
                }
                try {
                    const runtime = this.workspaceRuntimeFactory.createRemote(context.workspace);
                    const include = args.include ? ` --include=${quoteShellArg(String(args.include))}` : '';
                    const result = await runtime.exec({
                        command: `grep -RInE --exclude-dir=.git${include} -- ${quoteShellArg(pattern)} . | head -200`,
                    });
                    if (result.exitCode !== 0 && !result.stdout.trim()) {
                        return result.stderr.trim() ? `Grep failed:\n${result.stderr.trim()}` : 'No matches found.';
                    }
                    return result.stdout.trim() || 'No matches found.';
                }
                catch (error) {
                    return `Error searching workspace content: ${error instanceof Error ? error.message : String(error)}`;
                }
            },
        });
        this.tools.set('memory_get', {
            name: 'memory_get',
            internal: true,
            description: 'Read backend-managed coding-agent memory for the active SSH workspace. Use this before rereading files or when resuming context.',
            parameters: {
                kind: { type: 'string', description: 'Optional memory kind filter such as active_context, progress, file_summary, command, error.', required: false },
                query: { type: 'string', description: 'Optional text search across memory content and keys.', required: false },
                limit: { type: 'number', description: 'Maximum memories to return. Defaults to 30.', required: false },
            },
            policy: {
                requiresApproval: false,
                supportsAutoApprove: true,
                capabilities: ['memory', 'remote'],
                sandboxPolicy: 'workspace_runtime',
                riskLevel: 'low',
            },
            execute: async (args, context) => {
                const memory = context.agentMemory || this.agentMemoryService;
                if (!memory || !context.chatId) {
                    return 'Memory is not available in this context.';
                }
                const scope = { chatId: context.chatId, workspace: context.workspace, agentRunId: context.agentRunId };
                const limit = args.limit !== undefined ? Number(args.limit) : 30;
                const records = args.query
                    ? await memory.search(scope, String(args.query), limit)
                    : await memory.list(scope, args.kind ? [String(args.kind)] : undefined, limit);
                if (records.length === 0) {
                    return 'No matching memories.';
                }
                return records.map((record) => (`- ${record.kind} ${record.memory_key} (${record.source}/${record.confidence})\n${record.content}`)).join('\n\n');
            },
        });
        this.tools.set('memory_set', {
            name: 'memory_set',
            internal: true,
            description: 'Store or update one backend-managed agent memory item. Use for decisions, active context, todos, progress, and file summaries.',
            parameters: {
                kind: { type: 'string', description: 'Memory kind: active_context, progress, todo, decision, file_summary, command, error, test_result.' },
                key: { type: 'string', description: 'Stable key for the memory, such as current, todo:auth, decision:state-management, file:src/App.tsx.' },
                content: { type: 'string', description: 'Concise memory content to preserve for future agent turns.' },
            },
            policy: {
                requiresApproval: false,
                supportsAutoApprove: true,
                capabilities: ['memory', 'remote'],
                sandboxPolicy: 'workspace_runtime',
                riskLevel: 'low',
            },
            execute: async (args, context) => {
                const memory = context.agentMemory || this.agentMemoryService;
                if (!memory || !context.chatId) {
                    return 'Memory is not available in this context.';
                }
                const kind = String(args.kind || '');
                const key = String(args.key || '').trim();
                const content = String(args.content || '').trim();
                if (!kind || !key || !content) {
                    return 'Error: kind, key, and content are required.';
                }
                await memory.upsert({ chatId: context.chatId, workspace: context.workspace, agentRunId: context.agentRunId }, { kind, key, content, source: 'agent', confidence: 'agent_claim' });
                return `Memory updated: ${kind} ${key}`;
            },
        });
        this.tools.set('memory_checkpoint', {
            name: 'memory_checkpoint',
            internal: true,
            description: 'Save a structured progress checkpoint into backend-managed memory. Use after major milestones, before compaction, and before final answer.',
            parameters: {
                activeContext: { type: 'string', description: 'Current state of the task and what is being worked on.' },
                progress: { type: 'string', description: 'Completed work, preferably concise bullet text.' },
                nextSteps: { type: 'string', description: 'Remaining concrete next steps.' },
                decisions: { type: 'string', description: 'Important decisions or architecture choices.', required: false },
            },
            policy: {
                requiresApproval: false,
                supportsAutoApprove: true,
                capabilities: ['memory', 'remote'],
                sandboxPolicy: 'workspace_runtime',
                riskLevel: 'low',
            },
            execute: async (args, context) => {
                const memory = context.agentMemory || this.agentMemoryService;
                if (!memory || !context.chatId) {
                    return 'Memory is not available in this context.';
                }
                const scope = { chatId: context.chatId, workspace: context.workspace, agentRunId: context.agentRunId };
                const updates = [
                    ['active_context', 'current', args.activeContext],
                    ['progress', 'current', args.progress],
                    ['todo', 'next_steps', args.nextSteps],
                    ['decision', 'current', args.decisions],
                ];
                for (const [kind, key, content] of updates) {
                    const text = String(content || '').trim();
                    if (!text)
                        continue;
                    await memory.upsert(scope, {
                        kind: kind,
                        key,
                        content: text,
                        source: 'agent',
                        confidence: 'agent_claim',
                    });
                }
                return 'Memory checkpoint saved.';
            },
        });
        this.tools.set('task_create', {
            name: 'task_create',
            internal: true,
            description: 'Create a new task in the SSH agent run\'s checklist. Use this before starting non-trivial multi-step work to lay out the plan. Each task gets a unique id you will use to mark it in_progress and completed.',
            parameters: {
                subject: { type: 'string', description: 'Short imperative task title (e.g., "Add migration for users table")' },
                description: { type: 'string', description: 'Optional longer description of what this task entails.', required: false },
            },
            policy: {
                requiresApproval: false,
                supportsAutoApprove: true,
                capabilities: [],
                sandboxPolicy: 'none',
                riskLevel: 'low',
            },
            execute: async (args, context) => {
                if (!context.chatId || !context.agentRunId) {
                    return 'task_create is only available inside a spawned SSH agent run.';
                }
                const subject = String(args.subject || '').trim();
                if (!subject) {
                    return 'Error: subject is required';
                }
                const description = args.description !== undefined && args.description !== null
                    ? String(args.description).trim() || null
                    : null;
                const created = await agentRunTaskRepository_1.agentRunTaskRepository.create({
                    chatId: context.chatId,
                    agentRunId: context.agentRunId,
                    subject,
                    description,
                });
                const tasks = await emitTaskUpdate(context);
                return `Created task ${created.id}: ${created.subject}\n\nCurrent task list:\n${formatTaskListForObservation(tasks)}`;
            },
        });
        this.tools.set('task_update', {
            name: 'task_update',
            internal: true,
            description: 'Update a task\'s status, subject, or description. Mark a task in_progress when you begin working on it, and completed when finished. Status values: pending, in_progress, completed.',
            parameters: {
                taskId: { type: 'string', description: 'The task id returned by task_create' },
                status: { type: 'string', description: 'New status: pending, in_progress, or completed. Optional.', required: false },
                subject: { type: 'string', description: 'New subject. Optional.', required: false },
                description: { type: 'string', description: 'New description. Optional.', required: false },
            },
            policy: {
                requiresApproval: false,
                supportsAutoApprove: true,
                capabilities: [],
                sandboxPolicy: 'none',
                riskLevel: 'low',
            },
            execute: async (args, context) => {
                if (!context.chatId || !context.agentRunId) {
                    return 'task_update is only available inside a spawned SSH agent run.';
                }
                const taskId = String(args.taskId || '').trim();
                if (!taskId) {
                    return 'Error: taskId is required';
                }
                const update = {};
                if (args.subject !== undefined) {
                    update.subject = String(args.subject).trim();
                }
                if (args.description !== undefined) {
                    const text = args.description === null ? null : String(args.description).trim();
                    update.description = text || null;
                }
                if (args.status !== undefined) {
                    const status = String(args.status).trim();
                    if (!['pending', 'in_progress', 'completed'].includes(status)) {
                        return 'Error: status must be one of pending, in_progress, completed';
                    }
                    update.status = status;
                }
                if (Object.keys(update).length === 0) {
                    return 'Error: at least one of status, subject, or description must be provided';
                }
                const updated = await agentRunTaskRepository_1.agentRunTaskRepository.update(taskId, context.agentRunId, update);
                if (!updated) {
                    return `Error: task ${taskId} not found in this agent run.`;
                }
                const tasks = await emitTaskUpdate(context);
                return `Updated task ${updated.id} (${updated.status}): ${updated.subject}\n\nCurrent task list:\n${formatTaskListForObservation(tasks)}`;
            },
        });
        this.tools.set('task_list', {
            name: 'task_list',
            internal: true,
            description: 'List all tasks in the SSH agent run\'s checklist with their statuses. Use this to recall your current plan before deciding the next step.',
            parameters: {},
            policy: {
                requiresApproval: false,
                supportsAutoApprove: true,
                capabilities: [],
                sandboxPolicy: 'none',
                riskLevel: 'low',
            },
            execute: async (_args, context) => {
                if (!context.chatId || !context.agentRunId) {
                    return 'task_list is only available inside a spawned SSH agent run.';
                }
                const tasks = await agentRunTaskRepository_1.agentRunTaskRepository.listByRun(context.chatId, context.agentRunId);
                return formatTaskListForObservation(tasks);
            },
        });
        this.tools.set('bash', {
            name: 'bash',
            internal: true,
            description: 'Run a shell command in the active workspace. In SSH agent mode this runs on the configured remote host. Use workdir instead of cd. Prefer read/edit/write/apply_patch for file changes.',
            parameters: {
                command: { type: 'string', description: 'The shell command to execute' },
                description: { type: 'string', description: 'Clear concise description of what this command does' },
                workdir: { type: 'string', description: 'Working directory relative to the active workspace root. Defaults to root.', required: false },
                timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds. Defaults to 120000.', required: false },
            },
            policy: {
                requiresApproval: true,
                supportsAutoApprove: true,
                capabilities: ['process', 'filesystem', 'remote'],
                sandboxPolicy: 'workspace_runtime',
                riskLevel: 'high',
            },
            execute: async (args, context) => {
                const command = args.command;
                if (!command) {
                    return 'Error: command is required';
                }
                try {
                    const runtime = this.workspaceRuntimeFactory.createRemote(context.workspace);
                    let streamMode = 'stdout';
                    const result = await runtime.exec({
                        command,
                        workdir: args.workdir,
                        timeoutMs: args.timeoutMs !== undefined ? Number(args.timeoutMs) : undefined,
                        onStdout: (chunk) => {
                            let text = chunk;
                            if (text.includes('__OPERATOR_CHAT_STDERR_CHUNK__') || text.includes('__OPERATOR_CHAT_STDOUT_CHUNK__')) {
                                const parts = text.split(/(__OPERATOR_CHAT_STDERR_CHUNK__|__OPERATOR_CHAT_STDOUT_CHUNK__)/);
                                for (const part of parts) {
                                    if (!part)
                                        continue;
                                    if (part === '__OPERATOR_CHAT_STDERR_CHUNK__') {
                                        streamMode = 'stderr';
                                        continue;
                                    }
                                    if (part === '__OPERATOR_CHAT_STDOUT_CHUNK__') {
                                        streamMode = 'stdout';
                                        continue;
                                    }
                                    context.emitToolProgress?.(streamMode === 'stderr' ? `[stderr]\n${part}` : part);
                                }
                                return;
                            }
                            context.emitToolProgress?.(streamMode === 'stderr' ? `[stderr]\n${text}` : text);
                        },
                        onStderr: (chunk) => context.emitToolProgress?.(`[ssh stderr]\n${chunk}`),
                    });
                    const sections = [
                        `Command: ${command}`,
                        `Workspace: ${runtime.kind} ${runtime.root}`,
                        `Exit code: ${result.exitCode ?? 'unknown'}`,
                        `Duration: ${result.durationMs}ms`,
                    ];
                    if (result.timedOut) {
                        if (result.background) {
                            sections.push(`Status: still running in background terminal ${result.background.terminalId}`);
                            sections.push(`PID: ${result.background.pid}`);
                            sections.push('Use terminal_read to read more output later or terminal_kill to stop it.');
                        }
                        else {
                            sections.push('Status: timed out and was terminated');
                        }
                    }
                    if (result.stdout.trim()) {
                        sections.push(`\nSTDOUT:\n${result.stdout.trimEnd()}`);
                    }
                    if (result.stderr.trim()) {
                        sections.push(`\nSTDERR:\n${result.stderr.trimEnd()}`);
                    }
                    if (!result.stdout.trim() && !result.stderr.trim()) {
                        sections.push('\n(no output)');
                    }
                    if (context.agentMemory && context.chatId) {
                        await context.agentMemory.recordCommand({ chatId: context.chatId, workspace: context.workspace, agentRunId: context.agentRunId }, command, {
                            exitCode: result.exitCode,
                            stdout: result.stdout,
                            stderr: result.stderr,
                            durationMs: result.durationMs,
                        });
                    }
                    return sections.join('\n');
                }
                catch (error) {
                    return `Error running workspace command: ${error instanceof Error ? error.message : String(error)}`;
                }
            },
        });
        this.tools.set('terminal_list', {
            name: 'terminal_list',
            internal: true,
            description: 'List managed background terminals started by long-running bash commands in the active SSH workspace.',
            parameters: {},
            policy: {
                requiresApproval: false,
                supportsAutoApprove: true,
                capabilities: ['process', 'remote'],
                sandboxPolicy: 'workspace_runtime',
                riskLevel: 'low',
            },
            execute: async (_args, context) => {
                const runtime = this.workspaceRuntimeFactory.createRemote(context.workspace);
                if (!runtime.listTerminals) {
                    return 'Error: managed terminals are not supported by this workspace runtime.';
                }
                try {
                    return await runtime.listTerminals();
                }
                catch (error) {
                    return `Error listing managed terminals: ${error instanceof Error ? error.message : String(error)}`;
                }
            },
        });
        this.tools.set('terminal_read', {
            name: 'terminal_read',
            internal: true,
            description: 'Read status and recent output from a managed background terminal started by a long-running bash command.',
            parameters: {
                terminalId: { type: 'string', description: 'Managed terminal id returned by bash' },
                tailLines: { type: 'number', description: 'Number of stdout/stderr lines to read. Defaults to 120 and is capped at 1000.', required: false },
                maxBytes: { type: 'number', description: 'Maximum bytes to return per stream. Defaults to 65536 and is capped at 262144.', required: false },
            },
            policy: {
                requiresApproval: false,
                supportsAutoApprove: true,
                capabilities: ['process', 'remote'],
                sandboxPolicy: 'workspace_runtime',
                riskLevel: 'low',
            },
            execute: async (args, context) => {
                const runtime = this.workspaceRuntimeFactory.createRemote(context.workspace);
                if (!runtime.readTerminal) {
                    return 'Error: managed terminals are not supported by this workspace runtime.';
                }
                try {
                    return await runtime.readTerminal(String(args.terminalId || ''), args.tailLines !== undefined ? Number(args.tailLines) : undefined, args.maxBytes !== undefined ? Number(args.maxBytes) : undefined);
                }
                catch (error) {
                    return `Error reading managed terminal: ${error instanceof Error ? error.message : String(error)}`;
                }
            },
        });
        this.tools.set('terminal_kill', {
            name: 'terminal_kill',
            internal: true,
            description: 'Terminate a managed background terminal started by a long-running bash command.',
            parameters: {
                terminalId: { type: 'string', description: 'Managed terminal id returned by bash' },
            },
            policy: {
                requiresApproval: true,
                supportsAutoApprove: true,
                capabilities: ['process', 'remote'],
                sandboxPolicy: 'workspace_runtime',
                riskLevel: 'high',
            },
            execute: async (args, context) => {
                const runtime = this.workspaceRuntimeFactory.createRemote(context.workspace);
                if (!runtime.killTerminal) {
                    return 'Error: managed terminals are not supported by this workspace runtime.';
                }
                try {
                    return await runtime.killTerminal(String(args.terminalId || ''));
                }
                catch (error) {
                    return `Error killing managed terminal: ${error instanceof Error ? error.message : String(error)}`;
                }
            },
        });
        this.tools.set('write', {
            name: 'write',
            internal: true,
            description: 'Create or overwrite a text file in the active workspace. In SSH agent mode this writes to the configured remote host. Use edit for precise changes to existing files. Identical rewrites already tracked in backend memory are skipped.',
            parameters: {
                path: { type: 'string', description: 'File path relative to the active workspace root' },
                content: { type: 'string', description: 'Complete file content to write' },
            },
            policy: {
                requiresApproval: true,
                supportsAutoApprove: true,
                capabilities: ['filesystem', 'remote'],
                sandboxPolicy: 'workspace_runtime',
                riskLevel: 'medium',
            },
            execute: async (args, context) => {
                const filePath = args.path;
                if (!filePath) {
                    return 'Error: path is required';
                }
                if (args.content === undefined || args.content === null) {
                    return 'Error: content is required';
                }
                try {
                    const runtime = this.workspaceRuntimeFactory.createRemote(context.workspace);
                    const content = String(args.content);
                    const memory = context.agentMemory || this.agentMemoryService;
                    if (memory && context.chatId) {
                        const normalizedPath = (0, agentMemoryService_1.normalizeMemoryPath)(filePath, context.workspace);
                        const proposedHash = (0, agentMemoryService_1.agentMemoryContentHash)(content);
                        const fileState = await memory.get({ chatId: context.chatId, workspace: context.workspace, agentRunId: context.agentRunId }, 'file_state', `file:${normalizedPath}`);
                        const metadata = fileState?.metadata || {};
                        if (metadata.stale !== true && metadata.contentHash === proposedHash) {
                            return `Duplicate write skipped for ${normalizedPath}. Backend memory already has identical latest content (${proposedHash.slice(0, 12)}). Do not rewrite this file; continue with another file, run verification, or use memory_get if you need to recall what was written.`;
                        }
                    }
                    context.emitToolProgress?.(`${diffPreview(filePath, '', content)}\n`);
                    const result = await runtime.writeFile(filePath, content);
                    if (context.agentMemory && context.chatId) {
                        await context.agentMemory.recordFileWrite({ chatId: context.chatId, workspace: context.workspace, agentRunId: context.agentRunId }, filePath, content, 'write');
                    }
                    return result;
                }
                catch (error) {
                    return `Error writing workspace file: ${error instanceof Error ? error.message : String(error)}`;
                }
            },
        });
        this.tools.set('edit', {
            name: 'edit',
            internal: true,
            description: 'Modify an existing workspace file by replacing an exact oldString with newString. Use this for precise, reviewable code edits. If there are multiple matches, add more surrounding context.',
            parameters: {
                path: { type: 'string', description: 'File path relative to the active workspace root' },
                oldString: { type: 'string', description: 'Exact text to replace' },
                newString: { type: 'string', description: 'Replacement text' },
                replaceAll: { type: 'boolean', description: 'Replace all matches instead of requiring a unique match. Defaults to false.', required: false },
            },
            policy: {
                requiresApproval: true,
                supportsAutoApprove: true,
                capabilities: ['filesystem', 'remote'],
                sandboxPolicy: 'workspace_runtime',
                riskLevel: 'medium',
            },
            execute: async (args, context) => {
                const filePath = args.path;
                if (!filePath) {
                    return 'Error: path is required';
                }
                if (args.oldString === undefined || args.newString === undefined) {
                    return 'Error: oldString and newString are required';
                }
                try {
                    const runtime = this.workspaceRuntimeFactory.createRemote(context.workspace);
                    context.emitToolProgress?.(`${diffPreview(filePath, String(args.oldString), String(args.newString))}\n`);
                    const result = await runtime.editFile(filePath, String(args.oldString), String(args.newString), Boolean(args.replaceAll));
                    if (context.agentMemory && context.chatId) {
                        const latest = await runtime.readFile(filePath, { offset: 1, limit: 1000 });
                        await context.agentMemory.recordFileWrite({ chatId: context.chatId, workspace: context.workspace, agentRunId: context.agentRunId }, filePath, latest, 'edit');
                    }
                    return result;
                }
                catch (error) {
                    return `Error editing workspace file: ${error instanceof Error ? error.message : String(error)}`;
                }
            },
        });
        this.tools.set('apply_patch', {
            name: 'apply_patch',
            internal: true,
            description: 'Apply a patch to files in the active workspace. Paths in the patch must be relative to the workspace root and use OpenCode/Codex-style Begin Patch markers.',
            parameters: {
                patchText: { type: 'string', description: 'Full patch text with *** Begin Patch and *** End Patch markers' },
            },
            policy: {
                requiresApproval: true,
                supportsAutoApprove: true,
                capabilities: ['filesystem', 'remote'],
                sandboxPolicy: 'workspace_runtime',
                riskLevel: 'medium',
            },
            execute: async (args, context) => {
                const patchText = args.patchText;
                if (!patchText) {
                    return 'Error: patchText is required';
                }
                try {
                    const runtime = this.workspaceRuntimeFactory.createRemote(context.workspace);
                    context.emitToolProgress?.(`Applying patch...\n${patchText.slice(0, 20000)}${patchText.length > 20000 ? '\n[patch preview truncated]' : ''}\n`);
                    const result = await runtime.applyPatch(patchText);
                    if (context.agentMemory && context.chatId) {
                        const paths = context.agentMemory.extractPatchPaths(patchText);
                        for (const filePath of paths) {
                            await context.agentMemory.recordFilePatch({ chatId: context.chatId, workspace: context.workspace, agentRunId: context.agentRunId }, filePath, patchText);
                        }
                    }
                    return result;
                }
                catch (error) {
                    return `Error applying workspace patch: ${error instanceof Error ? error.message : String(error)}`;
                }
            },
        });
        // Web Search Tool
        this.tools.set('web_search', {
            name: 'web_search',
            description: 'Search the web for information using SearXNG. Use this to find current information, facts, news, or any information that might not be in your training data.',
            parameters: {
                query: { type: 'string', description: 'The search query' },
            },
            policy: {
                requiresApproval: false,
                supportsAutoApprove: true,
                capabilities: ['network'],
                sandboxPolicy: 'none',
                riskLevel: 'low',
            },
            execute: async (args, _context) => {
                const query = args.query;
                if (!query) {
                    return 'Error: No search query provided';
                }
                try {
                    const results = await this.searxngClient.search(query, 5);
                    if (results.length === 0) {
                        return 'No results found for the search query.';
                    }
                    return results
                        .map((r, i) => {
                        const content = `${r.content.substring(0, 500)}${r.content.length > 500 ? '...' : ''}`;
                        const image = r.imageUrl ? `\n   Image: ${r.imageUrl}` : '';
                        return `${i + 1}. ${r.title}\n   URL: ${r.url}${image}\n   Content: ${content}`;
                    })
                        .join('\n\n');
                }
                catch (error) {
                    // Return error message instead of throwing, so the agent can continue
                    return `Error: Web search failed - ${error instanceof Error ? error.message : 'Unknown error'}. The SearXNG server may not be running or is unreachable.`;
                }
            },
        });
        // YouTube Transcript Tool
        this.tools.set('youtube_transcript', {
            name: 'youtube_transcript',
            description: 'Fetch the spoken transcript (captions/subtitles) of a YouTube video using yt-dlp. Use this to summarize, quote, or answer questions about a video\'s content instead of guessing from the title. Prefers human-authored subtitles and falls back to auto-generated captions. Returns cleaned plain text plus the video title, channel, and duration.',
            parameters: {
                url: { type: 'string', description: 'YouTube video URL (watch, youtu.be, shorts, or embed) or an 11-character video id' },
                lang: { type: 'string', description: 'Preferred caption language code, e.g. "en", "pt", "es". Defaults to English; falls back to whatever is available.', required: false },
            },
            policy: {
                requiresApproval: false,
                supportsAutoApprove: true,
                capabilities: ['network'],
                sandboxPolicy: 'none',
                riskLevel: 'low',
            },
            execute: async (args, _context) => {
                const url = String(args.url || '').trim();
                if (!url) {
                    return 'Error: No YouTube URL or video id provided';
                }
                const lang = args.lang !== undefined ? String(args.lang).trim() || undefined : undefined;
                try {
                    const result = await youtubeTranscriptClient.fetch(url, { lang });
                    const header = [];
                    if (result.title)
                        header.push(`Title: ${result.title}`);
                    if (result.channel)
                        header.push(`Channel: ${result.channel}`);
                    if (result.durationString)
                        header.push(`Duration: ${result.durationString}`);
                    header.push(`URL: https://www.youtube.com/watch?v=${result.videoId}`);
                    header.push(`Captions: ${result.language || 'unknown'}${result.autoGenerated ? ' (auto-generated)' : ''}`);
                    // Cap very long transcripts so a single tool result can't blow the
                    // context window; long lectures can run to hundreds of KB of text.
                    const MAX_CHARS = 24_000;
                    let body = result.text;
                    let note = '';
                    if (body.length > MAX_CHARS) {
                        body = body.slice(0, MAX_CHARS);
                        note = `\n\n[Transcript truncated to ${MAX_CHARS} characters of ${result.text.length} total.]`;
                    }
                    return `${header.join('\n')}\n\n---\n\n${body}${note}`;
                }
                catch (error) {
                    if (error instanceof youtubeTranscriptClient_1.YouTubeTranscriptError) {
                        return `Error: ${error.message}`;
                    }
                    return `Error fetching YouTube transcript: ${error instanceof Error ? error.message : 'Unknown error'}`;
                }
            },
        });
        // Calculator Tool
        this.tools.set('calculator', {
            name: 'calculator',
            description: 'Perform mathematical calculations. Use this for any math operations including basic arithmetic, trigonometry, logarithms, etc.',
            parameters: {
                expression: { type: 'string', description: 'The mathematical expression to evaluate (e.g., "2 + 2", "sin(0.5)", "sqrt(16)")' },
            },
            policy: {
                requiresApproval: false,
                supportsAutoApprove: true,
                capabilities: [],
                sandboxPolicy: 'none',
                riskLevel: 'low',
            },
            execute: async (args, _context) => {
                const expression = args.expression;
                if (!expression) {
                    return 'Error: No expression provided';
                }
                try {
                    // Safe math evaluation using Function constructor with restricted scope
                    const safeMath = new Function('return ' + expression)();
                    return `Result: ${safeMath}`;
                }
                catch (error) {
                    return `Error: Invalid mathematical expression: ${error}`;
                }
            },
        });
        // File Read Tool
        this.tools.set('file_read', {
            name: 'file_read',
            description: 'Read the contents of a file from the sandbox directory. Supports text files and PDFs. Use this to examine files, read code, view text files, or extract text from PDF documents.',
            parameters: {
                path: { type: 'string', description: 'The path to the file to read (relative to sandbox root)' },
            },
            policy: {
                requiresApproval: false,
                supportsAutoApprove: true,
                capabilities: ['filesystem'],
                sandboxPolicy: 'chat_fs_only',
                riskLevel: 'low',
            },
            execute: async (args, context) => {
                const filePath = args.path;
                if (!filePath) {
                    return 'Error: No file path provided';
                }
                try {
                    const content = await this.sandboxManager.readFileAsync(context.sandboxId, filePath);
                    return `File contents of ${filePath}:\n\n${content}`;
                }
                catch (error) {
                    return `Error reading file: ${error}`;
                }
            },
        });
        // File Write Tool
        this.tools.set('file_write', {
            name: 'file_write',
            description: 'Write content to a file in the sandbox directory. Use this to create or modify files, save code, or store data.',
            parameters: {
                path: { type: 'string', description: 'The path where to write the file (relative to sandbox root)' },
                content: { type: 'string', description: 'The content to write to the file' },
            },
            policy: {
                requiresApproval: true,
                supportsAutoApprove: true,
                capabilities: ['filesystem'],
                sandboxPolicy: 'chat_fs_only',
                riskLevel: 'medium',
            },
            execute: async (args, context) => {
                const filePath = args.path;
                const content = args.content;
                if (!filePath) {
                    return 'Error: No file path provided';
                }
                if (!content) {
                    return 'Error: No content provided';
                }
                try {
                    this.sandboxManager.writeFile(context.sandboxId, filePath, content);
                    return `Successfully wrote ${content.length} bytes to ${filePath}`;
                }
                catch (error) {
                    return `Error writing file: ${error}`;
                }
            },
        });
        // File List Tool
        this.tools.set('file_list', {
            name: 'file_list',
            description: 'List files and directories in the sandbox. Use this to explore the file structure.',
            parameters: {
                path: { type: 'string', description: 'The directory path to list (relative to sandbox root, empty for root)' },
            },
            policy: {
                requiresApproval: false,
                supportsAutoApprove: true,
                capabilities: ['filesystem'],
                sandboxPolicy: 'chat_fs_only',
                riskLevel: 'low',
            },
            execute: async (args, context) => {
                if (isRemoteWorkspaceContext(context)) {
                    return 'Error: file_list is disabled in SSH agent mode. Use the remote list tool instead.';
                }
                const dirPath = args.path || '';
                try {
                    const items = this.sandboxManager.listFiles(context.sandboxId, dirPath);
                    if (items.length === 0) {
                        return `Directory ${dirPath || '/'} is empty.`;
                    }
                    return `Contents of ${dirPath || '/'}:\n${items.join('\n')}`;
                }
                catch (error) {
                    return `Error listing directory: ${error}`;
                }
            },
        });
        // Python Execute Tool
        this.tools.set('python_execute', {
            name: 'python_execute',
            description: 'Execute Python code in a sandboxed environment. Use this for data analysis, complex calculations, or running Python scripts. The code has access to the sandbox directory via the SANDBOX_PATH environment variable.',
            parameters: {
                code: { type: 'string', description: 'The Python code to execute' },
            },
            policy: {
                requiresApproval: true,
                supportsAutoApprove: true,
                capabilities: ['filesystem', 'process'],
                sandboxPolicy: 'isolated_process',
                riskLevel: 'high',
            },
            execute: async (args, context) => {
                if (isRemoteWorkspaceContext(context)) {
                    return 'Error: python_execute is disabled in SSH agent mode. Use bash to run commands on the configured remote workspace.';
                }
                const code = args.code;
                if (!code) {
                    return 'Error: No Python code provided';
                }
                const sandbox = this.sandboxManager.getSandbox(context.sandboxId);
                if (!sandbox) {
                    return 'Error: Sandbox not found';
                }
                try {
                    const result = await execAsync(`python3 -c "${code.replace(/"/g, '\\"')}"`, {
                        cwd: sandbox.basePath,
                        env: {
                            ...process.env,
                            SANDBOX_PATH: sandbox.basePath,
                        },
                        timeout: 30000, // 30 second timeout
                    });
                    return result.stdout || result.stderr || 'Code executed successfully with no output.';
                }
                catch (error) {
                    return `Python execution error:\n${error.message || error.stdout || error.stderr || 'Unknown error'}`;
                }
            },
        });
        // Create Directory Tool
        this.tools.set('file_mkdir', {
            name: 'file_mkdir',
            description: 'Create a new directory in the sandbox.',
            parameters: {
                path: { type: 'string', description: 'The path of the directory to create (relative to sandbox root)' },
            },
            policy: {
                requiresApproval: true,
                supportsAutoApprove: true,
                capabilities: ['filesystem'],
                sandboxPolicy: 'chat_fs_only',
                riskLevel: 'medium',
            },
            execute: async (args, context) => {
                if (isRemoteWorkspaceContext(context)) {
                    return 'Error: file_mkdir is disabled in SSH agent mode. Use bash or write through the configured remote workspace.';
                }
                const dirPath = args.path;
                if (!dirPath) {
                    return 'Error: No directory path provided';
                }
                try {
                    this.sandboxManager.createDirectory(context.sandboxId, dirPath);
                    return `Successfully created directory: ${dirPath}`;
                }
                catch (error) {
                    return `Error creating directory: ${error}`;
                }
            },
        });
        // Delete File Tool
        this.tools.set('file_delete', {
            name: 'file_delete',
            description: 'Delete a file or directory from the sandbox.',
            parameters: {
                path: { type: 'string', description: 'The path of the file or directory to delete (relative to sandbox root)' },
            },
            policy: {
                requiresApproval: true,
                supportsAutoApprove: false,
                capabilities: ['filesystem'],
                sandboxPolicy: 'chat_fs_only',
                riskLevel: 'high',
            },
            execute: async (args, context) => {
                if (isRemoteWorkspaceContext(context)) {
                    return 'Error: file_delete is disabled in SSH agent mode. Use bash on the configured remote workspace if deletion is explicitly required.';
                }
                const filePath = args.path;
                if (!filePath) {
                    return 'Error: No path provided';
                }
                try {
                    this.sandboxManager.deleteFile(context.sandboxId, filePath);
                    return `Successfully deleted: ${filePath}`;
                }
                catch (error) {
                    return `Error deleting file: ${error}`;
                }
            },
        });
        // Browser Visit Tool
        this.tools.set('browser_visit', {
            name: 'browser_visit',
            description: 'Visit a website and extract its content. First call without startChar/endChar to get page structure with headings and character positions. Then use startChar and endChar to read specific sections. This helps manage context by reading only relevant parts. The page is cached for 30 minutes.',
            parameters: {
                url: { type: 'string', description: 'The URL to visit (must include http:// or https://)' },
                startChar: { type: 'number', description: 'Starting character position to read from (optional). If not provided, returns page structure with headings.' },
                endChar: { type: 'number', description: 'Ending character position to read to (optional). Use with startChar to read a section.' },
            },
            policy: {
                requiresApproval: true,
                supportsAutoApprove: true,
                capabilities: ['network', 'browser'],
                sandboxPolicy: 'browser_isolated',
                riskLevel: 'medium',
            },
            execute: async (args, _context) => {
                const url = args.url;
                const startChar = args.startChar;
                const endChar = args.endChar;
                if (!url) {
                    return 'Error: No URL provided';
                }
                // Validate URL format
                if (!url.startsWith('http://') && !url.startsWith('https://')) {
                    return 'Error: URL must start with http:// or https://';
                }
                try {
                    const content = await browserClient.visit(url, { startChar, endChar });
                    if (content.error) {
                        return `Error visiting ${url}: ${content.error}`;
                    }
                    let result = `# ${content.title}\n\n`;
                    result += `URL: ${content.url}\n`;
                    result += `Words: ${content.wordCount} | Tokens: ~${content.tokenCount}\n`;
                    if (content.sectionStart !== undefined && content.sectionEnd !== undefined) {
                        result += `Section: Characters ${content.sectionStart} to ${content.sectionEnd}\n`;
                    }
                    if (content.truncated) {
                        result += `Status: **TRUNCATED** (original was longer)\n`;
                    }
                    result += '\n---\n\n';
                    // Add headings outline if available (when viewing page structure)
                    if (content.headings && content.headings.length > 0) {
                        result += '## Page Structure\n\n';
                        result += `The page has ${content.headings.length} headings. Use startChar and endChar to read specific sections.\n\n`;
                        content.headings.forEach((h) => {
                            result += `${'#'.repeat(h.level)} ${h.text} (chars ${h.charStart ?? 0}-${h.charEnd ?? 0})\n`;
                        });
                        result += '\n---\n\n';
                    }
                    // Add the main content
                    result += content.markdown;
                    return result;
                }
                catch (error) {
                    return `Error visiting ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`;
                }
            },
        });
        // Save Memory Tool
        this.tools.set('save_memory', {
            name: 'save_memory',
            description: 'Save an important fact or user preference to long-term memory. Use this to remember things across conversations. Be concise and factual.',
            parameters: {
                content: { type: 'string', description: 'The fact or preference to remember' },
                tags: { type: 'string', description: 'Optional comma-separated tags to categorize this memory' },
            },
            policy: {
                requiresApproval: false,
                supportsAutoApprove: true,
                capabilities: ['memory'],
                sandboxPolicy: 'none',
                riskLevel: 'low',
            },
            execute: async (args, context) => {
                const content = args.content;
                const tagsStr = args.tags;
                const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()) : undefined;
                if (!content) {
                    return 'Error: No content provided to remember';
                }
                try {
                    const memory = await this.memoryManager.addMemory(context.userId, content, tags);
                    return `Successfully remembered: "${content}" (ID: ${memory.id})`;
                }
                catch (error) {
                    return `Error saving memory: ${error}`;
                }
            },
        });
        // Delete Memory Tool
        this.tools.set('delete_memory', {
            name: 'delete_memory',
            description: 'Delete a fact from long-term memory using its ID.',
            parameters: {
                id: { type: 'string', description: 'The ID of the memory to delete' },
            },
            policy: {
                requiresApproval: true,
                supportsAutoApprove: false,
                capabilities: ['memory'],
                sandboxPolicy: 'none',
                riskLevel: 'medium',
            },
            execute: async (args, context) => {
                const id = args.id;
                if (!id) {
                    return 'Error: No memory ID provided';
                }
                try {
                    const success = await this.memoryManager.deleteMemory(id, context.userId);
                    if (success) {
                        return `Successfully deleted memory with ID: ${id}`;
                    }
                    else {
                        return `Error: Memory with ID ${id} not found or belongs to another user.`;
                    }
                }
                catch (error) {
                    return `Error deleting memory: ${error}`;
                }
            },
        });
        // Schedule Task Tool
        this.tools.set('schedule_task', {
            name: 'schedule_task',
            description: 'Create a scheduled AI task for the current user. Use this when the user asks you to do something later or repeatedly, such as "tomorrow at 9", "every weekday", "daily", "weekly", or "every 30 minutes". The task will run the provided prompt in the background and write the result to the attached chat.',
            parameters: {
                title: { type: 'string', description: 'Short human-readable task title' },
                prompt: { type: 'string', description: 'The full instruction the AI should execute when the task runs' },
                scheduleType: { type: 'string', description: 'One of: once, daily, weekdays, weekly, interval' },
                runAt: { type: 'string', description: 'ISO date/time for one-time tasks. Required only when scheduleType is once.', required: false },
                intervalMinutes: { type: 'number', description: 'Number of minutes between runs. Required only when scheduleType is interval.', required: false },
                daysOfWeek: { type: 'string', description: 'Comma-separated day numbers for weekly tasks, where 0=Sunday and 6=Saturday. Example: "1,3,5". Required only when scheduleType is weekly.', required: false },
                timeOfDay: { type: 'string', description: 'Local HH:MM time for daily, weekdays, or weekly schedules. Example: "09:00".', required: false },
                timezone: { type: 'string', description: 'IANA timezone name. Use UTC if unknown.', required: false },
            },
            policy: {
                requiresApproval: true,
                supportsAutoApprove: false,
                capabilities: ['schedule', 'write_chat'],
                sandboxPolicy: 'none',
                riskLevel: 'medium',
            },
            execute: async (args, context) => {
                const title = String(args.title || '').trim();
                const prompt = String(args.prompt || '').trim();
                const scheduleType = String(args.scheduleType || '').trim();
                const timezone = String(args.timezone || 'UTC').trim() || 'UTC';
                if (!title || !prompt) {
                    return 'Error: title and prompt are required to schedule a task.';
                }
                if (!['once', 'daily', 'weekdays', 'weekly', 'interval'].includes(scheduleType)) {
                    return 'Error: scheduleType must be one of once, daily, weekdays, weekly, or interval.';
                }
                const rawDaysOfWeek = typeof args.daysOfWeek === 'string'
                    ? args.daysOfWeek.split(',').map((value) => value.trim())
                    : args.daysOfWeek;
                const daysOfWeek = (0, schedule_1.normalizeDaysOfWeek)(rawDaysOfWeek);
                const intervalMinutes = args.intervalMinutes !== undefined ? Number(args.intervalMinutes) : null;
                const runAt = args.runAt ? String(args.runAt) : null;
                const timeOfDay = args.timeOfDay ? String(args.timeOfDay) : null;
                const nextRunAt = (0, schedule_1.computeNextRun)({
                    scheduleType,
                    runAt,
                    intervalMinutes,
                    daysOfWeek,
                    timeOfDay,
                });
                if (!nextRunAt) {
                    return 'Error: The schedule does not produce a future run time. For one-time tasks, provide a future ISO runAt value.';
                }
                const task = await taskRepository_1.taskRepository.create({
                    userId: context.userId,
                    chatId: context.chatId || null,
                    sandboxId: context.sandboxId || null,
                    title,
                    prompt,
                    scheduleType,
                    runAt: runAt ? new Date(runAt) : null,
                    intervalMinutes,
                    daysOfWeek,
                    timeOfDay,
                    timezone,
                    model: context.model || null,
                    approvalMode: { alwaysApprove: false },
                    reasoningEffort: 'medium',
                    nextRunAt,
                });
                return `Scheduled task created successfully.\nID: ${task.id}\nTitle: ${task.title}\nNext run: ${nextRunAt.toISOString()}\nSchedule type: ${task.schedule_type}`;
            },
        });
    }
    // Public method to re-register MCP tools (called when servers connect/disconnect)
    registerMCPTools() {
        if (!this.mcpClientManager) {
            return;
        }
        // Remove existing MCP tools
        for (const [toolName] of this.tools.entries()) {
            if (toolName.startsWith('mcp_')) {
                this.tools.delete(toolName);
            }
        }
        const mcpTools = this.mcpClientManager.getTools();
        for (const mcpTool of mcpTools) {
            // Create a tool name with server prefix to avoid conflicts
            const toolName = `mcp_${mcpTool.serverName}_${mcpTool.name}`;
            // Convert MCP input schema to our parameter format
            const parameters = {};
            const requiredParams = mcpTool.inputSchema.required || [];
            if (mcpTool.inputSchema.properties) {
                for (const [key, prop] of Object.entries(mcpTool.inputSchema.properties)) {
                    const propDef = prop;
                    parameters[key] = {
                        type: propDef.type || 'string',
                        description: propDef.description || `Parameter ${key}`,
                    };
                }
            }
            // Determine risk level based on tool capabilities
            let riskLevel = 'medium';
            let requiresApproval = true;
            let supportsAutoApprove = true;
            // MCP tools are generally considered medium risk since they're external
            // Users can configure auto-approve in the UI
            const toolLower = mcpTool.name.toLowerCase();
            if (toolLower.includes('read') || toolLower.includes('get') || toolLower.includes('list') || toolLower.includes('search')) {
                riskLevel = 'low';
                requiresApproval = false;
            }
            else if (toolLower.includes('delete') || toolLower.includes('remove') || toolLower.includes('write')) {
                riskLevel = 'high';
                supportsAutoApprove = false;
            }
            const serverName = mcpTool.serverName;
            const toolNameOriginal = mcpTool.name;
            this.tools.set(toolName, {
                name: toolName,
                description: `[MCP:${mcpTool.serverName}] ${mcpTool.description}`,
                parameters,
                policy: {
                    requiresApproval,
                    supportsAutoApprove,
                    capabilities: ['network'],
                    sandboxPolicy: 'none',
                    riskLevel,
                },
                execute: async (args, _context) => {
                    try {
                        return await this.mcpClientManager.executeTool(serverName, toolNameOriginal, args);
                    }
                    catch (error) {
                        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                        return `Error executing MCP tool '${mcpTool.name}': ${errorMessage}`;
                    }
                },
            });
        }
        if (mcpTools.length > 0) {
            console.log(`Registered ${mcpTools.length} MCP tools from ${new Set(mcpTools.map(t => t.serverName)).size} server(s)`);
        }
    }
    getTools() {
        return Array.from(this.tools.values());
    }
    getPublicTools() {
        return this.getTools().filter((tool) => !tool.internal);
    }
    getFilteredTools(enabledToolNames) {
        if (!enabledToolNames) {
            return this.getTools();
        }
        const enabledSet = new Set(enabledToolNames);
        return this.getTools().filter((tool) => enabledSet.has(tool.name));
    }
    getTool(name) {
        return this.tools.get(name);
    }
    getToolPolicy(name) {
        return this.tools.get(name)?.policy;
    }
    getDefaultPreferences() {
        return this.getTools().reduce((acc, tool) => {
            acc[tool.name] = {
                enabled: true,
                autoApprove: !tool.policy.requiresApproval,
            };
            return acc;
        }, {});
    }
    mergeWithDefaultPreferences(preferences, defaultPreferences) {
        const defaults = this.getDefaultPreferences();
        if (defaultPreferences) {
            for (const tool of this.getTools()) {
                const storedDefault = defaultPreferences[tool.name];
                if (storedDefault) {
                    defaults[tool.name] = {
                        enabled: storedDefault.enabled ?? defaults[tool.name].enabled,
                        autoApprove: tool.policy.supportsAutoApprove
                            ? storedDefault.autoApprove ?? defaults[tool.name].autoApprove
                            : false,
                    };
                }
            }
        }
        if (!preferences) {
            return defaults;
        }
        for (const tool of this.getTools()) {
            const stored = preferences[tool.name];
            if (stored) {
                defaults[tool.name] = {
                    enabled: stored.enabled ?? defaults[tool.name].enabled,
                    autoApprove: tool.policy.supportsAutoApprove
                        ? stored.autoApprove ?? defaults[tool.name].autoApprove
                        : false,
                };
            }
        }
        return defaults;
    }
    async executeTool(name, args, context, enabledToolNames) {
        const availableTools = this.getFilteredTools(enabledToolNames);
        const tool = availableTools.find((candidate) => candidate.name === name);
        if (!tool) {
            const availableNames = availableTools.map((candidate) => candidate.name);
            return `Error: Unknown or disabled tool '${name}'. Available tools: ${availableNames.length > 0 ? availableNames.join(', ') : 'none'}`;
        }
        return tool.execute(args, context);
    }
    getToolDescriptions(enabledToolNames) {
        const availableTools = this.getFilteredTools(enabledToolNames);
        if (availableTools.length === 0) {
            return 'No tools are currently enabled. You must answer directly without making tool calls.';
        }
        return availableTools
            .map((tool) => `${tool.name}(${Object.entries(tool.parameters)
            .map(([k, v]) => `${k}: ${v.type}`)
            .join(', ')}): ${tool.description} [risk=${tool.policy.riskLevel}; sandbox=${tool.policy.sandboxPolicy}; approval=${tool.policy.requiresApproval ? 'required' : 'not-required'}]`)
            .join('\n');
    }
    // Convert tools to OpenAI-compatible tool definitions for native tool calling
    getToolDefinitions() {
        return Array.from(this.tools.values()).map((tool) => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: {
                    type: 'object',
                    properties: Object.entries(tool.parameters).reduce((acc, [key, value]) => {
                        acc[key] = {
                            type: value.type,
                            description: value.description,
                        };
                        return acc;
                    }, {}),
                    required: Object.entries(tool.parameters)
                        .filter(([, value]) => value.required !== false)
                        .map(([key]) => key),
                },
            },
        }));
    }
    getFilteredToolDefinitions(enabledToolNames) {
        return this.getFilteredTools(enabledToolNames).map((tool) => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: {
                    type: 'object',
                    properties: Object.entries(tool.parameters).reduce((acc, [key, value]) => {
                        acc[key] = {
                            type: value.type,
                            description: value.description,
                        };
                        return acc;
                    }, {}),
                    required: Object.entries(tool.parameters)
                        .filter(([, value]) => value.required !== false)
                        .map(([key]) => key),
                },
            },
        }));
    }
}
exports.ToolRegistry = ToolRegistry;
//# sourceMappingURL=index.js.map
import { SearXNGClient, SearchResult } from '../services/searxngClient';
import { SandboxManager } from '../services/sandboxManager';
import { BrowserClient } from '../services/browserClient';
import { MemoryManager } from '../services/memoryManager';
import { MCPClientManager, MCPToolDefinition } from '../services/mcpClientManager';
import { WorkspaceConfig, WorkspaceRuntimeFactory } from '../services/workspaceRuntime';
import type { CreateAgentRunRequest } from '../agent/ReActAgent';
import { taskRepository } from '../repositories/taskRepository';
import { computeNextRun, normalizeDaysOfWeek } from '../services/schedule';
import { exec } from 'child_process';
import { promisify } from 'util';

const browserClient = new BrowserClient();
const execAsync = promisify(exec);

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function isRemoteWorkspaceContext(context: { workspace?: WorkspaceConfig }): boolean {
  return Boolean(context.workspace?.ssh?.enabled);
}

export type ToolCapability =
  | 'filesystem'
  | 'network'
  | 'process'
  | 'remote'
  | 'browser'
  | 'read_chat'
  | 'write_chat'
  | 'memory'
  | 'schedule';

export type ToolSandboxPolicy =
  | 'none'
  | 'chat_fs_only'
  | 'isolated_process'
  | 'workspace_runtime'
  | 'ssh_remote'
  | 'browser_isolated';

export type ToolRiskLevel = 'low' | 'medium' | 'high';

export interface ToolExecutionPolicy {
  requiresApproval: boolean;
  supportsAutoApprove: boolean;
  capabilities: ToolCapability[];
  sandboxPolicy: ToolSandboxPolicy;
  riskLevel: ToolRiskLevel;
}

export interface ChatToolPreference {
  enabled: boolean;
  autoApprove: boolean;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  policy: ToolExecutionPolicy;
  internal?: boolean;
  execute: (args: Record<string, any>, context: { sandboxId: string; userId: string; chatId?: string; model?: string; workspace?: WorkspaceConfig; createAgentRun?: (request: CreateAgentRunRequest) => Promise<string> }) => Promise<string>;
}

export class ToolRegistry {
  private tools: Map<string, Tool>;
  private searxngClient: SearXNGClient;
  private sandboxManager: SandboxManager;
  private workspaceRuntimeFactory: WorkspaceRuntimeFactory;
  private memoryManager: MemoryManager;
  private mcpClientManager?: MCPClientManager;

  constructor(searxngClient: SearXNGClient, sandboxManager: SandboxManager, memoryManager: MemoryManager, mcpClientManager?: MCPClientManager) {
    this.tools = new Map();
    this.searxngClient = searxngClient;
    this.sandboxManager = sandboxManager;
    this.workspaceRuntimeFactory = new WorkspaceRuntimeFactory(sandboxManager);
    this.memoryManager = memoryManager;
    this.mcpClientManager = mcpClientManager;
    
    this.registerBuiltInTools();
    // Note: MCP tools are registered dynamically via registerMCPTools() when servers connect
  }

  private registerBuiltInTools(): void {
    this.tools.set('create_agent', {
      name: 'create_agent',
      description: 'Start a separate coding agent run in the configured SSH remote environment. Use this when the user asks to create/start/run an agent. The agent live trace will appear in the originating chat. The model must choose the workspaceRoot for the agent.',
      parameters: {
        title: { type: 'string', description: 'Short title for the agent run' },
        prompt: { type: 'string', description: 'Complete task instruction for the new agent' },
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
        } catch (error) {
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
          return await runtime.list((args.path as string) || '.');
        } catch (error) {
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
        const filePath = args.path as string;
        if (!filePath) {
          return 'Error: path is required';
        }

        try {
          const runtime = this.workspaceRuntimeFactory.createRemote(context.workspace);
          return await runtime.readFile(filePath, {
            offset: args.offset !== undefined ? Number(args.offset) : undefined,
            limit: args.limit !== undefined ? Number(args.limit) : undefined,
          });
        } catch (error) {
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
        const pattern = args.pattern as string;
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
        } catch (error) {
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
        const pattern = args.pattern as string;
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
        } catch (error) {
          return `Error searching workspace content: ${error instanceof Error ? error.message : String(error)}`;
        }
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
        const command = args.command as string;
        if (!command) {
          return 'Error: command is required';
        }

        try {
          const runtime = this.workspaceRuntimeFactory.createRemote(context.workspace);
          const result = await runtime.exec({
            command,
            workdir: args.workdir as string | undefined,
            timeoutMs: args.timeoutMs !== undefined ? Number(args.timeoutMs) : undefined,
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
            } else {
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
          return sections.join('\n');
        } catch (error) {
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
        } catch (error) {
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
          return await runtime.readTerminal(
            String(args.terminalId || ''),
            args.tailLines !== undefined ? Number(args.tailLines) : undefined,
            args.maxBytes !== undefined ? Number(args.maxBytes) : undefined
          );
        } catch (error) {
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
        } catch (error) {
          return `Error killing managed terminal: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    });

    this.tools.set('write', {
      name: 'write',
      internal: true,
      description: 'Create or overwrite a text file in the active workspace. In SSH agent mode this writes to the configured remote host. Use edit for precise changes to existing files.',
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
        const filePath = args.path as string;
        if (!filePath) {
          return 'Error: path is required';
        }
        if (args.content === undefined || args.content === null) {
          return 'Error: content is required';
        }

        try {
          const runtime = this.workspaceRuntimeFactory.createRemote(context.workspace);
          return await runtime.writeFile(filePath, String(args.content));
        } catch (error) {
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
        const filePath = args.path as string;
        if (!filePath) {
          return 'Error: path is required';
        }
        if (args.oldString === undefined || args.newString === undefined) {
          return 'Error: oldString and newString are required';
        }

        try {
          const runtime = this.workspaceRuntimeFactory.createRemote(context.workspace);
          return await runtime.editFile(filePath, String(args.oldString), String(args.newString), Boolean(args.replaceAll));
        } catch (error) {
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
        const patchText = args.patchText as string;
        if (!patchText) {
          return 'Error: patchText is required';
        }

        try {
          const runtime = this.workspaceRuntimeFactory.createRemote(context.workspace);
          return await runtime.applyPatch(patchText);
        } catch (error) {
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
        const query = args.query as string;
        if (!query) {
          return 'Error: No search query provided';
        }
        
        try {
          const results = await this.searxngClient.search(query, 5);
          
          if (results.length === 0) {
            return 'No results found for the search query.';
          }

          return results
            .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Content: ${r.content.substring(0, 500)}${r.content.length > 500 ? '...' : ''}`)
            .join('\n\n');
        } catch (error) {
          // Return error message instead of throwing, so the agent can continue
          return `Error: Web search failed - ${error instanceof Error ? error.message : 'Unknown error'}. The SearXNG server may not be running or is unreachable.`;
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
        const expression = args.expression as string;
        if (!expression) {
          return 'Error: No expression provided';
        }

        try {
          // Safe math evaluation using Function constructor with restricted scope
          const safeMath = new Function('return ' + expression)();
          return `Result: ${safeMath}`;
        } catch (error) {
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
        const filePath = args.path as string;
        if (!filePath) {
          return 'Error: No file path provided';
        }

        try {
          const content = await this.sandboxManager.readFileAsync(context.sandboxId, filePath);
          return `File contents of ${filePath}:\n\n${content}`;
        } catch (error) {
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
        const filePath = args.path as string;
        const content = args.content as string;
        
        if (!filePath) {
          return 'Error: No file path provided';
        }
        if (!content) {
          return 'Error: No content provided';
        }

        try {
          this.sandboxManager.writeFile(context.sandboxId, filePath, content);
          return `Successfully wrote ${content.length} bytes to ${filePath}`;
        } catch (error) {
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
        const dirPath = (args.path as string) || '';

        try {
          const items = this.sandboxManager.listFiles(context.sandboxId, dirPath);
          if (items.length === 0) {
            return `Directory ${dirPath || '/'} is empty.`;
          }
          return `Contents of ${dirPath || '/'}:\n${items.join('\n')}`;
        } catch (error) {
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
        const code = args.code as string;
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
        } catch (error: any) {
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
        const dirPath = args.path as string;
        if (!dirPath) {
          return 'Error: No directory path provided';
        }

        try {
          this.sandboxManager.createDirectory(context.sandboxId, dirPath);
          return `Successfully created directory: ${dirPath}`;
        } catch (error) {
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
        const filePath = args.path as string;
        if (!filePath) {
          return 'Error: No path provided';
        }

        try {
          this.sandboxManager.deleteFile(context.sandboxId, filePath);
          return `Successfully deleted: ${filePath}`;
        } catch (error) {
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
        const url = args.url as string;
        const startChar = args.startChar as number | undefined;
        const endChar = args.endChar as number | undefined;

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
            content.headings.forEach((h: { level: number; text: string; charStart?: number; charEnd?: number }) => {
              result += `${'#'.repeat(h.level)} ${h.text} (chars ${h.charStart ?? 0}-${h.charEnd ?? 0})\n`;
            });
            result += '\n---\n\n';
          }

          // Add the main content
          result += content.markdown;

          return result;
        } catch (error) {
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
        const content = args.content as string;
        const tagsStr = args.tags as string | undefined;
        const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()) : undefined;

        if (!content) {
          return 'Error: No content provided to remember';
        }

        try {
          const memory = await this.memoryManager.addMemory(context.userId, content, tags);
          return `Successfully remembered: "${content}" (ID: ${memory.id})`;
        } catch (error) {
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
        const id = args.id as string;
        if (!id) {
          return 'Error: No memory ID provided';
        }

        try {
          const success = await this.memoryManager.deleteMemory(id, context.userId);
          if (success) {
            return `Successfully deleted memory with ID: ${id}`;
          } else {
            return `Error: Memory with ID ${id} not found or belongs to another user.`;
          }
        } catch (error) {
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
        const scheduleType = String(args.scheduleType || '').trim() as any;
        const timezone = String(args.timezone || 'UTC').trim() || 'UTC';

        if (!title || !prompt) {
          return 'Error: title and prompt are required to schedule a task.';
        }

        if (!['once', 'daily', 'weekdays', 'weekly', 'interval'].includes(scheduleType)) {
          return 'Error: scheduleType must be one of once, daily, weekdays, weekly, or interval.';
        }

        const rawDaysOfWeek = typeof args.daysOfWeek === 'string'
          ? args.daysOfWeek.split(',').map((value: string) => value.trim())
          : args.daysOfWeek;
        const daysOfWeek = normalizeDaysOfWeek(rawDaysOfWeek);
        const intervalMinutes = args.intervalMinutes !== undefined ? Number(args.intervalMinutes) : null;
        const runAt = args.runAt ? String(args.runAt) : null;
        const timeOfDay = args.timeOfDay ? String(args.timeOfDay) : null;

        const nextRunAt = computeNextRun({
          scheduleType,
          runAt,
          intervalMinutes,
          daysOfWeek,
          timeOfDay,
        });

        if (!nextRunAt) {
          return 'Error: The schedule does not produce a future run time. For one-time tasks, provide a future ISO runAt value.';
        }

        const task = await taskRepository.create({
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
  public registerMCPTools(): void {
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
      const parameters: Record<string, { type: string; description: string; required?: boolean }> = {};
      const requiredParams = mcpTool.inputSchema.required || [];
      
      if (mcpTool.inputSchema.properties) {
        for (const [key, prop] of Object.entries(mcpTool.inputSchema.properties)) {
          const propDef = prop as any;
          parameters[key] = {
            type: propDef.type || 'string',
            description: propDef.description || `Parameter ${key}`,
          };
        }
      }

      // Determine risk level based on tool capabilities
      let riskLevel: ToolRiskLevel = 'medium';
      let requiresApproval = true;
      let supportsAutoApprove = true;

      // MCP tools are generally considered medium risk since they're external
      // Users can configure auto-approve in the UI
      const toolLower = mcpTool.name.toLowerCase();
      if (toolLower.includes('read') || toolLower.includes('get') || toolLower.includes('list') || toolLower.includes('search')) {
        riskLevel = 'low';
        requiresApproval = false;
      } else if (toolLower.includes('delete') || toolLower.includes('remove') || toolLower.includes('write')) {
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
            return await this.mcpClientManager!.executeTool(serverName, toolNameOriginal, args);
          } catch (error) {
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

  getTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  getPublicTools(): Tool[] {
    return this.getTools().filter((tool) => !tool.internal);
  }

  getFilteredTools(enabledToolNames?: string[]): Tool[] {
    if (!enabledToolNames) {
      return this.getTools();
    }

    const enabledSet = new Set(enabledToolNames);
    return this.getTools().filter((tool) => enabledSet.has(tool.name));
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getToolPolicy(name: string): ToolExecutionPolicy | undefined {
    return this.tools.get(name)?.policy;
  }

  getDefaultPreferences(): Record<string, ChatToolPreference> {
    return this.getTools().reduce((acc, tool) => {
      acc[tool.name] = {
        enabled: true,
        autoApprove: !tool.policy.requiresApproval,
      };
      return acc;
    }, {} as Record<string, ChatToolPreference>);
  }

  mergeWithDefaultPreferences(
    preferences?: Record<string, ChatToolPreference>,
    defaultPreferences?: Record<string, ChatToolPreference>
  ): Record<string, ChatToolPreference> {
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

  async executeTool(
    name: string,
    args: Record<string, any>,
    context: { sandboxId: string; userId: string; chatId?: string; model?: string; workspace?: WorkspaceConfig; createAgentRun?: (request: CreateAgentRunRequest) => Promise<string> },
    enabledToolNames?: string[]
  ): Promise<string> {
    const availableTools = this.getFilteredTools(enabledToolNames);
    const tool = availableTools.find((candidate) => candidate.name === name);
    if (!tool) {
      const availableNames = availableTools.map((candidate) => candidate.name);
      return `Error: Unknown or disabled tool '${name}'. Available tools: ${availableNames.length > 0 ? availableNames.join(', ') : 'none'}`;
    }

    return tool.execute(args, context);
  }

  getToolDescriptions(enabledToolNames?: string[]): string {
    const availableTools = this.getFilteredTools(enabledToolNames);
    if (availableTools.length === 0) {
      return 'No tools are currently enabled. You must answer directly without making tool calls.';
    }

    return availableTools
      .map(
        (tool: Tool) =>
          `${tool.name}(${Object.entries(tool.parameters)
            .map(([k, v]) => `${k}: ${v.type}`)
            .join(', ')}): ${tool.description} [risk=${tool.policy.riskLevel}; sandbox=${tool.policy.sandboxPolicy}; approval=${tool.policy.requiresApproval ? 'required' : 'not-required'}]`
      )
      .join('\n');
  }

  // Convert tools to OpenAI-compatible tool definitions for native tool calling
  getToolDefinitions(): Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: {
        type: 'object';
        properties: Record<string, any>;
        required: string[];
      };
    };
  }> {
    return Array.from(this.tools.values()).map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: Object.entries(tool.parameters).reduce(
            (acc, [key, value]) => {
              acc[key] = {
                type: value.type,
                description: value.description,
              };
              return acc;
            },
            {} as Record<string, any>
          ),
          required: Object.entries(tool.parameters)
            .filter(([, value]) => value.required !== false)
            .map(([key]) => key),
        },
      },
    }));
  }

  getFilteredToolDefinitions(enabledToolNames?: string[]): Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: {
        type: 'object';
        properties: Record<string, any>;
        required: string[];
      };
    };
  }> {
    return this.getFilteredTools(enabledToolNames).map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: Object.entries(tool.parameters).reduce(
            (acc, [key, value]) => {
              acc[key] = {
                type: value.type,
                description: value.description,
              };
              return acc;
            },
            {} as Record<string, any>
          ),
          required: Object.entries(tool.parameters)
            .filter(([, value]) => value.required !== false)
            .map(([key]) => key),
        },
      },
    }));
  }
}

import { SandboxManager } from './sandboxManager';
export type WorkspaceKind = 'local_sandbox' | 'ssh_remote';
export interface SshWorkspaceConfig {
    enabled: boolean;
    host: string;
    port?: number;
    username: string;
    root: string;
    privateKeyPath?: string;
    privateKey?: string;
    strictHostKeyChecking?: boolean;
}
export interface WorkspaceConfig {
    type?: WorkspaceKind;
    ssh?: SshWorkspaceConfig;
}
export interface WorkspaceContext {
    sandboxId: string;
    workspace?: WorkspaceConfig;
}
export interface CommandOptions {
    command: string;
    workdir?: string;
    timeoutMs?: number;
}
export interface CommandResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
    background?: {
        terminalId: string;
        pid: string;
        status: 'running' | 'completed' | 'unknown';
    };
}
export interface ReadOptions {
    offset?: number;
    limit?: number;
}
export interface WorkspaceRuntime {
    readonly kind: WorkspaceKind;
    readonly root: string;
    list(relativePath?: string): Promise<string>;
    readFile(relativePath: string, options?: ReadOptions): Promise<string>;
    writeFile(relativePath: string, content: string): Promise<string>;
    editFile(relativePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<string>;
    applyPatch(patchText: string): Promise<string>;
    exec(options: CommandOptions): Promise<CommandResult>;
    listTerminals?(): Promise<string>;
    readTerminal?(terminalId: string, tailLines?: number, maxBytes?: number): Promise<string>;
    killTerminal?(terminalId: string): Promise<string>;
}
declare abstract class BaseWorkspaceRuntime implements WorkspaceRuntime {
    abstract readonly kind: WorkspaceKind;
    abstract readonly root: string;
    abstract list(relativePath?: string): Promise<string>;
    abstract readFile(relativePath: string, options?: ReadOptions): Promise<string>;
    abstract writeFile(relativePath: string, content: string): Promise<string>;
    abstract exec(options: CommandOptions): Promise<CommandResult>;
    editFile(relativePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<string>;
    applyPatch(patchText: string): Promise<string>;
    protected readRawFile(relativePath: string): Promise<string>;
}
export declare class LocalWorkspaceRuntime extends BaseWorkspaceRuntime {
    private sandboxManager;
    private sandboxId;
    readonly kind: "local_sandbox";
    readonly root: string;
    constructor(sandboxManager: SandboxManager, sandboxId: string);
    list(relativePath?: string): Promise<string>;
    readFile(relativePath: string, options?: ReadOptions): Promise<string>;
    protected readRawFile(relativePath: string): Promise<string>;
    writeFile(relativePath: string, content: string): Promise<string>;
    exec(options: CommandOptions): Promise<CommandResult>;
}
export declare class SshWorkspaceRuntime extends BaseWorkspaceRuntime {
    private config;
    readonly kind: "ssh_remote";
    readonly root: string;
    constructor(config: SshWorkspaceConfig);
    list(relativePath?: string): Promise<string>;
    readFile(relativePath: string, options?: ReadOptions): Promise<string>;
    protected readRawFile(relativePath: string): Promise<string>;
    writeFile(relativePath: string, content: string): Promise<string>;
    exec(options: CommandOptions): Promise<CommandResult>;
    listTerminals(): Promise<string>;
    readTerminal(terminalId: string, tailLines?: number, maxBytes?: number): Promise<string>;
    killTerminal(terminalId: string): Promise<string>;
    private remotePath;
    private sshArgs;
    private execRaw;
    private terminalRoot;
    private execManaged;
}
export declare class WorkspaceRuntimeFactory {
    private sandboxManager;
    constructor(sandboxManager: SandboxManager);
    createRemote(config?: WorkspaceConfig): WorkspaceRuntime;
    create(context: WorkspaceContext): WorkspaceRuntime;
}
export {};
//# sourceMappingURL=workspaceRuntime.d.ts.map
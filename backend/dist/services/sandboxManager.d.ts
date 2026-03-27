export interface SandboxInfo {
    id: string;
    basePath: string;
    createdAt: Date;
    protectedFiles: Set<string>;
}
export interface FileListItem {
    path: string;
    isDirectory: boolean;
    isProtected: boolean;
}
export declare class SandboxManager {
    private baseDirectory;
    private sandboxes;
    constructor(baseDirectory?: string);
    loadSandboxesFromDisk(): void;
    createSandbox(): SandboxInfo;
    getSandbox(sandboxId: string): SandboxInfo | undefined;
    addSandbox(sandboxId: string, basePath: string): SandboxInfo;
    protectFile(sandboxId: string, filename: string): void;
    isFileProtected(sandboxId: string, filename: string): boolean;
    listFilesWithProtection(sandboxId: string, relativePath?: string): FileListItem[];
    deleteSandbox(sandboxId: string): boolean;
    listFiles(sandboxId: string, relativePath?: string): string[];
    readFile(sandboxId: string, relativePath: string): string;
    readFileAsync(sandboxId: string, relativePath: string): Promise<string>;
    writeFile(sandboxId: string, relativePath: string, content: string): void;
    deleteFile(sandboxId: string, relativePath: string): void;
    createDirectory(sandboxId: string, relativePath: string): void;
    getAllSandboxes(): SandboxInfo[];
}
//# sourceMappingURL=sandboxManager.d.ts.map
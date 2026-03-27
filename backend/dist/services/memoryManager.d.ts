import { Memory } from '../repositories';
export { Memory };
export declare class MemoryManager {
    constructor(_filePath?: string);
    getMemories(userId: string): Promise<Memory[]>;
    addMemory(userId: string, content: string, tags?: string[]): Promise<Memory>;
    updateMemory(id: string, userId: string, content: string, tags?: string[]): Promise<Memory | null>;
    deleteMemory(id: string, userId: string): Promise<boolean>;
    searchMemories(userId: string, query: string): Promise<Memory[]>;
}
//# sourceMappingURL=memoryManager.d.ts.map
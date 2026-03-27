export interface Memory {
    id: string;
    user_id: string;
    content: string;
    tags: string[] | null;
    created_at: Date;
    updated_at: Date;
}
export interface CreateMemoryInput {
    userId: string;
    content: string;
    tags?: string[];
}
export interface UpdateMemoryInput {
    content?: string;
    tags?: string[];
}
export declare class MemoryRepository {
    findById(id: string): Promise<Memory | null>;
    findByUserId(userId: string): Promise<Memory[]>;
    create(input: CreateMemoryInput): Promise<Memory>;
    update(id: string, userId: string, input: UpdateMemoryInput): Promise<Memory | null>;
    delete(id: string, userId: string): Promise<boolean>;
    deleteByUserId(userId: string): Promise<number>;
    search(userId: string, searchTerm: string): Promise<Memory[]>;
    findByTag(userId: string, tag: string): Promise<Memory[]>;
    countByUserId(userId: string): Promise<number>;
}
export declare const memoryRepository: MemoryRepository;
//# sourceMappingURL=memoryRepository.d.ts.map
export interface Personality {
    id: string;
    user_id: string;
    name: string;
    description: string | null;
    tone: string | null;
    system_prompt: string;
    is_custom: boolean;
    created_at: Date;
    updated_at: Date;
}
export interface CreatePersonalityInput {
    userId: string;
    name: string;
    description?: string;
    tone?: string;
    systemPrompt: string;
}
export interface UpdatePersonalityInput {
    name?: string;
    description?: string;
    tone?: string;
    systemPrompt?: string;
}
export declare class PersonalityRepository {
    findById(id: string): Promise<Personality | null>;
    findByUserId(userId: string): Promise<Personality[]>;
    findCustomByUserId(userId: string): Promise<Personality[]>;
    create(input: CreatePersonalityInput): Promise<Personality>;
    update(id: string, userId: string, input: UpdatePersonalityInput): Promise<Personality | null>;
    delete(id: string, userId: string): Promise<boolean>;
    deleteByUserId(userId: string): Promise<number>;
    existsByName(userId: string, name: string): Promise<boolean>;
}
export declare const personalityRepository: PersonalityRepository;
//# sourceMappingURL=personalityRepository.d.ts.map
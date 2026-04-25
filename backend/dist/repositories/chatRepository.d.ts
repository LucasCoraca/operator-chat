export interface Chat {
    id: string;
    user_id: string;
    sandbox_id: string;
    name: string;
    agent_state: any;
    tool_preferences: any;
    approval_mode: any;
    created_at: Date;
    updated_at: Date;
}
export interface ChatMessage {
    id: string;
    chat_id: string;
    role: 'user' | 'assistant';
    content: string;
    model: string | null;
    agent_steps: any;
    message_index: number;
    created_at: Date;
}
export interface CreateChatInput {
    id?: string;
    userId: string;
    sandboxId: string;
    name?: string;
    toolPreferences?: any;
    approvalMode?: any;
}
export interface CreateMessageInput {
    id?: string;
    chatId: string;
    role: 'user' | 'assistant';
    content: string;
    model?: string;
    agentSteps?: any;
    messageIndex: number;
}
export interface ChatSummary {
    id: string;
    sandbox_id: string;
    message_count: number;
    name: string;
    created_at: Date;
    updated_at: Date;
}
export declare class ChatRepository {
    findAll(): Promise<Chat[]>;
    findById(id: string): Promise<Chat | null>;
    findByUserId(userId: string): Promise<ChatSummary[]>;
    create(input: CreateChatInput): Promise<Chat>;
    update(id: string, updates: Partial<Chat>): Promise<Chat | null>;
    delete(id: string): Promise<boolean>;
    deleteByUserId(userId: string): Promise<number>;
    findMessagesByChatId(chatId: string): Promise<ChatMessage[]>;
    addMessage(input: CreateMessageInput): Promise<ChatMessage>;
    updateMessage(id: string, updates: Partial<ChatMessage>): Promise<ChatMessage | null>;
    deleteMessagesFromIndex(chatId: string, fromIndex: number): Promise<number>;
    searchByContent(userId: string, searchTerm: string, limit?: number): Promise<any[]>;
    getWithMessages(chatId: string): Promise<{
        chat: Chat;
        messages: ChatMessage[];
    } | null>;
}
export declare const chatRepository: ChatRepository;
//# sourceMappingURL=chatRepository.d.ts.map
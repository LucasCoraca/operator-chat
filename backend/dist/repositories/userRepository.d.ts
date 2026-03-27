export interface User {
    id: string;
    username: string;
    password_hash: string;
    created_at: Date;
}
export interface CreateUserInput {
    username: string;
    passwordHash: string;
}
export declare class UserRepository {
    findById(id: string): Promise<User | null>;
    findByUsername(username: string): Promise<User | null>;
    findAll(): Promise<User[]>;
    create(input: CreateUserInput): Promise<User>;
    delete(id: string): Promise<boolean>;
    exists(username: string): Promise<boolean>;
}
export declare const userRepository: UserRepository;
//# sourceMappingURL=userRepository.d.ts.map
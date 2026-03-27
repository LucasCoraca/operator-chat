"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const db_1 = require("./db");
const repositories_1 = require("./repositories");
async function migrateUsers() {
    const usersFile = path_1.default.join(__dirname, '../users.json');
    if (!fs_1.default.existsSync(usersFile)) {
        console.log('No users.json file found, skipping user migration');
        return;
    }
    const data = fs_1.default.readFileSync(usersFile, 'utf-8');
    const users = JSON.parse(data);
    console.log(`Migrating ${users.length} users...`);
    for (const user of users) {
        try {
            const existingUser = await repositories_1.userRepository.findById(user.id);
            if (existingUser) {
                console.log(`User ${user.username} already exists, skipping`);
                continue;
            }
            await repositories_1.userRepository.create({
                username: user.username,
                passwordHash: user.passwordHash,
            });
            console.log(`Migrated user: ${user.username}`);
        }
        catch (error) {
            console.error(`Error migrating user ${user.username}:`, error);
        }
    }
}
async function migrateChats() {
    const chatsFile = path_1.default.join(__dirname, '../chats.json');
    if (!fs_1.default.existsSync(chatsFile)) {
        console.log('No chats.json file found, skipping chat migration');
        return;
    }
    const data = fs_1.default.readFileSync(chatsFile, 'utf-8');
    const chats = JSON.parse(data);
    console.log(`Migrating ${chats.length} chats...`);
    for (const chat of chats) {
        try {
            const existingChat = await repositories_1.chatRepository.findById(chat.id);
            if (existingChat) {
                console.log(`Chat ${chat.id} already exists, skipping`);
                continue;
            }
            // Create chat
            await repositories_1.chatRepository.create({
                userId: chat.userId || 'legacy-user',
                sandboxId: chat.sandboxId,
                name: chat.name,
                toolPreferences: chat.toolPreferences,
                approvalMode: chat.approvalMode,
            });
            // Update chat with additional fields
            await repositories_1.chatRepository.update(chat.id, {
                agent_state: chat.agentState,
            });
            // Add messages
            for (let i = 0; i < chat.messages.length; i++) {
                const msg = chat.messages[i];
                await repositories_1.chatRepository.addMessage({
                    chatId: chat.id,
                    role: msg.role,
                    content: msg.content,
                    model: msg.model,
                    agentSteps: msg.agentSteps,
                    messageIndex: i,
                });
            }
            console.log(`Migrated chat: ${chat.name} (${chat.messages.length} messages)`);
        }
        catch (error) {
            console.error(`Error migrating chat ${chat.id}:`, error);
        }
    }
}
async function migrateMemories() {
    const memoriesFile = path_1.default.join(__dirname, '../memories.json');
    if (!fs_1.default.existsSync(memoriesFile)) {
        console.log('No memories.json file found, skipping memory migration');
        return;
    }
    const data = fs_1.default.readFileSync(memoriesFile, 'utf-8');
    const memories = JSON.parse(data);
    console.log(`Migrating ${memories.length} memories...`);
    for (const memory of memories) {
        try {
            const existingMemory = await repositories_1.memoryRepository.findById(memory.id);
            if (existingMemory) {
                console.log(`Memory ${memory.id} already exists, skipping`);
                continue;
            }
            await repositories_1.memoryRepository.create({
                userId: memory.userId,
                content: memory.content,
                tags: memory.tags,
            });
            console.log(`Migrated memory: ${memory.content.substring(0, 50)}...`);
        }
        catch (error) {
            console.error(`Error migrating memory ${memory.id}:`, error);
        }
    }
}
async function migratePersonalities() {
    const personalitiesFile = path_1.default.join(__dirname, '../custom-personalities.json');
    if (!fs_1.default.existsSync(personalitiesFile)) {
        console.log('No custom-personalities.json file found, skipping personality migration');
        return;
    }
    const data = fs_1.default.readFileSync(personalitiesFile, 'utf-8');
    const personalities = JSON.parse(data);
    console.log(`Migrating ${personalities.length} custom personalities...`);
    for (const personality of personalities) {
        try {
            const existingPersonality = await repositories_1.personalityRepository.findById(personality.id);
            if (existingPersonality) {
                console.log(`Personality ${personality.name} already exists, skipping`);
                continue;
            }
            await repositories_1.personalityRepository.create({
                userId: personality.userId || 'legacy-user',
                name: personality.name,
                description: personality.description,
                tone: personality.tone,
                systemPrompt: personality.systemPrompt,
            });
            console.log(`Migrated personality: ${personality.name}`);
        }
        catch (error) {
            console.error(`Error migrating personality ${personality.name}:`, error);
        }
    }
}
async function migrateSettings() {
    const settingsFile = path_1.default.join(__dirname, '../settings.json');
    if (!fs_1.default.existsSync(settingsFile)) {
        console.log('No settings.json file found, skipping settings migration');
        return;
    }
    const data = fs_1.default.readFileSync(settingsFile, 'utf-8');
    const settings = JSON.parse(data);
    console.log('Migrating settings...');
    try {
        await repositories_1.settingsRepository.setLlamaConfig(settings.llama);
        await repositories_1.settingsRepository.setSearxngConfig(settings.searxng);
        await repositories_1.settingsRepository.setUiSettings(settings.ui);
        await repositories_1.settingsRepository.setMcpServers(settings.mcpServers || {});
        console.log('Migrated settings successfully');
    }
    catch (error) {
        console.error('Error migrating settings:', error);
    }
}
async function main() {
    console.log('Starting data migration from JSON files to MariaDB...\n');
    // Test database connection
    const connected = await (0, db_1.testConnection)();
    if (!connected) {
        console.error('Failed to connect to database. Please check your database configuration.');
        process.exit(1);
    }
    // Initialize database schema
    await (0, db_1.initializeDatabase)();
    console.log('Database schema initialized\n');
    // Migrate data
    await migrateUsers();
    console.log('');
    await migrateChats();
    console.log('');
    await migrateMemories();
    console.log('');
    await migratePersonalities();
    console.log('');
    await migrateSettings();
    console.log('');
    console.log('Data migration completed successfully!');
    process.exit(0);
}
main().catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
});
//# sourceMappingURL=migrate.js.map
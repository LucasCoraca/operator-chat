import fs from 'fs';
import path from 'path';
import { initializeDatabase, testConnection } from './db';
import { userRepository, chatRepository, memoryRepository, personalityRepository, settingsRepository } from './repositories';
import bcrypt from 'bcryptjs';

interface LegacyUser {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
}

interface LegacyChat {
  id: string;
  userId: string;
  sandboxId: string;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    model?: string;
    agentSteps?: any[];
  }>;
  name: string;
  createdAt: string;
  updatedAt: string;
  agentState?: {
    steps: any[];
    isComplete: boolean;
    finalAnswer: string | null;
    model?: string;
    partialFinalAnswer?: string;
  };
  toolPreferences: Record<string, any>;
  approvalMode: {
    alwaysApprove: boolean;
  };
}

interface LegacyMemory {
  id: string;
  userId: string;
  content: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

interface LegacyPersonality {
  id: string;
  userId?: string;
  name: string;
  description: string;
  tone: string;
  systemPrompt: string;
  isCustom?: boolean;
}

interface LegacySettings {
  llama: {
    baseUrl: string;
    model: string;
    temperature: number;
    maxTokens: number;
    topP: number;
  };
  searxng: {
    baseUrl: string;
    safeSearch: number;
  };
  ui: {
    showStats: boolean;
    selectedPersonality: string;
  };
  mcpServers: Record<string, any>;
}

async function migrateUsers(): Promise<void> {
  const usersFile = path.join(__dirname, '../users.json');
  if (!fs.existsSync(usersFile)) {
    console.log('No users.json file found, skipping user migration');
    return;
  }

  const data = fs.readFileSync(usersFile, 'utf-8');
  const users: LegacyUser[] = JSON.parse(data);
  
  console.log(`Migrating ${users.length} users...`);
  
  for (const user of users) {
    try {
      const existingUser = await userRepository.findById(user.id);
      if (existingUser) {
        console.log(`User ${user.username} already exists, skipping`);
        continue;
      }

      await userRepository.create({
        username: user.username,
        passwordHash: user.passwordHash,
      });
      console.log(`Migrated user: ${user.username}`);
    } catch (error) {
      console.error(`Error migrating user ${user.username}:`, error);
    }
  }
}

async function migrateChats(): Promise<void> {
  const chatsFile = path.join(__dirname, '../chats.json');
  if (!fs.existsSync(chatsFile)) {
    console.log('No chats.json file found, skipping chat migration');
    return;
  }

  const data = fs.readFileSync(chatsFile, 'utf-8');
  const chats: LegacyChat[] = JSON.parse(data);
  
  console.log(`Migrating ${chats.length} chats...`);
  
  for (const chat of chats) {
    try {
      const existingChat = await chatRepository.findById(chat.id);
      if (existingChat) {
        console.log(`Chat ${chat.id} already exists, skipping`);
        continue;
      }

      // Create chat
      await chatRepository.create({
        userId: chat.userId || 'legacy-user',
        sandboxId: chat.sandboxId,
        name: chat.name,
        toolPreferences: chat.toolPreferences,
        approvalMode: chat.approvalMode,
      });

      // Update chat with additional fields
      await chatRepository.update(chat.id, {
        agent_state: chat.agentState,
      });

      // Add messages
      for (let i = 0; i < chat.messages.length; i++) {
        const msg = chat.messages[i];
        await chatRepository.addMessage({
          chatId: chat.id,
          role: msg.role,
          content: msg.content,
          model: msg.model,
          agentSteps: msg.agentSteps,
          messageIndex: i,
        });
      }

      console.log(`Migrated chat: ${chat.name} (${chat.messages.length} messages)`);
    } catch (error) {
      console.error(`Error migrating chat ${chat.id}:`, error);
    }
  }
}

async function migrateMemories(): Promise<void> {
  const memoriesFile = path.join(__dirname, '../memories.json');
  if (!fs.existsSync(memoriesFile)) {
    console.log('No memories.json file found, skipping memory migration');
    return;
  }

  const data = fs.readFileSync(memoriesFile, 'utf-8');
  const memories: LegacyMemory[] = JSON.parse(data);
  
  console.log(`Migrating ${memories.length} memories...`);
  
  for (const memory of memories) {
    try {
      const existingMemory = await memoryRepository.findById(memory.id);
      if (existingMemory) {
        console.log(`Memory ${memory.id} already exists, skipping`);
        continue;
      }

      await memoryRepository.create({
        userId: memory.userId,
        content: memory.content,
        tags: memory.tags,
      });

      console.log(`Migrated memory: ${memory.content.substring(0, 50)}...`);
    } catch (error) {
      console.error(`Error migrating memory ${memory.id}:`, error);
    }
  }
}

async function migratePersonalities(): Promise<void> {
  const personalitiesFile = path.join(__dirname, '../custom-personalities.json');
  if (!fs.existsSync(personalitiesFile)) {
    console.log('No custom-personalities.json file found, skipping personality migration');
    return;
  }

  const data = fs.readFileSync(personalitiesFile, 'utf-8');
  const personalities: LegacyPersonality[] = JSON.parse(data);
  
  console.log(`Migrating ${personalities.length} custom personalities...`);
  
  for (const personality of personalities) {
    try {
      const existingPersonality = await personalityRepository.findById(personality.id);
      if (existingPersonality) {
        console.log(`Personality ${personality.name} already exists, skipping`);
        continue;
      }

      await personalityRepository.create({
        userId: personality.userId || 'legacy-user',
        name: personality.name,
        description: personality.description,
        tone: personality.tone,
        systemPrompt: personality.systemPrompt,
      });

      console.log(`Migrated personality: ${personality.name}`);
    } catch (error) {
      console.error(`Error migrating personality ${personality.name}:`, error);
    }
  }
}

async function migrateSettings(): Promise<void> {
  const settingsFile = path.join(__dirname, '../settings.json');
  if (!fs.existsSync(settingsFile)) {
    console.log('No settings.json file found, skipping settings migration');
    return;
  }

  const data = fs.readFileSync(settingsFile, 'utf-8');
  const settings: LegacySettings = JSON.parse(data);
  
  console.log('Migrating settings...');
  
  try {
    await settingsRepository.setLlamaConfig(settings.llama);
    await settingsRepository.setSearxngConfig(settings.searxng);
    await settingsRepository.setUiSettings(settings.ui);
    await settingsRepository.setMcpServers(settings.mcpServers || {});
    
    console.log('Migrated settings successfully');
  } catch (error) {
    console.error('Error migrating settings:', error);
  }
}

async function main(): Promise<void> {
  console.log('Starting data migration from JSON files to MariaDB...\n');

  // Test database connection
  const connected = await testConnection();
  if (!connected) {
    console.error('Failed to connect to database. Please check your database configuration.');
    process.exit(1);
  }

  // Initialize database schema
  await initializeDatabase();
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
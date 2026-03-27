import { memoryRepository, Memory, CreateMemoryInput, UpdateMemoryInput } from '../repositories';

export { Memory };

export class MemoryManager {
  constructor(_filePath?: string) {
    // filePath is no longer needed as we use the database
    // Keeping parameter for backward compatibility
  }

  async getMemories(userId: string): Promise<Memory[]> {
    return memoryRepository.findByUserId(userId);
  }

  async addMemory(userId: string, content: string, tags?: string[]): Promise<Memory> {
    const input: CreateMemoryInput = {
      userId,
      content,
      tags,
    };
    return memoryRepository.create(input);
  }

  async updateMemory(id: string, userId: string, content: string, tags?: string[]): Promise<Memory | null> {
    const input: UpdateMemoryInput = {
      content,
      tags,
    };
    return memoryRepository.update(id, userId, input);
  }

  async deleteMemory(id: string, userId: string): Promise<boolean> {
    return memoryRepository.delete(id, userId);
  }

  async searchMemories(userId: string, query: string): Promise<Memory[]> {
    return memoryRepository.search(userId, query);
  }
}

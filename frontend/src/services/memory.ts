import * as authService from './auth';

export interface Memory {
  id: string;
  userId: string;
  content: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

function normalizeTags(value: unknown): string[] | undefined {
  if (value == null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.filter((tag): tag is string => typeof tag === 'string');
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((tag): tag is string => typeof tag === 'string');
      }
    } catch {
      return [trimmed];
    }
  }

  return undefined;
}

function normalizeMemory(memory: Memory & { tags?: unknown }): Memory {
  return {
    ...memory,
    tags: normalizeTags(memory.tags),
  };
}

export async function getMemories(): Promise<Memory[]> {
  const res = await fetch('/api/memories', {
    headers: authService.getAuthHeader(),
  });
  if (!res.ok) throw new Error('Failed to fetch memories');
  const data = await res.json();
  return Array.isArray(data) ? data.map(normalizeMemory) : [];
}

export async function addMemory(content: string, tags?: string[]): Promise<Memory> {
  const res = await fetch('/api/memories', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authService.getAuthHeader(),
    },
    body: JSON.stringify({ content, tags }),
  });
  if (!res.ok) throw new Error('Failed to add memory');
  const data = await res.json();
  return normalizeMemory(data);
}

export async function deleteMemory(id: string): Promise<void> {
  const res = await fetch(`/api/memories/${id}`, {
    method: 'DELETE',
    headers: authService.getAuthHeader(),
  });
  if (!res.ok) throw new Error('Failed to delete memory');
}

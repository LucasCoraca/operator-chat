import * as authService from './auth';

export interface Memory {
  id: string;
  userId: string;
  content: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export async function getMemories(): Promise<Memory[]> {
  const res = await fetch('/api/memories', {
    headers: authService.getAuthHeader(),
  });
  if (!res.ok) throw new Error('Failed to fetch memories');
  return res.json();
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
  return res.json();
}

export async function deleteMemory(id: string): Promise<void> {
  const res = await fetch(`/api/memories/${id}`, {
    method: 'DELETE',
    headers: authService.getAuthHeader(),
  });
  if (!res.ok) throw new Error('Failed to delete memory');
}

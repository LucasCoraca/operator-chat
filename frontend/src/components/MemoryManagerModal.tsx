import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import * as memoryService from '../services/memory';
import { Memory } from '../services/memory';

interface MemoryManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function MemoryManagerModal({ isOpen, onClose }: MemoryManagerModalProps) {
  const { t } = useTranslation();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newMemory, setNewMemory] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadMemories();
    }
  }, [isOpen]);

  const loadMemories = async () => {
    try {
      setLoading(true);
      const data = await memoryService.getMemories();
      setMemories(data);
      setError(null);
    } catch (err) {
      setError(t('memory.failedToLoad'));
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t('memory.deleteConfirm'))) return;
    try {
      await memoryService.deleteMemory(id);
      setMemories(prev => prev.filter(m => m.id !== id));
    } catch (err) {
      alert(t('memory.failedToDelete'));
    }
  };

  const handleAddMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMemory.trim()) return;

    try {
      setIsAdding(true);
      const memory = await memoryService.addMemory(newMemory.trim());
      setMemories(prev => [memory, ...prev]);
      setNewMemory('');
    } catch (err) {
      alert(t('memory.failedToAdd'));
    } finally {
      setIsAdding(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-2xl bg-surface-100 border border-white/10 rounded-[28px] shadow-2xl flex flex-col max-h-[80vh] overflow-hidden">
        <div className="px-6 py-5 border-b border-white/5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-brand/10 rounded-xl text-brand">
              <svg className="size-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .52 8.105 4 4 0 0 0 7.327-2.258 M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.52 8.105 4 4 0 0 1-7.327-2.258 M12 5v17 M9 13a4.5 4.5 0 0 0 3-4 M15 13a4.5 4.5 0 0 1-3-4" />
              </svg>
            </div>
            <div>
              <h2 className="text-xl font-semibold text-zinc-100">{t('memory.title')}</h2>
              <p className="text-sm text-zinc-500 mt-1">{t('memory.description')}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-surface-200 text-zinc-400 transition-colors"
          >
            <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 flex-1 overflow-y-auto">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-lg font-medium text-zinc-100">{t('memory.yourMemories')}</h3>
            <button
              onClick={() => setShowAddForm(!showAddForm)}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-brand/10 text-brand rounded-lg hover:bg-brand/20 transition-colors"
            >
              <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              {t('memory.addMemory')}
            </button>
          </div>
          {showAddForm && (
          <form onSubmit={handleAddMemory} className="mb-8">
            <div className="flex gap-2">
              <input
                type="text"
                value={newMemory}
                onChange={(e) => setNewMemory(e.target.value)}
                placeholder={t('memory.addPlaceholder')}
                className="flex-1 bg-surface-200 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-brand/50"
              />
              <button
                type="submit"
                disabled={isAdding || !newMemory.trim()}
                className="bg-brand hover:bg-brand-dark disabled:opacity-50 text-white px-4 py-2.5 rounded-xl text-sm font-medium transition-all"
              >
                {t('common.add')}
              </button>
            </div>
          </form>
          )}

          {loading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-brand"></div>
            </div>
          ) : error ? (
            <div className="text-center py-12 text-red-400 text-sm">{error}</div>
          ) : memories.length === 0 ? (
            <div className="text-center py-12 text-zinc-500 text-sm">
              {t('memory.noMemories')}
            </div>
          ) : (
            <div className="space-y-3">
              {memories.map((memory) => (
                <div
                  key={memory.id}
                  className="group flex items-start gap-4 p-4 rounded-2xl bg-surface-200/50 border border-white/5 hover:border-white/10 transition-all"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-200 leading-relaxed">{memory.content}</p>
                    <div className="flex items-center gap-3 mt-2">
                      <span className="text-[11px] text-zinc-500 font-medium uppercase tracking-wider">
                        {new Date(memory.createdAt).toLocaleDateString()}
                      </span>
                      {memory.tags && memory.tags.length > 0 && (
                        <div className="flex gap-1.5">
                          {memory.tags.map(tag => (
                            <span key={tag} className="text-[10px] bg-brand/10 text-brand px-2 py-0.5 rounded-full">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDelete(memory.id)}
                    className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-400/10 opacity-0 group-hover:opacity-100 transition-all"
                  >
                    <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

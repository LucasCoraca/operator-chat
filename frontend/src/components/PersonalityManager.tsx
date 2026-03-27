import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PersonalityModal } from './PersonalityModal';

interface ChatPersonality {
  id: string;
  name: string;
  description: string;
  tone: string;
  systemPrompt: string;
  isCustom?: boolean;
}

interface PersonalityManagerProps {
  isOpen: boolean;
  onClose: () => void;
  customPersonalities: ChatPersonality[];
  onEdit: (personality: ChatPersonality) => void;
  onDelete: (id: string) => void;
  onCreate: (personality: Omit<ChatPersonality, 'id'> & { id?: string }) => void;
}

export function PersonalityManager({
  isOpen,
  onClose,
  customPersonalities,
  onEdit,
  onDelete,
  onCreate
}: PersonalityManagerProps) {
  const { t } = useTranslation();
  const [editingPersonality, setEditingPersonality] = useState<ChatPersonality | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const handleEdit = (personality: ChatPersonality) => {
    setEditingPersonality(personality);
    setIsModalOpen(true);
  };

  const handleCreate = () => {
    setEditingPersonality(null);
    setIsModalOpen(true);
  };

  const handleSave = (personality: Omit<ChatPersonality, 'id'> & { id?: string }) => {
    if (personality.id) {
      onEdit({ ...personality, id: personality.id } as ChatPersonality);
    } else {
      onCreate(personality);
    }
    setIsModalOpen(false);
    setEditingPersonality(null);
  };

  const handleDelete = (id: string) => {
    if (confirm(t('personality.deleteConfirm'))) {
      onDelete(id);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-3 sm:p-4">
        <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-white/10 bg-[#1e1e20] shadow-2xl">
          <div className="p-4 sm:p-6">
            <div className="mb-5 flex items-start justify-between gap-4 sm:mb-6">
              <div>
                <h2 className="text-2xl font-semibold text-zinc-100">{t('personality.managePersonalities')}</h2>
                <p className="mt-1 text-sm text-zinc-500">{t('personality.manageDescription')}</p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl p-2 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
                aria-label="Close"
              >
                <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Create Button */}
            <button
              onClick={handleCreate}
              className="mb-4 flex items-center gap-2 px-4 py-2 bg-brand hover:bg-brand-dark rounded-lg text-white transition-colors shadow-md shadow-brand/20"
            >
              <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
              {t('personality.createNewPersonality')}
            </button>

            {/* Personalities List */}
            {customPersonalities.length === 0 ? (
              <div className="rounded-lg border border-dashed border-white/20 bg-[#27272a] p-8 text-center">
                <svg className="mx-auto size-12 text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
                <h3 className="mt-4 text-lg font-medium text-zinc-300">{t('personality.noCustomPersonalities')}</h3>
                <p className="mt-1 text-sm text-zinc-500">
                  {t('personality.noCustomPersonalitiesDescription')}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {customPersonalities.map((personality) => (
                  <div
                    key={personality.id}
                    className="flex items-center justify-between gap-4 rounded-lg border border-white/10 bg-[#27272a] p-4"
                  >
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <svg className="size-5 text-brand flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                      </svg>
                      <div className="min-w-0">
                        <h4 className="font-medium text-zinc-100 truncate">{personality.name}</h4>
                        <p className="text-sm text-zinc-500 truncate">{personality.description}</p>
                        <p className="text-xs text-zinc-600 mt-1">Style: {personality.tone}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => handleEdit(personality)}
                        className="p-2 text-zinc-500 hover:text-zinc-200 hover:bg-white/5 rounded-lg transition-colors"
                        title="Edit"
                      >
                        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => handleDelete(personality.id)}
                        className="p-2 text-zinc-500 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors"
                        title="Delete"
                      >
                        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Info */}
            <div className="mt-6 rounded-lg border border-white/10 bg-[#27272a] p-4">
              <h4 className="text-sm font-medium text-zinc-300 mb-2">{t('personality.builtInPersonalities')}</h4>
              <p className="text-sm text-zinc-500">
                {t('personality.builtInDescription')}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {['Professional', 'Bubbly', 'Military', 'Intelligence Analyst', 'Creative Writer', 'Minimalist', 'Mentor', 'DevOps Engineer'].map((name) => (
                  <span key={name} className="px-2 py-1 text-xs rounded-md bg-[#1e1e20] text-zinc-400 border border-white/10">
                    {name}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <PersonalityModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingPersonality(null);
        }}
        onSave={handleSave}
        editingPersonality={editingPersonality}
      />
    </>
  );
}

export default PersonalityManager;
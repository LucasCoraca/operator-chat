import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

interface ChatPersonality {
  id: string;
  name: string;
  description: string;
  tone: string;
  systemPrompt: string;
  isCustom?: boolean;
}

interface PersonalityModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (personality: Omit<ChatPersonality, 'id'> & { id?: string }) => void;
  editingPersonality?: ChatPersonality | null;
}

const defaultSystemPrompt = `You are a helpful AI assistant. Respond to the user's questions in a ${''} manner.
- Be clear and concise
- Provide accurate information
- Ask clarifying questions when needed
- Use examples to illustrate complex concepts`;

const toneOptions = [
  { value: 'Professional and formal', labelKey: 'personality.toneProfessional' },
  { value: 'Friendly and enthusiastic', labelKey: 'personality.toneFriendly' },
  { value: 'Direct and authoritative', labelKey: 'personality.toneDirect' },
  { value: 'Analytical and objective', labelKey: 'personality.toneAnalytical' },
  { value: 'Creative and imaginative', labelKey: 'personality.toneCreative' },
  { value: 'Brief and efficient', labelKey: 'personality.toneBrief' },
  { value: 'Patient and teaching-focused', labelKey: 'personality.toneTeaching' },
  { value: 'Technical and pragmatic', labelKey: 'personality.toneTechnical' },
  { value: 'Humorous and witty', labelKey: 'personality.toneHumorous' },
  { value: 'Empathetic and supportive', labelKey: 'personality.toneEmpathetic' },
];

export function PersonalityModal({
  isOpen,
  onClose,
  onSave,
  editingPersonality
}: PersonalityModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tone, setTone] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');

  useEffect(() => {
    if (editingPersonality) {
      setName(editingPersonality.name);
      setDescription(editingPersonality.description);
      setTone(editingPersonality.tone);
      setSystemPrompt(editingPersonality.systemPrompt);
    } else {
      setName('');
      setDescription('');
      setTone(t('personality.toneProfessional'));
      setSystemPrompt(defaultSystemPrompt);
    }
  }, [editingPersonality, isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      id: editingPersonality?.id,
      name,
      description,
      tone,
      systemPrompt
    });
    onClose();
  };

  const handleToneChange = (toneValue: string) => {
    setTone(toneValue);
    const prompt = defaultSystemPrompt.replace('${}', toneValue);
    setSystemPrompt(prompt);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-3 sm:p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-white/10 bg-[#1e1e20] shadow-2xl">
        <div className="p-4 sm:p-6">
            <div className="mb-5 flex items-start justify-between gap-4 sm:mb-6">
              <div>
                <h2 className="text-2xl font-semibold text-zinc-100">
                  {editingPersonality ? t('personality.editPersonality') : t('personality.createPersonality')}
                </h2>
                <p className="mt-1 text-sm text-zinc-500">
                  {editingPersonality
                    ? t('personality.editPersonalityDescription')
                    : t('personality.createPersonalityDescription')}
                </p>
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

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Name */}
            <div>
              <label className="block text-sm text-zinc-400 mb-1">
                {t('personality.nameRequired')}
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('personality.name')}
                required
                className="w-full bg-[#27272a] text-zinc-100 rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-transparent placeholder:text-zinc-600"
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm text-zinc-400 mb-1">
                {t('personality.descriptionRequired')}
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('personality.shortDescription')}
                required
                className="w-full bg-[#27272a] text-zinc-100 rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-transparent placeholder:text-zinc-600"
              />
            </div>

            {/* Tone */}
            <div>
              <label className="block text-sm text-zinc-400 mb-1">
                {t('personality.communicationStyle')}
              </label>
              <select
                value={tone}
                onChange={(e) => handleToneChange(e.target.value)}
                className="w-full bg-[#27272a] text-zinc-100 rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-transparent"
              >
                {toneOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </option>
                ))}
              </select>
            </div>

            {/* System Prompt */}
            <div>
              <label className="block text-sm text-zinc-400 mb-1">
                {t('personality.systemPrompt')}
                <p className="mt-1 text-xs text-zinc-500">
                  {t('personality.systemPromptDescription')}
                </p>
              </label>
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={8}
                className="w-full bg-[#27272a] text-zinc-100 rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-transparent placeholder:text-zinc-600 font-mono text-sm"
                placeholder="Define the AI's behavior and response style..."
              />
            </div>

            {/* Preview */}
            <div className="rounded-lg border border-white/10 bg-[#27272a] p-4">
              <h4 className="text-sm font-medium text-zinc-300 mb-2">{t('personality.preview')}</h4>
              <div className="text-sm text-zinc-500">
                <span className="text-zinc-400">{t('personality.name')}:</span> {name || '—'}
                <div className="mt-1">
                  <span className="text-zinc-400">{t('personality.shortDescription')}:</span> {description || '—'}
                </div>
                <div className="mt-1">
                  <span className="text-zinc-400">{t('personality.style')}:</span> {tone || '—'}
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 bg-[#27272a] hover:bg-[#3f3f46] rounded-lg text-zinc-300 transition-colors border border-white/10"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={!name.trim() || !description.trim()}
                className="px-4 py-2 bg-brand hover:bg-brand-dark disabled:bg-zinc-600 disabled:cursor-not-allowed rounded-lg text-white transition-colors shadow-md shadow-brand/20"
              >
                {editingPersonality ? t('personality.saveChanges') : t('personality.createPersonalityBtn')}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default PersonalityModal;
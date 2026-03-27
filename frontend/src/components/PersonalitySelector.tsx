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

interface PersonalitySelectorProps {
  selectedPersonality: string;
  onPersonalityChange: (personalityId: string) => void;
  personalities: ChatPersonality[];
  onManagePersonalities?: () => void;
  compact?: boolean;
}

export function PersonalitySelector({
  selectedPersonality,
  onPersonalityChange,
  personalities,
  onManagePersonalities,
  compact = false
}: PersonalitySelectorProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const selected = personalities.find(p => p.id === selectedPersonality) || personalities[0];

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.personality-selector')) {
        setIsOpen(false);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const getIcon = (personality: ChatPersonality) => {
    const icons: Record<string, JSX.Element> = {
      professional: (
        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
      ),
      bubbly: (
        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      military: (
        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
      ),
      intelligence_analyst: (
        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
        </svg>
      ),
      creative_writer: (
        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
      ),
      minimalist: (
        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      ),
      mentor: (
        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
        </svg>
      ),
      devops_engineer: (
        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
        </svg>
      )
    };
    return icons[personality.id] || icons.professional;
  };

  if (compact) {
    return (
      <div className="relative personality-selector">
        <button
          onClick={(e) => {
            e.stopPropagation();
            setIsOpen(!isOpen);
          }}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#27272a] hover:bg-[#3f3f46] border border-white/10 transition-colors text-sm"
        >
          {getIcon(selected)}
          <span className="text-zinc-300">{selected.name}</span>
          <svg className="size-3 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {isOpen && (
          <div className="absolute top-full left-0 mt-1 w-64 max-h-64 overflow-y-auto rounded-xl border border-white/10 bg-[#1e1e20] shadow-2xl z-50">
            {personalities.map((personality) => (
              <button
                key={personality.id}
                onClick={(e) => {
                  e.stopPropagation();
                  onPersonalityChange(personality.id);
                  setIsOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                  selectedPersonality === personality.id
                    ? 'bg-brand/20 text-white'
                    : 'text-zinc-300 hover:bg-white/5'
                }`}
              >
                <span className={selectedPersonality === personality.id ? 'text-brand' : 'text-zinc-500'}>
                  {getIcon(personality)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate">{personality.name}</div>
                  <div className="text-xs text-zinc-500 truncate">{personality.description}</div>
                </div>
                {selectedPersonality === personality.id && (
                  <svg className="size-4 text-brand" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                )}
              </button>
            ))}
            {onManagePersonalities && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setIsOpen(false);
                  onManagePersonalities();
                }}
                className="w-full flex items-center gap-2 px-4 py-2 mt-1 border-t border-white/10 text-zinc-400 hover:text-zinc-200 hover:bg-white/5 text-sm"
              >
                <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
                {t('personality.managePersonalities')}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="personality-selector">
      <label className="block text-sm text-zinc-400 mb-2">{t('personality.aiPersonality')}</label>
      <div className="space-y-2">
        {personalities.map((personality) => (
          <button
            key={personality.id}
            onClick={() => onPersonalityChange(personality.id)}
            className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-colors ${
              selectedPersonality === personality.id
                ? 'bg-brand/10 border-brand/50 text-white'
                : 'bg-[#27272a] border-white/10 text-zinc-300 hover:border-white/20'
            }`}
          >
            <span className={selectedPersonality === personality.id ? 'text-brand' : 'text-zinc-500'}>
              {getIcon(personality)}
            </span>
            <div className="flex-1 text-left">
              <div className="font-medium text-sm">{personality.name}</div>
              <div className="text-xs text-zinc-500">{personality.description}</div>
            </div>
            {selectedPersonality === personality.id && (
              <svg className="size-5 text-brand" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
            )}
          </button>
        ))}
      </div>
      {onManagePersonalities && (
        <button
          onClick={onManagePersonalities}
          className="w-full mt-3 flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-dashed border-white/20 text-zinc-400 hover:text-zinc-200 hover:border-white/30 transition-colors text-sm"
        >
          <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          {t('personality.managePersonalities')}
        </button>
      )}
    </div>
  );
}

export default PersonalitySelector;
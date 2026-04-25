import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { PersonalitySelector } from './PersonalitySelector';
import { MCPServerManager } from './MCPServerManager';
import { supportedLanguages } from '../i18n';

interface ChatPersonality {
  id: string;
  name: string;
  description: string;
  tone: string;
  systemPrompt: string;
  isCustom?: boolean;
}

interface Settings {
  ui: {
    showStats: boolean;
    selectedPersonality: string;
    selectedModel?: string;
    defaultToolPreferences: Record<string, ToolPreference>;
  };
}

interface Tool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string }>;
  policy: {
    requiresApproval: boolean;
    supportsAutoApprove: boolean;
    capabilities: string[];
    sandboxPolicy: string;
    riskLevel: 'low' | 'medium' | 'high';
  };
}

interface ToolPreference {
  enabled: boolean;
  autoApprove: boolean;
}

interface SettingsPanelProps {
  settings: Settings;
  onSave: (settings: Settings) => void;
  onClose: () => void;
  personalities: ChatPersonality[];
  tools: Tool[];
  onManagePersonalities: () => void;
  isPersonalityManagerOpen?: boolean;
}

function SettingsPanel({
  settings,
  onSave,
  onClose,
  personalities,
  tools,
  onManagePersonalities,
  isPersonalityManagerOpen = false
}: SettingsPanelProps) {
  const { t, i18n } = useTranslation();
  const [formData, setFormData] = useState<Settings>(settings);

  const handleLanguageChange = (languageCode: string) => {
    i18n.changeLanguage(languageCode);
  };

  useEffect(() => {
    setFormData(settings);
  }, [settings]);

  const handleChange = (
    section: 'ui',
    field: string,
    value: string | number | boolean
  ) => {
    setFormData((prev) => ({
      ...prev,
      [section]: {
        ...prev[section],
        [field]: value,
      },
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(formData);
  };

  const toggleDefaultTool = (toolName: string) => {
    setFormData((prev) => ({
      ...prev,
      ui: {
        ...prev.ui,
        defaultToolPreferences: {
          ...prev.ui.defaultToolPreferences,
          [toolName]: {
            enabled: !(prev.ui.defaultToolPreferences[toolName]?.enabled ?? true),
            autoApprove: prev.ui.defaultToolPreferences[toolName]?.autoApprove ?? false,
          },
        },
      },
    }));
  };

  const toggleDefaultAutoApprove = (toolName: string) => {
    setFormData((prev) => ({
      ...prev,
      ui: {
        ...prev.ui,
        defaultToolPreferences: {
          ...prev.ui.defaultToolPreferences,
          [toolName]: {
            enabled: prev.ui.defaultToolPreferences[toolName]?.enabled ?? true,
            autoApprove: !(prev.ui.defaultToolPreferences[toolName]?.autoApprove ?? false),
          },
        },
      },
    }));
  };

  const handleBackdropClick = () => {
    if (isPersonalityManagerOpen) return;
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-4" onClick={handleBackdropClick}>
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-white/10 bg-[#1e1e20] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4 sm:mb-6">
            <div>
              <h2 className="text-2xl font-semibold text-zinc-100">{t('settings.title')}</h2>
              <p className="mt-1 text-sm text-zinc-500">{t('settings.description')}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl p-2 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
              aria-label={t('common.close')}
            >
              <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Language Settings */}
            <div className="space-y-4">
              <h3 className="text-lg font-semibold text-brand">{t('settings.language')}</h3>
              <p className="text-sm text-zinc-500">{t('settings.languageDescription')}</p>
              <select
                value={i18n.language}
                onChange={(e) => handleLanguageChange(e.target.value)}
                className="w-full bg-[#27272a] text-zinc-100 rounded-lg px-3 py-2 border border-white/10 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-transparent"
              >
                {supportedLanguages.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.flag} {lang.name}
                  </option>
                ))}
              </select>
            </div>

            <hr className="border-white/10" />

            {/* UI Settings */}
            <div className="space-y-4">
              <h3 className="text-lg font-semibold text-brand">{t('settings.uiSettings')}</h3>

              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm text-zinc-300">{t('settings.showStats')}</label>
                  <p className="text-xs text-zinc-500 mt-1">{t('settings.showStatsDescription')}</p>
                </div>
                <input
                  type="checkbox"
                  checked={formData.ui.showStats}
                  onChange={(e) => handleChange('ui', 'showStats', e.target.checked)}
                  className="w-4 h-4 rounded border-white/10 bg-[#27272a] text-brand focus:ring-brand/50 focus:ring-2"
                />
              </div>
            </div>

            <hr className="border-white/10" />

            <div className="space-y-4">
              <h3 className="text-lg font-semibold text-brand">{t('settings.toolDefaults')}</h3>
              <p className="text-sm text-zinc-500">{t('settings.toolDefaultsDescription')}</p>

              <div className="space-y-3">
                {tools.map((tool) => {
                  const preference = formData.ui.defaultToolPreferences[tool.name] ?? {
                    enabled: true,
                    autoApprove: !tool.policy.requiresApproval,
                  };

                  return (
                    <div
                      key={tool.name}
                      className="rounded-xl border border-white/10 bg-black/20 p-3"
                    >
                      <label className="flex cursor-pointer items-start gap-3">
                        <input
                          type="checkbox"
                          checked={preference.enabled}
                          onChange={() => toggleDefaultTool(tool.name)}
                          className="mt-0.5 h-4 w-4 rounded border-white/10 bg-[#27272a] text-brand focus:ring-brand/50"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold text-zinc-100">{tool.name}</div>
                          <div className="mt-1 text-xs leading-5 text-zinc-400">{tool.description}</div>
                        </div>
                      </label>

                      <div className="mt-3 ml-7 flex items-center justify-between rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2">
                        <span className="text-[11px] text-zinc-500">{t('settings.preApproveByDefault')}</span>
                        {tool.policy.supportsAutoApprove ? (
                          <label className="flex items-center gap-2 text-[11px] text-zinc-300">
                            <input
                              type="checkbox"
                              checked={preference.autoApprove}
                              onChange={() => toggleDefaultAutoApprove(tool.name)}
                              disabled={!preference.enabled}
                              className="h-4 w-4 rounded border-white/10 bg-[#27272a] text-brand focus:ring-brand/50 disabled:opacity-50"
                            />
                            <span>{t('settings.applyToNewChats')}</span>
                          </label>
                        ) : (
                          <span className="text-[11px] text-zinc-600">{t('chat.disabledForHighRisk')}</span>
                        )}
                      </div>
                    </div>
                  );
                })}

                {tools.length === 0 && (
                  <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-zinc-500">
                    {t('chat.noTools')}
                  </div>
                )}
              </div>
            </div>

            <hr className="border-white/10" />

            {/* AI Personality Settings */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-brand">{t('settings.aiPersonality')}</h3>
                <button
                  type="button"
                  onClick={onManagePersonalities}
                  className="flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-white/10 text-zinc-400 hover:text-zinc-200 hover:bg-white/5 transition-colors"
                >
                  <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                  {t('settings.manage')}
                </button>
              </div>
              
              <PersonalitySelector
                selectedPersonality={formData.ui.selectedPersonality}
                onPersonalityChange={(id) => handleChange('ui', 'selectedPersonality', id)}
                personalities={personalities}
                compact={false}
              />
            </div>

            <hr className="border-white/10" />

            {/* MCP Server Settings */}
            <div className="space-y-4">
              <h3 className="text-lg font-semibold text-brand">
                MCP Servers
              </h3>
              <p className="text-sm text-zinc-500">
                Add external MCP servers to extend tool capabilities.
              </p>
              
              <MCPServerManager />
            </div>

            {/* Action Buttons */}
            <div className="flex justify-end gap-3 pt-4">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 bg-[#27272a] hover:bg-[#3f3f46] rounded-lg text-zinc-300 transition-colors border border-white/10"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-brand hover:bg-brand-dark rounded-lg text-white transition-colors shadow-md shadow-brand/20"
              >
                {t('common.save')}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default SettingsPanel;

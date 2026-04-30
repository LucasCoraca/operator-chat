import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { PersonalitySelector } from './PersonalitySelector';
import { MCPServerManager } from './MCPServerManager';
import { supportedLanguages } from '../i18n';

type SettingsSection = 'general' | 'tools' | 'agent' | 'personality' | 'mcp';

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
  remoteWorkspace: {
    enabled: boolean;
    host: string;
    port: number;
    username: string;
    root: string;
    privateKey?: string;
    hasPrivateKey?: boolean;
    strictHostKeyChecking: boolean;
    approvalPolicy: 'ask' | 'auto-approve';
    toolApprovals: Record<string, 'ask' | 'auto-approve'>;
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

const agentToolApprovalOptions = [
  { name: 'list', label: 'List files', description: 'Inspect remote directory contents.' },
  { name: 'read', label: 'Read files', description: 'Read files from the remote workspace.' },
  { name: 'glob', label: 'Find paths', description: 'Search remote file paths by pattern.' },
  { name: 'grep', label: 'Search text', description: 'Search remote file contents.' },
  { name: 'bash', label: 'Run commands', description: 'Execute shell commands over SSH.' },
  { name: 'terminal_list', label: 'List terminals', description: 'Inspect managed background terminals.' },
  { name: 'terminal_read', label: 'Read terminal', description: 'Read output from a background terminal.' },
  { name: 'terminal_kill', label: 'Kill terminal', description: 'Stop a background terminal process.' },
  { name: 'write', label: 'Write files', description: 'Create or replace files in the remote workspace.' },
  { name: 'edit', label: 'Edit files', description: 'Modify existing remote files.' },
  { name: 'apply_patch', label: 'Apply patches', description: 'Apply structured patches to remote files.' },
] as const;

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
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');

  const sections: Array<{
    id: SettingsSection;
    label: string;
    description: string;
    icon: JSX.Element;
  }> = [
    {
      id: 'general',
      label: t('settings.uiSettings'),
      description: t('settings.language'),
      icon: (
        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.5 6h3m-7.5 6h12m-15 6h18M4 6h2m12 0h2M4 12h2m12 0h2M4 18h2m12 0h2" />
        </svg>
      ),
    },
    {
      id: 'tools',
      label: t('settings.toolDefaults'),
      description: t('settings.applyToNewChats'),
      icon: (
        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.83-5.83M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l5.653-4.655M12 6.75a3 3 0 016 0c0 .744-.27 1.425-.717 1.95" />
        </svg>
      ),
    },
    {
      id: 'agent',
      label: 'Agent Workspace',
      description: 'SSH remote',
      icon: (
        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z" />
        </svg>
      ),
    },
    {
      id: 'personality',
      label: t('settings.aiPersonality'),
      description: t('settings.manage'),
      icon: (
        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
      ),
    },
    {
      id: 'mcp',
      label: 'MCP Servers',
      description: 'Extensions',
      icon: (
        <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 6h12v12H6zM9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3" />
        </svg>
      ),
    },
  ];

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

  const handleRemoteWorkspaceChange = (
    field: keyof Settings['remoteWorkspace'],
    value: string | number | boolean
  ) => {
    setFormData((prev) => ({
      ...prev,
      remoteWorkspace: {
        ...prev.remoteWorkspace,
        [field]: value,
      },
    }));
  };

  const getAgentToolApproval = (toolName: string) => (
    formData.remoteWorkspace.toolApprovals?.[toolName]
    ?? formData.remoteWorkspace.approvalPolicy
    ?? 'ask'
  );

  const handleAgentToolApprovalChange = (toolName: string, value: 'ask' | 'auto-approve') => {
    setFormData((prev) => {
      const toolApprovals = {
        ...prev.remoteWorkspace.toolApprovals,
        [toolName]: value,
      };
      const allAutoApproved = agentToolApprovalOptions.every((tool) => (
        toolApprovals[tool.name] ?? prev.remoteWorkspace.approvalPolicy
      ) === 'auto-approve');

      return {
        ...prev,
        remoteWorkspace: {
          ...prev.remoteWorkspace,
          approvalPolicy: allAutoApproved ? 'auto-approve' : 'ask',
          toolApprovals,
        },
      };
    });
  };

  const handleBackdropClick = () => {
    if (isPersonalityManagerOpen) return;
    onClose();
  };

  const renderSection = () => {
    if (activeSection === 'general') {
      return (
        <div className="space-y-6">
          <section className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold text-brand">{t('settings.language')}</h3>
              <p className="mt-1 text-sm text-zinc-500">{t('settings.languageDescription')}</p>
            </div>
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
          </section>

          <section className="space-y-4 rounded-xl border border-white/10 bg-black/20 p-4">
            <h3 className="text-lg font-semibold text-brand">{t('settings.uiSettings')}</h3>

            <div className="flex items-center justify-between gap-4">
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
          </section>
        </div>
      );
    }

    if (activeSection === 'tools') {
      return (
        <div className="space-y-4">
          <div>
            <h3 className="text-lg font-semibold text-brand">{t('settings.toolDefaults')}</h3>
            <p className="mt-1 text-sm text-zinc-500">{t('settings.toolDefaultsDescription')}</p>
          </div>

          <div className="grid gap-3 xl:grid-cols-2">
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

                  <div className="mt-3 ml-7 flex items-center justify-between gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2">
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
      );
    }

    if (activeSection === 'personality') {
      return (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-brand">{t('settings.aiPersonality')}</h3>
              <p className="mt-1 text-sm text-zinc-500">{t('settings.description')}</p>
            </div>
            <button
              type="button"
              onClick={onManagePersonalities}
              className="flex shrink-0 items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-white/10 text-zinc-400 hover:text-zinc-200 hover:bg-white/5 transition-colors"
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
      );
    }

    if (activeSection === 'agent') {
      return (
        <div className="space-y-5">
          <div>
            <h3 className="text-lg font-semibold text-brand">Agent Workspace</h3>
            <p className="mt-1 text-sm text-zinc-500">
              Configure the SSH environment used by agent mode. Without this, coding agents will say setup is required.
            </p>
          </div>

          <section className="space-y-4 rounded-xl border border-white/10 bg-black/20 p-4">
            <label className="flex items-center justify-between gap-4">
              <span>
                <span className="block text-sm font-medium text-zinc-100">Enable SSH agent workspace</span>
                <span className="mt-1 block text-xs text-zinc-500">All agent commands and file edits run on this remote host.</span>
              </span>
              <input
                type="checkbox"
                checked={formData.remoteWorkspace.enabled}
                onChange={(event) => handleRemoteWorkspaceChange('enabled', event.target.checked)}
                className="h-4 w-4 rounded border-white/10 bg-[#27272a] text-brand focus:ring-brand/50"
              />
            </label>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="space-y-1 text-xs text-zinc-400">
                <span>Host or IP</span>
                <input
                  value={formData.remoteWorkspace.host}
                  onChange={(event) => handleRemoteWorkspaceChange('host', event.target.value)}
                  placeholder="192.168.1.20"
                  className="h-10 w-full rounded-lg border border-white/10 bg-[#27272a] px-3 text-sm text-zinc-100 outline-none focus:border-brand/50"
                />
              </label>
              <label className="space-y-1 text-xs text-zinc-400">
                <span>Port</span>
                <input
                  type="number"
                  value={formData.remoteWorkspace.port}
                  onChange={(event) => handleRemoteWorkspaceChange('port', Number(event.target.value) || 22)}
                  className="h-10 w-full rounded-lg border border-white/10 bg-[#27272a] px-3 text-sm text-zinc-100 outline-none focus:border-brand/50"
                />
              </label>
              <label className="space-y-1 text-xs text-zinc-400">
                <span>Username</span>
                <input
                  value={formData.remoteWorkspace.username}
                  onChange={(event) => handleRemoteWorkspaceChange('username', event.target.value)}
                  placeholder="ubuntu"
                  className="h-10 w-full rounded-lg border border-white/10 bg-[#27272a] px-3 text-sm text-zinc-100 outline-none focus:border-brand/50"
                />
              </label>
              <label className="space-y-1 text-xs text-zinc-400">
                <span>Workspace root</span>
                <input
                  value={formData.remoteWorkspace.root}
                  onChange={(event) => handleRemoteWorkspaceChange('root', event.target.value)}
                  placeholder="/home/ubuntu/project"
                  className="h-10 w-full rounded-lg border border-white/10 bg-[#27272a] px-3 text-sm text-zinc-100 outline-none focus:border-brand/50"
                />
              </label>
            </div>

            <label className="space-y-1 text-xs text-zinc-400">
              <span>Private SSH key</span>
              <textarea
                value={formData.remoteWorkspace.privateKey || ''}
                onChange={(event) => handleRemoteWorkspaceChange('privateKey', event.target.value)}
                placeholder={formData.remoteWorkspace.hasPrivateKey ? 'A private key is already saved. Leave blank to keep it.' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
                rows={7}
                className="w-full resize-y rounded-lg border border-white/10 bg-[#27272a] px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-brand/50"
                spellCheck={false}
              />
            </label>

            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={formData.remoteWorkspace.strictHostKeyChecking}
                onChange={(event) => handleRemoteWorkspaceChange('strictHostKeyChecking', event.target.checked)}
                className="h-4 w-4 rounded border-white/10 bg-[#27272a] text-brand focus:ring-brand/50"
              />
              Strict host key checking
            </label>

            <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <div>
                <div className="text-sm font-medium text-zinc-100">Agent approvals</div>
                <div className="mt-1 text-xs leading-5 text-zinc-500">
                  Choose which spawned-agent tools pause for approval and which continue automatically.
                </div>
              </div>

              <div className="grid gap-2">
                {agentToolApprovalOptions.map((tool) => {
                  const approval = getAgentToolApproval(tool.name);
                  return (
                    <div
                      key={tool.name}
                      className="grid gap-3 rounded-lg border border-white/5 bg-black/20 p-3 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-center"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-zinc-100">{tool.label}</div>
                        <div className="mt-1 text-xs leading-5 text-zinc-500">{tool.description}</div>
                      </div>
                      <select
                        value={approval}
                        onChange={(event) => handleAgentToolApprovalChange(tool.name, event.target.value as 'ask' | 'auto-approve')}
                        className="h-10 w-full rounded-lg border border-white/10 bg-[#27272a] px-3 text-sm text-zinc-100 outline-none focus:border-brand/50"
                      >
                        <option value="ask">Ask first</option>
                        <option value="auto-approve">Auto-approve</option>
                      </select>
                    </div>
                  );
                })}
              </div>

              {agentToolApprovalOptions.some((tool) => getAgentToolApproval(tool.name) === 'auto-approve') && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-200">
                  Auto-approve is dangerous. Agents will be able to use selected remote tools without stopping for confirmation, including commands or file edits if those are enabled.
                </div>
              )}
            </div>
          </section>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold text-brand">MCP Servers</h3>
          <p className="mt-1 text-sm text-zinc-500">
            Add external MCP servers to extend tool capabilities.
          </p>
        </div>

        <MCPServerManager />
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-4" onClick={handleBackdropClick}>
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#1e1e20] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-white/10 p-4 sm:p-6">
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

        <div className="min-h-0 flex-1 md:grid md:grid-cols-[220px_minmax(0,1fr)]">
          <nav className="border-b border-white/10 p-3 md:border-b-0 md:border-r md:p-4">
            <div className="flex gap-2 overflow-x-auto md:block md:space-y-1 md:overflow-visible">
              {sections.map((section) => {
                const isActive = activeSection === section.id;
                return (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => setActiveSection(section.id)}
                    className={`flex min-w-max items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors md:w-full md:min-w-0 ${
                      isActive
                        ? 'bg-brand/15 text-zinc-100 ring-1 ring-brand/30'
                        : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
                    }`}
                  >
                    <span className={isActive ? 'text-brand' : 'text-zinc-500'}>
                      {section.icon}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{section.label}</span>
                      <span className="hidden truncate text-xs text-zinc-500 md:block">{section.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </nav>

          <div className="min-h-0 overflow-y-auto p-4 sm:p-6">
            {renderSection()}
          </div>
        </div>

        <div className="flex justify-end gap-3 border-t border-white/10 p-4 sm:px-6">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-[#27272a] hover:bg-[#3f3f46] rounded-lg text-zinc-300 transition-colors border border-white/10"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => onSave(formData)}
            className="px-4 py-2 bg-brand hover:bg-brand-dark rounded-lg text-white transition-colors shadow-md shadow-brand/20"
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default SettingsPanel;

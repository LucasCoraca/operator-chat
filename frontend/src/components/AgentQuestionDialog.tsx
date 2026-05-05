import { useEffect, useMemo, useState } from 'react';

export interface AgentQuestionOption {
  value: string;
  label: string;
  recommended?: boolean;
}

export interface AgentQuestionPayload {
  chatId: string;
  agentRunId: string;
  questionId: string;
  question: string;
  options: AgentQuestionOption[];
  multiple: boolean;
  allowCustomAnswer: boolean;
  timeoutMs?: number;
}

interface Props {
  question: AgentQuestionPayload;
  onAnswer: (answer: string | string[]) => void;
  onDismiss: () => void;
}

export function AgentQuestionDialog({ question, onAnswer, onDismiss }: Props) {
  const [selected, setSelected] = useState<string[]>(() => {
    const recommended = question.options.find((option) => option.recommended);
    return recommended ? [recommended.value] : [];
  });
  const [customText, setCustomText] = useState('');
  const [activeTab, setActiveTab] = useState<'options' | 'custom'>(
    question.options.length === 0 ? 'custom' : 'options'
  );

  // Reset state if a different question replaces this one mid-display.
  useEffect(() => {
    const recommended = question.options.find((option) => option.recommended);
    setSelected(recommended ? [recommended.value] : []);
    setCustomText('');
    setActiveTab(question.options.length === 0 ? 'custom' : 'options');
  }, [question.questionId]);

  const canSubmit = useMemo(() => {
    if (activeTab === 'custom') return customText.trim().length > 0;
    return selected.length > 0;
  }, [activeTab, customText, selected]);

  const handleToggle = (value: string) => {
    if (question.multiple) {
      setSelected((current) => current.includes(value) ? current.filter((v) => v !== value) : [...current, value]);
    } else {
      setSelected([value]);
    }
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    if (activeTab === 'custom') {
      onAnswer(customText.trim());
      return;
    }
    onAnswer(question.multiple ? selected : selected[0]);
  };

  // Rendered inline at the bottom of the agent run card — not a floating
  // modal — so the question sits below the last trace entry the same way the
  // steering composer does. This keeps the conversation linear and lets the
  // dialog persist visually across page reloads (the parent component re-
  // renders it from socket state on reconnect).
  // Rendered inline at the bottom of the agent run card — not a floating
  // modal — so the question sits below the last trace entry the same way the
  // steering composer does. This keeps the conversation linear and lets the
  // dialog persist visually across page reloads (the parent component re-
  // renders it from socket state on reconnect).
  return (
    <div className="border-t border-emerald-500/30 bg-emerald-500/5">
      <div className="px-5 py-4">
        <div className="text-xs uppercase tracking-wide text-emerald-400">Agent question</div>
        <div className="mt-1 text-base font-medium text-zinc-100">{question.question}</div>
      </div>

      {question.options.length > 0 && question.allowCustomAnswer && (
        <div className="flex border-y border-white/10 bg-black/20 text-xs">
          <button
            type="button"
            onClick={() => setActiveTab('options')}
            className={`flex-1 px-4 py-2 ${activeTab === 'options' ? 'border-b-2 border-emerald-400 text-emerald-200' : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            Options
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('custom')}
            className={`flex-1 px-4 py-2 ${activeTab === 'custom' ? 'border-b-2 border-emerald-400 text-emerald-200' : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            Type my own answer
          </button>
        </div>
      )}

      <div className="px-5 py-4">
        {activeTab === 'options' && question.options.length > 0 && (
          <div className="space-y-2">
            {question.options.map((option) => {
              const isSelected = selected.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleToggle(option.value)}
                  className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    isSelected
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
                      : 'border-white/10 bg-black/30 text-zinc-200 hover:border-white/30'
                  }`}
                >
                  <span>{option.label}</span>
                  {option.recommended && (
                    <span className="ml-2 rounded-full border border-emerald-500/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-emerald-300">
                      recommended
                    </span>
                  )}
                </button>
              );
            })}
            {question.multiple && (
              <p className="mt-2 text-xs text-zinc-500">Multiple selection allowed.</p>
            )}
          </div>
        )}

        {activeTab === 'custom' && (
          <div>
            <textarea
              value={customText}
              onChange={(event) => setCustomText(event.target.value)}
              rows={3}
              placeholder="Type your answer to send to the agent"
              className="w-full resize-none rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-emerald-500/40"
            />
            <p className="mt-2 text-xs text-zinc-500">
              Tip: typing a regular chat message also dismisses this question and sends a steering update.
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-white/10 bg-black/30 px-5 py-3">
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-zinc-300 hover:border-white/30"
        >
          Ignore
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-black transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send answer
        </button>
      </div>
    </div>
  );
}

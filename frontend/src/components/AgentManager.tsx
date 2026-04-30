import { useEffect, useState } from 'react';
import * as authService from '../services/auth';

interface AgentSummary {
  chatId: string;
  chatName: string;
  status: 'running' | 'paused' | 'completed';
  stepCount: number;
  finalAnswer: string | null;
  updatedAt: string;
}

interface AgentManagerProps {
  onOpenChat: (chatId: string) => void;
}

function AgentManager({ onOpenChat }: AgentManagerProps) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAgents = async () => {
    try {
      const res = await fetch('/api/agents', { headers: authService.getAuthHeader() });
      const data = await res.json();
      setAgents(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to load agents:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAgents();
    const timer = window.setInterval(loadAgents, 5000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#141415]">
      <div className="border-b border-white/5 px-6 py-5">
        <h1 className="text-xl font-semibold text-zinc-100">Agents</h1>
        <p className="mt-1 text-sm text-zinc-500">Manage agent runs. Step-by-step tool activity stays in the originating chat.</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="text-sm text-zinc-500">Loading agents...</div>
        ) : agents.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 bg-black/20 px-4 py-6 text-sm text-zinc-500">
            No agent runs yet.
          </div>
        ) : (
          <div className="space-y-3">
            {agents.map((agent) => {
              const statusClass = agent.status === 'running'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                : agent.status === 'paused'
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                  : 'border-white/10 bg-white/5 text-zinc-300';

              return (
                <button
                  key={agent.chatId}
                  type="button"
                  onClick={() => onOpenChat(agent.chatId)}
                  className="w-full rounded-xl border border-white/10 bg-black/20 p-4 text-left transition-colors hover:border-white/20 hover:bg-white/[0.03]"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-zinc-100">{agent.chatName}</div>
                      <div className="mt-1 text-xs text-zinc-500">
                        {agent.stepCount} steps · {new Date(agent.updatedAt).toLocaleString()}
                      </div>
                    </div>
                    <span className={`rounded-full border px-2 py-0.5 text-xs uppercase ${statusClass}`}>
                      {agent.status}
                    </span>
                  </div>
                  {agent.finalAnswer && (
                    <div className="mt-3 max-h-12 overflow-hidden text-sm leading-6 text-zinc-400">{agent.finalAnswer}</div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default AgentManager;

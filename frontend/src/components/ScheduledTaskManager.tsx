import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Socket } from 'socket.io-client';
import { getAuthHeader } from '../services/auth';

export interface ScheduledTask {
  id: string;
  chatId: string | null;
  title: string;
  prompt: string;
  scheduleType: 'once' | 'daily' | 'weekdays' | 'weekly' | 'interval';
  runAt: string | null;
  intervalMinutes: number | null;
  daysOfWeek: number[] | null;
  timeOfDay: string | null;
  timezone: string;
  status: 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';
  model: string | null;
  reasoningEffort: 'low' | 'medium' | 'high';
  lastRunAt: string | null;
  nextRunAt: string | null;
}

interface Props {
  socket: Socket | null;
  currentChatId: string | null;
  currentModel: string;
  onOpenChat: (chatId: string) => void;
}

function formatDate(value: string | null | undefined, notScheduledLabel: string) {
  if (!value) return notScheduledLabel;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function statusClass(status: ScheduledTask['status']) {
  switch (status) {
    case 'active': return 'border-accent-line bg-accent-soft text-[var(--accent)]';
    case 'paused': return 'border-amber-line bg-amber-soft text-amber';
    case 'failed': return 'border-rose-line bg-rose-soft text-rose';
    case 'completed': return 'border-blue-line bg-blue-soft text-blue';
    default: return 'border-[var(--line)] bg-[rgba(255,255,255,.02)] text-[var(--fg-1)]';
  }
}

export default function ScheduledTaskManager({ socket, currentChatId, currentModel, onOpenChat }: Props) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    title: '',
    prompt: '',
    scheduleType: 'daily' as ScheduledTask['scheduleType'],
    runAt: '',
    intervalMinutes: 60,
    daysOfWeek: [1],
    timeOfDay: '09:00',
    reasoningEffort: 'medium' as ScheduledTask['reasoningEffort'],
    attachToCurrentChat: true,
  });

  const dayLabels = [
    t('scheduler.days.sun'),
    t('scheduler.days.mon'),
    t('scheduler.days.tue'),
    t('scheduler.days.wed'),
    t('scheduler.days.thu'),
    t('scheduler.days.fri'),
    t('scheduler.days.sat'),
  ];

  const notScheduledLabel = t('scheduler.notScheduled');

  const describeSchedule = (task: ScheduledTask) => {
    if (task.scheduleType === 'once') {
      return t('scheduler.scheduleDescriptions.onceAt', { time: formatDate(task.runAt, notScheduledLabel) });
    }
    if (task.scheduleType === 'daily') {
      return t('scheduler.scheduleDescriptions.dailyAt', { time: task.timeOfDay || '09:00' });
    }
    if (task.scheduleType === 'weekdays') {
      return t('scheduler.scheduleDescriptions.weekdaysAt', { time: task.timeOfDay || '09:00' });
    }
    if (task.scheduleType === 'weekly') {
      const days = (task.daysOfWeek || []).map((day) => dayLabels[day]).join(', ') || t('scheduler.scheduleTypes.weekly');
      return t('scheduler.scheduleDescriptions.weeklyAt', { days, time: task.timeOfDay || '09:00' });
    }
    return t('scheduler.scheduleDescriptions.everyMinutes', { count: task.intervalMinutes || 60 });
  };

  const loadTasks = async () => {
    try {
      const res = await fetch('/api/tasks', { headers: getAuthHeader() });
      const data = await res.json();
      setTasks(Array.isArray(data) ? data : []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTasks();
  }, []);

  useEffect(() => {
    if (!socket) return;
    const refresh = () => loadTasks();
    socket.on('task-created', refresh);
    socket.on('task-updated', refresh);
    socket.on('task-deleted', refresh);
    socket.on('task-run-started', refresh);
    socket.on('task-run-completed', refresh);
    socket.on('task-run-failed', refresh);
    socket.on('task-approval-required', refresh);
    return () => {
      socket.off('task-created', refresh);
      socket.off('task-updated', refresh);
      socket.off('task-deleted', refresh);
      socket.off('task-run-started', refresh);
      socket.off('task-run-completed', refresh);
      socket.off('task-run-failed', refresh);
      socket.off('task-approval-required', refresh);
    };
  }, [socket]);

  const grouped = useMemo(() => {
    const attention = tasks.filter((task) => task.status === 'failed' || task.status === 'paused');
    const active = tasks.filter((task) => task.status === 'active');
    const history = tasks.filter((task) => task.status === 'completed' || task.status === 'cancelled');
    return { attention, active, history };
  }, [tasks]);

  const createTask = async () => {
    if (!form.title.trim() || !form.prompt.trim()) return;
    const body: Record<string, unknown> = {
      title: form.title.trim(),
      prompt: form.prompt.trim(),
      scheduleType: form.scheduleType,
      timeOfDay: form.timeOfDay,
      intervalMinutes: form.intervalMinutes,
      daysOfWeek: form.daysOfWeek,
      reasoningEffort: form.reasoningEffort,
      model: currentModel,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      approvalMode: { alwaysApprove: false },
      chatId: form.attachToCurrentChat ? currentChatId : null,
    };
    if (form.scheduleType === 'once') {
      body.runAt = form.runAt;
    }

    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || t('scheduler.failedToCreate'));
      return;
    }
    setForm((prev) => ({ ...prev, title: '', prompt: '' }));
    setShowCreate(false);
    loadTasks();
  };

  const mutateTask = async (taskId: string, action: 'run-now' | 'pause' | 'resume' | 'delete') => {
    const method = action === 'delete' ? 'DELETE' : 'POST';
    const suffix = action === 'delete' ? '' : `/${action}`;
    await fetch(`/api/tasks/${taskId}${suffix}`, { method, headers: getAuthHeader() });
    loadTasks();
  };

  const toggleDay = (day: number) => {
    setForm((prev) => {
      const hasDay = prev.daysOfWeek.includes(day);
      const daysOfWeek = hasDay ? prev.daysOfWeek.filter((value) => value !== day) : [...prev.daysOfWeek, day].sort();
      return { ...prev, daysOfWeek };
    });
  };

  const renderTask = (task: ScheduledTask) => (
    <div key={task.id} className="overflow-hidden rounded-[var(--radius)] hairline studio-card">
      <div className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-base font-semibold text-[var(--fg-0)]">{task.title}</h3>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase ${statusClass(task.status)}`}>{t(`scheduler.status.${task.status}`)}</span>
            </div>
            <p className="mt-2 line-clamp-2 text-sm leading-6 text-[var(--fg-2)]">{task.prompt}</p>
          </div>
          <div className="rounded-[var(--radius)] hairline bg-[rgba(255,255,255,.03)] px-3 py-2 text-right">
            <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--fg-3)]">{t('scheduler.nextRun')}</div>
            <div className="mt-1 text-sm font-medium text-[var(--fg-0)]">{formatDate(task.nextRunAt, notScheduledLabel)}</div>
          </div>
        </div>

        <div className="mt-4 grid gap-2 text-xs text-[var(--fg-2)] sm:grid-cols-3">
          <div className="rounded-[var(--radius)] hairline bg-[rgba(255,255,255,.02)] px-3 py-2">
            <div className="text-[var(--fg-3)]">{t('scheduler.cadence')}</div>
            <div className="mt-1 text-[var(--fg-0)]">{describeSchedule(task)}</div>
          </div>
          <div className="rounded-[var(--radius)] hairline bg-[rgba(255,255,255,.02)] px-3 py-2">
            <div className="text-[var(--fg-3)]">{t('scheduler.lastRun')}</div>
            <div className="mt-1 text-[var(--fg-0)]">{formatDate(task.lastRunAt, notScheduledLabel)}</div>
          </div>
          <div className="rounded-[var(--radius)] hairline bg-[rgba(255,255,255,.02)] px-3 py-2">
            <div className="text-[var(--fg-3)]">{t('scheduler.model')}</div>
            <div className="mt-1 truncate text-[var(--fg-0)]">{task.model || t('scheduler.defaultModel')}</div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 border-t hairline bg-[rgba(255,255,255,.02)] px-4 py-3 text-xs">
        <button onClick={() => mutateTask(task.id, 'run-now')} className="rounded-[var(--radius-sm)] bg-[var(--accent)] px-3 py-1.5 font-medium text-[var(--accent-ink)] hover:bg-[var(--accent)]/80">{t('scheduler.runNow')}</button>
        {task.status === 'paused' ? (
          <button onClick={() => mutateTask(task.id, 'resume')} className="rounded-[var(--radius-sm)] hairline px-3 py-1.5 text-[var(--fg-1)] hover:bg-[rgba(255,255,255,.03)]">{t('scheduler.resume')}</button>
        ) : (
          <button onClick={() => mutateTask(task.id, 'pause')} className="rounded-[var(--radius-sm)] hairline px-3 py-1.5 text-[var(--fg-1)] hover:bg-[rgba(255,255,255,.03)]">{t('scheduler.pause')}</button>
        )}
        {task.chatId && <button onClick={() => onOpenChat(task.chatId!)} className="rounded-[var(--radius-sm)] hairline px-3 py-1.5 text-[var(--fg-1)] hover:bg-[rgba(255,255,255,.03)]">{t('scheduler.openChat')}</button>}
        <button onClick={() => mutateTask(task.id, 'delete')} className="ml-auto rounded-[var(--radius-sm)] border border-rose-line px-3 py-1.5 text-rose hover:bg-rose-soft">{t('common.delete')}</button>
      </div>
    </div>
  );

  const renderSection = (title: string, description: string, sectionTasks: ScheduledTask[]) => (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--fg-2)]">{title}</h2>
        <p className="mt-1 text-sm text-[var(--fg-3)]">{description}</p>
      </div>
      {sectionTasks.length > 0 ? <div className="grid gap-3">{sectionTasks.map(renderTask)}</div> : <div className="rounded-[var(--radius)] border border-dashed hairline bg-[rgba(255,255,255,.02)] p-5 text-sm text-[var(--fg-3)]">{t('scheduler.noTasksHere')}</div>}
    </section>
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="overflow-hidden rounded-[var(--radius)] hairline-strong studio-card p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="eyebrow text-[var(--accent)]">{t('scheduler.automation')}</div>
              <h1 className="mt-2 text-2xl font-semibold text-[var(--fg-0)]">{t('scheduler.title')}</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--fg-2)]">{t('scheduler.description')}</p>
            </div>
            <button onClick={() => setShowCreate((prev) => !prev)} className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] shadow-1 shadow-[var(--accent)]/20 hover:bg-[var(--accent)]/80">
              {showCreate ? t('common.close') : t('scheduler.newTask')}
            </button>
          </div>

          {showCreate && (
            <div className="mt-6 rounded-[var(--radius)] hairline bg-[var(--bg-0)]/70 p-4">
              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-1.5 text-sm">
                  <span className="text-[var(--fg-2)]">{t('scheduler.form.title')}</span>
                  <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="rounded-[var(--radius)] hairline bg-[rgba(255,255,255,.025)] border border-[var(--line)] px-3 py-2 text-[var(--fg-0)] outline-none focus:border-[var(--line-3)] focus:ring-2 focus:ring-[rgba(255,255,255,.025)]" placeholder={t('scheduler.form.titlePlaceholder')} />
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span className="text-[var(--fg-2)]">{t('scheduler.form.schedule')}</span>
                  <select value={form.scheduleType} onChange={(e) => setForm({ ...form, scheduleType: e.target.value as ScheduledTask['scheduleType'] })} className="rounded-[var(--radius)] hairline bg-[rgba(255,255,255,.025)] border border-[var(--line)] px-3 py-2 text-[var(--fg-0)] outline-none focus:border-[var(--line-3)] focus:ring-2 focus:ring-[rgba(255,255,255,.025)]">
                    <option value="once">{t('scheduler.scheduleTypes.once')}</option>
                    <option value="daily">{t('scheduler.scheduleTypes.daily')}</option>
                    <option value="weekdays">{t('scheduler.scheduleTypes.weekdays')}</option>
                    <option value="weekly">{t('scheduler.scheduleTypes.weekly')}</option>
                    <option value="interval">{t('scheduler.scheduleTypes.interval')}</option>
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm md:col-span-2">
                  <span className="text-[var(--fg-2)]">{t('scheduler.form.instruction')}</span>
                  <textarea value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} className="min-h-[110px] rounded-[var(--radius)] hairline bg-[rgba(255,255,255,.025)] border border-[var(--line)] px-3 py-2 text-[var(--fg-0)] outline-none focus:border-[var(--line-3)] focus:ring-2 focus:ring-[rgba(255,255,255,.025)]" placeholder={t('scheduler.form.instructionPlaceholder')} />
                </label>
                {form.scheduleType === 'once' ? (
                  <label className="grid gap-1.5 text-sm">
                    <span className="text-[var(--fg-2)]">{t('scheduler.form.runAt')}</span>
                    <input type="datetime-local" value={form.runAt} onChange={(e) => setForm({ ...form, runAt: e.target.value })} className="rounded-[var(--radius)] hairline bg-[rgba(255,255,255,.025)] border border-[var(--line)] px-3 py-2 text-[var(--fg-0)] outline-none focus:border-[var(--line-3)] focus:ring-2 focus:ring-[rgba(255,255,255,.025)]" />
                  </label>
                ) : form.scheduleType === 'interval' ? (
                  <label className="grid gap-1.5 text-sm">
                    <span className="text-[var(--fg-2)]">{t('scheduler.form.everyMinutes')}</span>
                    <input type="number" min={1} value={form.intervalMinutes} onChange={(e) => setForm({ ...form, intervalMinutes: Number(e.target.value) })} className="rounded-[var(--radius)] hairline bg-[rgba(255,255,255,.025)] border border-[var(--line)] px-3 py-2 text-[var(--fg-0)] outline-none focus:border-[var(--line-3)] focus:ring-2 focus:ring-[rgba(255,255,255,.025)]" />
                  </label>
                ) : (
                  <label className="grid gap-1.5 text-sm">
                    <span className="text-[var(--fg-2)]">{t('scheduler.form.time')}</span>
                    <input type="time" value={form.timeOfDay} onChange={(e) => setForm({ ...form, timeOfDay: e.target.value })} className="rounded-[var(--radius)] hairline bg-[rgba(255,255,255,.025)] border border-[var(--line)] px-3 py-2 text-[var(--fg-0)] outline-none focus:border-[var(--line-3)] focus:ring-2 focus:ring-[rgba(255,255,255,.025)]" />
                  </label>
                )}
                {form.scheduleType === 'weekly' && (
                  <div className="grid gap-1.5 text-sm">
                    <span className="text-[var(--fg-2)]">{t('scheduler.form.days')}</span>
                    <div className="flex flex-wrap gap-2">
                      {dayLabels.map((label, index) => (
                        <button key={label} type="button" onClick={() => toggleDay(index)} className={`rounded-[var(--radius-sm)] hairline px-2.5 py-1.5 text-xs ${form.daysOfWeek.includes(index) ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]' : 'hairline text-[var(--fg-2)] hover:bg-[rgba(255,255,255,.03)]'}`}>{label}</button>
                      ))}
                    </div>
                  </div>
                )}
                <label className="flex items-center gap-2 text-sm text-[var(--fg-2)]">
                  <input type="checkbox" checked={form.attachToCurrentChat} onChange={(e) => setForm({ ...form, attachToCurrentChat: e.target.checked })} disabled={!currentChatId} className="h-4 w-4 rounded-[var(--radius-sm)] hairline bg-[rgba(255,255,255,.025)] border border-[var(--line)] text-[var(--accent)]" />
                  {t('scheduler.form.attachToCurrentChat')}
                </label>
                <button onClick={createTask} className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] hover:bg-[var(--accent)]/80 md:justify-self-end">{t('scheduler.createTask')}</button>
              </div>
            </div>
          )}
        </div>

        {loading ? <div className="text-sm text-[var(--fg-3)]">{t('scheduler.loadingTasks')}</div> : (
          <>
            {renderSection(t('scheduler.sections.attention'), t('scheduler.sections.attentionDescription'), grouped.attention)}
            {renderSection(t('scheduler.sections.active'), t('scheduler.sections.activeDescription'), grouped.active)}
            {renderSection(t('scheduler.sections.history'), t('scheduler.sections.historyDescription'), grouped.history)}
          </>
        )}
      </div>
    </div>
  );
}

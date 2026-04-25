import { ScheduledTask, ScheduledTaskScheduleType } from '../repositories/taskRepository';

export interface ScheduleInput {
  scheduleType: ScheduledTaskScheduleType;
  runAt?: string | Date | null;
  intervalMinutes?: number | null;
  daysOfWeek?: number[] | null;
  timeOfDay?: string | null;
}

function parseTimeOfDay(timeOfDay?: string | null): { hours: number; minutes: number } {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(timeOfDay || '');
  if (!match) {
    return { hours: 9, minutes: 0 };
  }
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

function nextAtTime(days: number[], timeOfDay?: string | null, from: Date = new Date()): Date {
  const { hours, minutes } = parseTimeOfDay(timeOfDay);
  const allowedDays = days.length > 0 ? days : [from.getDay()];

  for (let offset = 0; offset <= 14; offset++) {
    const candidate = new Date(from);
    candidate.setDate(from.getDate() + offset);
    candidate.setHours(hours, minutes, 0, 0);
    if (allowedDays.includes(candidate.getDay()) && candidate.getTime() > from.getTime()) {
      return candidate;
    }
  }

  const fallback = new Date(from);
  fallback.setDate(from.getDate() + 1);
  fallback.setHours(hours, minutes, 0, 0);
  return fallback;
}

export function computeNextRun(input: ScheduleInput, from: Date = new Date()): Date | null {
  switch (input.scheduleType) {
    case 'once': {
      if (!input.runAt) return null;
      const runAt = new Date(input.runAt);
      return Number.isNaN(runAt.getTime()) || runAt.getTime() <= from.getTime() ? null : runAt;
    }
    case 'daily':
      return nextAtTime([0, 1, 2, 3, 4, 5, 6], input.timeOfDay, from);
    case 'weekdays':
      return nextAtTime([1, 2, 3, 4, 5], input.timeOfDay, from);
    case 'weekly':
      return nextAtTime(input.daysOfWeek || [from.getDay()], input.timeOfDay, from);
    case 'interval': {
      const minutes = Math.max(1, input.intervalMinutes || 60);
      return new Date(from.getTime() + minutes * 60 * 1000);
    }
    default:
      return null;
  }
}

export function computeNextRunForTask(task: ScheduledTask, from: Date = new Date()): Date | null {
  if (task.schedule_type === 'once') {
    return null;
  }

  return computeNextRun({
    scheduleType: task.schedule_type,
    intervalMinutes: task.interval_minutes,
    daysOfWeek: Array.isArray(task.days_of_week) ? task.days_of_week : null,
    timeOfDay: task.time_of_day,
  }, from);
}

export function normalizeDaysOfWeek(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const days = value
    .map((day) => Number(day))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  return Array.from(new Set(days));
}

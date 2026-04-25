import { execute, query, queryOne } from '../db';
import crypto from 'crypto';

function toMysqlDateTime(date: Date = new Date()): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export type ScheduledTaskStatus = 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type ScheduledTaskRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'needs_approval';
export type ScheduledTaskScheduleType = 'once' | 'daily' | 'weekdays' | 'weekly' | 'interval';

export interface ScheduledTask {
  id: string;
  user_id: string;
  chat_id: string | null;
  sandbox_id: string | null;
  title: string;
  prompt: string;
  schedule_type: ScheduledTaskScheduleType;
  run_at: Date | null;
  interval_minutes: number | null;
  days_of_week: any;
  time_of_day: string | null;
  timezone: string;
  status: ScheduledTaskStatus;
  model: string | null;
  tool_preferences: any;
  approval_mode: any;
  reasoning_effort: 'low' | 'medium' | 'high';
  last_run_at: Date | null;
  next_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ScheduledTaskRun {
  id: string;
  task_id: string;
  chat_id: string;
  status: ScheduledTaskRunStatus;
  started_at: Date | null;
  completed_at: Date | null;
  error: string | null;
  result_message_id: string | null;
  agent_steps: any;
  created_at: Date;
}

export interface CreateScheduledTaskInput {
  userId: string;
  chatId?: string | null;
  sandboxId?: string | null;
  title: string;
  prompt: string;
  scheduleType: ScheduledTaskScheduleType;
  runAt?: Date | null;
  intervalMinutes?: number | null;
  daysOfWeek?: number[] | null;
  timeOfDay?: string | null;
  timezone?: string;
  model?: string | null;
  toolPreferences?: any;
  approvalMode?: any;
  reasoningEffort?: 'low' | 'medium' | 'high';
  nextRunAt: Date | null;
}

export class TaskRepository {
  async findByUserId(userId: string): Promise<ScheduledTask[]> {
    return query<ScheduledTask>('SELECT * FROM scheduled_tasks WHERE user_id = ? ORDER BY next_run_at IS NULL, next_run_at ASC, updated_at DESC', [userId]);
  }

  async findById(id: string): Promise<ScheduledTask | null> {
    return queryOne<ScheduledTask>('SELECT * FROM scheduled_tasks WHERE id = ?', [id]);
  }

  async findDue(limit = 10): Promise<ScheduledTask[]> {
    return query<ScheduledTask>(
      `SELECT * FROM scheduled_tasks
       WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at ASC
       LIMIT ?`,
      [toMysqlDateTime(), limit]
    );
  }

  async create(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
    const id = crypto.randomUUID();
    const now = toMysqlDateTime();
    await execute(
      `INSERT INTO scheduled_tasks (
        id, user_id, chat_id, sandbox_id, title, prompt, schedule_type, run_at,
        interval_minutes, days_of_week, time_of_day, timezone, status, model,
        tool_preferences, approval_mode, reasoning_effort, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.userId,
        input.chatId || null,
        input.sandboxId || null,
        input.title,
        input.prompt,
        input.scheduleType,
        input.runAt ? toMysqlDateTime(input.runAt) : null,
        input.intervalMinutes ?? null,
        input.daysOfWeek ? JSON.stringify(input.daysOfWeek) : null,
        input.timeOfDay || null,
        input.timezone || 'UTC',
        input.model || null,
        JSON.stringify(input.toolPreferences || {}),
        JSON.stringify(input.approvalMode || { alwaysApprove: false }),
        input.reasoningEffort || 'medium',
        input.nextRunAt ? toMysqlDateTime(input.nextRunAt) : null,
        now,
        now,
      ]
    );
    const task = await this.findById(id);
    if (!task) throw new Error('Failed to create scheduled task');
    return task;
  }

  async update(id: string, updates: Partial<ScheduledTask>): Promise<ScheduledTask | null> {
    const fields: string[] = [];
    const values: any[] = [];
    const add = (field: string, value: any) => {
      fields.push(`${field} = ?`);
      values.push(value);
    };

    if (updates.chat_id !== undefined) add('chat_id', updates.chat_id);
    if (updates.sandbox_id !== undefined) add('sandbox_id', updates.sandbox_id);
    if (updates.title !== undefined) add('title', updates.title);
    if (updates.prompt !== undefined) add('prompt', updates.prompt);
    if (updates.schedule_type !== undefined) add('schedule_type', updates.schedule_type);
    if (updates.run_at !== undefined) add('run_at', updates.run_at ? toMysqlDateTime(new Date(updates.run_at)) : null);
    if (updates.interval_minutes !== undefined) add('interval_minutes', updates.interval_minutes);
    if (updates.days_of_week !== undefined) add('days_of_week', updates.days_of_week ? JSON.stringify(updates.days_of_week) : null);
    if (updates.time_of_day !== undefined) add('time_of_day', updates.time_of_day);
    if (updates.timezone !== undefined) add('timezone', updates.timezone);
    if (updates.status !== undefined) add('status', updates.status);
    if (updates.model !== undefined) add('model', updates.model);
    if (updates.tool_preferences !== undefined) add('tool_preferences', JSON.stringify(updates.tool_preferences));
    if (updates.approval_mode !== undefined) add('approval_mode', JSON.stringify(updates.approval_mode));
    if (updates.reasoning_effort !== undefined) add('reasoning_effort', updates.reasoning_effort);
    if (updates.last_run_at !== undefined) add('last_run_at', updates.last_run_at ? toMysqlDateTime(new Date(updates.last_run_at)) : null);
    if (updates.next_run_at !== undefined) add('next_run_at', updates.next_run_at ? toMysqlDateTime(new Date(updates.next_run_at)) : null);

    if (fields.length === 0) return this.findById(id);
    add('updated_at', toMysqlDateTime());
    values.push(id);
    await execute(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`, values);
    return this.findById(id);
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const result = await execute('DELETE FROM scheduled_tasks WHERE id = ? AND user_id = ?', [id, userId]);
    return result.affectedRows > 0;
  }

  async createRun(taskId: string, chatId: string): Promise<ScheduledTaskRun> {
    const id = crypto.randomUUID();
    await execute(
      `INSERT INTO scheduled_task_runs (id, task_id, chat_id, status, created_at)
       VALUES (?, ?, ?, 'queued', ?)`,
      [id, taskId, chatId, toMysqlDateTime()]
    );
    const run = await queryOne<ScheduledTaskRun>('SELECT * FROM scheduled_task_runs WHERE id = ?', [id]);
    if (!run) throw new Error('Failed to create task run');
    return run;
  }

  async updateRun(id: string, updates: Partial<ScheduledTaskRun>): Promise<ScheduledTaskRun | null> {
    const fields: string[] = [];
    const values: any[] = [];
    const add = (field: string, value: any) => {
      fields.push(`${field} = ?`);
      values.push(value);
    };

    if (updates.status !== undefined) add('status', updates.status);
    if (updates.started_at !== undefined) add('started_at', updates.started_at ? toMysqlDateTime(new Date(updates.started_at)) : null);
    if (updates.completed_at !== undefined) add('completed_at', updates.completed_at ? toMysqlDateTime(new Date(updates.completed_at)) : null);
    if (updates.error !== undefined) add('error', updates.error);
    if (updates.result_message_id !== undefined) add('result_message_id', updates.result_message_id);
    if (updates.agent_steps !== undefined) add('agent_steps', JSON.stringify(updates.agent_steps));
    if (fields.length === 0) return queryOne<ScheduledTaskRun>('SELECT * FROM scheduled_task_runs WHERE id = ?', [id]);
    values.push(id);
    await execute(`UPDATE scheduled_task_runs SET ${fields.join(', ')} WHERE id = ?`, values);
    return queryOne<ScheduledTaskRun>('SELECT * FROM scheduled_task_runs WHERE id = ?', [id]);
  }

  async findRunsByTaskId(taskId: string): Promise<ScheduledTaskRun[]> {
    return query<ScheduledTaskRun>('SELECT * FROM scheduled_task_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 50', [taskId]);
  }
}

export const taskRepository = new TaskRepository();

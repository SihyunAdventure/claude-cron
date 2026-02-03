import { parse } from 'yaml';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface TaskDefinition {
  id: string;
  file: string;
  cron: string;
  notify: string[];
  timeout: number;
  workdir?: string;
  prompt: string;
}

interface ScheduleYAML {
  tasks: Array<{
    id: string;
    file: string;
    cron: string;
    notify?: string[];
    timeout?: number;
    workdir?: string;
  }>;
}

function resolveHomeDir(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return path.join(os.homedir(), filepath.slice(2));
  }
  return filepath;
}

export async function loadTasks(tasksDir: string): Promise<TaskDefinition[]> {
  const scheduleFile = path.join(tasksDir, '_schedule.yaml');
  const scheduleContent = await fs.readFile(scheduleFile, 'utf-8');
  const schedule = parse(scheduleContent) as ScheduleYAML;

  if (!schedule.tasks || !Array.isArray(schedule.tasks)) {
    throw new Error('Invalid schedule: missing "tasks" array');
  }

  const tasks: TaskDefinition[] = [];

  for (const task of schedule.tasks) {
    if (!task.id || !task.file || !task.cron) {
      throw new Error(`Task missing required fields: ${JSON.stringify(task)}`);
    }

    const promptFile = path.join(tasksDir, task.file);
    const prompt = await fs.readFile(promptFile, 'utf-8');

    tasks.push({
      id: task.id,
      file: task.file,
      cron: task.cron,
      notify: task.notify || [],
      timeout: task.timeout || 300000,
      workdir: task.workdir ? resolveHomeDir(task.workdir) : undefined,
      prompt: prompt.trim(),
    });
  }

  return tasks;
}

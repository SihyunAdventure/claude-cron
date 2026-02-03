import cron from 'node-cron';
import { executeClaudeTask } from './executor.js';
import type { Notifier } from './notifier.js';
import type { TaskDefinition } from './task-loader.js';
import type { Config } from './config.js';
import fs from 'node:fs';
import path from 'node:path';

interface TaskExecutionLog {
  taskId: string;
  startedAt: string;
  completedAt: string;
  success: boolean;
  output?: string;
  error?: string;
}

function parseHour(timeStr: string): number {
  return parseInt(timeStr.split(':')[0], 10);
}

function isWithinActiveHours(activeHours?: { start: string; end: string }): boolean {
  if (!activeHours) return true;
  const now = new Date();
  const currentHour = now.getHours();
  const start = parseHour(activeHours.start);
  const end = parseHour(activeHours.end);
  if (start <= end) {
    return currentHour >= start && currentHour < end;
  }
  return currentHour >= start || currentHour < end;
}

function writeExecutionLog(config: Config, log: TaskExecutionLog): void {
  try {
    const logDir = config.logging.dir;
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(logDir, `${log.taskId}-${timestamp}.json`);
    fs.writeFileSync(logFile, JSON.stringify(log, null, 2), 'utf-8');
  } catch (error) {
    console.error(`Failed to write log for ${log.taskId}:`, error);
  }
}

async function executeScheduledTask(
  task: TaskDefinition,
  config: Config,
  notifier: Notifier
): Promise<void> {
  const log: TaskExecutionLog = {
    taskId: task.id,
    startedAt: new Date().toISOString(),
    completedAt: '',
    success: false,
  };

  try {
    console.log(`[${new Date().toISOString()}] Executing task: ${task.id}`);

    const result = await executeClaudeTask(
      { prompt: task.prompt, workdir: task.workdir, timeout: task.timeout },
      config.claude
    );

    log.completedAt = new Date().toISOString();
    log.success = result.success;
    log.output = result.output;
    if (!result.success) log.error = result.error;

    await notifier.send(task.notify, result.output, task.id);

    console.log(`[${new Date().toISOString()}] Task ${task.id} completed (success=${result.success})`);
  } catch (error) {
    log.completedAt = new Date().toISOString();
    log.error = error instanceof Error ? error.message : String(error);

    await notifier.send(task.notify, `Error: ${log.error}`, task.id);
    console.error(`[${new Date().toISOString()}] Task ${task.id} failed:`, log.error);
  } finally {
    writeExecutionLog(config, log);
  }
}

export function startScheduler(
  tasks: TaskDefinition[],
  config: Config,
  notifier: Notifier
): cron.ScheduledTask[] {
  const scheduledTasks: cron.ScheduledTask[] = [];

  for (const task of tasks) {
    const cronTask = cron.schedule(task.cron, async () => {
      if (!isWithinActiveHours(config.heartbeat.activeHours)) {
        console.log(`[${new Date().toISOString()}] Skipping ${task.id} - outside active hours`);
        return;
      }
      await executeScheduledTask(task, config, notifier);
    });

    scheduledTasks.push(cronTask);
    console.log(`Scheduled task: ${task.id} [${task.cron}]`);
  }

  return scheduledTasks;
}

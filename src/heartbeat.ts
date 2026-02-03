import cron from 'node-cron';
import { executeClaudeTask } from './executor.js';
import type { Notifier } from './notifier.js';
import type { Config } from './config.js';
import fs from 'node:fs';

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

export function startHeartbeat(config: Config, notifier: Notifier): cron.ScheduledTask | null {
  if (!config.heartbeat?.enabled) {
    console.log('Heartbeat is disabled');
    return null;
  }

  const heartbeatFile = config.heartbeat.file;
  if (!fs.existsSync(heartbeatFile)) {
    console.log(`HEARTBEAT.md not found at ${heartbeatFile}, skipping heartbeat`);
    return null;
  }

  const task = cron.schedule(config.heartbeat.cron, async () => {
    if (!isWithinActiveHours(config.heartbeat.activeHours)) {
      return;
    }

    try {
      console.log(`[${new Date().toISOString()}] Running heartbeat`);
      const prompt = fs.readFileSync(heartbeatFile, 'utf-8');

      const result = await executeClaudeTask(
        { prompt, timeout: 120000 },
        config.claude
      );

      if (result.output.includes('HEARTBEAT_OK')) {
        console.log(`[${new Date().toISOString()}] Heartbeat OK`);
        return;
      }

      await notifier.send(['telegram'], result.output, 'heartbeat');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[${new Date().toISOString()}] Heartbeat failed:`, msg);
      await notifier.send(['telegram'], `Heartbeat error: ${msg}`, 'heartbeat');
    }
  });

  console.log(`Heartbeat scheduled [${config.heartbeat.cron}]`);
  return task;
}

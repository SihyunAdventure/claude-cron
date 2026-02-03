import 'dotenv/config';
import { loadConfig } from './config.js';
import { loadTasks } from './task-loader.js';
import { createNotifier } from './notifier.js';
import { startScheduler } from './scheduler.js';
import { startHeartbeat } from './heartbeat.js';
import { startTelegramBot } from './telegram-bot.js';
import { SessionStore } from './session-store.js';
import { watch } from 'chokidar';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

async function main() {
  console.log('Claude Cron Service starting...');

  // Load config
  const config = loadConfig();
  console.log('Config loaded');

  // Load tasks
  const tasksDir = path.resolve(PROJECT_ROOT, 'tasks');
  let tasks = await loadTasks(tasksDir);
  console.log(`Loaded ${tasks.length} task(s)`);

  // Create notifier
  const notifier = createNotifier(config.notifications);

  // Start scheduler
  let scheduledTasks = startScheduler(tasks, config, notifier);

  // Start heartbeat
  const heartbeatTask = startHeartbeat(config, notifier);

  // Start Telegram bot (if enabled)
  if (config.telegramBot.enabled) {
    try {
      startTelegramBot(config, tasks);
    } catch (error) {
      console.error('Failed to start Telegram bot:', error);
    }
  }

  // Clean expired sessions periodically
  const sessionStore = new SessionStore({
    dir: config.sessions.dir,
    ttlHours: config.sessions.ttlHours,
  });
  setInterval(() => sessionStore.cleanExpired(), 60 * 60 * 1000);

  // Hot-reload: watch tasks directory
  const watcher = watch(tasksDir, { ignoreInitial: true });
  watcher.on('change', async (filePath) => {
    console.log(`[Hot-reload] File changed: ${filePath}`);
    try {
      // Stop existing cron jobs
      scheduledTasks.forEach((t) => t.stop());

      // Reload tasks
      tasks = await loadTasks(tasksDir);
      console.log(`[Hot-reload] Reloaded ${tasks.length} task(s)`);

      // Restart scheduler
      scheduledTasks = startScheduler(tasks, config, notifier);
    } catch (error) {
      console.error('[Hot-reload] Failed to reload tasks:', error);
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('Shutting down...');
    scheduledTasks.forEach((t) => t.stop());
    heartbeatTask?.stop();
    watcher.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('Claude Cron Service running. Press Ctrl+C to stop.');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

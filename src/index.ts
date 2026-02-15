import 'dotenv/config';
import { loadConfig } from './config.js';
import { loadTasks } from './task-loader.js';
import { createNotifier } from './notifier.js';
import { startScheduler } from './scheduler.js';
import { startHeartbeat } from './heartbeat.js';
import { startTelegramBot } from './telegram-bot.js';
import { SessionStore } from './session-store.js';
import { getChatGPTBrowserClient, stopChatGPTBrowserClient } from './chatgpt-browser.js';
import { initGoogleCalendar } from './google-calendar.js';
import { watch } from 'chokidar';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { syncCodexAuth } from './codex-auth-sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const LOCK_FILE = '/tmp/claude-cron.lock';

function syncCodexAuthFromConfig() {
  const sourcePath =
    process.env.CODEX_AUTH_SOURCE || path.resolve(PROJECT_ROOT, 'config', 'codex-auth.json');
  const targetPath =
    process.env.CODEX_AUTH_TARGET ||
    path.resolve(os.homedir(), '.codex', 'auth.json');

  const result = syncCodexAuth({ sourcePath, targetPath });
  if (result.status === 'failed') {
    console.warn(`[codex-auth] sync failed: ${result.reason}`);
  } else if (result.status === 'skipped') {
    console.log(`[codex-auth] sync skipped: ${result.reason}`);
  } else {
    console.log(`[codex-auth] sync: ${result.reason}`);
  }
}

function startCodexAuthSyncScheduler() {
  const rawIntervalMinutes = Number(process.env.CODEX_AUTH_SYNC_INTERVAL_MINUTES || '0');
  if (!Number.isFinite(rawIntervalMinutes) || rawIntervalMinutes <= 0) {
    return;
  }

  const intervalMs = rawIntervalMinutes * 60 * 1000;
  setInterval(() => {
    syncCodexAuthFromConfig();
  }, intervalMs);
}

function acquireLock(): boolean {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
      // Check if process is running
      try {
        process.kill(pid, 0); // Signal 0 = check if exists
        console.error(`claude-cron is already running (PID: ${pid}). Exiting.`);
        return false;
      } catch {
        // Process not running, stale lock file
        console.log('Removing stale lock file');
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    return true;
  } catch (err) {
    console.error('Failed to acquire lock:', err);
    return false;
  }
}

function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

async function main() {
  console.log('Claude Cron Service starting...');

  // Acquire singleton lock
  if (!acquireLock()) {
    process.exit(1);
  }

  syncCodexAuthFromConfig();
  startCodexAuthSyncScheduler();

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

  // Start ChatGPT Browser service (if enabled) - 사전 워밍업
  if (config.chatgptBrowser?.enabled) {
    try {
      const browserClient = getChatGPTBrowserClient(config.chatgptBrowser);
      await browserClient.start();
      console.log('ChatGPT Browser service started');
    } catch (error) {
      console.error('Failed to start ChatGPT Browser service:', error);
      // 실패해도 서비스는 계속 실행 (fallback이 있음)
    }
  }

  // Initialize Google Calendar (if enabled)
  if (config.googleCalendar?.enabled) {
    try {
      const rawCredFile = config.googleCalendar.credentialsFile
        || 'config/google-credentials.json';
      const credFile = path.isAbsolute(rawCredFile)
        ? rawCredFile
        : path.resolve(PROJECT_ROOT, rawCredFile);
      const calResult = await initGoogleCalendar(credFile);
      if (calResult.ready) {
        console.log('Google Calendar connected');
      } else {
        console.log('Google Calendar requires auth. Use /gcal command in Telegram to authenticate.');
        if (calResult.authUrl) {
          console.log('Auth URL:', calResult.authUrl);
        }
      }
    } catch (error) {
      console.error('Failed to initialize Google Calendar:', error);
    }
  }

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
  const shutdown = async (signal?: string) => {
    console.log(`Shutting down... (signal: ${signal || 'unknown'})`);
    console.log('Stack trace:', new Error().stack);
    scheduledTasks.forEach((t) => t.stop());
    heartbeatTask?.stop();
    watcher.close();
    // ChatGPT Browser 서비스 종료 (Chrome 프로세스 정리)
    await stopChatGPTBrowserClient().catch(() => {});
    releaseLock();
    process.exit(0);
  };

  process.on('exit', (code) => {
    console.log(`Process exit with code: ${code}`);
    releaseLock();
  });
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
  });

  console.log('Claude Cron Service running. Press Ctrl+C to stop.');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { executeClaudeTask } from './executor.js';
import { SessionStore } from './session-store.js';
import { watch } from 'chokidar';
import { ReminderManager, formatTime } from './reminders.js';
import type { TaskDefinition } from './task-loader.js';
import type { Config } from './config.js';

const execAsync = promisify(exec);

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number; type: string };
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

class TelegramBot {
  private token: string;
  private baseUrl: string;
  private offset = 0;
  private running = false;

  constructor(token: string) {
    this.token = token;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async apiPost(endpoint: string, data: Record<string, unknown>): Promise<any> {
    const url = `${this.baseUrl}/${endpoint}`;
    const body = JSON.stringify(data).replace(/'/g, "'\\''");
    const { stdout } = await execAsync(
      `curl -s -X POST '${url}' -H 'Content-Type: application/json' -d '${body}'`,
      { timeout: 30000 }
    );
    return JSON.parse(stdout);
  }

  private async apiGet(endpoint: string): Promise<any> {
    const url = `${this.baseUrl}/${endpoint}`;
    const { stdout } = await execAsync(
      `curl -s --max-time 35 '${url}'`,
      { timeout: 40000 }
    );
    return JSON.parse(stdout);
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    const maxLen = 4096;
    const chunks: string[] = [];
    if (text.length <= maxLen) {
      chunks.push(text);
    } else {
      for (let i = 0; i < text.length; i += maxLen) {
        chunks.push(text.slice(i, i + maxLen));
      }
    }
    for (const chunk of chunks) {
      await this.apiPost('sendMessage', { chat_id: chatId, text: chunk });
    }
  }

  async getFile(fileId: string): Promise<string | null> {
    try {
      const data = await this.apiGet(`getFile?file_id=${fileId}`);
      if (data.ok && data.result.file_path) {
        return `https://api.telegram.org/file/bot${this.token}/${data.result.file_path}`;
      }
      return null;
    } catch {
      return null;
    }
  }

  async downloadFile(fileUrl: string, destPath: string): Promise<boolean> {
    try {
      await execAsync(`curl -s -o '${destPath}' '${fileUrl}'`, { timeout: 30000 });
      return true;
    } catch {
      return false;
    }
  }

  async getUpdates(): Promise<TelegramUpdate[]> {
    try {
      const data = await this.apiGet(`getUpdates?offset=${this.offset}&timeout=30`);
      if (data.ok && data.result.length > 0) {
        this.offset = data.result[data.result.length - 1].update_id + 1;
      }
      return data.ok ? data.result : [];
    } catch {
      return [];
    }
  }

  async startPolling(handler: (msg: TelegramMessage) => Promise<void>): Promise<void> {
    this.running = true;
    console.log('Telegram bot polling started');
    while (this.running) {
      const updates = await this.getUpdates();
      for (const update of updates) {
        if (update.message) {
          handler(update.message).catch((error) => {
            console.error('Message handler error:', error);
          });
        }
      }
    }
  }

  stop(): void {
    this.running = false;
  }
}

// Per-chatId queue: sequential within same user, parallel across users
class ChatQueue {
  private queues: Map<number, Array<() => Promise<void>>> = new Map();
  private running: Set<number> = new Set();

  enqueue(chatId: number, fn: () => Promise<void>): void {
    if (!this.queues.has(chatId)) {
      this.queues.set(chatId, []);
    }
    this.queues.get(chatId)!.push(fn);
    this.process(chatId);
  }

  private async process(chatId: number): Promise<void> {
    if (this.running.has(chatId)) return;
    this.running.add(chatId);

    const queue = this.queues.get(chatId)!;
    while (queue.length > 0) {
      const fn = queue.shift()!;
      try {
        await fn();
      } catch (err) {
        console.error(`[queue] Error for chat ${chatId}:`, err);
      }
    }

    this.running.delete(chatId);
  }
}

function getTodayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function getTimeStr(): string {
  return new Date().toTimeString().slice(0, 5);
}

/** Get user-specific memory directory */
function getUserMemoryDir(baseMemoryDir: string, chatId: number): string {
  const userDir = path.join(baseMemoryDir, String(chatId));
  // Ensure all subdirs exist
  fs.mkdirSync(path.join(userDir, 'bot'), { recursive: true });
  fs.mkdirSync(path.join(userDir, 'user'), { recursive: true });
  fs.mkdirSync(path.join(userDir, 'areas'), { recursive: true });
  fs.mkdirSync(path.join(userDir, 'daily'), { recursive: true });
  return userDir;
}

/** Initialize user memory from templates if first time */
function initUserMemory(baseMemoryDir: string, chatId: number): void {
  const userDir = getUserMemoryDir(baseMemoryDir, chatId);

  // Copy template files if they don't exist yet
  // Templates are stored in memory/templates/ and copied to user-specific directories
  const templates: [string, string][] = [
    ['templates/IDENTITY.md', 'bot/IDENTITY.md'],
    ['templates/USER.md', 'user/USER.md'],
    ['templates/MEMORY.md', 'user/MEMORY.md'],
    ['templates/areas/work.md', 'areas/work.md'],
    ['templates/areas/health.md', 'areas/health.md'],
  ];

  // Ensure areas directory exists
  fs.mkdirSync(path.join(userDir, 'areas'), { recursive: true });

  for (const [src, dest] of templates) {
    const destPath = path.join(userDir, dest);
    if (!fs.existsSync(destPath)) {
      const srcPath = path.join(baseMemoryDir, src);
      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

function appendDailyLog(userMemoryDir: string, prompt: string, response: string): void {
  const dateStr = getTodayDateStr();
  const logFile = path.join(userMemoryDir, 'daily', `${dateStr}.md`);
  const time = getTimeStr();

  const promptSummary = prompt.length > 100 ? prompt.slice(0, 100) + '...' : prompt;
  const responseSummary = response.length > 100 ? response.slice(0, 100) + '...' : response;

  let entry = '';
  if (!fs.existsSync(logFile)) {
    entry += `# ${dateStr} 대화 로그\n\n`;
  }
  entry += `- [${time}] 사용자: ${promptSummary}\n`;
  entry += `- [${time}] Claude: ${responseSummary}\n\n`;

  fs.appendFileSync(logFile, entry);
}

export function startTelegramBot(config: Config, tasks: TaskDefinition[]): TelegramBot {
  if (!config.notifications.telegram?.token) {
    throw new Error('Telegram bot token not configured');
  }

  const bot = new TelegramBot(config.notifications.telegram.token);
  const sessionStore = new SessionStore({
    dir: config.sessions.dir,
    ttlHours: config.sessions.ttlHours,
  });
  const allowedChatIds = new Set(config.telegramBot.allowedChatIds);
  const baseMemoryDir = config.memory?.dir || path.resolve(process.cwd(), 'memory');
  const chatQueue = new ChatQueue();

  function isAuthorized(chatId: number): boolean {
    return allowedChatIds.has(String(chatId));
  }

  // Initialize reminder manager
  const reminderMgr = new ReminderManager(
    (chatId, text) => bot.sendMessage(chatId, text)
  );
  reminderMgr.setClaudeConfig(config.claude, config.telegramBot.defaultWorkdir);
  reminderMgr.startAll();

  const logDir = config.logging.dir;
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(baseMemoryDir, { recursive: true });

  // Directory for downloaded images
  const imagesDir = path.join(baseMemoryDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  // Load system prompt template
  let systemPromptTemplate: string | undefined;
  if (config.memory?.enabled && config.memory.systemPromptFile) {
    try {
      systemPromptTemplate = fs.readFileSync(config.memory.systemPromptFile, 'utf-8');
      console.log('System prompt loaded from', config.memory.systemPromptFile);
    } catch {
      console.warn('System prompt file not found:', config.memory.systemPromptFile);
    }
  }

  function getSystemPrompt(chatId: number): string {
    const now = new Date();
    const currentDateTime = now.toLocaleString('ko-KR', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const timeInfo = `[현재 시간: ${currentDateTime} (KST)]\n\n`;

    if (!systemPromptTemplate) return timeInfo;
    return timeInfo + systemPromptTemplate.replace(/\{chatId\}/g, String(chatId));
  }

  function logConversation(chatId: number, prompt: string, result: any): void {
    const logFile = path.join(logDir, `chat-${chatId}.jsonl`);
    const entry = {
      timestamp: new Date().toISOString(),
      chatId,
      prompt,
      response: result.output,
      sessionId: result.sessionId,
      success: result.success,
    };
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  }

  async function sendTyping(chatId: number): Promise<NodeJS.Timeout> {
    const send = () => bot.apiPost('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    send();
    return setInterval(send, 4000);
  }

  async function handlePrompt(chatId: number, prompt: string): Promise<void> {
    const typingInterval = await sendTyping(chatId);

    // Initialize per-user memory
    if (config.memory?.enabled) {
      initUserMemory(baseMemoryDir, chatId);
    }

    // Get existing session for --resume
    const existingSessionId = sessionStore.getSession(String(chatId));
    const userMemDir = getUserMemoryDir(baseMemoryDir, chatId);
    const remindersPath = path.resolve(config.telegramBot.defaultWorkdir || '.', 'config', 'reminders.json');
    const memoryPrefix = `[메모리 시스템]
경로: ${userMemDir}
- 대화 시작 시: user/USER.md, user/MEMORY.md, bot/IDENTITY.md를 Read하여 맥락 파악
- 사용자 정보(이름, 선호 등) → user/USER.md를 Read 후 업데이트
- 기억 요청, 중요 정보 → user/MEMORY.md를 Read 후 append (덮어쓰기 금지)
- 봇 이름/성격 설정 → bot/IDENTITY.md를 Read 후 업데이트
- 업무/프로젝트 정보 → areas/work.md, 건강/운동 정보 → areas/health.md
[알림 관리: ${remindersPath}] 알람/리마인더 등록·수정·삭제 요청 시 이 JSON 파일을 Read하고 Write로 수정하라. 형식: [{"id":"r-타임스탬프","chatId":${chatId},"type":"message"|"task","message":"내용","hour":시,"minute":분,"cron":"분 시 * * *","createdAt":"ISO"}]. type=task는 Claude가 실행, type=message는 단순 알림.

`;

    // Progress message tracking (debounced + deduped)
    let lastProgressTime = 0;
    let lastProgressMessage = '';
    const progressDebounce = 3000; // 3초마다 최대 1개 메시지
    const onProgress = async (message: string) => {
      const now = Date.now();
      // 동일 메시지는 10초 내 중복 차단
      if (message === lastProgressMessage && now - lastProgressTime < 10000) {
        return;
      }
      if (now - lastProgressTime > progressDebounce) {
        lastProgressTime = now;
        lastProgressMessage = message;
        try {
          await bot.sendMessage(chatId, message);
        } catch (err) {
          console.error('[progress] Failed to send:', err);
        }
      }
    };

    let result = await executeClaudeTask(
      {
        prompt: memoryPrefix + prompt,
        workdir: config.telegramBot.defaultWorkdir,
        systemPrompt: getSystemPrompt(chatId),
        sessionId: existingSessionId || undefined,
        onProgress,
      },
      config.claude
    );

    // If resume failed (stale session or auth error), retry without session
    // DO NOT send error to user - silently retry
    const sessionErrors = ['no conversation found', 'invalid api key', 'session', 'resume'];
    const outputLower = (result.output || '').toLowerCase() + (result.error || '').toLowerCase();
    const isSessionError = sessionErrors.some(err => outputLower.includes(err));
    if (!result.success && existingSessionId && isSessionError) {
      console.log(`[resume] Session error for ${chatId}, retrying without resume:`, result.output?.slice(0, 100));
      sessionStore.clearSession(String(chatId));
      // 재시도 시 onProgress 제거하여 중복 메시지 방지
      result = await executeClaudeTask(
        {
          prompt: memoryPrefix + prompt,
          workdir: config.telegramBot.defaultWorkdir,
          systemPrompt: getSystemPrompt(chatId),
          // onProgress 제거 - 재시도에서는 progress 알림 없음
        },
        config.claude
      );
    }

    clearInterval(typingInterval);

    // Save session ID for future --resume
    if (result.sessionId) {
      sessionStore.setSession(String(chatId), result.sessionId);
    }

    logConversation(chatId, prompt, result);

    // Append to daily memory log (per-user)
    if (config.memory?.enabled) {
      try {
        const userMemDir = getUserMemoryDir(baseMemoryDir, chatId);
        appendDailyLog(userMemDir, prompt, result.output);
      } catch (err) {
        console.error('Failed to append daily log:', err);
      }
    }

    if (result.success) {
      await bot.sendMessage(chatId, result.output);
    } else {
      await bot.sendMessage(chatId, `오류: ${result.output}`);
    }
  }

  async function handleMessage(msg: TelegramMessage): Promise<void> {
    const chatId = msg.chat.id;
    const text = msg.text;
    const caption = msg.caption;
    const photo = msg.photo;

    if (!isAuthorized(chatId)) return;

    // Handle photo messages
    if (photo && photo.length > 0) {
      chatQueue.enqueue(chatId, async () => {
        // Get the largest photo (last in array)
        const largestPhoto = photo[photo.length - 1];
        const fileUrl = await bot.getFile(largestPhoto.file_id);

        if (!fileUrl) {
          await bot.sendMessage(chatId, '이미지를 가져오는 데 실패했어요 😢');
          return;
        }

        // Download image to local path
        const fileName = `${chatId}_${Date.now()}.jpg`;
        const localPath = path.join(imagesDir, fileName);
        const downloaded = await bot.downloadFile(fileUrl, localPath);

        if (!downloaded) {
          await bot.sendMessage(chatId, '이미지 다운로드에 실패했어요 😢');
          return;
        }

        // Build prompt with image reference
        const userPrompt = caption || '이 이미지를 분석해줘';
        const imagePrompt = `[이미지 분석 요청]
이미지 경로: ${localPath}
사용자 메시지: ${userPrompt}

위 경로의 이미지를 Read 도구로 읽어서 분석해줘.`;

        await handlePrompt(chatId, imagePrompt);
      });
      return;
    }

    if (!text) return;

    // Commands that are quick - run directly
    if (text === '/new' || text.startsWith('/new ')) {
      sessionStore.clearSession(String(chatId));
      await bot.sendMessage(chatId, '새 대화를 시작합니다.');
      return;
    }

    if (text === '/tasks' || text.startsWith('/tasks ')) {
      if (tasks.length === 0) {
        await bot.sendMessage(chatId, '등록된 태스크 없음');
        return;
      }
      const list = tasks
        .map((t) => `- ${t.id} [${t.cron}]: ${t.prompt.slice(0, 80)}...`)
        .join('\n');
      await bot.sendMessage(chatId, `등록된 태스크:\n${list}`);
      return;
    }

    if (text === '/status' || text.startsWith('/status ')) {
      const sessionId = sessionStore.getSession(String(chatId));
      const status = sessionId
        ? `활성 세션: ${sessionId.slice(0, 12)}...`
        : '활성 세션 없음';
      await bot.sendMessage(chatId, status);
      return;
    }

    if (text === '/alarms' || text.startsWith('/alarms ')) {
      const list = reminderMgr.list(chatId);
      if (list.length === 0) {
        await bot.sendMessage(chatId, '등록된 알람이 없어요.');
        return;
      }
      const lines = list.map((r, i) => {
        const icon = r.type === 'task' ? '🔄' : '⏰';
        return `${i + 1}. ${icon} ${formatTime(r.hour, r.minute)} - ${r.message}`;
      });
      await bot.sendMessage(chatId, `등록된 알람:\n${lines.join('\n')}`);
      return;
    }

    if (text.startsWith('/delalarm')) {
      const arg = text.replace(/^\/delalarm\s*/, '').trim();
      if (!arg) {
        await bot.sendMessage(chatId, '사용법: /delalarm <번호> (/alarms에서 확인)');
        return;
      }
      const ok = reminderMgr.remove(chatId, arg);
      await bot.sendMessage(chatId, ok ? '알람을 삭제했어요.' : '해당 알람을 찾지 못했어요.');
      return;
    }

    if (text === '/start') {
      await bot.sendMessage(chatId, 'Claude Cron Bot\n\n/ask <질문> - Claude에게 질문\n/alarm <시간+내용> - 알람 등록\n/alarms - 알람 목록\n/delalarm <번호> - 알람 삭제\n/run <task-id> - 태스크 실행\n/tasks - 태스크 목록\n/new - 새 대화\n/status - 세션 상태\n\n또는 그냥 메시지를 보내세요.');
      return;
    }

    // Commands that call Claude - enqueue per chatId
    chatQueue.enqueue(chatId, async () => {
      if (text.startsWith('/run')) {
        const taskId = text.replace(/^\/run\s*/, '').trim();
        if (!taskId) {
          await bot.sendMessage(chatId, '사용법: /run <task-id>');
          return;
        }
        const task = tasks.find((t) => t.id === taskId);
        if (!task) {
          const ids = tasks.map((t) => t.id).join(', ');
          await bot.sendMessage(chatId, `태스크 없음: ${taskId}\n등록된 태스크: ${ids}`);
          return;
        }
        await bot.sendMessage(chatId, `태스크 실행 중: ${taskId}`);
        const result = await executeClaudeTask(
          { prompt: task.prompt, workdir: task.workdir, timeout: task.timeout },
          config.claude
        );
        const status = result.success ? '[OK]' : '[ERROR]';
        await bot.sendMessage(chatId, `${status} ${taskId}\n${result.output}`);
        return;
      }

      if (text.startsWith('/ask')) {
        const prompt = text.replace(/^\/ask\s*/, '').trim();
        if (!prompt) {
          await bot.sendMessage(chatId, '사용법: /ask <질문>');
          return;
        }
        await handlePrompt(chatId, prompt);
        return;
      }

      if (!text.startsWith('/')) {
        await handlePrompt(chatId, text);
      }
    });
  }

  // Watch reminders.json for changes (Claude may edit it directly)
  const remindersFile = reminderMgr.getFilePath();
  const remindersWatcher = watch(remindersFile, { ignoreInitial: true });
  remindersWatcher.on('change', () => {
    reminderMgr.reload();
  });

  bot.startPolling(handleMessage);
  return bot;
}

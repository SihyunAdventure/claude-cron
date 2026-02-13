import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { executeTask, Provider } from './unified-executor.js';
import { SessionStore } from './session-store.js';
import { watch } from 'chokidar';
import { ReminderManager, formatTime } from './reminders.js';
import { initGoogleCalendar, authorizeWithCode, isCalendarReady } from './google-calendar.js';
import type { TaskDefinition } from './task-loader.js';
import type { Config } from './config.js';
import { ToolExecutor } from './tool-executor.js';

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
      console.log('[getUpdates] Polling... offset:', this.offset);
      const data = await this.apiGet(`getUpdates?offset=${this.offset}&timeout=30`);
      if (!data.ok) {
        console.error('[getUpdates] API error:', data.error_code, data.description);
        return [];
      }
      console.log(`[getUpdates] OK, received ${data.result.length} update(s)`);
      if (data.result.length > 0) {
        this.offset = data.result[data.result.length - 1].update_id + 1;
      }
      return data.result;
    } catch (err) {
      console.error('[getUpdates] Exception:', err);
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

// Provider selection per chat (in-memory, resets on restart)
class ProviderStore {
  private providers: Map<number, Provider> = new Map();

  get(chatId: number): Provider | undefined {
    return this.providers.get(chatId);
  }

  set(chatId: number, provider: Provider): void {
    this.providers.set(chatId, provider);
  }

  clear(chatId: number): void {
    this.providers.delete(chatId);
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

/**
 * 메모리 파일 내용을 읽어서 인라인 문자열로 반환합니다.
 * Codex API처럼 파일 읽기 도구가 없는 stateless 프로바이더용.
 */
function getInlinedMemoryContent(baseMemoryDir: string, chatId: number): string {
  const userDir = getUserMemoryDir(baseMemoryDir, chatId);
  const files: { path: string; label: string }[] = [
    { path: path.join(userDir, 'bot', 'IDENTITY.md'), label: '봇 정체성' },
    { path: path.join(userDir, 'user', 'USER.md'), label: '사용자 정보' },
    { path: path.join(userDir, 'user', 'MEMORY.md'), label: '중요 기억' },
  ];

  const sections: string[] = [];
  for (const file of files) {
    try {
      const text = fs.readFileSync(file.path, 'utf-8').trim();
      if (text) {
        sections.push(`[${file.label}]\n${text}`);
      }
    } catch {
      // 파일 없으면 무시
    }
  }

  return sections.join('\n\n');
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
  const providerStore = new ProviderStore();

  function isAuthorized(chatId: number): boolean {
    return allowedChatIds.has(String(chatId));
  }

  // Initialize reminder manager
  const reminderMgr = new ReminderManager(
    (chatId, text) => bot.sendMessage(chatId, text)
  );
  reminderMgr.setClaudeConfig(config.claude, config.telegramBot.defaultWorkdir);
  reminderMgr.setFullConfig(config, config.telegramBot.defaultWorkdir, baseMemoryDir);
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

  async function handlePrompt(chatId: number, prompt: string, options?: { forceProvider?: Provider; imagePath?: string }): Promise<void> {
    console.log(`[handlePrompt] Starting for chat ${chatId}`);

    const typingInterval = await sendTyping(chatId);

    // Initialize per-user memory
    if (config.memory?.enabled) {
      initUserMemory(baseMemoryDir, chatId);
    }

    // Get existing session for --resume
    const existingSessionId = sessionStore.getSession(String(chatId));
    const userMemDir = getUserMemoryDir(baseMemoryDir, chatId);
    const remindersPath = path.resolve(config.telegramBot.defaultWorkdir || '.', 'config', 'reminders.json');
    // 실효 프로바이더: 강제 지정 → 사용자 설정 → config 기본값 → claude
    const currentProvider = options?.forceProvider || providerStore.get(chatId) || config.defaultProvider || 'claude';

    // openai 프로바이더일 때 에이전트 모드용 ToolExecutor 생성
    let toolExecutor: ToolExecutor | undefined;
    if (currentProvider === 'openai' && config.memory?.enabled) {
      const workdir = config.telegramBot.defaultWorkdir || process.cwd();
      toolExecutor = new ToolExecutor([userMemDir, path.dirname(remindersPath), workdir]);
      toolExecutor.setWorkdir(workdir);
    }

    // 프로바이더별 memoryPrefix 분기
    // Claude: Read/Write 도구 사용 (기존 방식)
    // OpenAI 에이전트: 코어 파일 인라인 + 도구로 추가 읽기/쓰기 (하이브리드)
    const isAgent = currentProvider === 'openai' && toolExecutor;
    const readCmd = isAgent ? 'read_file' : 'Read';
    const writeCmd = isAgent ? 'write_file' : 'Write';
    const appendCmd = isAgent ? 'append_file' : 'append (Write)';

    // 에이전트 모드: 코어 메모리 파일을 미리 읽어서 인라인
    // → 첫 API 호출부터 성격/맥락이 반영됨 (에이전트 루프 1회 절약)
    // → 메모리 파일 수정하면 다음 대화부터 자동 반영 (하드코딩 아님)
    let inlinedMemory = '';
    if (isAgent && config.memory?.enabled) {
      inlinedMemory = getInlinedMemoryContent(baseMemoryDir, chatId);
    }

    const memoryPrefix = isAgent
      ? `${inlinedMemory ? `[현재 메모리]\n${inlinedMemory}\n\n` : ''}[메모리 시스템]
경로: ${userMemDir}
- 위 [현재 메모리]에 이미 코어 파일 내용이 포함되어 있으므로 다시 읽을 필요 없음
- 추가 정보 필요 시: ${userMemDir}/areas/work.md, ${userMemDir}/areas/health.md 등을 read_file로 읽기
- 사용자 정보 변경 → ${userMemDir}/user/USER.md를 write_file로 업데이트
- 기억 요청 → ${userMemDir}/user/MEMORY.md에 append_file로 추가 (덮어쓰기 금지)
- 봇 설정 → ${userMemDir}/bot/IDENTITY.md를 write_file로 업데이트
- 업무 → ${userMemDir}/areas/work.md, 건강 → ${userMemDir}/areas/health.md
[알림: ${remindersPath}] 알람 등록·수정·삭제 시 read_file로 읽고 write_file로 수정. 형식: [{"id":"r-타임스탬프","chatId":${chatId},"type":"message"|"task","message":"내용","hour":시,"minute":분,"cron":"분 시 * * *","createdAt":"ISO"}]

`
      : `[메모리 시스템]
경로: ${userMemDir}
- 대화 시작 시 다음 3개 파일을 Read하여 맥락 파악:
  1. ${userMemDir}/bot/IDENTITY.md
  2. ${userMemDir}/user/USER.md
  3. ${userMemDir}/user/MEMORY.md
- 사용자 정보 변경 → ${userMemDir}/user/USER.md를 Write로 업데이트
- 기억 요청 → ${userMemDir}/user/MEMORY.md에 append (Write)로 추가 (덮어쓰기 금지)
- 봇 설정 → ${userMemDir}/bot/IDENTITY.md를 Write로 업데이트
- 업무 → ${userMemDir}/areas/work.md, 건강 → ${userMemDir}/areas/health.md
[알림: ${remindersPath}] 알람 등록·수정·삭제 시 Read하고 Write로 수정. 형식: [{"id":"r-타임스탬프","chatId":${chatId},"type":"message"|"task","message":"내용","hour":시,"minute":분,"cron":"분 시 * * *","createdAt":"ISO"}]

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

    let result = await executeTask(
      {
        prompt: memoryPrefix + prompt,
        workdir: config.telegramBot.defaultWorkdir,
        systemPrompt: getSystemPrompt(chatId),
        sessionId: existingSessionId || undefined,
        onProgress,
        provider: currentProvider,
        toolExecutor,
        imagePath: options?.imagePath,
      },
      config
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
      result = await executeTask(
        {
          prompt: memoryPrefix + prompt,
          workdir: config.telegramBot.defaultWorkdir,
          systemPrompt: getSystemPrompt(chatId),
          provider: currentProvider,
          toolExecutor,
          // onProgress 제거 - 재시도에서는 progress 알림 없음
        },
        config
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

        // 프로바이더별 이미지 처리 분기
        const currentProvider = providerStore.get(chatId) || config.defaultProvider || 'claude';

        if (currentProvider === 'openai' && config.chatgptBrowser?.enabled) {
          // OpenAI: base64로 변환하여 gpt-4o 비전 모델로 직접 전송
          await handlePrompt(chatId, userPrompt, { imagePath: localPath });
        } else {
          // Claude: Read 도구로 로컬 이미지 파일을 직접 읽기
          const imagePrompt = `[이미지 분석 요청]
이미지 경로: ${localPath}
사용자 메시지: ${userPrompt}

위 경로의 이미지를 Read 도구로 읽어서 분석해줘.`;
          await handlePrompt(chatId, imagePrompt);
        }
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

    // /model 명령: provider 전환
    if (text === '/model' || text.startsWith('/model ')) {
      const arg = text.replace(/^\/model\s*/, '').trim().toLowerCase();

      if (!arg) {
        // 현재 상태 표시
        const current = providerStore.get(chatId) || config.defaultProvider || 'claude';
        const openaiStatus = config.openai?.enabled ? '활성화' : '비활성화';
        const gatewayNote = config.openclawGateway?.enabled ? ' (Gateway 활성화)' : '';
        await bot.sendMessage(chatId,
          `현재 모델: ${current}\n\n` +
          `사용 가능한 모델:\n` +
          `- claude: Claude CLI (기본)\n` +
          `- openai: ChatGPT (${openaiStatus})${gatewayNote}\n\n` +
          `전환: /model claude 또는 /model openai`
        );
        return;
      }

      if (arg === 'claude') {
        providerStore.set(chatId, 'claude');
        await bot.sendMessage(chatId, 'Claude로 전환했습니다.');
        return;
      }

      if (arg === 'openai' || arg === 'chatgpt' || arg === 'gpt') {
        if (!config.openai?.enabled && !config.openclawGateway?.enabled && !config.chatgptBrowser?.enabled) {
          await bot.sendMessage(chatId,
            'OpenAI가 비활성화 상태입니다.\n' +
            'config.yaml에서 chatgptBrowser.enabled, openai.enabled, 또는 openclawGateway.enabled를 true로 설정하세요.'
          );
          return;
        }
        providerStore.set(chatId, 'openai');
        const method = config.chatgptBrowser?.enabled ? 'Browser' :
          config.openclawGateway?.enabled ? 'Gateway' : 'Codex CLI';
        await bot.sendMessage(chatId, `ChatGPT (${method})로 전환했습니다.`);
        return;
      }

      await bot.sendMessage(chatId, '알 수 없는 모델입니다. claude 또는 openai를 입력하세요.');
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

    // /gcal 명령: Google Calendar 인증 및 상태 확인
    if (text === '/gcal' || text.startsWith('/gcal ')) {
      const arg = text.replace(/^\/gcal\s*/, '').trim();

      if (!arg) {
        // 상태 표시
        const ready = isCalendarReady();
        const status = ready ? '연결됨' : '미연결';
        let msg = `Google Calendar: ${status}\n\n`;
        if (!ready) {
          msg += '인증 방법:\n';
          msg += '1. /gcal auth - 인증 URL 생성\n';
          msg += '2. URL을 브라우저에서 열고 코드 복사\n';
          msg += '3. /gcal code <인증코드> - 코드 입력';
        }
        await bot.sendMessage(chatId, msg);
        return;
      }

      if (arg === 'auth') {
        // 인증 URL 생성/표시
        if (isCalendarReady()) {
          await bot.sendMessage(chatId, 'Google Calendar가 이미 연결되어 있습니다.');
          return;
        }
        try {
          const rawCredFile = config.googleCalendar?.credentialsFile || 'config/google-credentials.json';
          const credFile = path.isAbsolute(rawCredFile)
            ? rawCredFile
            : path.resolve(config.telegramBot.defaultWorkdir || '.', rawCredFile);
          const result = await initGoogleCalendar(credFile);
          if (result.ready) {
            await bot.sendMessage(chatId, 'Google Calendar가 이미 연결되어 있습니다.');
          } else if (result.authUrl) {
            await bot.sendMessage(chatId,
              '아래 URL을 브라우저에서 열어 인증하세요:\n\n' +
              result.authUrl + '\n\n' +
              '인증 후 받은 코드를 /gcal code <코드> 로 입력하세요.'
            );
          }
        } catch (err: any) {
          await bot.sendMessage(chatId, `Google Calendar 초기화 실패: ${err.message}`);
        }
        return;
      }

      if (arg.startsWith('code ')) {
        const code = arg.replace(/^code\s+/, '').trim();
        if (!code) {
          await bot.sendMessage(chatId, '사용법: /gcal code <인증코드>');
          return;
        }
        try {
          const success = await authorizeWithCode(code);
          if (success) {
            await bot.sendMessage(chatId, 'Google Calendar 연결 완료! 이제 일정을 관리할 수 있습니다.');
          } else {
            await bot.sendMessage(chatId, '인증에 실패했습니다. 코드가 올바른지 확인해주세요.');
          }
        } catch (err: any) {
          await bot.sendMessage(chatId, `인증 실패: ${err.message}`);
        }
        return;
      }

      await bot.sendMessage(chatId, '사용법:\n/gcal - 상태 확인\n/gcal auth - 인증 시작\n/gcal code <코드> - 인증 코드 입력');
      return;
    }

    if (text === '/start') {
      await bot.sendMessage(chatId, 'Claude Cron Bot\n\n/ask <질문> - Claude에게 질문\n/alarm <시간+내용> - 알람 등록\n/alarms - 알람 목록\n/delalarm <번호> - 알람 삭제\n/gcal - Google Calendar 연결\n/run <task-id> - 태스크 실행\n/tasks - 태스크 목록\n/new - 새 대화\n/status - 세션 상태\n/model - 모델 선택 (Claude/ChatGPT)\n\n또는 그냥 메시지를 보내세요.');
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
        const currentProvider = providerStore.get(chatId);
        const result = await executeTask(
          { prompt: task.prompt, workdir: task.workdir, timeout: task.timeout, provider: currentProvider },
          config
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

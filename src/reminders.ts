import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { executeClaudeTask } from './executor.js';
import type { ClaudeConfig } from './config.js';

export interface Reminder {
  id: string;
  chatId: number;
  type: 'message' | 'task';
  message: string;
  hour: number;
  minute: number;
  cron: string;
  workdir?: string;
  createdAt: string;
}

export interface ReminderParseResult {
  isReminder: boolean;
  type?: 'message' | 'task';
  hour?: number;
  minute?: number;
  message?: string;
}

const REMINDERS_FILE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'config',
  'reminders.json'
);

function loadReminders(): Reminder[] {
  try {
    if (fs.existsSync(REMINDERS_FILE)) {
      return JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf-8'));
    }
  } catch {
    // corrupted file
  }
  return [];
}

function saveReminders(reminders: Reminder[]): void {
  fs.writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2));
}

const PARSE_PROMPT = `사용자 메시지가 알람/리마인더/예약 작업 요청인지 판단해줘.

알람(message) 예시: "9시에 밥 먹었는지 물어봐", "매일 오후 3시에 운동 체크", "22시에 일기 쓰라고 알려줘"
예약 작업(task) 예시: "매일 9시에 git 상태 확인해줘", "오후 6시에 서버 로그 분석해줘", "8시에 뉴스 요약해줘"
일반 대화 예시: "오늘 날씨 어때?", "9시 뉴스 뭐 나왔어?", "3시에 회의 있었는데 어땠어?"

구분 기준:
- message: 단순 알림/리마인더 (미리 정해진 메시지만 보내면 되는 것)
- task: Claude가 뭔가 실행/분석/검색해야 하는 것

반드시 아래 JSON 형식으로만 답해. 다른 텍스트 없이 JSON만.
알람이면: {"isReminder":true,"type":"message","hour":9,"minute":0,"message":"밥 먹었는지 체크"}
예약 작업이면: {"isReminder":true,"type":"task","hour":9,"minute":0,"message":"git 상태 확인해서 리포트 만들어"}
둘 다 아니면: {"isReminder":false}

사용자 메시지: `;

export async function parseWithLLM(
  text: string,
  claudeConfig: ClaudeConfig
): Promise<ReminderParseResult> {
  try {
    const result = await executeClaudeTask(
      {
        prompt: PARSE_PROMPT + text,
        timeout: 30000,
        allowedTools: [],
      },
      { ...claudeConfig, outputFormat: 'text' }
    );

    if (!result.success) return { isReminder: false };

    const jsonMatch = result.output.match(/\{[^}]+\}/);
    if (!jsonMatch) return { isReminder: false };

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.isReminder) return { isReminder: false };

    const hour = Number(parsed.hour);
    const minute = Number(parsed.minute || 0);
    if (isNaN(hour) || hour < 0 || hour > 23) return { isReminder: false };

    return {
      isReminder: true,
      type: parsed.type === 'task' ? 'task' : 'message',
      hour,
      minute: Math.min(59, Math.max(0, minute)),
      message: parsed.message || '리마인더',
    };
  } catch {
    return { isReminder: false };
  }
}

export function formatTime(hour: number, minute: number): string {
  const h = hour.toString().padStart(2, '0');
  const m = minute.toString().padStart(2, '0');
  return `${h}:${m}`;
}

export class ReminderManager {
  private reminders: Reminder[];
  private scheduledJobs: Map<string, cron.ScheduledTask> = new Map();
  private sendFn: (chatId: number, text: string) => Promise<void>;
  private claudeConfig: ClaudeConfig | null = null;
  private defaultWorkdir: string | undefined;

  constructor(sendFn: (chatId: number, text: string) => Promise<void>) {
    this.sendFn = sendFn;
    this.reminders = loadReminders();
  }

  setClaudeConfig(config: ClaudeConfig, workdir?: string): void {
    this.claudeConfig = config;
    this.defaultWorkdir = workdir;
  }

  startAll(): void {
    for (const r of this.reminders) {
      this.scheduleJob(r);
    }
    if (this.reminders.length > 0) {
      console.log(`Started ${this.reminders.length} reminder(s)`);
    }
  }

  private scheduleJob(r: Reminder): void {
    const job = cron.schedule(r.cron, async () => {
      try {
        if (r.type === 'task' && this.claudeConfig) {
          const result = await executeClaudeTask(
            {
              prompt: r.message + '\n\n[주의: 마크다운 문법(**bold**, __italic__ 등) 사용 금지. 플레인 텍스트와 이모지만 사용하라.]',
              workdir: r.workdir || this.defaultWorkdir,
              timeout: 300000,
            },
            this.claudeConfig
          );
          await this.sendFn(r.chatId, result.output || '(결과 없음)');
        } else {
          await this.sendFn(r.chatId, `⏰ ${r.message}`);
        }
      } catch (err) {
        console.error(`Failed to execute reminder ${r.id}:`, err);
      }
    });
    this.scheduledJobs.set(r.id, job);
  }

  add(chatId: number, hour: number, minute: number, message: string, type: 'message' | 'task' = 'message', workdir?: string): Reminder {
    const id = `r-${Date.now()}`;
    const cronExpr = `${minute} ${hour} * * *`;
    const reminder: Reminder = {
      id,
      chatId,
      type,
      message,
      hour,
      minute,
      cron: cronExpr,
      workdir,
      createdAt: new Date().toISOString(),
    };
    this.reminders.push(reminder);
    saveReminders(this.reminders);
    this.scheduleJob(reminder);
    return reminder;
  }

  remove(chatId: number, idOrIndex: string): boolean {
    let idx = this.reminders.findIndex((r) => r.id === idOrIndex && r.chatId === chatId);
    if (idx === -1) {
      const num = parseInt(idOrIndex, 10);
      if (!isNaN(num)) {
        const chatReminders = this.reminders.filter((r) => r.chatId === chatId);
        if (num >= 1 && num <= chatReminders.length) {
          const target = chatReminders[num - 1];
          idx = this.reminders.indexOf(target);
        }
      }
    }
    if (idx === -1) return false;

    const removed = this.reminders[idx];
    const job = this.scheduledJobs.get(removed.id);
    if (job) {
      job.stop();
      this.scheduledJobs.delete(removed.id);
    }
    this.reminders.splice(idx, 1);
    saveReminders(this.reminders);
    return true;
  }

  list(chatId: number): Reminder[] {
    return this.reminders.filter((r) => r.chatId === chatId);
  }

  reload(): void {
    this.stopAll();
    this.reminders = loadReminders();
    this.startAll();
    console.log(`[Reminders] Reloaded ${this.reminders.length} reminder(s)`);
  }

  getFilePath(): string {
    return REMINDERS_FILE;
  }

  stopAll(): void {
    for (const [, job] of this.scheduledJobs) {
      job.stop();
    }
    this.scheduledJobs.clear();
  }
}

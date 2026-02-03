import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { NotificationsConfig } from './config.js';

const execAsync = promisify(exec);

const TELEGRAM_MAX_LENGTH = 4096;

export type NotifierConfig = NotificationsConfig;

export interface Notifier {
  send(channels: string[], message: string, taskId?: string): Promise<void>;
}

class NotifierImpl implements Notifier {
  private telegramToken?: string;
  private telegramChatId?: string;
  private slackWebhookUrl?: string;

  constructor(config: NotifierConfig) {
    if (config.telegram?.token && config.telegram?.chatId) {
      this.telegramToken = config.telegram.token;
      this.telegramChatId = config.telegram.chatId;
    }
    if (config.slack?.webhookUrl) {
      this.slackWebhookUrl = config.slack.webhookUrl;
    }
  }

  async send(channels: string[], message: string, taskId?: string): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const channel of channels) {
      if (channel === 'telegram' && this.telegramToken && this.telegramChatId) {
        promises.push(this.sendTelegram(message, taskId));
      } else if (channel === 'slack' && this.slackWebhookUrl) {
        promises.push(this.sendSlack(message, taskId));
      }
    }
    const results = await Promise.allSettled(promises);
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error(`[Notifier] Failed to send to ${channels[index]}:`, result.reason);
      }
    });
  }

  private async sendTelegram(message: string, taskId?: string): Promise<void> {
    if (!this.telegramToken || !this.telegramChatId) return;

    const prefix = taskId ? `*Task: ${taskId}*\n\n` : '';
    const fullMessage = prefix + message;
    const chunks = this.splitMessage(fullMessage, TELEGRAM_MAX_LENGTH);

    for (const chunk of chunks) {
      const url = `https://api.telegram.org/bot${this.telegramToken}/sendMessage`;
      const body = JSON.stringify({ chat_id: this.telegramChatId, text: chunk }).replace(/'/g, "'\\''");
      await execAsync(`curl -s -X POST '${url}' -H 'Content-Type: application/json' -d '${body}'`, { timeout: 15000 });
    }
  }

  private async sendSlack(message: string, taskId?: string): Promise<void> {
    if (!this.slackWebhookUrl) return;
    const text = taskId ? `*Task: ${taskId}*\n\n${message}` : message;
    const response = await fetch(this.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Slack webhook failed: ${response.status} ${body}`);
    }
  }

  private splitMessage(message: string, maxLength: number): string[] {
    if (message.length <= maxLength) return [message];
    const chunks: string[] = [];
    for (let i = 0; i < message.length; i += maxLength) {
      chunks.push(message.slice(i, i + maxLength));
    }
    return chunks;
  }
}

export function createNotifier(config: NotifierConfig): Notifier {
  return new NotifierImpl(config);
}

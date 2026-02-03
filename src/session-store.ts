import * as fs from 'fs';
import * as path from 'path';

interface SessionData {
  sessionId: string;
  lastUsed: number;
  createdAt: number;
}

interface SessionStoreOptions {
  dir: string;
  ttlHours: number;
}

export class SessionStore {
  private readonly dir: string;
  private readonly ttlMs: number;

  constructor(options: SessionStoreOptions) {
    this.dir = options.dir;
    this.ttlMs = options.ttlHours * 60 * 60 * 1000;

    // Ensure sessions directory exists
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  /**
   * Get the session file path for a chat ID
   */
  private getSessionFilePath(chatId: string): string {
    // Sanitize chatId to be filesystem-safe
    const sanitized = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dir, `${sanitized}.json`);
  }

  /**
   * Read session data from disk
   */
  private readSessionData(chatId: string): SessionData | null {
    const filePath = this.getSessionFilePath(chatId);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as SessionData;
    } catch (error) {
      // If file is corrupted, treat as missing
      console.error(`Failed to read session for ${chatId}:`, error);
      return null;
    }
  }

  /**
   * Write session data to disk
   */
  private writeSessionData(chatId: string, data: SessionData): void {
    const filePath = this.getSessionFilePath(chatId);

    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      console.error(`Failed to write session for ${chatId}:`, error);
      throw error;
    }
  }

  /**
   * Delete session file from disk
   */
  private deleteSessionFile(chatId: string): void {
    const filePath = this.getSessionFilePath(chatId);

    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        console.error(`Failed to delete session for ${chatId}:`, error);
      }
    }
  }

  /**
   * Check if a session is expired
   */
  private isExpired(data: SessionData): boolean {
    const now = Date.now();
    return (now - data.lastUsed) > this.ttlMs;
  }

  /**
   * Get active session ID for a chat, returns null if expired or missing
   */
  getSession(chatId: string): string | null {
    const data = this.readSessionData(chatId);

    if (!data) {
      return null;
    }

    if (this.isExpired(data)) {
      // Clean up expired session
      this.deleteSessionFile(chatId);
      return null;
    }

    return data.sessionId;
  }

  /**
   * Store or update session for a chat
   */
  setSession(chatId: string, sessionId: string): void {
    const now = Date.now();
    const existingData = this.readSessionData(chatId);

    const data: SessionData = {
      sessionId,
      lastUsed: now,
      createdAt: existingData?.createdAt ?? now,
    };

    this.writeSessionData(chatId, data);
  }

  /**
   * Delete session for a chat (for /new command)
   */
  clearSession(chatId: string): void {
    this.deleteSessionFile(chatId);
  }

  /**
   * Remove all expired sessions
   */
  cleanExpired(): void {
    if (!fs.existsSync(this.dir)) {
      return;
    }

    const files = fs.readdirSync(this.dir);
    let cleanedCount = 0;

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }

      const filePath = path.join(this.dir, file);

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(content) as SessionData;

        if (this.isExpired(data)) {
          fs.unlinkSync(filePath);
          cleanedCount++;
        }
      } catch (error) {
        // If file is corrupted, delete it
        console.error(`Removing corrupted session file ${file}:`, error);
        fs.unlinkSync(filePath);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`Cleaned ${cleanedCount} expired session(s)`);
    }
  }
}

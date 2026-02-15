import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type CodexAuthSyncStatus = 'synced' | 'skipped' | 'failed';

export interface CodexAuthSyncResult {
  status: CodexAuthSyncStatus;
  sourcePath: string;
  targetPath: string;
  reason: string;
}

export interface CodexAuthSyncOptions {
  sourcePath: string;
  targetPath: string;
}

function toAbsolutePath(value: string): string {
  if (value.startsWith('~')) {
    const home = os.homedir();
    return path.join(home, value.slice(1));
  }
  return path.resolve(value);
}

function normalizePath(value: string): string {
  return path.normalize(toAbsolutePath(value));
}

function parseRefreshAt(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return parsed;
}

function hasAuthPayload(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data === 'object' &&
    (typeof data.auth_mode === 'string' || typeof data.OPENAI_API_KEY === 'string' || typeof (data as { tokens?: unknown }).tokens === 'object')
  );
}

function readJsonFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

function safeReadJson(filePath: string): unknown | null {
  try {
    const parsed = readJsonFile(filePath);
    if (!hasAuthPayload(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function syncCodexAuth(options: CodexAuthSyncOptions): CodexAuthSyncResult {
  const source = normalizePath(options.sourcePath);
  const target = normalizePath(options.targetPath);

  if (!fs.existsSync(source)) {
    return { status: 'failed', sourcePath: source, targetPath: target, reason: 'source file not found' };
  }

  const sourceStat = fs.statSync(source);
  const sourceData = safeReadJson(source);
  if (!sourceData) {
    return { status: 'failed', sourcePath: source, targetPath: target, reason: 'source file is invalid or not an auth payload' };
  }

  let targetStat: fs.Stats | null = null;
  let targetData: unknown | null = null;
  if (fs.existsSync(target)) {
    try {
      targetStat = fs.statSync(target);
      targetData = safeReadJson(target);
    } catch {
      targetData = null;
    }
  }

  if (targetData && targetStat) {
    const targetHasRefresh = parseRefreshAt((targetData as { last_refresh?: unknown }).last_refresh);
    const sourceHasRefresh = parseRefreshAt((sourceData as { last_refresh?: unknown }).last_refresh);
    if (
      Number.isFinite(targetHasRefresh ?? NaN) &&
      Number.isFinite(sourceHasRefresh ?? NaN) &&
      (targetHasRefresh as number) >= (sourceHasRefresh as number)
    ) {
      return {
        status: 'skipped',
        sourcePath: source,
        targetPath: target,
        reason: 'target has newer or same auth refresh time',
      };
    }

    if (targetStat.mtimeMs >= sourceStat.mtimeMs) {
      return {
        status: 'skipped',
        sourcePath: source,
        targetPath: target,
        reason: 'target is newer than source',
      };
    }
  }

  try {
    const targetDir = path.dirname(target);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const sourceRaw = fs.readFileSync(source, 'utf-8');
    fs.writeFileSync(target, sourceRaw, 'utf-8');
    fs.chmodSync(target, 0o600);

    return {
      status: 'synced',
      sourcePath: source,
      targetPath: target,
      reason: `copied from source (${sourceStat.size} bytes)`,
    };
  } catch (error) {
    return {
      status: 'failed',
      sourcePath: source,
      targetPath: target,
      reason: `failed to sync: ${(error as Error).message}`,
    };
  }
}

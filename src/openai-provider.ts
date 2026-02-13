/**
 * OpenAI/Codex Provider for claude-cron
 * Uses Codex CLI as subprocess (same pattern as Claude CLI executor)
 * Codex CLI handles OAuth token management and API calls internally
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execAsync = promisify(exec);

export interface OpenAIConfig {
  enabled: boolean;
  model: string;
  maxTokens: number;
  binary?: string;       // codex binary path (default: codex)
  defaultTimeout?: number;
  apiKey?: string;
  useOAuth?: boolean;
}

export interface OpenAIExecutorOptions {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  workdir?: string;
  timeout?: number;
}

export interface OpenAIExecutionResult {
  output: string;
  success: boolean;
  error?: string;
  model: string;
}

function escapeShellArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Check if Codex CLI is authenticated (has ~/.codex/auth.json)
 */
export function isOpenAIAuthenticated(config: OpenAIConfig): boolean {
  const authFile = path.join(os.homedir(), '.codex', 'auth.json');
  try {
    if (fs.existsSync(authFile)) {
      const data = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
      if (data.tokens?.access_token || data.OPENAI_API_KEY) {
        return true;
      }
    }
  } catch {}
  return !!config.apiKey;
}

/**
 * Execute task using Codex CLI (subprocess)
 */
export async function executeOpenAITask(
  options: OpenAIExecutorOptions,
  config: OpenAIConfig
): Promise<OpenAIExecutionResult> {
  const binary = config.binary || 'codex';
  const model = options.model || config.model || 'gpt-5.3-codex-spark';
  const timeout = options.timeout || config.defaultTimeout || 300000;
  const tmpOutput = path.join(os.tmpdir(), `codex-out-${Date.now()}.txt`);

  // Prepend system prompt to user prompt if provided
  let fullPrompt = options.prompt;
  if (options.systemPrompt) {
    fullPrompt = `[시스템 지시사항]\n${options.systemPrompt}\n\n[사용자 메시지]\n${options.prompt}`;
  }

  // Build codex exec command
  let cmd = `${binary} exec`;
  cmd += ` -c model=${escapeShellArg(model)}`;
  cmd += ` --full-auto`;
  cmd += ` --skip-git-repo-check`;
  cmd += ` -o ${escapeShellArg(tmpOutput)}`;
  cmd += ` ${escapeShellArg(fullPrompt)}`;
  cmd += ` < /dev/null`;

  console.log('[codex] Starting Codex CLI...');
  console.log('[codex] Model:', model);
  console.log('[codex] Timeout:', timeout);
  console.log('[codex] Command preview:', cmd.slice(0, 200));

  try {
    await execAsync(cmd, {
      cwd: options.workdir || process.cwd(),
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        // Prevent nested session detection
        CLAUDECODE: undefined,
      },
    });

    // Read output from file
    let output = '';
    try {
      output = fs.readFileSync(tmpOutput, 'utf-8').trim();
    } catch {
      output = '응답을 읽지 못했습니다.';
    }

    // Cleanup temp file
    try { fs.unlinkSync(tmpOutput); } catch {}

    return {
      output: output || '(빈 응답)',
      success: true,
      model,
    };
  } catch (error: any) {
    // Try to read output even on error
    let output = '';
    try {
      output = fs.readFileSync(tmpOutput, 'utf-8').trim();
    } catch {}
    try { fs.unlinkSync(tmpOutput); } catch {}

    if (output) {
      return { output, success: true, model };
    }

    // Check stdout/stderr from error
    const stdout = (error.stdout || '').trim();
    if (stdout) {
      return { output: stdout, success: true, model };
    }

    console.error('[codex] Error:', error.message);
    console.error('[codex] Stderr:', error.stderr?.slice(0, 500));

    return {
      output: error.stderr || error.message || 'Codex CLI 오류',
      success: false,
      error: error.message,
      model,
    };
  }
}

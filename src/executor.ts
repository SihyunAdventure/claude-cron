import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ClaudeConfig } from './config.js';

const execAsync = promisify(exec);

export interface ExecutorOptions {
  prompt: string;
  workdir?: string;
  timeout?: number;
  sessionId?: string;
  allowedTools?: string[];
  systemPrompt?: string;
  onProgress?: (message: string) => void;
}

export interface ExecutionResult {
  output: string;
  sessionId: string;
  success: boolean;
  error?: string;
}

function escapeShellArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

export async function executeClaudeTask(
  options: ExecutorOptions,
  config: ClaudeConfig
): Promise<ExecutionResult> {
  const {
    prompt,
    workdir,
    timeout = config.defaultTimeout || 300000,
    sessionId,
    allowedTools = config.allowedTools || ['Bash', 'Read', 'Write', 'Glob', 'Grep'],
  } = options;

  let cmd = config.binary;

  if (sessionId) {
    cmd += ` --resume ${escapeShellArg(sessionId)}`;
  }

  if (options.systemPrompt) {
    cmd += ` --system-prompt ${escapeShellArg(options.systemPrompt)}`;
  }

  cmd += ` -p ${escapeShellArg(prompt)}`;
  cmd += ` --output-format ${config.outputFormat || 'json'}`;
  cmd += ` --allowedTools ${escapeShellArg(allowedTools.join(','))}`;

  if (config.extraArgs) {
    cmd += ` ${config.extraArgs.join(' ')}`;
  }

  cmd += ` < /dev/null`;

  console.log('[executor] Starting Claude CLI...');
  console.log('[executor] Workdir:', workdir);
  console.log('[executor] Timeout:', timeout);
  console.log('[executor] Command length:', cmd.length);
  console.log('[executor] Command preview:', cmd.slice(0, 200));

  try {
    const { stdout } = await execAsync(cmd, {
      cwd: workdir,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        // Claude Code 중첩 세션 방지 해제
        // 서버가 Claude Code 내에서 실행될 때도 CLI 호출 가능하도록
        CLAUDECODE: undefined,
        // Use default ~/.claude config (shares Max Plan login session)
        ...(process.env.CLAUDE_CRON_CONFIG_DIR && {
          CLAUDE_CONFIG_DIR: process.env.CLAUDE_CRON_CONFIG_DIR,
        }),
      },
    });

    let parsedOutput: any;
    let extractedSessionId = sessionId || '';

    try {
      parsedOutput = JSON.parse(stdout);
      if (parsedOutput.session_id) {
        extractedSessionId = parsedOutput.session_id;
      } else if (parsedOutput.sessionId) {
        extractedSessionId = parsedOutput.sessionId;
      }
    } catch {
      parsedOutput = { rawOutput: stdout };
    }

    const output =
      typeof parsedOutput === 'string'
        ? parsedOutput
        : parsedOutput.result || parsedOutput.rawOutput || JSON.stringify(parsedOutput, null, 2);

    return { output, sessionId: extractedSessionId, success: true };
  } catch (error: any) {
    const stdout = error.stdout || '';
    if (stdout.trim()) {
      try {
        const parsed = JSON.parse(stdout);
        const sid = parsed.session_id || parsed.sessionId || sessionId || '';
        const out = parsed.result || JSON.stringify(parsed, null, 2);
        const isError = parsed.is_error === true;
        return { output: out, sessionId: sid, success: !isError };
      } catch {
        // fall through
      }
    }
    console.error('[executor] Error:', error.message);
    console.error('[executor] Code:', error.code);
    console.error('[executor] Stderr:', error.stderr?.slice(0, 500));
    console.error('[executor] Cmd:', cmd.slice(0, 200));
    return {
      output: error.stderr || error.message || 'Unknown error',
      sessionId: sessionId || '',
      success: false,
      error: error.message,
    };
  }
}

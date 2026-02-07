import { spawn } from 'node:child_process';
import type { ClaudeConfig } from './config.js';

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

interface StreamEvent {
  type: string;
  name?: string;
  message?: string;
  content?: Array<{ type: string; text?: string }>;
  result?: string;
  session_id?: string;
  is_error?: boolean;
  subtype?: string;
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
    onProgress,
  } = options;

  const args: string[] = [];

  if (sessionId) {
    args.push('--resume', sessionId);
  }

  if (options.systemPrompt) {
    args.push('--system-prompt', options.systemPrompt);
  }

  args.push('-p', prompt);
  args.push('--output-format', 'stream-json');
  args.push('--verbose');
  args.push('--allowedTools', allowedTools.join(','));

  if (config.extraArgs) {
    args.push(...config.extraArgs);
  }

  return new Promise((resolve) => {
    const child = spawn(config.binary, args, {
      cwd: workdir,
      env: {
        ...process.env,
        ...(process.env.CLAUDE_CRON_CONFIG_DIR && {
          CLAUDE_CONFIG_DIR: process.env.CLAUDE_CRON_CONFIG_DIR,
        }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Close stdin immediately
    child.stdin.end();

    let finalResult = '';
    let extractedSessionId = sessionId || '';
    let isError = false;
    let lastAssistantMessage = '';
    let buffer = '';

    const timeoutId = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        output: 'Timeout: 작업이 시간 내에 완료되지 않았습니다.',
        sessionId: extractedSessionId,
        success: false,
        error: 'Timeout',
      });
    }, timeout);

    child.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();

      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const event: StreamEvent = JSON.parse(line);

          // Extract session ID
          if (event.session_id) {
            extractedSessionId = event.session_id;
          }

          // Handle different event types
          switch (event.type) {
            case 'assistant':
              // Save assistant message for final result (don't send as progress to avoid duplicates)
              if (event.message) {
                lastAssistantMessage = event.message;
              }
              if (event.content) {
                for (const block of event.content) {
                  if (block.type === 'text' && block.text) {
                    lastAssistantMessage = block.text;
                  }
                }
              }
              break;

            case 'tool_use':
              // Notify when important tools are being used
              if (onProgress && event.name) {
                const toolNames: Record<string, string> = {
                  'Read': '📖 파일 읽는 중...',
                  'Write': '✏️ 파일 작성 중...',
                  'Edit': '✏️ 파일 수정 중...',
                  'Bash': '⚙️ 명령 실행 중...',
                  'Glob': '🔍 파일 검색 중...',
                  'Grep': '🔍 내용 검색 중...',
                };
                const msg = toolNames[event.name];
                if (msg) {
                  onProgress(msg);
                }
              }
              break;

            case 'result':
              // Final result
              finalResult = event.result || lastAssistantMessage || '';
              isError = event.is_error === true;
              if (event.subtype === 'error_tool_use') {
                isError = true;
              }
              break;

            case 'error':
              isError = true;
              finalResult = event.message || 'Unknown error';
              break;
          }
        } catch {
          // Not JSON, might be raw output or error
          if (line.includes('Invalid API key') || line.includes('No conversation found')) {
            // Session/auth error - will be handled by retry logic
            isError = true;
            finalResult = line;
          }
        }
      }
    });

    let stderrOutput = '';
    child.stderr.on('data', (data: Buffer) => {
      stderrOutput += data.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timeoutId);

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event: StreamEvent = JSON.parse(buffer);
          if (event.result) {
            finalResult = event.result;
          }
          if (event.session_id) {
            extractedSessionId = event.session_id;
          }
          if (event.is_error) {
            isError = true;
          }
        } catch {
          // Ignore parse errors for incomplete data
        }
      }

      // If no result but we have assistant message, use that
      if (!finalResult && lastAssistantMessage) {
        finalResult = lastAssistantMessage;
      }

      // Handle errors
      if (code !== 0 && !finalResult) {
        finalResult = stderrOutput || `Process exited with code ${code}`;
        isError = true;
      }

      resolve({
        output: finalResult || 'No response',
        sessionId: extractedSessionId,
        success: !isError && code === 0,
        error: isError ? (stderrOutput || finalResult) : undefined,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeoutId);
      resolve({
        output: err.message,
        sessionId: extractedSessionId,
        success: false,
        error: err.message,
      });
    });
  });
}

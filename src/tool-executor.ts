import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  isCalendarReady,
  listEvents,
  createEvent,
  deleteEvent,
} from './google-calendar.js';

const execAsync = promisify(exec);

/**
 * OpenAI Responses API 형식의 도구 정의
 */
export interface ToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, any>;
  strict?: boolean;
}

/**
 * 도구 호출 결과
 */
export interface ToolCallResult {
  call_id: string;
  output: string; // JSON 문자열 형식의 결과
}

/**
 * ChatGPT Browser 에이전트 모드용 도구 정의 및 실행 엔진
 */
export class ToolExecutor {
  private workdir: string | undefined;

  constructor(
    private allowedPaths: string[], // 허용된 기본 경로 배열
    private maxReadSize: number = 10240, // 최대 읽기 크기 (10KB)
    private maxWriteSize: number = 5120, // 최대 쓰기 크기 (5KB)
  ) {}

  /** Bash 실행 시 사용할 작업 디렉토리 설정 */
  setWorkdir(dir: string): void {
    this.workdir = dir;
  }

  /**
   * API 요청에 사용할 도구 정의 반환
   */
  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        type: 'function' as const,
        name: 'read_file',
        description: '파일의 내용을 읽습니다.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '읽을 파일의 경로',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        type: 'function' as const,
        name: 'write_file',
        description: '파일의 내용을 덮어씁니다.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '쓸 파일의 경로',
            },
            content: {
              type: 'string',
              description: '파일에 쓸 내용',
            },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        type: 'function' as const,
        name: 'append_file',
        description: '파일 끝에 내용을 추가합니다.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '내용을 추가할 파일의 경로',
            },
            content: {
              type: 'string',
              description: '추가할 내용',
            },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        type: 'function' as const,
        name: 'list_dir',
        description: '디렉토리의 내용을 나열합니다.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '나열할 디렉토리의 경로',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        type: 'function' as const,
        name: 'read_json',
        description: 'JSON 파일을 읽고 파싱합니다.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '읽을 JSON 파일의 경로',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        type: 'function' as const,
        name: 'bash',
        description: '셸 명령어를 실행합니다. curl, yt-dlp, grep, jq 등 시스템 명령어를 사용할 수 있습니다.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: '실행할 셸 명령어',
            },
          },
          required: ['command'],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        type: 'function' as const,
        name: 'web_search',
        description: '웹 검색을 수행합니다. 날씨, 뉴스, 정보 검색 등에 사용합니다.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '검색 쿼리',
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        type: 'function' as const,
        name: 'search_files',
        description: '허용된 디렉토리 내 파일들에서 텍스트를 검색합니다. grep과 유사하게 동작합니다.',
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: '검색할 텍스트 또는 정규표현식 패턴',
            },
            file_glob: {
              type: 'string',
              description: '검색 대상 파일 패턴 (예: "*.md", "*.json"). 기본값: "*"',
            },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
        strict: false,
      },
      // Google Calendar 도구 (연결 시에만 활성화)
      ...(isCalendarReady() ? [
        {
          type: 'function' as const,
          name: 'calendar_list_events',
          description: 'Google Calendar에서 다가오는 일정을 조회합니다.',
          parameters: {
            type: 'object',
            properties: {
              max_results: {
                type: 'number',
                description: '최대 조회 개수 (기본: 10)',
              },
              time_min: {
                type: 'string',
                description: '조회 시작 시간 (ISO 8601). 기본: 현재 시간',
              },
              time_max: {
                type: 'string',
                description: '조회 종료 시간 (ISO 8601). 예: "2026-02-15T23:59:59+09:00"',
              },
            },
            required: [],
            additionalProperties: false,
          },
          strict: false,
        },
        {
          type: 'function' as const,
          name: 'calendar_create_event',
          description: 'Google Calendar에 새 일정을 생성합니다.',
          parameters: {
            type: 'object',
            properties: {
              summary: {
                type: 'string',
                description: '일정 제목',
              },
              start: {
                type: 'string',
                description: '시작 시간. 종일: "2026-02-14", 시간지정: "2026-02-14T10:00:00+09:00"',
              },
              end: {
                type: 'string',
                description: '종료 시간 (선택). 미지정 시 1시간 후',
              },
              description: {
                type: 'string',
                description: '일정 설명 (선택)',
              },
              location: {
                type: 'string',
                description: '장소 (선택)',
              },
            },
            required: ['summary', 'start'],
            additionalProperties: false,
          },
          strict: false,
        },
        {
          type: 'function' as const,
          name: 'calendar_delete_event',
          description: 'Google Calendar에서 일정을 삭제합니다.',
          parameters: {
            type: 'object',
            properties: {
              event_id: {
                type: 'string',
                description: '삭제할 일정의 ID (calendar_list_events로 조회 가능)',
              },
            },
            required: ['event_id'],
            additionalProperties: false,
          },
          strict: false,
        },
      ] : []),
    ];
  }

  /**
   * 도구 호출을 실행하고 결과를 반환
   */
  async execute(
    name: string,
    args: Record<string, any>,
    callId: string,
  ): Promise<ToolCallResult> {
    try {
      let result: any;

      switch (name) {
        case 'read_file':
          result = await this.readFile(args.path);
          break;
        case 'write_file':
          result = await this.writeFile(args.path, args.content);
          break;
        case 'append_file':
          result = await this.appendFile(args.path, args.content);
          break;
        case 'list_dir':
          result = await this.listDir(args.path);
          break;
        case 'read_json':
          result = await this.readJson(args.path);
          break;
        case 'bash':
          result = await this.executeBash(args.command);
          break;
        case 'web_search':
          result = await this.webSearch(args.query);
          break;
        case 'search_files':
          result = await this.searchFiles(args.pattern, args.file_glob);
          break;
        case 'calendar_list_events':
          result = await listEvents(args.max_results, args.time_min, args.time_max);
          break;
        case 'calendar_create_event':
          result = await createEvent({
            summary: args.summary,
            start: args.start,
            end: args.end,
            description: args.description,
            location: args.location,
          });
          break;
        case 'calendar_delete_event':
          result = await deleteEvent(args.event_id);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        call_id: callId,
        output: JSON.stringify({ success: true, result }),
      };
    } catch (error) {
      return {
        call_id: callId,
        output: JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  }

  /**
   * 경로가 허용된 디렉토리 내에 있는지 검증
   *
   * 상대 경로가 들어오면 허용된 경로들을 기준으로 해석을 시도합니다.
   * 예: "user/USER.md" → allowedPaths[0] + "/user/USER.md"
   */
  private validatePath(requestedPath: string): string {
    // '..' 포함 여부 확인
    if (requestedPath.includes('..')) {
      throw new Error(`경로에 '..'를 포함할 수 없습니다: ${requestedPath}`);
    }

    // 절대 경로인 경우 바로 검증
    if (path.isAbsolute(requestedPath)) {
      const absolutePath = path.resolve(requestedPath);
      const isAllowed = this.allowedPaths.some((allowedPath) => {
        const resolvedAllowed = path.resolve(allowedPath);
        return absolutePath.startsWith(resolvedAllowed);
      });

      if (!isAllowed) {
        throw new Error(
          `경로가 허용된 디렉토리 내에 없습니다: ${absolutePath}`,
        );
      }
      return absolutePath;
    }

    // 상대 경로: 각 allowedPath를 기준으로 해석 시도
    for (const allowedPath of this.allowedPaths) {
      const resolvedAllowed = path.resolve(allowedPath);
      const candidate = path.join(resolvedAllowed, requestedPath);

      // 후보 경로가 허용된 경로 내에 있는지 확인
      if (candidate.startsWith(resolvedAllowed)) {
        // 파일/디렉토리가 실제로 존재하면 반환
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }

    // 어떤 allowedPath에서도 해석 불가
    throw new Error(
      `경로를 해석할 수 없습니다: ${requestedPath} (허용 경로: ${this.allowedPaths.join(', ')})`,
    );
  }

  /**
   * 파일 읽기
   */
  private async readFile(filePath: string): Promise<string> {
    const validPath = this.validatePath(filePath);
    const stats = fs.statSync(validPath);

    if (stats.size > this.maxReadSize) {
      throw new Error(
        `파일 크기가 최대 읽기 크기를 초과합니다: ${stats.size} > ${this.maxReadSize}`,
      );
    }

    return fs.readFileSync(validPath, 'utf-8');
  }

  /**
   * 파일 쓰기
   */
  private async writeFile(filePath: string, content: string): Promise<string> {
    const validPath = this.validatePath(filePath);

    if (content.length > this.maxWriteSize) {
      throw new Error(
        `내용 크기가 최대 쓰기 크기를 초과합니다: ${content.length} > ${this.maxWriteSize}`,
      );
    }

    const dir = path.dirname(validPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(validPath, content, 'utf-8');

    return `파일 작성 완료: ${validPath}`;
  }

  /**
   * 파일에 내용 추가
   */
  private async appendFile(
    filePath: string,
    content: string,
  ): Promise<string> {
    const validPath = this.validatePath(filePath);

    if (content.length > this.maxWriteSize) {
      throw new Error(
        `내용 크기가 최대 쓰기 크기를 초과합니다: ${content.length} > ${this.maxWriteSize}`,
      );
    }

    const dir = path.dirname(validPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(validPath, content, 'utf-8');

    return `파일에 내용 추가 완료: ${validPath}`;
  }

  /**
   * 디렉토리 내용 나열
   */
  private async listDir(
    dirPath: string,
  ): Promise<Array<{ name: string; type: 'file' | 'dir' }>> {
    const validPath = this.validatePath(dirPath);
    const entries = fs.readdirSync(validPath, { withFileTypes: true });

    return entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'dir' : 'file',
    }));
  }

  /**
   * JSON 파일 읽기
   */
  private async readJson(filePath: string): Promise<any> {
    const content = await this.readFile(filePath);
    return JSON.parse(content);
  }

  /**
   * JSON 파일 쓰기
   */
  private async writeJson(filePath: string, data: any): Promise<string> {
    const content = JSON.stringify(data, null, 2);
    return this.writeFile(filePath, content);
  }

  /**
   * 웹 검색 (DuckDuckGo lite, API 키 불필요)
   */
  private async webSearch(query: string): Promise<string> {
    const MAX_TIMEOUT = 15000;
    try {
      // DuckDuckGo HTML lite 버전으로 검색 → 텍스트 결과 추출
      const encoded = encodeURIComponent(query);
      const { stdout } = await execAsync(
        `curl -sL "https://lite.duckduckgo.com/lite/?q=${encoded}" | sed 's/<[^>]*>//g' | sed '/^$/d' | head -80`,
        { timeout: MAX_TIMEOUT, maxBuffer: 50 * 1024 },
      );
      return stdout.trim() || '(검색 결과 없음)';
    } catch (err: any) {
      // fallback: ddgs CLI (pip install duckduckgo-search)
      try {
        const { stdout } = await execAsync(
          `ddgs text -k "${query.replace(/"/g, '\\"')}" -m 5 2>/dev/null`,
          { timeout: MAX_TIMEOUT, maxBuffer: 50 * 1024 },
        );
        return stdout.trim() || '(검색 결과 없음)';
      } catch {
        return `검색 실패: ${err.message}`;
      }
    }
  }

  /**
   * 파일 검색 (허용된 디렉토리 내)
   */
  private async searchFiles(pattern: string, fileGlob?: string): Promise<string> {
    const MAX_TIMEOUT = 10000;
    const results: string[] = [];

    for (const basePath of this.allowedPaths) {
      if (!basePath || !fs.existsSync(basePath)) continue;

      const glob = fileGlob || '*';
      try {
        const { stdout } = await execAsync(
          `grep -rl --include="${glob}" "${pattern.replace(/"/g, '\\"')}" "${basePath}" 2>/dev/null | head -20`,
          { timeout: MAX_TIMEOUT, maxBuffer: 50 * 1024 },
        );
        if (stdout.trim()) {
          // 파일 경로와 매칭 라인을 함께 반환
          const files = stdout.trim().split('\n');
          for (const file of files.slice(0, 10)) {
            try {
              const { stdout: matchLines } = await execAsync(
                `grep -n "${pattern.replace(/"/g, '\\"')}" "${file}" | head -5`,
                { timeout: 5000, maxBuffer: 10 * 1024 },
              );
              results.push(`📄 ${file}\n${matchLines.trim()}`);
            } catch {
              results.push(`📄 ${file}`);
            }
          }
        }
      } catch {
        // 검색 실패 무시
      }
    }

    return results.length > 0
      ? results.join('\n\n')
      : `"${pattern}" 패턴을 찾지 못했습니다.`;
  }

  /**
   * 셸 명령어 실행
   * - 타임아웃: 30초
   * - 최대 출력: 50KB
   * - CLAUDECODE 환경변수 제거 (중첩 세션 방지)
   */
  private async executeBash(command: string): Promise<string> {
    const MAX_TIMEOUT = 30000;
    const MAX_OUTPUT = 50 * 1024; // 50KB

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.workdir || process.cwd(),
        timeout: MAX_TIMEOUT,
        maxBuffer: MAX_OUTPUT,
        env: {
          ...process.env,
          CLAUDECODE: undefined, // 중첩 세션 방지
        },
      });

      const output = stdout || stderr || '(출력 없음)';
      // 출력이 너무 길면 잘라서 반환
      if (output.length > MAX_OUTPUT) {
        return output.slice(0, MAX_OUTPUT) + '\n...(출력 잘림)';
      }
      return output;
    } catch (err: any) {
      // 명령어 실패해도 stdout/stderr 반환 (exit code > 0)
      const output = err.stdout || err.stderr || err.message;
      return `[exit code: ${err.code || 'unknown'}]\n${output}`;
    }
  }
}

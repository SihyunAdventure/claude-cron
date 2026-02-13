import fs from 'node:fs';
import path from 'node:path';

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
  constructor(
    private allowedPaths: string[], // 허용된 기본 경로 배열
    private maxReadSize: number = 10240, // 최대 읽기 크기 (10KB)
    private maxWriteSize: number = 5120, // 최대 쓰기 크기 (5KB)
  ) {}

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
}

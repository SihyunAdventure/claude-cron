/**
 * ChatGPT Browser Client
 *
 * Browser Service + Auth를 결합한 고수준 ChatGPT API 클라이언트.
 * Playwright로 실행된 Chrome 내에서 fetch()를 호출하여
 * Cloudflare를 자연스럽게 우회합니다.
 *
 * 검증된 API 스펙:
 * - Endpoint: https://chatgpt.com/backend-api/codex/responses
 * - Method: POST, SSE 스트리밍 (stream: true 필수)
 * - Body: { model, instructions, input: [{role, content}], stream: true, store: false }
 * - Headers: Authorization, User-Agent: CodexBar, ChatGPT-Account-Id
 * - sentinel/chat-requirements 토큰 필요
 *
 * 에이전트 모드: tools 파라미터로 도구 호출 지원
 * - sendMessage()에 toolExecutor 옵션 전달 시 에이전트 루프 활성화
 * - 모델이 function_call → 로컬 도구 실행 → 결과 반환 → 반복
 *
 * 인터페이스: sendMessage(message) → { text, durationMs, model }
 */

import fs from 'node:fs';
import path from 'node:path';
import { BrowserService, type BrowserServiceOptions, type FetchResult } from './browser-service.js';
import { getValidTokens, hasAuthTokens, type AuthTokens } from './chatgpt-auth.js';
import { ToolExecutor, type ToolDefinition } from './tool-executor.js';
import type { SSEEvent, SSEStructuredResult } from './browser-service.js';

const BASE_URL = 'https://chatgpt.com/backend-api';
const CODEX_RESPONSES_URL = `${BASE_URL}/codex/responses`;
const CHAT_REQUIREMENTS_URL = `${BASE_URL}/sentinel/chat-requirements`;

export interface ChatGPTBrowserConfig {
  enabled: boolean;
  model?: string;
  visionModel?: string; // 이미지 처리용 비전 모델 (기본: gpt-4.1-mini)
  timeout?: number;
  headless?: boolean;
  cdpPort?: number;
}

export interface ChatGPTBrowserResult {
  text: string;
  durationMs: number;
  model?: string;
}

export class ChatGPTBrowserClient {
  private browserService: BrowserService;
  private config: ChatGPTBrowserConfig;
  private stopped = false;

  constructor(config: ChatGPTBrowserConfig) {
    this.config = config;
    this.browserService = new BrowserService({
      headless: config.headless ?? true,
      cdpPort: config.cdpPort,
    });
  }

  async start(): Promise<void> {
    if (!hasAuthTokens()) {
      console.warn('[chatgpt-browser] OAuth 토큰이 없습니다. ~/.codex/auth.json을 확인하세요.');
      return;
    }
    this.stopped = false;
    await this.browserService.start();
    console.log('[chatgpt-browser] ChatGPT Browser Client 시작 완료');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.browserService.stop();
    console.log('[chatgpt-browser] ChatGPT Browser Client 종료');
  }

  isReady(): boolean {
    return this.browserService.isReady() && hasAuthTokens();
  }

  /**
   * ChatGPT에 메시지를 전송하고 응답을 받습니다.
   */
  async sendMessage(
    message: string,
    options?: {
      model?: string;
      timeout?: number;
      systemPrompt?: string;
      toolExecutor?: ToolExecutor;
      imagePath?: string; // 이미지 포함 시 로컬 파일 경로
    }
  ): Promise<ChatGPTBrowserResult> {
    const start = Date.now();
    let model = options?.model || this.config.model || 'gpt-5.3-codex-spark';

    // 이미지가 있으면 비전 모델로 자동 전환
    let imageBase64: string | undefined;
    let imageMimeType: string | undefined;
    if (options?.imagePath) {
      const visionModel = this.config.visionModel || 'gpt-5.1';
      console.log(`[chatgpt-browser] 이미지 감지 → 모델 전환: ${model} → ${visionModel}`);
      model = visionModel;

      // 이미지를 base64로 변환
      const imageBuffer = fs.readFileSync(options.imagePath);
      const ext = path.extname(options.imagePath).slice(1) || 'jpeg';
      imageMimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
      imageBase64 = imageBuffer.toString('base64');
      console.log(`[chatgpt-browser] 이미지: ${options.imagePath} (${imageBuffer.length} bytes)`);
    }

    if (!this.browserService.isReady()) {
      await this.browserService.start();
    }

    const tokens = await getValidTokens();
    if (!tokens) {
      throw new Error('유효한 OAuth 토큰을 얻을 수 없습니다');
    }

    try {
      if (options?.toolExecutor || imageBase64) {
        // 에이전트 루프: 도구 사용 또는 이미지 포함 요청 모두 여기서 처리
        return await this.doAgentRequest(message, model, tokens, start, options?.systemPrompt, options?.toolExecutor, imageBase64, imageMimeType);
      }
      return await this.doRequest(message, model, tokens, start, options?.systemPrompt);
    } catch (err: any) {
      return await this.handleErrorAndRetry(err, message, model, tokens, start, options?.systemPrompt, options?.toolExecutor);
    }
  }

  // --- Private Methods ---

  /**
   * sentinel/chat-requirements 토큰을 획득합니다.
   */
  private async getSentinelToken(tokens: AuthTokens): Promise<string | null> {
    try {
      const result = await this.browserService.evaluateFetch(CHAT_REQUIREMENTS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokens.accessToken}`,
          'User-Agent': 'CodexBar',
          'ChatGPT-Account-Id': tokens.accountId,
        },
        body: '{}',
      });

      if (result.status === 200) {
        const data = JSON.parse(result.body);
        return data.token || null;
      }
      console.warn(`[chatgpt-browser] sentinel 실패 (${result.status})`);
      return null;
    } catch (err: any) {
      console.warn('[chatgpt-browser] sentinel 에러:', err.message);
      return null;
    }
  }

  /**
   * ChatGPT Codex Responses API에 SSE 스트리밍 요청을 보냅니다.
   *
   * 검증된 스펙:
   * - URL: /backend-api/codex/responses
   * - stream: true (필수), store: false (필수)
   * - input: [{role: "user", content: "..."}] (배열 필수)
   * - instructions: 시스템 프롬프트 (필수)
   * - SSE 이벤트에서 response.output_text.done의 text 추출
   */
  private async doRequest(
    message: string,
    model: string,
    tokens: AuthTokens,
    startTime: number,
    systemPrompt?: string
  ): Promise<ChatGPTBrowserResult> {
    const sentinelToken = await this.getSentinelToken(tokens);

    const requestBody = JSON.stringify({
      model,
      instructions: systemPrompt || 'You are a helpful assistant.',
      input: [
        { role: 'user', content: message },
      ],
      stream: true,
      store: false,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokens.accessToken}`,
      'User-Agent': 'CodexBar',
      'Accept': 'text/event-stream',
      'ChatGPT-Account-Id': tokens.accountId,
    };

    if (sentinelToken) {
      headers['openai-sentinel-chat-requirements-token'] = sentinelToken;
    }

    console.log(`[chatgpt-browser] 요청: model=${model}, msg=${message.slice(0, 60)}...`);
    console.log(`[chatgpt-browser] instructions: ${systemPrompt ? systemPrompt.slice(0, 80) + '...' : '(기본값)'} (${systemPrompt?.length || 0}자)`);

    // SSE 스트리밍 fetch는 evaluateFetch 대신 브라우저 내에서 직접 스트림 수집
    const result = await this.browserService.evaluateSSE(
      CODEX_RESPONSES_URL,
      { method: 'POST', headers, body: requestBody }
    );

    const durationMs = Date.now() - startTime;

    // HTTP 에러 처리
    if (result.status !== 200) {
      this.throwHttpError(result);
    }

    // SSE에서 텍스트 추출
    const text = this.extractFromSSE(result.body);
    console.log(`[chatgpt-browser] 응답: ${durationMs}ms, ${text.length}자`);

    return { text, durationMs, model };
  }

  /**
   * 에이전트 루프: tools 포함 요청 → function_call 감지 → 도구 실행 → 결과 반환 → 반복
   * 최대 MAX_AGENT_ITERATIONS 회까지 반복, 텍스트 응답 수신 시 종료.
   */
  private async doAgentRequest(
    message: string,
    model: string,
    tokens: AuthTokens,
    startTime: number,
    systemPrompt?: string,
    toolExecutor?: ToolExecutor,
    imageBase64?: string,
    imageMimeType?: string,
  ): Promise<ChatGPTBrowserResult> {
    const MAX_AGENT_ITERATIONS = 30;
    const sentinelToken = await this.getSentinelToken(tokens);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokens.accessToken}`,
      'User-Agent': 'CodexBar',
      'Accept': 'text/event-stream',
      'ChatGPT-Account-Id': tokens.accountId,
    };
    if (sentinelToken) {
      headers['openai-sentinel-chat-requirements-token'] = sentinelToken;
    }

    // 첫 번째 메시지: 이미지가 있으면 content parts 배열, 없으면 plain string
    let firstMessage: any;
    if (imageBase64 && imageMimeType) {
      firstMessage = {
        role: 'user',
        content: [
          { type: 'input_text', text: message },
          { type: 'input_image', image_url: `data:${imageMimeType};base64,${imageBase64}` },
        ],
      };
      console.log(`[chatgpt-browser] 이미지 포함 요청 (${imageMimeType}, base64 ${imageBase64.length}자)`);
    } else {
      firstMessage = { role: 'user', content: message };
    }

    // Conversation items accumulate across iterations
    const conversationItems: any[] = [firstMessage];

    const toolDefs = toolExecutor?.getToolDefinitions() || [];

    for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration++) {
      console.log(`[chatgpt-browser] 에이전트 루프 #${iteration + 1}, items=${conversationItems.length}`);

      const requestBody = JSON.stringify({
        model,
        instructions: systemPrompt || 'You are a helpful assistant.',
        input: conversationItems,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        stream: true,
        store: false,
      });

      const result = await this.browserService.evaluateSSEStructured(
        CODEX_RESPONSES_URL,
        { method: 'POST', headers, body: requestBody }
      );

      // HTTP error
      if (result.status !== 200) {
        this.throwHttpError({ status: result.status, body: result.rawBody });
      }

      // Extract function calls and text from events
      const functionCalls = result.events.filter(
        (e) => e.type === 'response.output_item.done' && e.data.item?.type === 'function_call'
      );
      const textDone = result.events.find(
        (e) => e.type === 'response.output_text.done'
      );

      // If there are function calls, execute them and continue the loop
      if (functionCalls.length > 0) {
        for (const fc of functionCalls) {
          const item = fc.data.item;
          const callId = item.call_id;
          const toolName = item.name;
          const toolArgs = JSON.parse(item.arguments || '{}');

          console.log(`[chatgpt-browser] 도구 호출: ${toolName}(${JSON.stringify(toolArgs).slice(0, 100)})`);

          // Execute the tool
          const toolResult = await toolExecutor!.execute(toolName, toolArgs, callId);
          console.log(`[chatgpt-browser] 도구 결과: ${toolResult.output.slice(0, 100)}...`);

          // Add function_call + function_call_output to conversation
          conversationItems.push({
            type: 'function_call',
            call_id: callId,
            name: toolName,
            arguments: item.arguments || '{}',
          });
          conversationItems.push({
            type: 'function_call_output',
            call_id: callId,
            output: toolResult.output,
          });
        }

        // If there was also text alongside function calls, we might want to include it
        // but typically we continue the loop to get the final response after tool results
        if (textDone && functionCalls.length === 0) {
          // Only text, no function calls - we're done
          const durationMs = Date.now() - startTime;
          console.log(`[chatgpt-browser] 에이전트 완료: ${durationMs}ms, ${textDone.data.text?.length || 0}자, ${iteration + 1}회`);
          return { text: textDone.data.text || '', durationMs, model };
        }

        // Continue loop to get model's response after tool execution
        continue;
      }

      // No function calls - extract text and return
      if (textDone) {
        const durationMs = Date.now() - startTime;
        console.log(`[chatgpt-browser] 에이전트 완료: ${durationMs}ms, ${textDone.data.text?.length || 0}자, ${iteration + 1}회`);
        return { text: textDone.data.text || '', durationMs, model };
      }

      // Fallback: collect delta text
      const deltaText = result.events
        .filter((e) => e.type === 'response.output_text.delta')
        .map((e) => e.data.delta)
        .join('');

      if (deltaText) {
        const durationMs = Date.now() - startTime;
        return { text: deltaText, durationMs, model };
      }

      // No text at all - something went wrong
      console.warn('[chatgpt-browser] 에이전트: 텍스트/도구 호출 없음, rawBody:', result.rawBody.slice(0, 200));
      break;
    }

    const durationMs = Date.now() - startTime;
    return { text: '(에이전트 최대 반복 횟수 초과 또는 응답 없음)', durationMs, model };
  }

  /**
   * HTTP 에러를 분류하여 throw합니다.
   */
  private throwHttpError(result: { status: number; body: string }): never {
    console.error(`[chatgpt-browser] HTTP ${result.status}:`, result.body.slice(0, 300));

    if (result.status === 401) {
      const err = new Error('401 Unauthorized') as any;
      err.statusCode = 401;
      throw err;
    }

    if (result.status === 403) {
      const isCf = result.body.includes('cf-') || result.body.includes('Cloudflare');
      const err = new Error(isCf ? '403 Cloudflare Challenge' : '403 Forbidden') as any;
      err.statusCode = 403;
      err.cfChallenge = isCf;
      throw err;
    }

    if (result.status === 429) {
      const err = new Error('429 Too Many Requests') as any;
      err.statusCode = 429;
      err.retryAfter = 5000;
      throw err;
    }

    throw new Error(`API 에러 (${result.status}): ${result.body.slice(0, 200)}`);
  }

  /**
   * 에러 유형에 따라 복구를 시도하고 재요청합니다.
   */
  private async handleErrorAndRetry(
    err: any,
    message: string,
    model: string,
    tokens: AuthTokens,
    startTime: number,
    systemPrompt?: string,
    toolExecutor?: ToolExecutor,
  ): Promise<ChatGPTBrowserResult> {
    if (err.statusCode === 401) {
      console.log('[chatgpt-browser] 401 → 토큰 갱신 후 재시도');
      const refreshed = await getValidTokens();
      if (!refreshed) throw new Error('토큰 갱신 실패');
      if (toolExecutor) return this.doAgentRequest(message, model, refreshed, startTime, systemPrompt, toolExecutor);
      return this.doRequest(message, model, refreshed, startTime, systemPrompt);
    }

    if (err.statusCode === 403 && err.cfChallenge) {
      console.log('[chatgpt-browser] 403 CF → Cloudflare 재워밍업 후 재시도');
      await this.browserService.refreshCloudflare();
      if (toolExecutor) return this.doAgentRequest(message, model, tokens, startTime, systemPrompt, toolExecutor);
      return this.doRequest(message, model, tokens, startTime, systemPrompt);
    }

    if (err.statusCode === 429) {
      const waitMs = err.retryAfter || 5000;
      console.log(`[chatgpt-browser] 429 → ${waitMs}ms 대기 후 재시도`);
      await new Promise((r) => setTimeout(r, waitMs));
      if (toolExecutor) return this.doAgentRequest(message, model, tokens, startTime, systemPrompt, toolExecutor);
      return this.doRequest(message, model, tokens, startTime, systemPrompt);
    }

    throw err;
  }

  /**
   * SSE 스트리밍 응답에서 최종 텍스트를 추출합니다.
   *
   * 검증된 이벤트 타입:
   * - response.output_text.delta: 텍스트 조각 (delta 필드)
   * - response.output_text.done: 전체 텍스트 (text 필드) ← 이것을 사용
   */
  private extractFromSSE(body: string): string {
    const lines = body.split('\n');
    let fullText = '';
    let deltaText = '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') break;

      try {
        const data = JSON.parse(payload);

        // 최종 텍스트 (가장 신뢰)
        if (data.type === 'response.output_text.done' && data.text) {
          fullText = data.text;
        }

        // delta 누적 (fallback)
        if (data.type === 'response.output_text.delta' && data.delta) {
          deltaText += data.delta;
        }
      } catch {}
    }

    return fullText || deltaText || '(응답 없음)';
  }
}

// --- Singleton ---

let client: ChatGPTBrowserClient | null = null;

export function getChatGPTBrowserClient(config: ChatGPTBrowserConfig): ChatGPTBrowserClient {
  if (!client) {
    client = new ChatGPTBrowserClient(config);
  }
  return client;
}

export async function stopChatGPTBrowserClient(): Promise<void> {
  if (client) {
    await client.stop();
    client = null;
  }
}

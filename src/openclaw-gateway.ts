/**
 * OpenClaw Gateway WebSocket Client for claude-cron
 *
 * OpenClaw 게이트웨이에 직접 WebSocket으로 연결하여 API 호출을 수행합니다.
 * Codex CLI 서브프로세스 대비 ~5배 빠른 응답 속도를 제공합니다. (13-18초 → 2-4초)
 *
 * 프로토콜 (검증 완료):
 * 1. ws://localhost:18789 연결 (로컬 게이트웨이)
 * 2. 게이트웨이가 { type: "event", event: "connect.challenge" } 전송
 * 3. 클라이언트가 { type: "req", method: "connect", params: { auth: { token }, ... } } 전송
 * 4. 인증 완료 후 chat.send → agent.wait + chat event 스트리밍으로 응답 수신
 *
 * 프레임 포맷:
 * - Request:  { type: "req",   id: string, method: string, params?: any }
 * - Response: { type: "res",   id: string, ok: boolean, payload?: any, error?: { message } }
 * - Event:    { type: "event", event: string, payload?: any }
 */

import WebSocket from 'ws';
import crypto from 'node:crypto';

export interface OpenClawGatewayConfig {
  enabled: boolean;
  url: string;          // ws://localhost:18789 (로컬 게이트웨이)
  token: string;        // gateway auth token (openclaw.json의 gateway.auth.token)
  sessionId?: string;   // persistent session ID for conversation continuity
  timeout?: number;     // request timeout in ms (default: 30000)
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** chat 이벤트에서 수신된 메시지 */
interface ChatEvent {
  runId: string;
  sessionKey: string;
  seq: number;
  state: 'delta' | 'final' | 'aborted' | 'error';
  message?: {
    role: string;
    content: Array<{ type: string; text?: string }>;
  };
  errorMessage?: string;
}

/**
 * OpenClaw 게이트웨이에 대한 영속적(persistent) WebSocket 연결을 관리합니다.
 *
 * 왜 영속적 연결인가?
 * - WebSocket 핸드셰이크 + 인증 챌린지 응답 오버헤드 제거 (~30ms로 단축)
 * - 게이트웨이가 이미 Cloudflare bypass + OAuth 토큰을 처리한 상태
 * - 연결 끊김 시 자동 재연결으로 안정성 확보
 */
export class OpenClawGatewayClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private authenticated = false;
  private pending = new Map<string, PendingRequest>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  private stopped = false;

  /**
   * runId별로 수신된 chat 이벤트의 최종 텍스트를 저장합니다.
   * agent.wait 완료 후 이 Map에서 결과를 가져옵니다.
   */
  private chatFinalTexts = new Map<string, string>();

  constructor(private config: OpenClawGatewayConfig) {}

  /**
   * 게이트웨이 연결을 시작합니다.
   * 연결 + 인증 완료 시 Promise가 resolve됩니다.
   */
  async connect(): Promise<void> {
    if (this.connected && this.authenticated) return;
    this.stopped = false;

    return new Promise<void>((resolve, reject) => {
      const connectTimeout = setTimeout(() => {
        reject(new Error('Gateway 연결 시간 초과'));
      }, this.config.timeout || 30000);

      try {
        this.ws = new WebSocket(this.config.url);

        this.ws.on('open', () => {
          console.log('[openclaw-gw] WebSocket 연결됨');
          this.connected = true;
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          const raw = data.toString();
          try {
            const parsed = JSON.parse(raw);
            this.handleMessage(parsed, () => {
              clearTimeout(connectTimeout);
              resolve();
            });
          } catch {
            console.error('[openclaw-gw] 메시지 파싱 실패:', raw.slice(0, 200));
          }
        });

        this.ws.on('close', (code, reason) => {
          console.log(`[openclaw-gw] 연결 종료: ${code} ${reason.toString()}`);
          this.connected = false;
          this.authenticated = false;
          this.flushPending(new Error('연결 종료'));
          if (!this.stopped) this.scheduleReconnect();
        });

        this.ws.on('error', (err) => {
          console.error('[openclaw-gw] WebSocket 에러:', err.message);
          if (!this.connected) {
            clearTimeout(connectTimeout);
            reject(err);
          }
        });
      } catch (err) {
        clearTimeout(connectTimeout);
        reject(err);
      }
    });
  }

  /**
   * 게이트웨이 연결을 종료합니다.
   */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.authenticated = false;
    this.flushPending(new Error('클라이언트 종료'));
  }

  /**
   * 게이트웨이의 연결/인증 상태를 반환합니다.
   */
  isReady(): boolean {
    return this.connected && this.authenticated;
  }

  /**
   * 채팅 메시지를 전송하고 응답을 기다립니다.
   *
   * 내부 동작 (테스트 검증 완료):
   * 1. chat.send 요청 → runId 수신 (즉시, ~20ms)
   * 2. chat 이벤트 스트리밍 수신 (delta → final)
   * 3. agent.wait 요청 → 모델 응답 완료 대기
   * 4. chatFinalTexts Map에서 최종 응답 텍스트 추출
   *
   * chat.history는 빈 배열을 반환하므로 사용하지 않습니다.
   * 대신 "chat" 이벤트의 state: "final" 메시지에서 텍스트를 추출합니다.
   */
  async sendMessage(
    message: string,
    options?: { sessionId?: string; thinking?: string; timeout?: number }
  ): Promise<{ text: string; durationMs: number; model?: string }> {
    if (!this.isReady()) {
      await this.connect();
    }

    const sessionId = options?.sessionId || this.config.sessionId || 'claude-cron-default';
    const timeout = options?.timeout || this.config.timeout || 30000;
    const start = Date.now();

    // Step 1: chat.send - 메시지 전송 (idempotencyKey 필수)
    const sendResult = await this.request('chat.send', {
      message,
      sessionKey: sessionId,
      idempotencyKey: crypto.randomUUID(),
    }, timeout);

    const runId = sendResult?.runId;
    if (!runId) {
      throw new Error('chat.send 응답에 runId 없음');
    }

    // Step 2: agent.wait - 응답 완료 대기
    // chat 이벤트는 handleMessage에서 자동으로 캡처됨
    const waitTimeout = Math.max(timeout - (Date.now() - start), 5000);
    const waitResult = await this.request('agent.wait', {
      runId,
      timeoutMs: waitTimeout,
    }, waitTimeout + 2000);

    if (waitResult?.status !== 'ok') {
      throw new Error(`agent.wait 실패: ${waitResult?.status || 'unknown'}`);
    }

    const durationMs = Date.now() - start;

    // Step 3: chatFinalTexts에서 최종 응답 텍스트 추출
    const text = this.chatFinalTexts.get(runId) || '(응답 없음)';
    this.chatFinalTexts.delete(runId); // cleanup

    return {
      text,
      durationMs,
      model: waitResult?.model || sendResult?.model,
    };
  }

  // --- Private Methods ---

  /**
   * 수신된 WebSocket 메시지를 처리합니다.
   *
   * 프레임 타입:
   * - event: 서버 이벤트 (connect.challenge, chat, agent, health 등)
   * - res:   요청에 대한 응답 (ok + payload 또는 error)
   */
  private handleMessage(parsed: any, onAuthenticated?: () => void): void {
    // Event frame (서버 → 클라이언트 이벤트)
    if (parsed.type === 'event') {
      if (parsed.event === 'connect.challenge') {
        this.sendConnect(onAuthenticated);
        return;
      }

      // "chat" 이벤트에서 최종 응답 텍스트 캡처
      if (parsed.event === 'chat' && parsed.payload) {
        this.handleChatEvent(parsed.payload);
      }

      // agent, health 등 기타 이벤트는 무시
      return;
    }

    // Response frame (요청에 대한 응답)
    if (parsed.type === 'res' && parsed.id) {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;

      this.pending.delete(parsed.id);
      clearTimeout(pending.timer);

      if (parsed.ok === false || parsed.error) {
        pending.reject(new Error(parsed.error?.message || 'Gateway 요청 실패'));
      } else {
        pending.resolve(parsed.payload);
      }
    }
  }

  /**
   * chat 이벤트를 처리하여 최종 응답 텍스트를 캡처합니다.
   *
   * 이벤트 형식 (실제 테스트 결과):
   * {
   *   runId: "...",
   *   sessionKey: "...",
   *   seq: 10,
   *   state: "final",
   *   message: {
   *     role: "assistant",
   *     content: [{ type: "text", text: "안녕! 뭘 도와줄까? ..." }]
   *   }
   * }
   */
  private handleChatEvent(payload: ChatEvent): void {
    if (payload.state === 'final' && payload.message && payload.runId) {
      const content = payload.message.content;
      if (Array.isArray(content)) {
        // content 배열에서 text 타입만 추출하여 합침
        const text = content
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text)
          .join('\n');
        if (text) {
          this.chatFinalTexts.set(payload.runId, text);
        }
      }
    }
  }

  /**
   * 인증 요청을 전송합니다.
   *
   * 검증된 프로토콜:
   * - protocolVersion: 3 (게이트웨이 요구사항)
   * - client.id: "cli" (paired devices에 등록된 클라이언트 ID)
   * - client.mode: "cli"
   * - 프레임: { type: "req", id, method: "connect", params }
   */
  private sendConnect(onAuthenticated?: () => void): void {
    const id = this.generateId();
    const frame = {
      type: 'req' as const,
      id,
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: 'cli',
          displayName: 'Claude Cron',
          version: '1.0.0',
          platform: process.platform,
          mode: 'cli',
        },
        caps: [],
        auth: {
          token: this.config.token,
        },
        role: 'operator',
        scopes: ['operator.admin'],
      },
    };

    const timer = setTimeout(() => {
      this.pending.delete(id);
      console.error('[openclaw-gw] connect 시간 초과');
    }, 10000);

    this.pending.set(id, {
      resolve: () => {
        this.authenticated = true;
        this.backoffMs = 1000;
        console.log('[openclaw-gw] 인증 성공');
        onAuthenticated?.();
      },
      reject: (err: Error) => {
        console.error('[openclaw-gw] 인증 실패:', err.message);
      },
      timer,
    });

    this.ws?.send(JSON.stringify(frame));
  }

  /**
   * 게이트웨이에 요청을 전송하고 응답을 기다립니다.
   *
   * 프레임: { type: "req", id, method, params }
   */
  private request(method: string, params: any, timeoutMs = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket 연결되지 않음'));
      }

      const id = this.generateId();
      const frame = {
        type: 'req' as const,
        id,
        method,
        params,
      };

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`요청 시간 초과: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(frame));
    });
  }

  private generateId(): string {
    return crypto.randomUUID();
  }

  private flushPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;

    console.log(`[openclaw-gw] ${this.backoffMs}ms 후 재연결...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        console.log('[openclaw-gw] 재연결 성공');
      } catch (err: any) {
        console.error('[openclaw-gw] 재연결 실패:', err.message);
        this.backoffMs = Math.min(this.backoffMs * 2, 30000);
        this.scheduleReconnect();
      }
    }, this.backoffMs);
  }
}

// --- Singleton Client Instance ---

let gatewayClient: OpenClawGatewayClient | null = null;

/**
 * 싱글톤 게이트웨이 클라이언트를 가져옵니다.
 * 영속적 WebSocket 연결을 재사용하여 매 요청마다 새 연결을 만들지 않습니다.
 */
export function getGatewayClient(config: OpenClawGatewayConfig): OpenClawGatewayClient {
  if (!gatewayClient) {
    gatewayClient = new OpenClawGatewayClient(config);
  }
  return gatewayClient;
}

/**
 * 게이트웨이 클라이언트를 종료합니다.
 */
export function stopGatewayClient(): void {
  if (gatewayClient) {
    gatewayClient.stop();
    gatewayClient = null;
  }
}

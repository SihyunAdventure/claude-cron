/**
 * Browser Service - Playwright + Chrome CDP 연결 관리
 *
 * 핵심 원리: Cloudflare는 직접 HTTP 요청을 차단하지만,
 * 실제 브라우저 내에서 실행되는 fetch()는 통과합니다.
 * Playwright로 Chrome을 띄우고, page.evaluate(() => fetch(...))로
 * API 요청을 라우팅합니다.
 *
 * - Chrome 실행: child_process.spawn으로 시스템 Chrome 실행
 * - CDP 연결: chromium.connectOverCDP (playwright-core)
 * - Cloudflare 워밍업: chatgpt.com 방문으로 챌린지 자동 해결
 * - 자동 복구: 연결 끊김 시 exponential backoff로 재시작
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';

/** Chrome 실행 시 사용할 기본 포트 (OpenClaw의 18800-18899와 충돌 회피) */
const DEFAULT_CDP_PORT = 19222;

/** 브라우저 사용자 데이터 디렉토리 (Cloudflare 세션 유지) */
const DEFAULT_USER_DATA_DIR = path.join(
  os.homedir(),
  '.claude-cron',
  'browser',
  'user-data'
);

/** macOS에서 시스템 Chrome 경로 */
const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ],
};

export interface BrowserServiceOptions {
  headless?: boolean;
  cdpPort?: number;
  userDataDir?: string;
}

export interface FetchResult {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

/** 구조화된 SSE 이벤트 */
export interface SSEEvent {
  type: string;           // e.g., 'response.output_text.done', 'response.function_call_arguments.done'
  data: Record<string, any>;  // parsed JSON payload
}

/** 구조화된 SSE 결과 (에이전트 루프용) */
export interface SSEStructuredResult {
  status: number;
  events: SSEEvent[];     // parsed events list
  rawBody: string;        // raw SSE body for debugging
}

/**
 * 시스템에 설치된 Chrome 바이너리 경로를 찾습니다.
 */
function findChromeBinary(): string | null {
  const platform = process.platform;
  const paths = CHROME_PATHS[platform];
  if (!paths) return null;

  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export class BrowserService {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private chromeProcess: ChildProcess | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private reconnecting = false;
  private warmedUp = false;

  private readonly headless: boolean;
  private readonly cdpPort: number;
  private readonly userDataDir: string;

  constructor(options: BrowserServiceOptions = {}) {
    this.headless = options.headless ?? true;
    this.cdpPort = options.cdpPort ?? DEFAULT_CDP_PORT;
    this.userDataDir = options.userDataDir ?? DEFAULT_USER_DATA_DIR;
  }

  /**
   * Chrome을 실행하고 CDP로 연결합니다.
   * Cloudflare 워밍업(chatgpt.com 방문)도 수행합니다.
   */
  async start(): Promise<void> {
    if (this.browser && this.page) return;
    this.stopped = false;

    // 1. 사용자 데이터 디렉토리 생성
    if (!fs.existsSync(this.userDataDir)) {
      fs.mkdirSync(this.userDataDir, { recursive: true });
    }

    // 2. Chrome 프로세스 시작
    await this.launchChrome();

    // 3. CDP 연결
    await this.connectCDP();

    // 4. Cloudflare 워밍업
    await this.warmup();

    console.log('[browser-service] 브라우저 서비스 시작 완료');
  }

  /**
   * 브라우저 서비스를 종료합니다.
   */
  async stop(): Promise<void> {
    this.stopped = true;

    if (this.browser) {
      try {
        await this.browser.close();
      } catch {}
      this.browser = null;
    }

    if (this.chromeProcess) {
      try {
        this.chromeProcess.kill('SIGTERM');
      } catch {}
      this.chromeProcess = null;
    }

    this.page = null;
    this.warmedUp = false;
    console.log('[browser-service] 브라우저 서비스 종료');
  }

  /**
   * 브라우저가 사용 가능한지 확인합니다.
   */
  isReady(): boolean {
    return !!(this.browser && this.page && this.warmedUp);
  }

  /**
   * 브라우저 내에서 fetch()를 실행합니다.
   * 브라우저 컨텍스트에서 실행되므로 Cloudflare를 자연스럽게 통과합니다.
   *
   * @param url - 요청할 URL
   * @param init - fetch 옵션 (method, headers, body)
   * @returns 응답 상태 코드와 본문
   */
  async evaluateFetch(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string }
  ): Promise<FetchResult> {
    if (!this.page) {
      throw new Error('브라우저가 시작되지 않았습니다');
    }

    try {
      const result = await this.page.evaluate(
        async ({ url, init }) => {
          const resp = await fetch(url, {
            method: init.method || 'GET',
            headers: init.headers,
            body: init.body,
          });

          // 응답 헤더 중 주요 항목 추출
          const headers: Record<string, string> = {};
          const importantHeaders = ['content-type', 'retry-after', 'cf-ray'];
          for (const h of importantHeaders) {
            const val = resp.headers.get(h);
            if (val) headers[h] = val;
          }

          return {
            status: resp.status,
            body: await resp.text(),
            headers,
          };
        },
        { url, init }
      );

      return result;
    } catch (err: any) {
      // 페이지/브라우저 크래시 감지 → 자동 복구
      if (
        err.message?.includes('Target closed') ||
        err.message?.includes('Session closed') ||
        err.message?.includes('page has been closed')
      ) {
        console.error('[browser-service] 페이지 크래시 감지, 복구 시도...');
        await this.recover();
        throw new Error('브라우저 복구 중, 재시도 필요');
      }
      throw err;
    }
  }

  /**
   * 브라우저 내에서 SSE 스트리밍 fetch를 실행합니다.
   * ReadableStream으로 전체 SSE 데이터를 수집한 뒤 반환합니다.
   */
  async evaluateSSE(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string }
  ): Promise<FetchResult> {
    if (!this.page) {
      throw new Error('브라우저가 시작되지 않았습니다');
    }

    try {
      const result = await this.page.evaluate(
        async ({ url, init }) => {
          const resp = await fetch(url, {
            method: init.method || 'POST',
            headers: init.headers,
            body: init.body,
          });

          if (!resp.ok || !resp.body) {
            return {
              status: resp.status,
              body: await resp.text(),
            };
          }

          // SSE 스트림을 전부 수집
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let fullBody = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fullBody += decoder.decode(value, { stream: true });
          }

          return {
            status: resp.status,
            body: fullBody,
          };
        },
        { url, init }
      );

      return result;
    } catch (err: any) {
      if (
        err.message?.includes('Target closed') ||
        err.message?.includes('Session closed') ||
        err.message?.includes('page has been closed')
      ) {
        console.error('[browser-service] 페이지 크래시 감지, 복구 시도...');
        await this.recover();
        throw new Error('브라우저 복구 중, 재시도 필요');
      }
      throw err;
    }
  }

  /**
   * 브라우저 내에서 SSE 스트리밍 fetch를 실행하고 구조화된 이벤트 리스트를 반환합니다.
   * 각 data: 라인을 파싱하여 { type, data } 형태의 이벤트 배열로 변환합니다.
   */
  async evaluateSSEStructured(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string }
  ): Promise<SSEStructuredResult> {
    if (!this.page) {
      throw new Error('브라우저가 시작되지 않았습니다');
    }

    try {
      const result = await this.page.evaluate(
        async ({ url, init }) => {
          const resp = await fetch(url, {
            method: init.method,
            headers: init.headers,
            body: init.body,
          });

          if (!resp.ok || !resp.body) {
            return {
              status: resp.status,
              events: [],
              rawBody: await resp.text(),
            };
          }

          // SSE 스트림을 전부 수집하면서 이벤트 파싱
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let fullBody = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fullBody += decoder.decode(value, { stream: true });
          }

          // SSE 데이터 라인 파싱
          const events = [];
          for (const line of fullBody.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') break;
            try {
              const data = JSON.parse(payload);
              if (data.type) {
                events.push({ type: data.type, data });
              }
            } catch {
              // JSON 파싱 실패 시 무시
            }
          }

          return {
            status: resp.status,
            events,
            rawBody: fullBody,
          };
        },
        { url, init }
      );

      return result;
    } catch (err: any) {
      if (
        err.message?.includes('Target closed') ||
        err.message?.includes('Session closed') ||
        err.message?.includes('page has been closed')
      ) {
        console.error('[browser-service] 페이지 크래시 감지, 복구 시도...');
        await this.recover();
        throw new Error('브라우저 복구 중, 재시도 필요');
      }
      throw err;
    }
  }

  /**
   * Cloudflare 챌린지를 해결하기 위해 chatgpt.com을 방문합니다.
   * 이미 워밍업된 경우에도 강제로 재방문합니다.
   */
  async refreshCloudflare(): Promise<void> {
    if (!this.page) {
      throw new Error('브라우저가 시작되지 않았습니다');
    }

    console.log('[browser-service] Cloudflare 챌린지 재해결 중...');
    try {
      await this.page.goto('https://chatgpt.com', {
        waitUntil: 'load',
        timeout: 30000,
      });
      await this.waitForCloudflareResolution();
    } catch (err: any) {
      console.error('[browser-service] Cloudflare 재워밍업 실패:', err.message);
    }
  }

  // --- Private Methods ---

  /**
   * 시스템 Chrome을 CDP 모드로 실행합니다.
   */
  private async launchChrome(): Promise<void> {
    const chromeBinary = findChromeBinary();
    if (!chromeBinary) {
      throw new Error(
        '시스템에 Chrome이 설치되지 않았습니다. ' +
        'Google Chrome을 설치해주세요.'
      );
    }

    const args = [
      `--remote-debugging-port=${this.cdpPort}`,
      `--user-data-dir=${this.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--metrics-recording-only',
      '--no-service-autorun',
      // Cloudflare stealth: navigator.webdriver 감지 우회
      '--disable-blink-features=AutomationControlled',
      // 실제 브라우저처럼 보이기 위한 추가 플래그
      '--disable-features=IsolateOrigins,site-per-process',
      '--flag-switches-begin',
      '--flag-switches-end',
    ];

    if (this.headless) {
      args.push('--headless=new');
    }

    console.log(`[browser-service] Chrome 시작: ${chromeBinary}`);
    console.log(`[browser-service] CDP 포트: ${this.cdpPort}`);

    this.chromeProcess = spawn(chromeBinary, args, {
      stdio: 'ignore',
      detached: false,
    });

    this.chromeProcess.on('exit', (code) => {
      console.log(`[browser-service] Chrome 종료 (code: ${code})`);
      if (!this.stopped) {
        this.recover();
      }
    });

    // Chrome이 CDP 포트를 열 때까지 대기
    await this.waitForCDP();
  }

  /**
   * Chrome의 CDP 포트가 열릴 때까지 폴링합니다.
   */
  private async waitForCDP(maxRetries = 20, intervalMs = 500): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const resp = await fetch(`http://localhost:${this.cdpPort}/json/version`);
        if (resp.ok) {
          console.log('[browser-service] CDP 포트 준비 완료');
          return;
        }
      } catch {
        // 아직 준비 안됨
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`CDP 포트 ${this.cdpPort}가 ${maxRetries * intervalMs}ms 내에 열리지 않음`);
  }

  /**
   * Playwright를 통해 CDP에 연결합니다.
   */
  private async connectCDP(): Promise<void> {
    console.log('[browser-service] CDP 연결 중...');

    this.browser = await chromium.connectOverCDP(`http://localhost:${this.cdpPort}`);

    // 연결 끊김 감지
    this.browser.on('disconnected', () => {
      console.log('[browser-service] 브라우저 연결 끊김');
      this.browser = null;
      this.page = null;
      this.warmedUp = false;
      if (!this.stopped) {
        this.recover();
      }
    });

    // 기본 컨텍스트의 첫 번째 페이지 사용 또는 새 페이지 생성
    const contexts = this.browser.contexts();
    if (contexts.length > 0 && contexts[0]!.pages().length > 0) {
      this.page = contexts[0]!.pages()[0]!;
    } else {
      const context = contexts.length > 0
        ? contexts[0]!
        : await this.browser.newContext();
      this.page = await context.newPage();
    }

    // Stealth: navigator.webdriver를 false로 덮어쓰기
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    console.log('[browser-service] CDP 연결 완료');
  }

  /**
   * chatgpt.com을 방문하여 Cloudflare 챌린지를 해결합니다.
   * 챌린지 해결 여부를 cf_clearance 쿠키로 검증합니다.
   */
  private async warmup(): Promise<void> {
    if (!this.page) return;

    console.log('[browser-service] Cloudflare 워밍업 시작...');
    try {
      await this.page.goto('https://chatgpt.com', {
        waitUntil: 'load',
        timeout: 30000,
      });

      // Cloudflare 챌린지 해결 대기 및 검증
      await this.waitForCloudflareResolution();

      this.warmedUp = true;
      this.backoffMs = 1000;
    } catch (err: any) {
      console.error('[browser-service] 워밍업 실패:', err.message);
      // 워밍업 실패해도 서비스는 시작 (API 호출 시 재시도)
      this.warmedUp = true;
    }
  }

  /**
   * Cloudflare 챌린지가 해결될 때까지 대기합니다.
   * cf_clearance 쿠키 존재 또는 페이지 타이틀 변화로 판단합니다.
   */
  private async waitForCloudflareResolution(maxWaitMs = 15000): Promise<void> {
    if (!this.page) return;

    const startTime = Date.now();
    const checkInterval = 1000;

    while (Date.now() - startTime < maxWaitMs) {
      // 방법 1: cf_clearance 쿠키 확인
      const context = this.page.context();
      const cookies = await context.cookies('https://chatgpt.com');
      const hasCfClearance = cookies.some((c) => c.name === 'cf_clearance');

      if (hasCfClearance) {
        console.log('[browser-service] cf_clearance 쿠키 확인 → 워밍업 완료');
        return;
      }

      // 방법 2: 페이지가 챌린지 페이지가 아닌지 확인
      const title = await this.page.title().catch(() => '');
      const url = this.page.url();

      // ChatGPT 메인 페이지에 도달했으면 성공
      if (title.includes('ChatGPT') && !title.includes('Just a moment')) {
        console.log(`[browser-service] 페이지 타이틀 확인: "${title}" → 워밍업 완료`);
        return;
      }

      console.log(`[browser-service] 챌린지 대기 중... (${Math.round((Date.now() - startTime) / 1000)}s, title: "${title}", url: ${url})`);
      await this.page.waitForTimeout(checkInterval);
    }

    console.warn('[browser-service] Cloudflare 챌린지 해결 타임아웃 (워밍업 계속 진행)');
  }

  /**
   * 브라우저 복구: exponential backoff로 재시작합니다.
   */
  private async recover(): Promise<void> {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;

    console.log(`[browser-service] ${this.backoffMs}ms 후 복구 시도...`);
    await new Promise((r) => setTimeout(r, this.backoffMs));

    try {
      // 기존 프로세스 정리
      if (this.chromeProcess) {
        try { this.chromeProcess.kill('SIGTERM'); } catch {}
        this.chromeProcess = null;
      }
      if (this.browser) {
        try { await this.browser.close(); } catch {}
        this.browser = null;
      }
      this.page = null;
      this.warmedUp = false;

      // 재시작
      await this.start();
      this.backoffMs = 1000;
      console.log('[browser-service] 복구 성공');
    } catch (err: any) {
      console.error('[browser-service] 복구 실패:', err.message);
      this.backoffMs = Math.min(this.backoffMs * 2, 30000);
      // 다음 evaluateFetch 호출 시 다시 시도
    } finally {
      this.reconnecting = false;
    }
  }
}

# ChatGPT Browser 연결 방식

## 배경: 왜 브라우저가 필요한가?

### Codex CLI (공식 클라이언트)의 방식
OpenAI의 공식 제품인 Codex CLI는 직접 HTTP 요청으로 ChatGPT API를 호출합니다:

```
Codex CLI (Rust/Node.js)
    ↓ 직접 HTTP fetch
    ↓ User-Agent: "CodexBar" + sentinel token
    ↓ Cloudflare 서버 측 화이트리스트로 통과
    ↓
chatgpt.com/backend-api/codex/responses
```

- OpenAI가 Cloudflare 설정에서 `CodexBar` User-Agent + 특정 `client_id`를 **화이트리스트 등록**
- 공식 클라이언트이므로 Cloudflare 챌린지를 받지 않음
- 브라우저 불필요

### 우리의 문제
우리는 공식 클라이언트가 아니므로 **Cloudflare 화이트리스트에 없습니다.**
Node.js에서 동일한 헤더로 직접 fetch해도 Cloudflare가 차단합니다.

### 해결책: 실제 브라우저 안에서 fetch

Cloudflare는 직접 HTTP 요청(Node.js fetch, curl)을 차단하지만, **실제 브라우저 안에서 실행되는 `fetch()`는 통과**시킵니다.

이 원리를 이용하여:
1. Playwright로 실제 Chrome 브라우저를 headless로 실행
2. Chrome 안에서 `page.evaluate(() => fetch(...))` 로 API 호출
3. Cloudflare가 보기에는 정상 브라우저 트래픽 → 통과

## 공식 vs 비공식 비교

| | Codex CLI (공식) | ChatGPT Browser (우리) |
|---|---|---|
| Cloudflare 통과 | 서버 측 화이트리스트 (정식) | 브라우저 에뮬레이션 (우회) |
| 브라우저 필요 | 없음 | Chrome 필요 |
| OpenAI 승인 | 있음 (공식 제품) | 없음 (비공식) |
| 안정성 | 높음 | Cloudflare 정책 변경 시 깨질 수 있음 |
| API 엔드포인트 | 동일 (`backend-api/codex/responses`) | 동일 |
| OAuth 토큰 | Codex CLI가 생성 | Codex CLI 토큰 재사용 |
| ToS 위반 가능성 | 없음 | 있음 (비공식 API + CF 우회) |

### 리스크
- **계정 정지**: 자동화 탐지 시 가능성 있음
- **갑작스런 중단**: 비공식 API라 사전 공지 없이 변경 가능
- **ToS 위반**: Cloudflare 우회 + 비공식 API 사용은 OpenAI 이용약관에 위배될 수 있음

## 아키텍처

```
Telegram 메시지
    │
    ▼
unified-executor.ts (provider: 'openai')
    │
    ├── [1순위] chatgpt-browser.ts    ← Playwright + Chrome (2-5초)
    └── [2순위] openai-provider.ts    ← Codex CLI 서브프로세스 (fallback, 13-18초)
```

```
chatgpt-browser.ts (고수준 API 클라이언트)
    ├── browser-service.ts  (Chrome 실행/관리, evaluateFetch)
    └── chatgpt-auth.ts     (OAuth 토큰 읽기/갱신)
```

## 3개 모듈 상세

### 1. `chatgpt-auth.ts` - OAuth 토큰 관리

**역할**: `~/.codex/auth.json`에서 OAuth 토큰을 읽고 만료 시 갱신

```
~/.codex/auth.json (Codex CLI가 생성한 파일을 재사용)
├── tokens.access_token   ← API 호출에 사용 (JWT, 만료 있음)
├── tokens.refresh_token  ← 만료 시 새 access_token 발급용
└── tokens.account_id     ← ChatGPT 계정 ID (헤더에 포함)
```

**토큰 갱신 흐름**:
1. access_token의 JWT payload에서 `exp` 클레임 디코딩
2. 만료 5분 전이면 갱신 시작
3. `POST https://auth.openai.com/oauth/token` (refresh_token 사용)
   - auth.openai.com은 Cloudflare 뒤에 없으므로 Node.js fetch로 직접 호출 가능
4. 새 토큰을 `~/.codex/auth.json`에 재저장

**다중 PC 동기화**: `config/codex-auth.json`에 토큰 사본 저장 → git push → 다른 PC에서 `~/.codex/auth.json`으로 복사

### 2. `browser-service.ts` - Chrome 브라우저 관리

**역할**: Playwright + CDP로 Chrome 인스턴스를 관리하고, 브라우저 내 fetch 실행

**Chrome 실행 방식**:
```
child_process.spawn('/Applications/Google Chrome.app/...')
  --remote-debugging-port=19222     ← CDP 디버깅 포트
  --user-data-dir=~/.claude-cron/browser/user-data  ← 세션 유지
  --headless=new                    ← GUI 없이 실행
  --no-first-run --no-default-browser-check
```

**CDP 연결**:
```typescript
chromium.connectOverCDP('http://localhost:19222')
```
- playwright-core만 사용 (~4MB, 브라우저 미포함)
- 시스템에 설치된 Chrome 사용

**Cloudflare 워밍업**:
- 시작 시 `page.goto('https://chatgpt.com')` 실행
- Cloudflare 챌린지 자동 해결
- `cf_clearance` 쿠키가 user-data-dir에 저장 → 이후 headless에서도 통과

**핵심 메서드 - evaluateFetch**:
```typescript
// Node.js에서 호출하지만, 실제 fetch는 Chrome 브라우저 안에서 실행됨
async evaluateFetch(url: string, init: RequestInit): Promise<FetchResult> {
  return this.page.evaluate(async ({url, init}) => {
    const resp = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body
    });
    return { status: resp.status, body: await resp.text() };
  }, {url, init});
}
```

**자동 복구**:
- `browser.on('disconnected')` → backoff 재시작 (1s, 2s, 4s... max 30s)
- Chrome이 죽으면 자동으로 재실행 + CDP 재연결

### 3. `chatgpt-browser.ts` - ChatGPT API 클라이언트

**역할**: Auth + Browser를 결합한 고수준 API 클라이언트

**API 엔드포인트**: `https://chatgpt.com/backend-api/codex/responses`
- 이것은 OpenAI의 **비공식 내부 API**입니다 (공식 API는 `api.openai.com/v1/`)
- Codex CLI가 사용하는 것과 동일한 엔드포인트

**요청 헤더**:
```
Authorization: Bearer <access_token>
User-Agent: CodexBar
ChatGPT-Account-Id: <account_id>
openai-sentinel-chat-requirements-token: <sentinel_token>
```

**요청 본문** (Responses API 형식):
```json
{
  "model": "gpt-5.3-codex-spark",
  "instructions": "시스템 프롬프트",
  "input": [
    { "role": "user", "content": "오늘 날씨 어때?" }
  ],
  "tools": [...],
  "stream": true,
  "store": false
}
```

**에이전트 모드** (도구 호출 루프):
```
1. 사용자 메시지 전송 → 모델 응답 수신
2. 모델이 function_call 반환?
   → Yes: 로컬에서 도구 실행 (bash, web_search, calendar 등)
          결과를 conversation에 추가
          다시 API 호출 (반복, 최대 30회)
   → No:  텍스트 응답 반환 → 완료
```

**에러 처리**:
- 401 → 토큰 갱신 후 재시도 (1회)
- 403 + Cloudflare → `page.goto('https://chatgpt.com')` 워밍업 후 재시도
- 429 → Retry-After 대기

## 전체 흐름 (예: "오늘 날씨 어때?")

```
1. Telegram 메시지 수신
2. unified-executor → chatgpt-browser 선택
3. chatgpt-auth: ~/.codex/auth.json에서 토큰 로드 (만료 시 갱신)
4. chatgpt-browser: sentinel 토큰 획득
5. browser-service: Chrome 내 page.evaluate(fetch(...))로 API 호출
   → Cloudflare 통과 (실제 브라우저이므로)
6. SSE 스트리밍으로 응답 수신
7. 모델이 bash 도구 호출: curl wttr.in/Seoul
8. tool-executor가 로컬에서 실행, 결과 반환
9. 모델이 최종 텍스트 응답 생성
10. Telegram으로 전송
```

## 설정 (config.yaml)

```yaml
chatgptBrowser:
  enabled: true
  model: gpt-5.3-codex-spark        # 기본 모델
  visionModel: gpt-5.1              # 이미지 분석용
  timeout: 30000                     # 요청 타임아웃 (ms)
  headless: true                     # headless 모드
  cdpPort: 19222                     # CDP 포트
```

## 다른 PC에서 설정

1. `git pull` (최신 코드)
2. `cp config/codex-auth.json ~/.codex/auth.json` (OAuth 토큰)
3. Google Chrome 설치 필요
4. `npm install` → `npm run dev`

## 의존성

- `playwright-core` (~4MB) - 브라우저 제어 라이브러리 (브라우저 미포함)
- 시스템 Chrome - `/Applications/Google Chrome.app` (macOS)

## 성능 비교

| 방식 | 속도 | 외부 의존성 |
|------|------|------------|
| ChatGPT Browser | 2-5초 | playwright-core + Chrome |
| Codex CLI (fallback) | 13-18초 | codex 바이너리 |

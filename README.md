# Claude Cron

Claude Code CLI 기반의 경량 크론 서비스입니다. YAML 파일로 작업을 정의하고, Claude AI가 자동으로 실행합니다.

## 기능

- **YAML 기반 작업 정의**: `config/tasks.yaml`에서 크론 작업 관리
- **Claude Code CLI 통합**: AI 기반 작업 실행
- **텔레그램 알림**: 작업 결과를 텔레그램으로 전송
- **Hot Reload**: 설정 파일 변경 시 자동 리로드

## 설치

```bash
# 저장소 클론
git clone https://github.com/SihyunAdventure/claude-cron.git
cd claude-cron

# Node.js 버전 설정 (nvm 사용 시)
nvm use

# 의존성 설치
npm install

# 환경변수 설정
cp .env.example .env
# .env 파일을 편집하여 TELEGRAM_BOT_TOKEN과 TELEGRAM_CHAT_ID 설정
```

## 설정

### 환경변수 (.env)

```env
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

### 작업 정의 (config/tasks.yaml)

```yaml
tasks:
  - name: "daily-report"
    schedule: "0 9 * * *"  # 매일 오전 9시
    prompt: "오늘의 작업 보고서를 작성해주세요"
    enabled: true
```

## 실행

```bash
# 개발 모드
npm run dev

# 프로덕션 빌드 및 실행
npm run build
npm start
```

## Codex OAuth 토큰 동기화

서비스 시작 시 `config/codex-auth.json`을 `~/.codex/auth.json`로 자동 반영할 수 있습니다.

- 기본 동작: 서비스 부팅 시 1회 동기화
- 설정값(환경변수):
  - `CODEX_AUTH_SOURCE` (기본: `config/codex-auth.json`)
  - `CODEX_AUTH_TARGET` (기본: `~/.codex/auth.json`)
  - `CODEX_AUTH_SYNC_INTERVAL_MINUTES` (기본: `0`, 1 이상 입력 시 주기 동기화)

예시:

```env
CODEX_AUTH_SOURCE=config/codex-auth.json
CODEX_AUTH_TARGET=~/.codex/auth.json
CODEX_AUTH_SYNC_INTERVAL_MINUTES=0
```

동기화 정책:
- source/target JSON이 유효한 auth payload일 때만 반영
- target 파일의 `last_refresh` 또는 파일 수정 시각이 source보다 최신이면 덮어쓰지 않음
- 덮어쓰기 시 `chmod 600`으로 보호 설정

## 요구사항

- Node.js 22+
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- Anthropic API 키 설정

## 라이선스

MIT

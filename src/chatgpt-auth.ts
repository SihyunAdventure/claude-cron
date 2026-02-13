/**
 * ChatGPT OAuth Token Manager
 *
 * ~/.codex/auth.json에서 OAuth 토큰을 읽고 관리합니다.
 * - 토큰 읽기: tokens.access_token, tokens.refresh_token, tokens.account_id
 * - 만료 확인: JWT payload의 exp 클레임 디코딩 (5분 버퍼)
 * - 토큰 갱신: auth.openai.com/oauth/token (Cloudflare 뒤에 없으므로 직접 호출)
 * - 갱신 결과를 auth.json에 재저장
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AUTH_FILE = path.join(os.homedir(), '.codex', 'auth.json');
const REFRESH_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** 토큰 만료 전 갱신 버퍼 (5분) */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accountId: string;
}

interface AuthFileData {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  OPENAI_API_KEY?: string;
}

/**
 * JWT payload에서 만료 시간(exp)을 추출합니다.
 * JWT는 header.payload.signature 형식이며, payload는 base64url 인코딩됩니다.
 * 외부 라이브러리 없이 base64 디코딩만으로 처리합니다.
 */
function getJwtExpiry(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    // base64url → base64 변환 후 디코딩
    const payload = parts[1]!
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
    return typeof decoded.exp === 'number' ? decoded.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * 토큰이 만료되었는지 확인합니다 (5분 버퍼 포함).
 */
function isTokenExpired(token: string): boolean {
  const expiry = getJwtExpiry(token);
  if (expiry === null) {
    // exp 클레임이 없으면 만료되지 않은 것으로 간주
    return false;
  }
  return Date.now() >= expiry - EXPIRY_BUFFER_MS;
}

/**
 * auth.json 파일에서 토큰을 읽습니다.
 */
function readAuthFile(): AuthFileData | null {
  try {
    if (!fs.existsSync(AUTH_FILE)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
  } catch (err) {
    console.error('[chatgpt-auth] auth.json 읽기 실패:', err);
    return null;
  }
}

/**
 * 갱신된 토큰을 auth.json에 저장합니다.
 * 기존 파일 내용을 유지하면서 토큰만 업데이트합니다.
 */
function writeAuthFile(data: AuthFileData): void {
  try {
    const dir = path.dirname(AUTH_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[chatgpt-auth] auth.json 저장 실패:', err);
  }
}

/**
 * refresh_token을 사용하여 새 access_token을 발급받습니다.
 * auth.openai.com은 Cloudflare 뒤에 없으므로 Node.js fetch로 직접 호출합니다.
 */
async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token: string;
} | null> {
  try {
    console.log('[chatgpt-auth] 토큰 갱신 중...');

    const resp = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[chatgpt-auth] 토큰 갱신 실패 (${resp.status}):`, text.slice(0, 200));
      return null;
    }

    const result = await resp.json() as { access_token: string; refresh_token: string };
    console.log('[chatgpt-auth] 토큰 갱신 성공');
    return result;
  } catch (err) {
    console.error('[chatgpt-auth] 토큰 갱신 에러:', err);
    return null;
  }
}

/**
 * 유효한 OAuth 토큰을 반환합니다.
 * 만료된 경우 자동으로 갱신하고 auth.json에 저장합니다.
 *
 * @returns 유효한 토큰 정보, 또는 토큰이 없는 경우 null
 */
export async function getValidTokens(): Promise<AuthTokens | null> {
  const data = readAuthFile();
  if (!data?.tokens?.access_token || !data.tokens.refresh_token) {
    console.error('[chatgpt-auth] auth.json에 토큰 없음');
    return null;
  }

  let { access_token, refresh_token, account_id } = data.tokens;

  // 토큰 만료 확인 및 갱신
  if (isTokenExpired(access_token)) {
    console.log('[chatgpt-auth] 토큰 만료됨, 갱신 시도...');
    const refreshed = await refreshAccessToken(refresh_token);
    if (!refreshed) {
      return null;
    }

    // auth.json 업데이트
    data.tokens.access_token = refreshed.access_token;
    data.tokens.refresh_token = refreshed.refresh_token;
    writeAuthFile(data);

    access_token = refreshed.access_token;
    refresh_token = refreshed.refresh_token;
  }

  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    accountId: account_id || '',
  };
}

/**
 * auth.json에 유효한 토큰이 존재하는지 확인합니다.
 */
export function hasAuthTokens(): boolean {
  const data = readAuthFile();
  return !!(data?.tokens?.access_token && data.tokens.refresh_token);
}

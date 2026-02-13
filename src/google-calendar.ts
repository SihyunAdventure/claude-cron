/**
 * Google Calendar 연동 모듈
 *
 * Desktop OAuth 방식으로 Google Calendar API에 접근합니다.
 * - 최초 1회: 브라우저에서 인증 → 토큰 저장
 * - 이후: 저장된 토큰 자동 사용/갱신
 *
 * 사전 준비:
 * 1. Google Cloud Console에서 프로젝트 생성
 * 2. Google Calendar API 활성화
 * 3. OAuth 2.0 Client ID (Desktop) 생성
 * 4. credentials.json 다운로드 → config/google-credentials.json
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { google, type calendar_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const TOKEN_DIR = path.join(os.homedir(), '.claude-cron');
const TOKEN_PATH = path.join(TOKEN_DIR, 'google-calendar-token.json');

export interface GoogleCalendarConfig {
  enabled: boolean;
  credentialsFile?: string; // 기본: config/google-credentials.json
}

export interface CalendarEvent {
  id?: string;
  summary: string;
  description?: string;
  start: string; // ISO 8601 또는 "2026-02-14", "2026-02-14T10:00:00+09:00"
  end?: string;
  location?: string;
  allDay?: boolean;
}

let oAuth2Client: OAuth2Client | null = null;
let calendarApi: calendar_v3.Calendar | null = null;

/**
 * credentials.json에서 OAuth2 클라이언트를 생성합니다.
 */
function loadCredentials(credentialsFile: string): OAuth2Client {
  if (!fs.existsSync(credentialsFile)) {
    throw new Error(
      `Google credentials 파일이 없습니다: ${credentialsFile}\n` +
      'Google Cloud Console에서 OAuth 2.0 Client ID (Desktop)를 생성하고 다운로드하세요.'
    );
  }

  const content = JSON.parse(fs.readFileSync(credentialsFile, 'utf-8'));
  const { client_id, client_secret, redirect_uris } =
    content.installed || content.web || {};

  if (!client_id || !client_secret) {
    throw new Error('credentials.json 형식이 올바르지 않습니다.');
  }

  return new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris?.[0] || 'urn:ietf:wg:oauth:2.0:oob'
  );
}

/**
 * 저장된 토큰을 로드합니다.
 */
function loadToken(): any | null {
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    }
  } catch {}
  return null;
}

/**
 * 토큰을 파일에 저장합니다.
 */
function saveToken(token: any): void {
  if (!fs.existsSync(TOKEN_DIR)) {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
  }
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
  console.log('[google-calendar] 토큰 저장 완료:', TOKEN_PATH);
}

/**
 * Google Calendar 서비스를 초기화합니다.
 * 토큰이 없으면 인증 URL을 반환합니다.
 */
export async function initGoogleCalendar(
  credentialsFile: string
): Promise<{ ready: boolean; authUrl?: string }> {
  oAuth2Client = loadCredentials(credentialsFile);

  const token = loadToken();
  if (token) {
    oAuth2Client.setCredentials(token);

    // 토큰 갱신 이벤트 핸들러
    oAuth2Client.on('tokens', (newTokens) => {
      const merged = { ...token, ...newTokens };
      saveToken(merged);
      console.log('[google-calendar] 토큰 자동 갱신 완료');
    });

    calendarApi = google.calendar({ version: 'v3', auth: oAuth2Client });
    console.log('[google-calendar] 초기화 완료 (기존 토큰 사용)');
    return { ready: true };
  }

  // 토큰이 없으면 인증 URL 생성
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('[google-calendar] 인증 필요. 아래 URL을 브라우저에서 열어주세요:');
  console.log(authUrl);

  return { ready: false, authUrl };
}

/**
 * 인증 코드로 토큰을 발급받습니다.
 * Telegram에서 코드를 입력받아 호출합니다.
 */
export async function authorizeWithCode(code: string): Promise<boolean> {
  if (!oAuth2Client) {
    throw new Error('OAuth 클라이언트가 초기화되지 않았습니다.');
  }

  try {
    const { tokens } = await oAuth2Client.getToken(code.trim());
    oAuth2Client.setCredentials(tokens);
    saveToken(tokens);

    oAuth2Client.on('tokens', (newTokens) => {
      const merged = { ...tokens, ...newTokens };
      saveToken(merged);
    });

    calendarApi = google.calendar({ version: 'v3', auth: oAuth2Client });
    console.log('[google-calendar] 인증 완료!');
    return true;
  } catch (err: any) {
    console.error('[google-calendar] 인증 실패:', err.message);
    return false;
  }
}

/**
 * Calendar API가 사용 가능한지 확인
 */
export function isCalendarReady(): boolean {
  return calendarApi !== null;
}

/**
 * 다가오는 일정을 조회합니다.
 */
export async function listEvents(
  maxResults: number = 10,
  timeMin?: string,
  timeMax?: string,
): Promise<string> {
  if (!calendarApi) return '(Google Calendar가 연결되지 않았습니다)';

  try {
    const now = new Date().toISOString();
    const res = await calendarApi.events.list({
      calendarId: 'primary',
      timeMin: timeMin || now,
      timeMax: timeMax || undefined,
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = res.data.items || [];
    if (events.length === 0) return '예정된 일정이 없습니다.';

    return events
      .map((event) => {
        const start = event.start?.dateTime || event.start?.date || '?';
        const end = event.end?.dateTime || event.end?.date || '';
        const summary = event.summary || '(제목 없음)';
        const location = event.location ? ` 📍 ${event.location}` : '';
        const desc = event.description ? `\n   ${event.description.slice(0, 100)}` : '';
        return `• ${start} ~ ${end}\n  ${summary}${location}${desc}`;
      })
      .join('\n\n');
  } catch (err: any) {
    return `일정 조회 실패: ${err.message}`;
  }
}

/**
 * 일정을 생성합니다.
 */
export async function createEvent(event: CalendarEvent): Promise<string> {
  if (!calendarApi) return '(Google Calendar가 연결되지 않았습니다)';

  try {
    let startObj: any;
    let endObj: any;

    if (event.allDay || (event.start.length === 10 && !event.start.includes('T'))) {
      // 종일 이벤트: "2026-02-14"
      startObj = { date: event.start };
      endObj = { date: event.end || event.start };
    } else {
      // 시간 지정 이벤트
      startObj = { dateTime: event.start, timeZone: 'Asia/Seoul' };
      const endTime = event.end || new Date(new Date(event.start).getTime() + 3600000).toISOString();
      endObj = { dateTime: endTime, timeZone: 'Asia/Seoul' };
    }

    const res = await calendarApi.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: event.summary,
        description: event.description,
        location: event.location,
        start: startObj,
        end: endObj,
      },
    });

    return `일정 생성 완료: "${res.data.summary}" (${res.data.start?.dateTime || res.data.start?.date})`;
  } catch (err: any) {
    return `일정 생성 실패: ${err.message}`;
  }
}

/**
 * 일정을 삭제합니다.
 */
export async function deleteEvent(eventId: string): Promise<string> {
  if (!calendarApi) return '(Google Calendar가 연결되지 않았습니다)';

  try {
    await calendarApi.events.delete({
      calendarId: 'primary',
      eventId,
    });
    return `일정 삭제 완료 (ID: ${eventId})`;
  } catch (err: any) {
    return `일정 삭제 실패: ${err.message}`;
  }
}

/**
 * 일정을 수정합니다.
 */
export async function updateEvent(
  eventId: string,
  updates: Partial<CalendarEvent>,
): Promise<string> {
  if (!calendarApi) return '(Google Calendar가 연결되지 않았습니다)';

  try {
    const existing = await calendarApi.events.get({
      calendarId: 'primary',
      eventId,
    });

    const body: any = { ...existing.data };
    if (updates.summary) body.summary = updates.summary;
    if (updates.description) body.description = updates.description;
    if (updates.location) body.location = updates.location;
    if (updates.start) {
      if (updates.start.length === 10) {
        body.start = { date: updates.start };
      } else {
        body.start = { dateTime: updates.start, timeZone: 'Asia/Seoul' };
      }
    }
    if (updates.end) {
      if (updates.end.length === 10) {
        body.end = { date: updates.end };
      } else {
        body.end = { dateTime: updates.end, timeZone: 'Asia/Seoul' };
      }
    }

    const res = await calendarApi.events.update({
      calendarId: 'primary',
      eventId,
      requestBody: body,
    });

    return `일정 수정 완료: "${res.data.summary}"`;
  } catch (err: any) {
    return `일정 수정 실패: ${err.message}`;
  }
}

/**
 * ÚNICO arquivo no worker que importa googleapis.calendar.
 * Wraps Calendar API leitura: freebusy, getCalendarMetadata, testAccess.
 *
 * Criação/edição/deleção de eventos vem na Entrega 4 (não aqui).
 */

import { google, type calendar_v3 } from 'googleapis';
import { getAuthedOAuth2Client } from '../../integrations/google/client-factory.js';
import { GoogleApiError } from '../../integrations/google/types.js';
import type { GoogleOAuthConnection } from '../../integrations/google/types.js';

export type BusySlot = { start: string; end: string };

export type CalendarMetadata = {
  id: string;
  summary: string;
  timeZone: string;
};

export type TestAccessResult =
  | { ok: true; metadata: CalendarMetadata }
  | { ok: false; error: 'not_shared' | 'not_found' | 'auth' | 'unknown'; detail?: string };

type CalClientFactory = (conn: GoogleOAuthConnection) => Promise<calendar_v3.Calendar>;

let _calClientFactory: CalClientFactory | null = null;

/** Somente para testes — injeta factory alternativa. */
export function _setCalClientFactory(f: CalClientFactory | null): void {
  _calClientFactory = f;
}

async function calClient(conn: GoogleOAuthConnection): Promise<calendar_v3.Calendar> {
  if (_calClientFactory) return _calClientFactory(conn);
  const auth = await getAuthedOAuth2Client(conn);
  return google.calendar({ version: 'v3', auth });
}

export async function getEvent(
  conn: GoogleOAuthConnection,
  calendarId: string,
  eventId: string,
): Promise<calendar_v3.Schema$Event | null> {
  const cal = await calClient(conn);
  try {
    const res = await cal.events.get({ calendarId, eventId });
    return res.data ?? null;
  } catch (e: unknown) {
    const code = (e as { code?: number })?.code;
    if (code === 404 || code === 410) return null;
    throw e;
  }
}

export async function freebusy(
  conn: GoogleOAuthConnection,
  calendarId: string,
  timeMin: Date,
  timeMax: Date
): Promise<BusySlot[]> {
  const cal = await calClient(conn);
  const res = await cal.freebusy.query({
    requestBody: {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      items: [{ id: calendarId }],
    },
  });
  const calendars = res.data.calendars ?? {};
  const target = calendars[calendarId];
  if (!target) return [];
  if (target.errors && target.errors.length > 0) {
    const reason = target.errors[0]!.reason ?? 'unknown';
    throw new GoogleApiError(403, `freebusy: ${reason}`);
  }
  return (target.busy ?? []).map((b) => ({
    start: b.start ?? '',
    end: b.end ?? '',
  }));
}

export async function getCalendarMetadata(
  conn: GoogleOAuthConnection,
  calendarId: string
): Promise<CalendarMetadata> {
  const cal = await calClient(conn);
  const res = await cal.calendars.get({ calendarId });
  return {
    id: res.data.id ?? calendarId,
    summary: res.data.summary ?? '',
    timeZone: res.data.timeZone ?? 'UTC',
  };
}

export type CalendarListItem = {
  id: string;
  summary: string;
  timeZone: string;
  primary: boolean;
  accessRole: string; // 'owner' | 'writer' | 'reader' | 'freeBusyReader'
  writable: boolean;  // true se accessRole permite events.insert
};

/**
 * Lista calendars acessíveis pelo usuário Google conectado.
 * Filtra apenas writable (owner/writer) — pra GUI mostrar opções válidas pro agente.
 */
export async function listCalendars(
  conn: GoogleOAuthConnection
): Promise<CalendarListItem[]> {
  const cal = await calClient(conn);
  const items: CalendarListItem[] = [];
  let pageToken: string | undefined;
  do {
    const res = await cal.calendarList.list({ pageToken, maxResults: 250 });
    for (const c of res.data.items ?? []) {
      const role = c.accessRole ?? 'reader';
      // summaryOverride reflete o nome que o usuário deu ao calendar no Google Calendar UI.
      // summary é o nome canônico server-side (pra primary, geralmente é o email).
      const name = c.summaryOverride ?? c.summary ?? '';
      items.push({
        id: c.id ?? '',
        summary: name,
        timeZone: c.timeZone ?? 'UTC',
        primary: c.primary ?? false,
        accessRole: role,
        writable: role === 'owner' || role === 'writer',
      });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return items;
}

export async function testAccess(
  conn: GoogleOAuthConnection,
  calendarId: string
): Promise<TestAccessResult> {
  try {
    const metadata = await getCalendarMetadata(conn, calendarId);
    return { ok: true, metadata };
  } catch (e) {
    const status = (e as { code?: number; status?: number; response?: { status?: number } })?.code
      ?? (e as { status?: number }).status
      ?? (e as { response?: { status?: number } }).response?.status;
    const msg = (e as Error).message ?? 'unknown';
    if (status === 401) return { ok: false, error: 'auth', detail: msg };
    if (status === 403) return { ok: false, error: 'not_shared', detail: msg };
    if (status === 404) return { ok: false, error: 'not_found', detail: msg };
    return { ok: false, error: 'unknown', detail: msg };
  }
}

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

async function calClient(conn: GoogleOAuthConnection): Promise<calendar_v3.Calendar> {
  const auth = await getAuthedOAuth2Client(conn);
  return google.calendar({ version: 'v3', auth });
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

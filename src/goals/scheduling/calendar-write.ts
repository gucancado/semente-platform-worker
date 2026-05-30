/**
 * ÚNICO arquivo do worker que escreve em googleapis.calendar.
 * (Read fica em goals/scheduling/google-calendar.ts da Entrega 2.)
 */

import { google, type calendar_v3 } from 'googleapis';
import { getAuthedOAuth2Client } from '../../integrations/google/client-factory.js';
import type { GoogleOAuthConnection } from '../../integrations/google/types.js';

export type HoldEventArgs = {
  calendarId: string;
  slotIso: string;          // start ISO 8601 com offset
  durationMin: number;
  label: string;            // título do evento
};

export type ConfirmEventArgs = {
  attendees: string[];
  summary: string;
  description?: string;
  conferenceRequestId: string;
};

export type CreateDirectEventArgs = HoldEventArgs & ConfirmEventArgs;

export type PatchEventArgs = {
  startIso?: string;
  endIso?: string;
  summary?: string;
  description?: string;
};

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

function addMinutes(iso: string, minutes: number): string {
  const d = new Date(iso);
  d.setTime(d.getTime() + minutes * 60 * 1000);
  return d.toISOString();
}

export async function createHold(
  conn: GoogleOAuthConnection,
  args: HoldEventArgs
): Promise<{ eventId: string }> {
  const cal = await calClient(conn);
  const endIso = addMinutes(args.slotIso, args.durationMin);
  const res = await cal.events.insert({
    calendarId: args.calendarId,
    requestBody: {
      summary: args.label,
      description: 'Reserva tentativa criada pelo agente. Expira em 30min ou é confirmada pelo lead.',
      start: { dateTime: args.slotIso },
      end: { dateTime: endIso },
      status: 'tentative',
      transparency: 'opaque',
    },
  });
  return { eventId: res.data.id ?? '' };
}

export async function confirmHold(
  conn: GoogleOAuthConnection,
  calendarId: string,
  eventId: string,
  args: ConfirmEventArgs
): Promise<{ meetLink: string | null }> {
  const cal = await calClient(conn);
  const res = await cal.events.patch({
    calendarId,
    eventId,
    conferenceDataVersion: 1,
    sendUpdates: 'all',
    requestBody: {
      status: 'confirmed',
      summary: args.summary,
      description: args.description,
      attendees: args.attendees.map((email) => ({ email })),
      conferenceData: {
        createRequest: {
          requestId: args.conferenceRequestId,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    },
  });
  const entryPoints = res.data.conferenceData?.entryPoints ?? [];
  const videoEntry = entryPoints.find((e) => e.entryPointType === 'video');
  return { meetLink: videoEntry?.uri ?? null };
}

export async function createEventDirect(
  conn: GoogleOAuthConnection,
  args: CreateDirectEventArgs
): Promise<{ eventId: string; meetLink: string | null }> {
  const cal = await calClient(conn);
  const endIso = addMinutes(args.slotIso, args.durationMin);
  const res = await cal.events.insert({
    calendarId: args.calendarId,
    conferenceDataVersion: 1,
    sendUpdates: 'all',
    requestBody: {
      summary: args.summary,
      description: args.description,
      start: { dateTime: args.slotIso },
      end: { dateTime: endIso },
      status: 'confirmed',
      attendees: args.attendees.map((email) => ({ email })),
      conferenceData: {
        createRequest: {
          requestId: args.conferenceRequestId,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    },
  });
  const entryPoints = res.data.conferenceData?.entryPoints ?? [];
  const videoEntry = entryPoints.find((e) => e.entryPointType === 'video');
  return { eventId: res.data.id ?? '', meetLink: videoEntry?.uri ?? null };
}

export async function patchEvent(
  conn: GoogleOAuthConnection,
  calendarId: string,
  eventId: string,
  args: PatchEventArgs
): Promise<void> {
  const cal = await calClient(conn);
  const requestBody: calendar_v3.Schema$Event = {};
  if (args.startIso) requestBody.start = { dateTime: args.startIso };
  if (args.endIso) requestBody.end = { dateTime: args.endIso };
  if (args.summary !== undefined) requestBody.summary = args.summary;
  if (args.description !== undefined) requestBody.description = args.description;
  await cal.events.patch({
    calendarId,
    eventId,
    sendUpdates: 'all',
    requestBody,
  });
}

/**
 * Lista eventos do calendar com title começando por `summaryPrefix`,
 * limitado à janela [timeMin, timeMax]. Usa events.list (já com `q` pra
 * filtragem server-side) e adiciona filtro client-side por prefixo exato
 * já que `q` é full-text fuzzy. Sem paginação — limit hard 250.
 */
export async function listEventsBySummaryPrefix(
  conn: GoogleOAuthConnection,
  calendarId: string,
  summaryPrefix: string,
  timeMin: Date,
  timeMax: Date
): Promise<Array<{ id: string; summary: string; start: string | null }>> {
  const cal = await calClient(conn);
  const res = await cal.events.list({
    calendarId,
    q: summaryPrefix,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    maxResults: 250,
  });
  const items = res.data.items ?? [];
  return items
    .filter((it) => typeof it.summary === 'string' && it.summary.startsWith(summaryPrefix) && typeof it.id === 'string')
    .map((it) => ({
      id: it.id!,
      summary: it.summary!,
      start: it.start?.dateTime ?? it.start?.date ?? null,
    }));
}

export async function deleteEvent(
  conn: GoogleOAuthConnection,
  calendarId: string,
  eventId: string,
  opts: { sendUpdates?: 'all' | 'none' } = {}
): Promise<void> {
  const cal = await calClient(conn);
  try {
    await cal.events.delete({
      calendarId,
      eventId,
      sendUpdates: opts.sendUpdates ?? 'all',
    });
  } catch (e) {
    const status = (e as { code?: number; status?: number; response?: { status?: number } })?.code
      ?? (e as { status?: number }).status
      ?? (e as { response?: { status?: number } }).response?.status;
    if (status === 404 || status === 410) {
      return; // já deletado externamente — swallow
    }
    throw e;
  }
}

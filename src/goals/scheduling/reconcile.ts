import type { Pool } from 'pg';
import type { calendar_v3 } from 'googleapis';
import { DateTime } from 'luxon';
import { enqueueReconcileTrigger } from '../../db.js';
import type { GoogleOAuthConnection } from '../../integrations/google/types.js';
import type { SchedulingAgenda } from '../../admin/db.js';

export type ReconcileDeps = {
  pool: Pool;
  getConn: (projectId: number) => Promise<GoogleOAuthConnection | null>;
  getAgenda: (projectId: number) => Promise<SchedulingAgenda | null>;
  getEvent: (
    conn: GoogleOAuthConnection,
    calendarId: string,
    eventId: string,
  ) => Promise<calendar_v3.Schema$Event | null>;
  now: () => Date;
  logger: { info: Function; warn: Function; error: Function };
};

export type ReconcileResult = {
  scanned: number;
  cancelled: number;
  moved: number;
  skipped: number;
};

const WINDOW_HOURS = 48;

type MeetingRow = {
  id: number;
  project_id: number;
  channel: string;
  identifier: string;
  slot_iso: string;
  google_event_id: string;
  status: string;
  agent: string;
  project_slug: string;
};

export async function reconcileMeetings(deps: ReconcileDeps): Promise<ReconcileResult> {
  const now = deps.now();
  const windowEnd = new Date(now.getTime() + WINDOW_HOURS * 60 * 60 * 1000);

  const res = await deps.pool.query<MeetingRow>(
    `SELECT m.id, m.project_id, m.channel, m.identifier,
            to_char(m.slot_iso, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS slot_iso,
            m.google_event_id, m.status,
            p.agent, p.slug AS project_slug
       FROM meetings m
       JOIN projects p ON p.id = m.project_id
      WHERE m.status IN ('scheduled', 'rescheduled')
        AND m.google_event_id IS NOT NULL
        AND m.slot_iso >= $1::timestamptz
        AND m.slot_iso <= $2::timestamptz`,
    [now.toISOString(), windowEnd.toISOString()],
  );

  const result: ReconcileResult = {
    scanned: res.rows.length,
    cancelled: 0,
    moved: 0,
    skipped: 0,
  };

  const scannedIds: number[] = [];

  for (const m of res.rows) {
    scannedIds.push(m.id);

    const conn = await deps.getConn(m.project_id);
    if (!conn) {
      deps.logger.info?.({ meeting_id: m.id }, 'reconcile: no_oauth_connection, skip');
      result.skipped += 1;
      continue;
    }
    const agenda = await deps.getAgenda(m.project_id);
    if (!agenda) {
      deps.logger.info?.({ meeting_id: m.id }, 'reconcile: no_active_agenda, skip');
      result.skipped += 1;
      continue;
    }

    let event: calendar_v3.Schema$Event | null;
    try {
      event = await deps.getEvent(conn, agenda.person_email, m.google_event_id);
    } catch (err) {
      deps.logger.warn?.({ err, meeting_id: m.id }, 'reconcile: getEvent error, skip');
      result.skipped += 1;
      continue;
    }

    if (!event || event.status === 'cancelled') {
      await handleCancelled(deps, m);
      result.cancelled += 1;
      continue;
    }

    const eventStart = event.start?.dateTime;
    if (!eventStart) {
      deps.logger.warn?.({ meeting_id: m.id }, 'reconcile: event sem start.dateTime, skip');
      result.skipped += 1;
      continue;
    }

    if (!isoEquals(eventStart, m.slot_iso)) {
      await handleMoved(deps, m, eventStart);
      result.moved += 1;
      continue;
    }
    // no-op: ainda válida
  }

  if (scannedIds.length > 0) {
    try {
      await deps.pool.query(
        `UPDATE meetings SET last_reconciled_at = NOW() WHERE id = ANY($1::bigint[])`,
        [scannedIds],
      );
    } catch (err) {
      deps.logger.warn?.({ err }, 'reconcile: batch UPDATE last_reconciled_at falhou');
    }
  }

  return result;
}

function isoEquals(a: string, b: string): boolean {
  try {
    const ma = DateTime.fromISO(a).toMillis();
    const mb = DateTime.fromISO(b).toMillis();
    if (Number.isNaN(ma) || Number.isNaN(mb)) return a === b;
    return ma === mb;
  } catch {
    return a === b;
  }
}

function formatHuman(iso: string): string {
  const dt = DateTime.fromISO(iso);
  if (!dt.isValid) return iso;
  const dd = String(dt.day).padStart(2, '0');
  const mm = String(dt.month).padStart(2, '0');
  const days = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  const dayName = days[dt.weekday % 7];
  const hh = String(dt.hour).padStart(2, '0');
  const min = String(dt.minute).padStart(2, '0');
  const timeStr = dt.minute === 0 ? `${hh}h` : `${hh}h${min}`;
  return `${dayName} (${dd}/${mm}) às ${timeStr}`;
}

async function handleCancelled(deps: ReconcileDeps, m: MeetingRow): Promise<void> {
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE meetings
          SET status = 'cancelled_by_organizer',
              cancelled_by = 'organizer',
              updated_at = NOW()
        WHERE id = $1`,
      [m.id],
    );
    await enqueueReconcileTrigger(client as any, {
      agent: m.agent,
      project: m.project_slug,
      identifier: m.identifier,
      payload: {
        event: 'cancelled_by_organizer',
        meeting_id: m.id,
        old_slot_iso: m.slot_iso,
      },
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function handleMoved(deps: ReconcileDeps, m: MeetingRow, newIso: string): Promise<void> {
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE meetings
          SET status = 'rescheduled_by_organizer',
              slot_iso = $2::timestamptz,
              slot_human = $3,
              updated_at = NOW()
        WHERE id = $1`,
      [m.id, newIso, formatHuman(newIso)],
    );
    await enqueueReconcileTrigger(client as any, {
      agent: m.agent,
      project: m.project_slug,
      identifier: m.identifier,
      payload: {
        event: 'moved_by_organizer',
        meeting_id: m.id,
        old_slot_iso: m.slot_iso,
        new_slot_iso: newIso,
      },
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

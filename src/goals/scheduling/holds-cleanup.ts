import type { FastifyBaseLogger } from 'fastify';
import { pool } from '../../db.js';
import { getConnectionByProjectId } from '../../integrations/google/db.js';
import { deleteEvent } from './calendar-write.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export type CleanupResult = {
  checked: number;
  deleted: number;
  google_errors: number;
};

export type CleanupDeps = {
  query: typeof pool.query;
  getConnectionByProjectId: typeof getConnectionByProjectId;
  deleteEvent: typeof deleteEvent;
};

const defaultDeps: CleanupDeps = {
  query: pool.query.bind(pool),
  getConnectionByProjectId,
  deleteEvent,
};

export async function cleanupExpiredHolds(
  logger?: FastifyBaseLogger,
  deps: CleanupDeps = defaultDeps
): Promise<CleanupResult> {
  // JOIN com scheduling_agendas pra obter person_email (calendarId onde o evento tentativo foi criado).
  const { rows } = await deps.query<{ id: number; project_id: number; google_event_id: string; person_email: string }>(
    `SELECT sh.id, sh.project_id, sh.google_event_id, sa.person_email
       FROM slot_holds sh JOIN scheduling_agendas sa ON sh.agenda_id = sa.id
      WHERE sh.expires_at < NOW() AND sh.consumed = FALSE
      LIMIT 200`
  );
  let deleted = 0;
  let googleErrors = 0;
  for (const row of rows) {
    try {
      const conn = await deps.getConnectionByProjectId(row.project_id);
      if (conn) {
        await deps.deleteEvent(conn, row.person_email, row.google_event_id, { sendUpdates: 'none' });
      }
    } catch (e) {
      googleErrors++;
      logger?.warn({ err: e, hold_id: row.id }, 'holds-cleanup: google delete failed');
    }
    await deps.query(`DELETE FROM slot_holds WHERE id = $1`, [row.id]);
    deleted++;
  }
  return { checked: rows.length, deleted, google_errors: googleErrors };
}

export function startHoldsCleanupCron(
  logger: FastifyBaseLogger,
  intervalMs: number = DEFAULT_INTERVAL_MS
): () => void {
  const tick = async () => {
    try {
      const result = await cleanupExpiredHolds(logger);
      if (result.checked > 0) {
        logger.info({ op: 'holds-cleanup', ...result }, 'holds cleanup tick');
      }
    } catch (e) {
      logger.error({ err: e }, 'holds-cleanup tick failed');
    }
  };
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}

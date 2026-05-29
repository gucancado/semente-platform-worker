import type { FastifyBaseLogger } from 'fastify';
import { pool } from '../../db.js';
import { getConnectionByProjectId } from '../../integrations/google/db.js';
import { listAgendas } from '../../admin/db.js';
import { getEvent } from './google-calendar.js';
import { reconcileMeetings, type ReconcileResult, type ReconcileDeps } from './reconcile.js';

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

type ReconcileFn = (deps: ReconcileDeps) => Promise<ReconcileResult>;
let _reconcileOverride: ReconcileFn | null = null;

/** Somente pra testes. */
export function _setReconcileForTest(fn: ReconcileFn | null): void {
  _reconcileOverride = fn;
}

async function runOnce(logger: FastifyBaseLogger): Promise<void> {
  const reconcile = _reconcileOverride ?? reconcileMeetings;
  const startedAt = Date.now();
  try {
    const result = await reconcile({
      pool,
      getConn: getConnectionByProjectId,
      getAgenda: async (projectId) => {
        const agendas = await listAgendas(projectId, { activeOnly: true });
        return agendas[0] ?? null;
      },
      getEvent,
      now: () => new Date(),
      logger,
    });
    logger.info(
      { ...result, duration_ms: Date.now() - startedAt },
      'reconcile: ciclo completo',
    );
  } catch (err) {
    logger.error(
      { err: (err as Error).message, duration_ms: Date.now() - startedAt },
      'reconcile: ciclo falhou',
    );
  }
}

export function startReconcileCron(
  logger: FastifyBaseLogger,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): void {
  void runOnce(logger);
  const handle = setInterval(() => void runOnce(logger), intervalMs);
  if (typeof (handle as any).unref === 'function') (handle as any).unref();
}

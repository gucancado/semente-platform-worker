// src/whatsapp/instance-outages.ts
import type { Pool } from 'pg';

export type OutageRow = {
  instance: string;
  startedAt: string;
  endedAt: string | null;
  startedAtSource: string;
  reason: string | null;
};

/** Teto de linhas por instância. Outage é raro (unidades, não milhares):
 *  bater neste teto é sinal de ANOMALIA — provavelmente episódio órfão
 *  reabrindo em loop — e o caller deve logar, não paginar. */
export const OUTAGE_PAGE_CAP = 200;

/**
 * `minClosedMs` descarta NO BANCO episódio fechado mais curto que isso — sem ele
 * as oscilações de segundos (centenas por número) ocupam o teto de linhas e
 * empurram as quedas reais mais antigas pra fora da leitura. Aberto sempre vem.
 */
export async function listOutagesByInstance(
  pool: Pool, instance: string, limit = OUTAGE_PAGE_CAP, minClosedMs = 0,
): Promise<OutageRow[]> {
  const { rows } = await pool.query(
    `SELECT instance, started_at, ended_at, started_at_source, reason
       FROM instance_outages
      WHERE instance = $1
        AND (ended_at IS NULL OR ended_at - started_at >= make_interval(secs => $3::double precision / 1000))
      ORDER BY started_at DESC
      LIMIT $2`,
    [instance, limit, minClosedMs],
  );
  return rows.map((r) => ({
    instance: r.instance,
    startedAt: r.started_at.toISOString(),
    endedAt: r.ended_at ? r.ended_at.toISOString() : null,
    startedAtSource: r.started_at_source,
    reason: r.reason ?? null,
  }));
}

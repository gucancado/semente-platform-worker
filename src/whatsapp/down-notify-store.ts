import type { Pool } from 'pg';

/**
 * Estado do aviso de queda ao próprio número — camada de banco (mig 064).
 *
 * O claim é OTIMISTA e versionado pela CONTAGEM de avisos, não pelo instante:
 * `down_notified_at` sai de NOW() com microssegundo e volta ao JS com
 * milissegundo, então comparar o timestamp falharia sempre depois do primeiro
 * aviso. A contagem só sobe dentro do próprio claim — é uma versão exata. É o
 * que impede dois ticks concorrentes (ou dois containers num rolling deploy) de
 * mandarem o mesmo aviso duas vezes.
 */

export type NotifyVersion = { lastNotifiedAt: Date | null; notifyCount: number };

export type DownNumberRow = NotifyVersion & {
  id: number;
  workspaceId: string;
  instance: string;
  phone: string;
  label: string | null;
  downSince: Date;
};

/** Números fora do ar com telefone conhecido — sem telefone não há para quem avisar. */
export async function listDownNumbers(pool: Pool): Promise<DownNumberRow[]> {
  const { rows } = await pool.query(
    `SELECT id, workspace_id, evolution_instance, phone, label,
            disconnected_since, down_notified_at, down_notify_count
       FROM whatsapp_numbers
      WHERE status <> 'connected'
        AND removed_at IS NULL
        AND disconnected_since IS NOT NULL
        AND phone IS NOT NULL
      ORDER BY id`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    workspaceId: r.workspace_id,
    instance: r.evolution_instance,
    phone: r.phone,
    label: r.label,
    downSince: r.disconnected_since,
    lastNotifiedAt: r.down_notified_at ?? null,
    notifyCount: Number(r.down_notify_count),
  }));
}

export async function claimNumberNotification(pool: Pool, id: number, prev: NotifyVersion): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE whatsapp_numbers
        SET down_notified_at = NOW(), down_notify_count = down_notify_count + 1
      WHERE id = $1 AND status <> 'connected' AND down_notify_count = $2`,
    [id, prev.notifyCount],
  );
  return rowCount === 1;
}

/** Devolve um claim cujo envio falhou de forma transitória — o próximo tick tenta de novo. */
export async function releaseNumberNotification(pool: Pool, id: number, prev: NotifyVersion): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_numbers
        SET down_notified_at = $3, down_notify_count = $2
      WHERE id = $1 AND down_notify_count = $2 + 1`,
    [id, prev.notifyCount, prev.lastNotifiedAt],
  );
}

export type SystemTarget = { instance: string; expectedPhone: string; label: string | null };

export type SystemVerdict = {
  down: boolean;
  reason: 'state' | 'store_stale' | null;
  state: string;
  ownStoreTs: Date | null;
  peerStoreTs: Date | null;
};

export type SystemHealthRow = NotifyVersion & {
  instance: string;
  expectedPhone: string;
  label: string | null;
  downSince: Date | null;
};

/**
 * Grava o veredito do tick e devolve o estado do episódio:
 *   saudável → fora : abre no início observado (ou NOW(), sem estimativa)
 *   fora → fora     : preserva o início — o episódio continua
 *   fora → saudável : encerra e zera o aviso (a próxima queda é episódio novo)
 */
export async function recordSystemHealth(
  pool: Pool,
  t: SystemTarget,
  v: SystemVerdict,
  observedDownSince: Date | null = null,
): Promise<SystemHealthRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialização por INSTÂNCIA. Não dá pra depender de `FOR UPDATE` na linha
    // de system_instance_health: no primeiro tick ela não existe, e travar
    // ausência não impede duas primeiras observações concorrentes.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [t.instance]);
    const { rows } = await client.query(
      `WITH prev AS (
         SELECT down_since FROM system_instance_health WHERE instance = $1
       ),
       ins AS (
         INSERT INTO system_instance_health
           (instance, expected_phone, label, last_state, last_reason, own_store_ts, peer_store_ts,
            checked_at, down_since, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(),
                 CASE WHEN $8::boolean THEN COALESCE($9::timestamptz, NOW()) END, NOW())
         ON CONFLICT (instance) DO UPDATE SET
           expected_phone    = EXCLUDED.expected_phone,
           label             = EXCLUDED.label,
           last_state        = EXCLUDED.last_state,
           last_reason       = EXCLUDED.last_reason,
           own_store_ts      = EXCLUDED.own_store_ts,
           peer_store_ts     = EXCLUDED.peer_store_ts,
           checked_at        = NOW(),
           updated_at        = NOW(),
           down_since        = CASE WHEN $8::boolean THEN COALESCE(system_instance_health.down_since, $9::timestamptz, NOW()) END,
           down_notified_at  = CASE WHEN $8::boolean THEN system_instance_health.down_notified_at END,
           down_notify_count = CASE WHEN $8::boolean THEN system_instance_health.down_notify_count ELSE 0 END
         RETURNING instance, expected_phone, label, down_since, down_notified_at, down_notify_count
       ),
       -- 'prev' lê o snapshot do INÍCIO do statement, então enxerga o down_since
       -- ANTERIOR mesmo com o INSERT acima já o sobrescrevendo. O INSERT segue
       -- com VALUES (não SELECT ... FROM prev): com prev vazia — primeiro tick de
       -- instância nova — o INSERT inteiro desapareceria e a observação se perderia.
       opened AS (
         INSERT INTO instance_outages (instance, kind, number_id, started_at, started_at_source, reason, detected_by)
         SELECT $1, 'system', NULL, COALESCE($9::timestamptz, NOW()),
                CASE WHEN $9::timestamptz IS NULL THEN 'detected_now' ELSE 'observed_store' END,
                $5, 'watch'
          WHERE $8::boolean AND (SELECT down_since FROM prev) IS NULL
         ON CONFLICT (instance) WHERE ended_at IS NULL DO NOTHING
       ),
       closed AS (
         UPDATE instance_outages o SET ended_at = NOW(), updated_at = NOW()
          WHERE o.instance = $1 AND o.ended_at IS NULL
            AND NOT $8::boolean AND (SELECT down_since FROM prev) IS NOT NULL
       )
       SELECT * FROM ins`,
      [t.instance, t.expectedPhone, t.label, v.state, v.reason, v.ownStoreTs, v.peerStoreTs, v.down, observedDownSince],
    );
    await client.query('COMMIT');
    const r = rows[0];
    return {
      instance: r.instance,
      expectedPhone: r.expected_phone,
      label: r.label,
      downSince: r.down_since ?? null,
      lastNotifiedAt: r.down_notified_at ?? null,
      notifyCount: Number(r.down_notify_count),
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function claimSystemNotification(pool: Pool, instance: string, prev: NotifyVersion): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE system_instance_health
        SET down_notified_at = NOW(), down_notify_count = down_notify_count + 1, updated_at = NOW()
      WHERE instance = $1 AND down_since IS NOT NULL AND down_notify_count = $2`,
    [instance, prev.notifyCount],
  );
  return rowCount === 1;
}

export async function releaseSystemNotification(pool: Pool, instance: string, prev: NotifyVersion): Promise<void> {
  await pool.query(
    `UPDATE system_instance_health
        SET down_notified_at = $3, down_notify_count = $2, updated_at = NOW()
      WHERE instance = $1 AND down_notify_count = $2 + 1`,
    [instance, prev.notifyCount, prev.lastNotifiedAt],
  );
}

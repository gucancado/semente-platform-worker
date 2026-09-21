import type { Pool } from 'pg';
import { planEpisode } from './down-notify.js';

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

/**
 * Perfil de tráfego do alvo — decide como o atraso do store é medido.
 *  - 'business_hours' (padrão): só fala em horário comercial (grupos de equipe,
 *    caso do saturno). O silêncio da noite e do fim de semana não conta.
 *  - 'always': recebe a qualquer hora; o atraso é medido pelo relógio de parede.
 */
export type SystemTraffic = 'business_hours' | 'always';

export type SystemTarget = { instance: string; expectedPhone: string; label: string | null; traffic?: SystemTraffic };

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
 * Grava o veredito do tick e devolve o estado do episódio. A transição é decidida
 * por `planEpisode` (pura, testada sem banco):
 *   saudável → fora        : SUSPEITA — anota o veredito, não abre episódio
 *   suspeita → fora        : abre no início observado (ou NOW(), sem estimativa)
 *   suspeita → saudável    : some sem rastro (era um soluço)
 *   episódio → fora        : preserva o início — o episódio continua
 *   episódio → saudável    : encerra e zera o aviso (a próxima queda é episódio novo)
 *
 * "O tick anterior viu fora" é `last_reason IS NOT NULL` da própria linha — o
 * veredito do tick anterior já mora ali, então a confirmação em dois ticks não
 * pede coluna nova. `down_since` nulo com `last_reason` preenchido = suspeita.
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
    // ausência não impede duas primeiras observações concorrentes. É este lock
    // que torna seguro ler o estado anterior e gravar o novo em statements
    // separados — ninguém mais escreve esta instância enquanto ele vale.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [t.instance]);
    const prev = (
      await client.query(`SELECT down_since, last_reason FROM system_instance_health WHERE instance = $1`, [t.instance])
    ).rows[0] as { down_since: Date | null; last_reason: string | null } | undefined;
    const plan = planEpisode({ downSince: prev?.down_since ?? null, sawDown: prev?.last_reason != null }, v.down);

    // LEAST(.., NOW()): início estimado no FUTURO (relógio da Evolution adiantado)
    // violaria `ended_at >= started_at` no fechamento, e o episódio nunca fecharia.
    const { rows } = await client.query(
      `INSERT INTO system_instance_health
         (instance, expected_phone, label, last_state, last_reason, own_store_ts, peer_store_ts,
          checked_at, down_since, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(),
               CASE WHEN $8 = 'open' THEN LEAST(COALESCE($9::timestamptz, NOW()), NOW()) END, NOW())
       ON CONFLICT (instance) DO UPDATE SET
         expected_phone    = EXCLUDED.expected_phone,
         label             = EXCLUDED.label,
         last_state        = EXCLUDED.last_state,
         last_reason       = EXCLUDED.last_reason,
         own_store_ts      = EXCLUDED.own_store_ts,
         peer_store_ts     = EXCLUDED.peer_store_ts,
         checked_at        = NOW(),
         updated_at        = NOW(),
         down_since        = CASE $8 WHEN 'open' THEN EXCLUDED.down_since
                                     WHEN 'keep' THEN system_instance_health.down_since END,
         down_notified_at  = CASE WHEN $8 = 'keep' THEN system_instance_health.down_notified_at END,
         down_notify_count = CASE WHEN $8 = 'keep' THEN system_instance_health.down_notify_count ELSE 0 END
       RETURNING instance, expected_phone, label, down_since, down_notified_at, down_notify_count`,
      [t.instance, t.expectedPhone, t.label, v.state, v.reason, v.ownStoreTs, v.peerStoreTs, plan, observedDownSince],
    );
    const r = rows[0];

    if (plan === 'open') {
      // O episódio nasce com o MESMO início gravado na saúde — copiado DENTRO do
      // banco: passar `r.down_since` pelo JS truncaria o NOW() de µs para ms e as
      // duas colunas deixariam de bater. A linha de saúde sempre existe aqui (o
      // upsert acima é desta mesma transação), então o SELECT nunca vem vazio.
      // ON CONFLICT: o índice único parcial garante um aberto por instância — um
      // órfão já aberto é mantido como o episódio.
      await client.query(
        `INSERT INTO instance_outages (instance, kind, number_id, started_at, started_at_source, reason, detected_by)
         SELECT h.instance, 'system', NULL, h.down_since, $2, $3, 'watch'
           FROM system_instance_health h
          WHERE h.instance = $1 AND h.down_since IS NOT NULL
         ON CONFLICT (instance) WHERE ended_at IS NULL DO NOTHING`,
        [t.instance, observedDownSince ? 'observed_store' : 'detected_now', v.reason],
      );
    } else if (plan === 'close') {
      await client.query(
        `UPDATE instance_outages SET ended_at = NOW(), updated_at = NOW()
          WHERE instance = $1 AND ended_at IS NULL`,
        [t.instance],
      );
    }

    await client.query('COMMIT');
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

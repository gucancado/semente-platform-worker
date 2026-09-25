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

/**
 * Números fora do ar com telefone conhecido — sem telefone não há para quem
 * avisar. Inclui o "zumbi": `status='connected'` (a Evolution/webhook nunca
 * viu queda) mas com episódio `probe` aberto (a sonda PROVOU que a sessão
 * morreu por dentro — spec §7). `downSince` = `started_at` do episódio aberto
 * quando houver (fonte `webhook` ou `probe`), senão `disconnected_since`.
 */
export async function listDownNumbers(pool: Pool): Promise<DownNumberRow[]> {
  const { rows } = await pool.query(
    `SELECT wn.id, wn.workspace_id, wn.evolution_instance, wn.phone, wn.label,
            COALESCE(o.started_at, wn.disconnected_since) AS down_since,
            wn.down_notified_at, wn.down_notify_count
       FROM whatsapp_numbers wn
       LEFT JOIN instance_outages o ON o.instance = wn.evolution_instance AND o.ended_at IS NULL
      WHERE wn.removed_at IS NULL AND wn.phone IS NOT NULL
        AND ( (wn.status <> 'connected' AND wn.disconnected_since IS NOT NULL)
              OR o.started_at_source = 'probe' )
      ORDER BY wn.id`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    workspaceId: r.workspace_id,
    instance: r.evolution_instance,
    phone: r.phone,
    label: r.label,
    downSince: r.down_since,
    lastNotifiedAt: r.down_notified_at ?? null,
    notifyCount: Number(r.down_notify_count),
  }));
}

/**
 * Reivindicação otimista do aviso. Além do `status <> 'connected'` de sempre,
 * aceita o zumbi: número `connected` com episódio `probe` aberto — a mesma
 * condição de `listDownNumbers`.
 */
export async function claimNumberNotification(pool: Pool, id: number, prev: NotifyVersion): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE whatsapp_numbers wn
        SET down_notified_at = NOW(), down_notify_count = wn.down_notify_count + 1
      WHERE wn.id = $1 AND wn.down_notify_count = $2
        AND ( wn.status <> 'connected'
              OR EXISTS (SELECT 1 FROM instance_outages o
                          WHERE o.instance = wn.evolution_instance AND o.ended_at IS NULL
                            AND o.started_at_source = 'probe') )`,
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

/** Intervalo do vigia quando o chamador não informa — o mesmo default do config. */
export const DEFAULT_WATCH_INTERVAL_MS = 300_000;

function toHealthRow(r: any): SystemHealthRow {
  return {
    instance: r.instance,
    expectedPhone: r.expected_phone,
    label: r.label,
    downSince: r.down_since ?? null,
    lastNotifiedAt: r.down_notified_at ?? null,
    notifyCount: Number(r.down_notify_count),
  };
}

/**
 * Grava o veredito da observação e devolve o estado do episódio. A transição é
 * decidida por `planEpisode` (pura, testada sem banco):
 *   saudável → fora              : SUSPEITA — anota o veredito, não abre episódio
 *   suspeita → fora, cedo demais : não grava NADA (o relógio da suspeita não renova)
 *   suspeita → fora, no prazo    : abre no início observado (ou na 1ª observação)
 *   suspeita → fora, velha demais: recomeça como primeira observação
 *   suspeita → saudável          : some sem rastro (era um soluço)
 *   episódio → fora              : preserva o início — o episódio continua
 *   episódio → saudável          : encerra e zera o aviso (a próxima queda é episódio novo)
 *
 * O estado da suspeita mora na própria linha, sem coluna nova: `last_reason`
 * preenchido com `down_since` nulo = suspeita, e `checked_at` = instante da
 * PRIMEIRA observação fora (é por isso que o 'hold' não pode regravar a linha).
 * A idade é medida com o NOW() do BANCO — o relógio do processo pode divergir.
 */
export async function recordSystemHealth(
  pool: Pool,
  t: SystemTarget,
  v: SystemVerdict,
  observedDownSince: Date | null = null,
  intervalMs: number = DEFAULT_WATCH_INTERVAL_MS,
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
      await client.query(
        `SELECT instance, expected_phone, label, down_since, down_notified_at, down_notify_count, last_reason,
                EXTRACT(EPOCH FROM (NOW() - checked_at)) * 1000 AS age_ms
           FROM system_instance_health WHERE instance = $1`,
        [t.instance],
      )
    ).rows[0];
    const plan = planEpisode(
      {
        downSince: prev?.down_since ?? null,
        sawDown: prev?.last_reason != null,
        ageMs: prev?.age_ms == null ? null : Number(prev.age_ms),
      },
      v.down,
      intervalMs,
    );

    if (plan === 'hold') {
      // Observação cedo demais para confirmar: a linha fica EXATAMENTE como está.
      await client.query('COMMIT');
      return toHealthRow(prev);
    }

    // Só 'open' e 'keep' carregam `down_since`, e nenhum dos dois acontece sem
    // linha anterior — por isso o ramo de INSERT grava sempre NULL.
    //
    // Início do episódio, na ordem: estimativa pelo store ($9) → instante da
    // PRIMEIRA observação fora (o `checked_at` antigo; no SET o lado direito
    // ainda enxerga a linha anterior) → agora. Sem o `checked_at`, o "desde" de
    // uma queda sem par à frente saía um intervalo atrasado.
    // LEAST(.., NOW()): início estimado no FUTURO (relógio da Evolution adiantado)
    // violaria `ended_at >= started_at` no fechamento, e o episódio nunca fecharia.
    const { rows } = await client.query(
      `INSERT INTO system_instance_health
         (instance, expected_phone, label, last_state, last_reason, own_store_ts, peer_store_ts,
          checked_at, down_since, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NULL, NOW())
       ON CONFLICT (instance) DO UPDATE SET
         expected_phone    = EXCLUDED.expected_phone,
         label             = EXCLUDED.label,
         last_state        = EXCLUDED.last_state,
         last_reason       = EXCLUDED.last_reason,
         own_store_ts      = EXCLUDED.own_store_ts,
         peer_store_ts     = EXCLUDED.peer_store_ts,
         checked_at        = NOW(),
         updated_at        = NOW(),
         down_since        = CASE $8::text
                               WHEN 'open' THEN LEAST(COALESCE($9::timestamptz, system_instance_health.checked_at, NOW()), NOW())
                               WHEN 'keep' THEN system_instance_health.down_since
                             END,
         down_notified_at  = CASE WHEN $8::text = 'keep' THEN system_instance_health.down_notified_at END,
         down_notify_count = CASE WHEN $8::text = 'keep' THEN system_instance_health.down_notify_count ELSE 0 END
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
    return toHealthRow(r);
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

import type { Pool } from 'pg';
import { nextDownSource, planEpisode } from './down-notify.js';
import type { Trigger } from './connection-probe.js';

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
                                  AND o.kind = 'number'
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
 *
 * ⚠️ Não é livre de corrida contra um `closeProbeEpisode` concorrente: sob READ
 * COMMITTED, o EvalPlanQual só reavalia a linha de `whatsapp_numbers` que o
 * UPDATE trava — o `EXISTS` continua vendo o snapshot antigo, então um claim que
 * começou antes do fechamento commitar ainda pode contar um aviso a mais (o
 * fechamento zera a contagem logo em seguida, e o `listDownNumbers` do próximo
 * tick já não devolve o número). Custo: no máximo um aviso atrasado.
 */
export async function claimNumberNotification(pool: Pool, id: number, prev: NotifyVersion): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE whatsapp_numbers wn
        SET down_notified_at = NOW(), down_notify_count = wn.down_notify_count + 1
      WHERE wn.id = $1 AND wn.down_notify_count = $2
        AND ( wn.status <> 'connected'
              OR EXISTS (SELECT 1 FROM instance_outages o
                          WHERE o.instance = wn.evolution_instance AND o.ended_at IS NULL
                            AND o.kind = 'number' AND o.started_at_source = 'probe') )`,
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
 *   episódio da SONDA            : mantém (a leitura saudável é o que mente no zumbi); fecha
 *                                  por tráfego real no store depois do início, em qualquer
 *                                  estado; passa a fonte 'state' quando a Evolution admite `close`
 *
 * `store_stale` NÃO pode chegar aqui como queda (lança): ele é só gatilho de sonda
 * — gravado como suspeita, o flap diário de 1s confirmaria direto (regressão 21/09).
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
  if (v.down && v.reason === 'store_stale') {
    throw new Error('recordSystemHealth: store_stale não é queda — é gatilho de sonda (openSystemProbeEpisode)');
  }
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
        `SELECT instance, expected_phone, label, down_since, down_source, down_notified_at, down_notify_count,
                last_reason, EXTRACT(EPOCH FROM (NOW() - checked_at)) * 1000 AS age_ms,
                -- Tráfego REAL depois do início do episódio E da última leitura gravada
                -- (a segunda condição segura store com relógio adiantado, cuja "última
                -- mensagem" já estava à frente do início). Comparado aqui dentro: o
                -- início pode sair de NOW() com µs e não pode passar pelo JS.
                ($2::timestamptz IS NOT NULL AND down_since IS NOT NULL
                 AND $2::timestamptz > down_since
                 AND (own_store_ts IS NULL OR $2::timestamptz > own_store_ts)) AS traffic_after
           FROM system_instance_health WHERE instance = $1`,
        [t.instance, v.ownStoreTs],
      )
    ).rows[0];
    const prevSource: 'state' | 'probe' | null = prev?.down_source ?? null;
    const plan = planEpisode(
      {
        downSince: prev?.down_since ?? null,
        sawDown: prev?.last_reason != null,
        ageMs: prev?.age_ms == null ? null : Number(prev.age_ms),
        downSource: prevSource,
        trafficAfterDown: prev?.traffic_after === true,
      },
      v.down,
      intervalMs,
    );
    const source = nextDownSource(plan, prevSource, v.state);

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
         down_source       = $10::text,
         down_notified_at  = CASE WHEN $8::text = 'keep' THEN system_instance_health.down_notified_at END,
         down_notify_count = CASE WHEN $8::text = 'keep' THEN system_instance_health.down_notify_count ELSE 0 END
       RETURNING instance, expected_phone, label, down_since, down_notified_at, down_notify_count`,
      [t.instance, t.expectedPhone, t.label, v.state, v.reason, v.ownStoreTs, v.peerStoreTs, plan, observedDownSince, source],
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

/**
 * A SONDA confirmou a queda de uma instância de sistema (spec 2026-09-25 §7):
 * abre o episódio com `down_source='probe'` — que a leitura `open` do tick seguinte
 * MANTÉM (`planEpisode`) — e o `instance_outages` de fonte `probe`, sob o MESMO lock
 * de `recordSystemHealth` (as duas escritas nunca se cruzam).
 *
 * Início = `LEAST(COALESCE(startedAt, firstSentAt), firstSentAt, NOW())`: a última
 * mensagem de tráfego real, se o chamador souber, nunca depois do 1º envio da sonda
 * nem no futuro (relógio da Evolution adiantado violaria `ended_at >= started_at`).
 *
 * Episódio já aberto (de estado, ou desta mesma sonda) é mantido como está — a
 * instância já está documentada como fora; a contagem de aviso só zera quando abre.
 * O `instance_outages` copia `down_since` DENTRO do banco (µs), com `ON CONFLICT
 * DO NOTHING` pelo índice único parcial de episódio aberto.
 */
export async function openSystemProbeEpisode(
  pool: Pool,
  t: SystemTarget,
  startedAt: Date | null,
  firstSentAt: Date,
  trigger: Trigger,
): Promise<SystemHealthRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [t.instance]);
    const { rows } = await client.query(
      `INSERT INTO system_instance_health
         (instance, expected_phone, label, checked_at, down_since, down_source,
          down_notified_at, down_notify_count, updated_at)
       VALUES ($1, $2, $3, NOW(),
               LEAST(COALESCE($4::timestamptz, $5::timestamptz), $5::timestamptz, NOW()),
               'probe', NULL, 0, NOW())
       ON CONFLICT (instance) DO UPDATE SET
         down_source       = CASE WHEN system_instance_health.down_since IS NULL THEN 'probe'
                                  ELSE system_instance_health.down_source END,
         down_notified_at  = CASE WHEN system_instance_health.down_since IS NULL THEN NULL
                                  ELSE system_instance_health.down_notified_at END,
         down_notify_count = CASE WHEN system_instance_health.down_since IS NULL THEN 0
                                  ELSE system_instance_health.down_notify_count END,
         down_since        = COALESCE(system_instance_health.down_since, EXCLUDED.down_since),
         updated_at        = NOW()
       RETURNING instance, expected_phone, label, down_since, down_source, down_notified_at, down_notify_count`,
      [t.instance, t.expectedPhone, t.label, startedAt, firstSentAt],
    );
    // Só quando o episódio é desta sonda: um episódio de estado já aberto tem o seu.
    await client.query(
      `INSERT INTO instance_outages (instance, kind, number_id, started_at, started_at_source, reason, detected_by)
       SELECT h.instance, 'system', NULL, h.down_since, 'probe', $2, 'probe'
         FROM system_instance_health h
        WHERE h.instance = $1 AND h.down_since IS NOT NULL AND h.down_source = 'probe'
       ON CONFLICT (instance) WHERE ended_at IS NULL DO NOTHING`,
      [t.instance, trigger],
    );
    await client.query('COMMIT');
    return toHealthRow(rows[0]);
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

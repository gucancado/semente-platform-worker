import type { Pool } from 'pg';
import type { MessageKey } from '../evolution/client.js';
import type { CloudStatus, Trigger, Verdict, ProbeHistory } from './connection-probe.js';

/**
 * Camada de banco da sonda de conexão (mig 068, tabela `connection_probes`).
 * Ver spec 2026-09-25-sonda-conexao-whatsapp-design.md §6, §9, §10, §12.
 *
 * Idades sempre pelo `NOW()` do BANCO (`EXTRACT(EPOCH FROM (NOW() -
 * COALESCE(sent_at, created_at))) * 1000`) — nunca comparar timestamp do
 * banco com `Date.now()` do processo (relógio local ~40s atrasado no dev).
 */

export type ProbeRow = {
  id: number;
  instance: string;
  kind: 'number' | 'system';
  numberId: number | null;
  phone: string;
  label: string | null;
  code: string;
  parentId: number | null;
  trigger: Trigger;
  wamid: string | null;
  sentAt: Date | null;
  cloudStatus: CloudStatus | null;
  receivedAt: Date | null;
  msgKey: MessageKey | null;
  /** `null` = ainda em aberto. Distingue "recebida mas ainda sem veredito" (`receivedAt` preenchido, `verdict` null) de "aberta e nada chegou". */
  verdict: Verdict | null;
  ageMs: number;
};

const ROW_SELECT = `id, instance, kind, number_id, phone, label, code, parent_id, trigger, wamid, sent_at,
  cloud_status, received_at, msg_key, verdict,
  EXTRACT(EPOCH FROM (NOW() - COALESCE(sent_at, created_at))) * 1000 AS age_ms`;

function mapProbeRow(r: any): ProbeRow {
  return {
    id: Number(r.id),
    instance: r.instance,
    kind: r.kind,
    numberId: r.number_id == null ? null : Number(r.number_id),
    phone: r.phone,
    label: r.label,
    code: r.code,
    parentId: r.parent_id == null ? null : Number(r.parent_id),
    trigger: r.trigger,
    wamid: r.wamid,
    sentAt: r.sent_at,
    cloudStatus: r.cloud_status,
    receivedAt: r.received_at,
    msgKey: r.msg_key,
    verdict: r.verdict,
    ageMs: Number(r.age_ms),
  };
}

/**
 * Serializa erro/objeto arbitrário para JSONB. `name`/`message` de `Error`
 * são explícitos porque não são enumeráveis (`JSON.stringify(err)` cru daria
 * `'{}'`); o spread depois cobre propriedades próprias adicionais que um
 * erro customizado tenha atribuído (ex.: `.code`), sem perder `name`/`message`
 * caso alguma delas também exista como própria.
 */
function toJsonbParam(v: unknown): string {
  if (v instanceof Error) {
    const { name, message, ...rest } = v as Error & Record<string, unknown>;
    return JSON.stringify({ name, message, ...rest });
  }
  return JSON.stringify(v ?? null);
}

/**
 * Cria uma sonda sob `pg_advisory_xact_lock(hashtextextended(instance,0))`
 * (mesmo lock de `recordSystemHealth`). O índice único parcial
 * `uq_connection_probes_open` é a 2ª barreira contra dois containers
 * sondando a mesma instância no mesmo tick — `23505` vira `null` (nenhuma
 * sonda nova), nunca exceção. Unicidade do `code` é responsabilidade do
 * chamador (`takenCodes`); aqui não é validada.
 */
export async function createProbe(
  pool: Pool,
  p: {
    instance: string;
    kind: 'number' | 'system';
    numberId: number | null;
    phone: string;
    label: string | null;
    trigger: Trigger;
    parentId?: number | null;
    code: string;
  },
): Promise<ProbeRow | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [p.instance]);
    const { rows } = await client.query(
      `INSERT INTO connection_probes (instance, kind, number_id, phone, label, code, parent_id, trigger)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${ROW_SELECT}`,
      [p.instance, p.kind, p.numberId, p.phone, p.label, p.code, p.parentId ?? null, p.trigger],
    );
    await client.query('COMMIT');
    return mapProbeRow(rows[0]);
  } catch (e: any) {
    await client.query('ROLLBACK');
    if (e?.code === '23505') return null;
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Grava o resultado do envio. Com `sendError` preenchido, o veredito É
 * DECIDIDO ALI (`send_failed`) — mas só se a sonda ainda estiver em aberto E
 * sem recebimento. O sender pode estourar o timeout de 15s DEPOIS de a Meta
 * já ter aceitado o envio — o HTTP falha, mas a mensagem foi entregue, e o
 * webhook de recebimento é independente desse timeout e pode já ter batido
 * (`recordProbeReceipt`) antes desta chamada terminar. Sem o CASE,
 * `send_failed` sobrescreveria uma sonda já recebida (ou com outro veredito
 * já gravado), inclusive um `alive` que o recebimento ainda não teve chance
 * de materializar via `setVerdict`.
 */
export async function markProbeSent(
  pool: Pool,
  id: number,
  p: { wamid: string | null; mirrorWamid: string | null; sendError: unknown | null },
): Promise<void> {
  if (p.sendError != null) {
    await pool.query(
      `UPDATE connection_probes
          SET wamid = $2, mirror_wamid = $3, sent_at = NOW(), send_error = $4::jsonb,
              verdict = CASE WHEN verdict IS NULL AND received_at IS NULL THEN 'send_failed' ELSE verdict END,
              verdict_at = CASE WHEN verdict IS NULL AND received_at IS NULL THEN NOW() ELSE verdict_at END
        WHERE id = $1`,
      [id, p.wamid, p.mirrorWamid, toJsonbParam(p.sendError)],
    );
  } else {
    await pool.query(
      `UPDATE connection_probes SET wamid = $2, mirror_wamid = $3, sent_at = NOW() WHERE id = $1`,
      [id, p.wamid, p.mirrorWamid],
    );
  }
}

/**
 * Grava o `wamid` do espelho ao operador, DEPOIS de `markProbeSent` já ter gravado
 * o do alvo. Separado de propósito: o `delivered` do alvo chega em ~1s (medido:
 * enviado 7s, entregue 8s) e `recordCloudStatuses` casa por `wamid` — se o do alvo
 * só fosse gravado depois do envio do espelho, esse status se perderia.
 */
export async function markProbeMirrorSent(pool: Pool, id: number, mirrorWamid: string): Promise<void> {
  await pool.query(`UPDATE connection_probes SET mirror_wamid = $2 WHERE id = $1`, [id, mirrorWamid]);
}

/**
 * Recebimento (inbound) da mensagem de teste. Casa por `(instance, code)`
 * nos últimos 7 dias, preferindo a sonda ABERTA (`verdict IS NULL`) quando o
 * código se repete dentro da janela — o código é único por instância nos
 * últimos 7 dias (garantido pelo chamador via `takenCodes`), mas nada aqui
 * impede duas linhas com o mesmo texto de código coexistirem na janela, e
 * "preferir a aberta" é o desempate seguro para esse caso. Idempotente:
 * `COALESCE` preserva o primeiro `received_at`/`msg_key` gravado. Recebimento
 * TARDIO (após veredito já definido) também é aceito — é o que sustenta a
 * corrida com `setVerdict` (spec §6): o texto chegou, então a sonda não
 * estava morta.
 */
export async function recordProbeReceipt(
  pool: Pool,
  instance: string,
  code: string,
  key: MessageKey,
): Promise<ProbeRow | null> {
  const { rows } = await pool.query(
    `UPDATE connection_probes
        SET received_at = COALESCE(received_at, NOW()),
            msg_key = COALESCE(msg_key, $3::jsonb)
      WHERE id = (
        SELECT id FROM connection_probes
         WHERE instance = $1 AND code = $2 AND created_at > NOW() - INTERVAL '7 days'
         ORDER BY (verdict IS NULL) DESC, created_at DESC
         LIMIT 1
      )
      RETURNING ${ROW_SELECT}`,
    [instance, code, JSON.stringify(key)],
  );
  return rows[0] ? mapProbeRow(rows[0]) : null;
}

/**
 * Status de entrega do Cloud API para o `wamid` (sonda ou espelho). O
 * ranking mora no SQL (não em `cloudStatusRank`) para não regredir sob
 * concorrência: ler-decidir-gravar em dois passos deixaria uma janela para
 * um status mais antigo, atrasado na fila do webhook, sobrescrever um mais
 * novo. `failed` grava `cloud_error`; outros preservam o que já havia.
 * Devolve quantas linhas foram efetivamente atualizadas.
 */
export async function recordCloudStatuses(
  pool: Pool,
  statuses: { id: string; status: string; errors: unknown[] }[],
): Promise<number> {
  let updated = 0;
  for (const s of statuses) {
    const { rowCount } = await pool.query(
      `UPDATE connection_probes SET cloud_status = $2, cloud_status_at = NOW(),
              cloud_error = CASE WHEN $2 = 'failed' THEN $3::jsonb ELSE cloud_error END
        WHERE wamid = $1
          AND (CASE $2 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 4 ELSE 0 END)
            > (CASE cloud_status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 4 ELSE 0 END)`,
      [s.id, s.status, toJsonbParam(s.errors ?? [])],
    );
    updated += rowCount ?? 0;
  }
  return updated;
}

/** Sondas em aberto (`verdict IS NULL`) — usado pelo tick para avaliar veredito. */
export async function listOpenProbes(pool: Pool): Promise<ProbeRow[]> {
  const { rows } = await pool.query(
    `SELECT ${ROW_SELECT} FROM connection_probes WHERE verdict IS NULL ORDER BY created_at`,
  );
  return rows.map(mapProbeRow);
}

/**
 * Grava o veredito de uma sonda, idempotente entre containers. Dois
 * caminhos, conforme `verdict`:
 *
 * - **`'alive'` (positivo)**: o chamador já SABE que a mensagem foi
 *   recebida (ou decidiu por outro motivo direto) — não há corrida a
 *   arbitrar, só idempotência. Grava sempre que `verdict IS NULL`, com ou
 *   sem `received_at` preenchido (não é condição aqui: quem chama com
 *   `'alive'` não precisa que o recebimento já tenha sido registrado nesta
 *   tabela). `rowCount=1` → `'set'`; já tinha veredito → `'already'`
 *   (nunca `'received'` — esse resultado é exclusivo do caminho negativo).
 *
 * - **qualquer outro valor (negativo)**: só grava se ainda
 *   `verdict IS NULL AND received_at IS NULL`. Se a 1ª UPDATE não pegar
 *   ninguém, relê: se enquanto isso a mensagem chegou (`received_at`
 *   preenchido, sem veredito ainda — a corrida do spec §6), o resultado
 *   correto é `'alive'`, NUNCA o veredito negativo que o chamador tentou
 *   gravar — devolve `'received'`. Se já havia veredito, devolve
 *   `'already'`.
 */
export async function setVerdict(
  pool: Pool,
  id: number,
  verdict: Verdict,
  extra?: { storeSeen?: boolean },
): Promise<'set' | 'received' | 'already'> {
  if (verdict === 'alive') {
    const { rowCount } = await pool.query(
      `UPDATE connection_probes SET verdict = 'alive', verdict_at = NOW(), store_seen = COALESCE($2, store_seen)
        WHERE id = $1 AND verdict IS NULL`,
      [id, extra?.storeSeen ?? null],
    );
    return rowCount === 1 ? 'set' : 'already';
  }

  const upd = await pool.query(
    `UPDATE connection_probes SET verdict = $2, verdict_at = NOW(), store_seen = COALESCE($3, store_seen)
      WHERE id = $1 AND verdict IS NULL AND received_at IS NULL`,
    [id, verdict, extra?.storeSeen ?? null],
  );
  if (upd.rowCount === 1) return 'set';
  const alive = await pool.query(
    `UPDATE connection_probes SET verdict = 'alive', verdict_at = NOW(), store_seen = COALESCE($2, store_seen)
      WHERE id = $1 AND verdict IS NULL AND received_at IS NOT NULL`,
    [id, extra?.storeSeen ?? null],
  );
  return alive.rowCount === 1 ? 'received' : 'already';
}

/**
 * Veredito EFETIVO para o histórico: sonda recebida é `alive`, qualquer que seja o
 * veredito gravado. O recebimento TARDIO (depois de um `down`/`inconclusive`) fecha
 * o episódio mas não reescreve `verdict`; sem isto o cooldown de `decideTrigger`
 * leria `down`, não bloquearia e uma sonda nova sairia no tick seguinte — até 3
 * pares/dia com episódio e aviso novos. O instante é o do evento mais recente.
 */
const EFFECTIVE_VERDICT = `(CASE WHEN received_at IS NOT NULL THEN 'alive' ELSE verdict END)`;
const EFFECTIVE_AT = `GREATEST(verdict_at, received_at)`;

/**
 * Histórico usado por `decideTrigger` (connection-probe.ts, puro) para
 * decidir se sonda de novo. `lastVerdict` EXCLUI `repeated`: é estado
 * intermediário da 1ª sonda de um par — quem carrega o desfecho real é a
 * sonda filha (`parent_id` apontando pra ela), então `repeated` no topo do
 * histórico não deveria contar como "o último veredito conhecido" para
 * cooldown nem para a sequência de `consecutiveInconclusive`.
 */
export async function probeHistory(pool: Pool, instance: string): Promise<ProbeHistory> {
  const [openRes, lastVerdictRes, primaryRes, quietRes, sequenceRes] = await Promise.all([
    pool.query(`SELECT EXISTS(SELECT 1 FROM connection_probes WHERE instance = $1 AND verdict IS NULL) AS has_open`, [
      instance,
    ]),
    pool.query(
      `SELECT ${EFFECTIVE_VERDICT} AS verdict, EXTRACT(EPOCH FROM (NOW() - ${EFFECTIVE_AT})) * 1000 AS age_ms
         FROM connection_probes
        WHERE instance = $1 AND verdict IS NOT NULL AND ${EFFECTIVE_VERDICT} <> 'repeated'
        ORDER BY ${EFFECTIVE_AT} DESC, id DESC
        LIMIT 1`,
      [instance],
    ),
    pool.query(
      `SELECT count(*)::int AS n FROM connection_probes
        WHERE instance = $1 AND parent_id IS NULL AND created_at > NOW() - INTERVAL '24 hours'`,
      [instance],
    ),
    pool.query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - COALESCE(sent_at, created_at))) * 1000 AS age_ms
         FROM connection_probes
        WHERE instance = $1 AND parent_id IS NULL AND trigger = 'quiet'
        ORDER BY created_at DESC
        LIMIT 1`,
      [instance],
    ),
    pool.query(
      `SELECT ${EFFECTIVE_VERDICT} AS verdict FROM connection_probes
        WHERE instance = $1 AND verdict IS NOT NULL AND ${EFFECTIVE_VERDICT} <> 'repeated'
        ORDER BY ${EFFECTIVE_AT} DESC, id DESC
        LIMIT 50`,
      [instance],
    ),
  ]);

  let consecutiveInconclusive = 0;
  for (const r of sequenceRes.rows) {
    if (r.verdict !== 'inconclusive') break;
    consecutiveInconclusive++;
  }

  return {
    hasOpen: openRes.rows[0].has_open === true,
    lastVerdict: lastVerdictRes.rows[0]
      ? { verdict: lastVerdictRes.rows[0].verdict as Verdict, ageMs: Number(lastVerdictRes.rows[0].age_ms) }
      : null,
    primaryCount24h: Number(primaryRes.rows[0].n),
    lastQuietAgeMs: quietRes.rows[0] ? Number(quietRes.rows[0].age_ms) : null,
    consecutiveInconclusive,
  };
}

/** Códigos já usados pela instância nos últimos 7 dias — para gerar um código novo sem colisão. */
export async function takenCodes(pool: Pool, instance: string): Promise<Set<string>> {
  const { rows } = await pool.query(
    `SELECT code FROM connection_probes WHERE instance = $1 AND created_at > NOW() - INTERVAL '7 days'`,
    [instance],
  );
  return new Set(rows.map((r) => r.code as string));
}

/**
 * Abre o episódio de queda de um NÚMERO confirmado pela sonda (`instance_outages`,
 * `kind='number'`, `started_at_source='probe'`, `detected_by='probe'`, `reason`=gatilho
 * que levou à sonda). Ver spec §7 "Números de atendimento".
 *
 * `started_at` é o mais cedo entre o início estimado (última mensagem de tráfego
 * real do store, se o chamador souber) e o envio da 1ª sonda — nunca no futuro
 * (`LEAST(..., NOW())`): início estimado adiantado violaria `ended_at >= started_at`
 * no fechamento (mesma proteção de `recordSystemHealth`).
 *
 * `ON CONFLICT (instance) WHERE ended_at IS NULL DO NOTHING`: a 2ª sonda do mesmo
 * par (`repeated` → `down`) não abre um segundo episódio, e um episódio `webhook`
 * já aberto (número caiu por transição de estado antes de a sonda concluir)
 * também bloqueia — a instância já está documentada como fora do ar.
 */
export async function openNumberProbeEpisode(
  pool: Pool,
  p: { instance: string; numberId: number; startedAt: Date | null; firstSentAt: Date; trigger: Trigger },
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO instance_outages (instance, kind, number_id, started_at, started_at_source, reason, detected_by)
     VALUES ($1, 'number', $2,
             LEAST(COALESCE($3::timestamptz, $4::timestamptz), $4::timestamptz, NOW()),
             'probe', $5, 'probe')
     ON CONFLICT (instance) WHERE ended_at IS NULL DO NOTHING`,
    [p.instance, p.numberId, p.startedAt, p.firstSentAt, p.trigger],
  );
  return rowCount === 1;
}

/**
 * Fecha o episódio ABERTO de fonte `probe` da instância — nunca um episódio
 * `webhook` (aquele segue as regras de `updateNumberStatus`/`closeOpenOutage`).
 * `ended_at = GREATEST(NOW(), started_at)` protege o CHECK `ended_at >= started_at`
 * do mesmo jeito que `closeOpenOutage` em `numbers.ts`.
 *
 * Se o episódio fechado for de NÚMERO (`kind='number'`), zera `down_notified_at`/
 * `down_notify_count` do número na MESMA instrução (CTE) — atômico com o
 * fechamento, como todo fechamento de episódio de número (spec §7).
 *
 * Se for de SISTEMA (`kind='system'`), zera na mesma instrução o episódio e o aviso
 * em `system_instance_health` (`down_since`, `down_source`, contagem) — senão o
 * tick seguinte leria o episódio `probe` ainda aberto na saúde e o manteria (`keep`).
 * A saúde de fonte `probe` é zerada mesmo sem `instance_outages` de fonte `probe`
 * a fechar: um episódio ÓRFÃO de outra fonte aberto faz o insert da sonda cair no
 * `DO NOTHING`, e sem isto a saúde ficaria presa em `probe` para sempre.
 */
export async function closeProbeEpisode(pool: Pool, instance: string): Promise<boolean> {
  const { rows } = await pool.query(
    `WITH closed AS (
       UPDATE instance_outages
          SET ended_at = GREATEST(NOW(), started_at), updated_at = NOW()
        WHERE instance = $1 AND ended_at IS NULL AND started_at_source = 'probe'
        RETURNING kind, number_id, instance),
     zeroed AS (
       UPDATE whatsapp_numbers wn
          SET down_notified_at = NULL, down_notify_count = 0
         FROM closed
        WHERE closed.kind = 'number' AND wn.id = closed.number_id
        RETURNING wn.id),
     sys AS (
       UPDATE system_instance_health h
          SET down_since = NULL, down_source = NULL, down_notified_at = NULL, down_notify_count = 0,
              updated_at = NOW()
        WHERE h.instance = $1
          AND (h.down_source = 'probe' OR EXISTS (SELECT 1 FROM closed WHERE closed.kind = 'system'))
        RETURNING h.instance)
     SELECT (SELECT count(*) FROM closed)::int + (SELECT count(*) FROM sys)::int AS n`,
    [instance],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * Episódio `probe` aberto da instância, se houver. Usado pelo lado sistema
 * (Task 8) para decidir a transição de `planEpisode` quando a fonte da queda
 * é a sonda, não o estado da Evolution.
 */
export async function openProbeEpisodeOf(
  pool: Pool,
  instance: string,
): Promise<{ startedAt: Date; kind: 'number' | 'system' } | null> {
  const { rows } = await pool.query(
    `SELECT started_at, kind FROM instance_outages
      WHERE instance = $1 AND ended_at IS NULL AND started_at_source = 'probe'
      LIMIT 1`,
    [instance],
  );
  return rows[0] ? { startedAt: rows[0].started_at, kind: rows[0].kind } : null;
}

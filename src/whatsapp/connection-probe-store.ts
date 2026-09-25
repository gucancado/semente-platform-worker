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
      `SELECT verdict, EXTRACT(EPOCH FROM (NOW() - verdict_at)) * 1000 AS age_ms
         FROM connection_probes
        WHERE instance = $1 AND verdict IS NOT NULL AND verdict <> 'repeated'
        ORDER BY verdict_at DESC, id DESC
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
      `SELECT verdict FROM connection_probes
        WHERE instance = $1 AND verdict IS NOT NULL AND verdict <> 'repeated'
        ORDER BY verdict_at DESC, id DESC
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

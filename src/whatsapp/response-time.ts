/**
 * src/whatsapp/response-time.ts
 * Tempo de resposta do atendimento, POR VEZ DO CLIENTE (não só a 1ª resposta).
 *
 * Uma "vez" começa na mensagem do cliente que vem depois de uma nossa (ou que
 * abre a conversa) e termina na nossa próxima mensagem. Mensagens seguidas do
 * cliente são a MESMA vez: ele está esperando desde a primeira delas. Medir só a
 * 1ª resposta da conversa (first-response.ts) esconde o atendente que responde
 * rápido no "oi" e some depois.
 *
 * O TEMPO é medido só nas vezes que COMEÇAM no horário comercial
 * (business-hours.ts: seg–sex, 09h–18h de São Paulo, fora feriado nacional),
 * contado em minutos de expediente. Vez que começa fora do expediente entra nas
 * contagens (vezes, sem resposta) mas não no tempo: contada em expediente ela
 * valeria 0 min (respondida antes de abrir) e, em número que atende à noite,
 * puxava a mediana pra zero (medido: mediana 0 em 2 dos 3 maiores números);
 * contada em relógio corrido, a mensagem das 23h respondida às 9h valeria 10h.
 *
 * Regras de entrada (iguais às de first-response.ts e do board):
 *  - LIVE-ONLY: created_at de backfill é outra base de tempo;
 *  - DM-only: grupo é ruidoso pra SLA;
 *  - figurinha não abre nem fecha vez (um 👍 final não pode virar "sem resposta");
 *  - resposta em menos de AUTO_REPLY_SECONDS é automática e não fecha a vez.
 *
 * Janela (since/until) recorta pelo INÍCIO da vez; a resposta pode vir depois de
 * `until`. Mensagens anteriores a `since` são lidas com folga de 30 dias só pra
 * saber se a mensagem do cliente continua uma vez já aberta.
 *
 * Payload agregado: sem identifier e sem texto (minimização LGPD).
 */
import type { Pool } from 'pg';
import { DateTime } from 'luxon';
import { businessMsBetween, isWithinBusinessHours } from './business-hours.js';
import { AUTO_REPLY_SECONDS } from './auto-reply.js';

export { AUTO_REPLY_SECONDS };

/** Meta de resposta (minutos de expediente) do card "% respondidas em até…". */
export const RESPONSE_SLA_MINUTES = 15;
/** Folga pra trás que decide se a mensagem do cliente continua uma vez já aberta. */
const LOOKBACK_DAYS = 30;

export interface ResponseTurn {
  /** Início da vez (1ª mensagem do cliente sem resposta). */
  startAt: Date;
  /** Nossa resposta, ou null se ainda não houve. */
  respondedAt: Date | null;
  /** A vez abre a conversa (nenhuma mensagem antes dela). */
  isFirstContact: boolean;
}

export interface ResponseTimeDay {
  /** Dia de São Paulo (yyyy-MM-dd) em que a vez começou. */
  date: string;
  turns: number;
  unanswered: number;
  /** Respondidas que começaram no expediente: a base do tempo (média = sumMinutes / timed). */
  timed: number;
  /** Das `timed`, respondidas em até RESPONSE_SLA_MINUTES de expediente. */
  withinSla: number;
  /** Σ minutos de expediente das `timed`. */
  sumMinutes: number;
}

export interface ResponseTimeStats {
  slaMinutes: number;
  /** Todas as vezes do cliente no período. */
  turns: number;
  answered: number;
  /** Vezes ainda sem resposta nossa. */
  unanswered: number;
  /** Vezes que começaram fora do expediente (fora do tempo). */
  offHours: number;
  /** Respondidas que começaram no expediente: a base de todas as medidas de tempo. */
  timed: number;
  withinSla: number;
  /** % das `timed` que saíram em até slaMinutes (0–100), null sem nenhuma. */
  withinSlaPct: number | null;
  medianMinutes: number | null;
  avgMinutes: number | null;
  p90Minutes: number | null;
  /** Mediana só das vezes que abrem a conversa (1º contato), mesmo recorte de expediente. */
  firstResponseMedianMinutes: number | null;
  firstContacts: number;
  series: ResponseTimeDay[];
}

const round1 = (v: number | null): number | null => (v == null ? null : Math.round(v * 10) / 10);

/** Percentil com interpolação linear (= PERCENTILE_CONT do Postgres). */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (b - a) * (idx - lo);
}

/** Agregação PURA (testada sem banco). */
export function aggregateResponseTurns(
  turns: readonly ResponseTurn[],
  slaMinutes = RESPONSE_SLA_MINUTES,
): ResponseTimeStats {
  const durations: number[] = [];
  const firstDurations: number[] = [];
  const byDay = new Map<string, ResponseTimeDay>();
  let answered = 0;
  let offHours = 0;
  let withinSla = 0;
  let firstContacts = 0;

  for (const t of turns) {
    const date = DateTime.fromJSDate(t.startAt, { zone: 'America/Sao_Paulo' }).toFormat('yyyy-MM-dd');
    let day = byDay.get(date);
    if (!day) {
      day = { date, turns: 0, unanswered: 0, timed: 0, withinSla: 0, sumMinutes: 0 };
      byDay.set(date, day);
    }
    day.turns++;
    if (t.isFirstContact) firstContacts++;
    const inHours = isWithinBusinessHours(t.startAt);
    if (!inHours) offHours++;
    if (!t.respondedAt) {
      day.unanswered++;
      continue;
    }
    answered++;
    if (!inHours) continue;
    const minutes = businessMsBetween(t.startAt, t.respondedAt) / 60_000;
    durations.push(minutes);
    if (t.isFirstContact) firstDurations.push(minutes);
    day.timed++;
    day.sumMinutes += minutes;
    if (minutes <= slaMinutes) {
      withinSla++;
      day.withinSla++;
    }
  }

  durations.sort((a, b) => a - b);
  firstDurations.sort((a, b) => a - b);
  const timed = durations.length;
  const sum = durations.reduce((s, v) => s + v, 0);
  const series = [...byDay.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ ...d, sumMinutes: Math.round(d.sumMinutes * 10) / 10 }));

  return {
    slaMinutes,
    turns: turns.length,
    answered,
    unanswered: turns.length - answered,
    offHours,
    timed,
    withinSla,
    withinSlaPct: timed > 0 ? round1((withinSla / timed) * 100) : null,
    medianMinutes: round1(percentile(durations, 0.5)),
    avgMinutes: timed > 0 ? round1(sum / timed) : null,
    p90Minutes: round1(percentile(durations, 0.9)),
    firstResponseMedianMinutes: round1(percentile(firstDurations, 0.5)),
    firstContacts,
    series,
  };
}

/**
 * Vezes do cliente no escopo. `$1`=workspace, `$2`=número|null, `$3`=since,
 * `$4`=until. A resposta (`next_out`) é procurada até AGORA, sem teto em until.
 *
 * Passos: `base` lê a janela (com folga) e marca a conversa de grupo (alguma
 * mensagem com author); `tagged` tira figurinha e grupo e anota a mensagem
 * anterior; `real` descarta a resposta automática; `seq` recalcula a anterior
 * sem ela e acha a próxima resposta. A próxima resposta é um MIN acumulado em
 * ordem DESCENDENTE com o quadro começando em UNBOUNDED PRECEDING — o Postgres
 * soma isso incrementalmente; com "1 FOLLOWING até o fim" ele refazia o
 * agregado a cada linha (quadrático: 870 ms de 1,7 s no número de maior volume).
 */
export const RESPONSE_TURNS_SQL = `
  WITH base AS (
    SELECT m.id, m.whatsapp_number_id AS nid, m.identifier, m.direction, m.created_at, m.kind,
           bool_or(m.author IS NOT NULL) OVER (PARTITION BY m.whatsapp_number_id, m.identifier) AS is_group
      FROM messages m
     WHERE m.workspace_id = $1
       AND ($2::int IS NULL OR m.whatsapp_number_id = $2)
       AND m.ingest_source = 'live'
       AND m.created_at >= $3::timestamptz - interval '${LOOKBACK_DAYS} days'
  ),
  tagged AS (
    SELECT b.id, b.nid, b.identifier, b.direction, b.created_at,
           LAG(b.direction) OVER w AS prev_dir,
           LAG(b.created_at) OVER w AS prev_at
      FROM base b
     WHERE NOT b.is_group
       AND b.kind IS DISTINCT FROM 'sticker'
       AND b.direction IN ('inbound', 'outbound')
    WINDOW w AS (PARTITION BY b.nid, b.identifier ORDER BY b.created_at, b.id)
  ),
  real AS (
    SELECT t.id, t.nid, t.identifier, t.direction, t.created_at
      FROM tagged t
     WHERE NOT (t.direction = 'outbound' AND t.prev_dir = 'inbound'
                AND t.created_at - t.prev_at < interval '${AUTO_REPLY_SECONDS} seconds')
  ),
  seq AS (
    SELECT r.nid, r.identifier, r.direction, r.created_at,
           LAG(r.direction) OVER (PARTITION BY r.nid, r.identifier ORDER BY r.created_at, r.id) AS prev_dir,
           MIN(r.created_at) FILTER (WHERE r.direction = 'outbound') OVER (
             PARTITION BY r.nid, r.identifier ORDER BY r.created_at DESC, r.id DESC
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
           ) AS next_out
      FROM real r
  )
  SELECT s.created_at AS start_at, s.next_out AS responded_at,
         (s.prev_dir IS NULL AND NOT EXISTS (
            SELECT 1 FROM messages mo
             WHERE mo.whatsapp_number_id = s.nid AND mo.identifier = s.identifier
               AND mo.created_at < s.created_at
         )) AS is_first_contact
    FROM seq s
   WHERE s.direction = 'inbound'
     AND s.prev_dir IS DISTINCT FROM 'inbound'
     AND s.created_at >= $3::timestamptz
     AND ($4::timestamptz IS NULL OR s.created_at <= $4::timestamptz)
     AND NOT EXISTS (
       SELECT 1 FROM whatsapp_groups g WHERE g.whatsapp_number_id = s.nid AND g.jid = s.identifier
     )`;

export async function getResponseTime(
  pool: Pool,
  p: { workspaceId: string; numberId?: number; since: string; until?: string },
): Promise<ResponseTimeStats> {
  const res = await pool.query(RESPONSE_TURNS_SQL, [p.workspaceId, p.numberId ?? null, p.since, p.until ?? null]);
  const turns: ResponseTurn[] = res.rows.map((r: any) => ({
    startAt: new Date(r.start_at),
    respondedAt: r.responded_at ? new Date(r.responded_at) : null,
    isFirstContact: r.is_first_contact === true,
  }));
  return aggregateResponseTurns(turns);
}

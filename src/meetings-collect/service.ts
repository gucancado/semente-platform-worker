import type { Pool } from 'pg';
import type { VexaClient, VexaMeeting } from '../integrations/vexa/client.js';
import type { CollectedMeetingRow } from './db.js';
import { updateCollectedMeeting, listQueuedMeetings, countActiveCollections } from './db.js';
import { vexaMeetingToEpisodeInput, episodeHasEnoughContent } from '../integrations/vexa/normalize.js';
import type { insertEpisodeWithTurns } from '../episodes/db.js';
import { appendStatusLog, silentRoomDetail, truncateDetail, vexaFailedDetail } from './diagnostics.js';
import { sttAffectedSince, type HealthState } from '../openai-health/core.js';

/** Por que uma coleta vai para a transcrição pela gravação (mig 071). */
export type RecoveryReason = 'silent_room' | 'partial';

export type MeetingsCollectDeps = {
  pool: Pool;
  vexa: Pick<VexaClient, 'sendBot' | 'getTranscript' | 'stopBot'>;
  putAndVerify: (key: string, body: string, contentType: string) => Promise<void>;
  insertEpisode: typeof insertEpisodeWithTurns;
  inactivityStopMin: number;
  admissionTimeoutMin: number;
  botName: string;
  maxConcurrent: number;
  queueMaxWaitMin: number;
  now: () => Date;
  log?: { warn: (o: unknown, m?: string) => void; info: (o: unknown, m?: string) => void };
  /** Estado da conta OpenAI (a MESMA da transcrição ao vivo da Vexa). Ausente =
   *  comportamento antigo: silêncio derruba o bot. */
  sttHealth?: () => Promise<{ state: HealthState; lastDownAt: Date | null }>;
  /** Teto de permanência na sala com a conta fora (o bot não sai por silêncio). */
  sttDownMaxMin?: number;
  /** Encaminha a coleta para a transcrição pela gravação. Ausente = não encaminha. */
  enqueueRecovery?: (row: CollectedMeetingRow, reason: RecoveryReason) => Promise<void>;
};

/** A transcrição ao vivo desta coleta foi afetada por queda da conta OpenAI?
 *  Erro ao ler o estado = "não" (cai no comportamento antigo, nunca trava). */
async function sttAffected(deps: MeetingsCollectDeps, row: CollectedMeetingRow): Promise<boolean> {
  if (!deps.sttHealth) return false;
  try {
    const h = await deps.sttHealth();
    return sttAffectedSince(h, new Date(row.started_at ?? row.created_at));
  } catch (err) {
    deps.log?.warn?.({ id: row.id, err: (err as Error).message }, 'meetings-collect: estado da OpenAI ilegível');
    return false;
  }
}

async function enqueueRecoverySafe(deps: MeetingsCollectDeps, row: CollectedMeetingRow, reason: RecoveryReason): Promise<void> {
  if (!deps.enqueueRecovery) return;
  try { await deps.enqueueRecovery(row, reason); }
  catch (err) { deps.log?.warn?.({ id: row.id, err: (err as Error).message }, 'meetings-collect: falha ao encaminhar para recuperação'); }
}

/**
 * Expira e promove a fila de coletas. Chamado pelo POST (resposta imediata
 * quando há slot) e por TODO tick do poller. Nunca lança — falha de sendBot
 * marca a row e segue; a promoção é sequencial (fila curta, sem paralelismo).
 */
export async function promoteQueuedMeetings(deps: MeetingsCollectDeps): Promise<{ promoted: number; expired: number }> {
  let promoted = 0; let expired = 0;
  // Contrato "Nunca lança": envolve TODA a rotina de expirar+promover. Qualquer erro de DB
  // (listQueuedMeetings, countActiveCollections, updateCollectedMeeting) é engolido aqui e a
  // função retorna os counts acumulados até o ponto do erro. Racional: é chamada em todo tick
  // do poller (um erro de DB não pode derrubar o tick) e no caminho do POST — que faz sua
  // PRÓPRIA re-leitura da row depois; se o DB estiver realmente fora, essa re-leitura falha e
  // o POST 500a de qualquer forma, então engolir aqui não mascara erro real do POST.
  try {
    const now = deps.now();
    const queued = await listQueuedMeetings(deps.pool);
    for (const row of queued) {
      const limit = row.queue_expires_at ?? new Date(row.created_at.getTime() + deps.queueMaxWaitMin * 60_000);
      if (limit < now) {
        await updateCollectedMeeting(deps.pool, row.id, { status: 'failed', failureReason: 'no_slot' });
        expired++;
      }
    }
    for (const row of await listQueuedMeetings(deps.pool)) {
      if ((await countActiveCollections(deps.pool)) >= deps.maxConcurrent) break;
      // sendBot preserva o comportamento atual: falha marca a row failed/vexa_send_failed e SEGUE
      // pra próxima da fila (não conta como erro fatal da rotina).
      try {
        const meeting = await deps.vexa.sendBot(row.meet_code, deps.botName, 'pt');
        // started_at é a âncora do timeout de admissão (processCollectedMeeting). Relógio
        // do worker, o mesmo que o poller usa pra medir — não NOW() do banco.
        await updateCollectedMeeting(deps.pool, row.id, { status: 'collecting', vexaMeetingId: meeting.id, startedAt: deps.now() });
        promoted++;
      } catch (err) {
        // A mensagem já traz HTTP status + corpo (VexaClient.req) — é o que separa
        // "outro bot já na sala" de Vexa fora do ar.
        await updateCollectedMeeting(deps.pool, row.id, {
          status: 'failed', failureReason: 'vexa_send_failed', failureDetail: truncateDetail((err as Error).message),
        });
        deps.log?.warn?.({ id: row.id, err: (err as Error).message }, 'meetings-collect: sendBot falhou na promoção');
      }
    }
  } catch (err) {
    deps.log?.warn?.({ err: (err as Error).message }, 'meetings-collect: promoteQueuedMeetings falhou');
  }
  return { promoted, expired };
}

function lastSegmentDate(meeting: VexaMeeting): Date | null {
  if (!meeting.segments?.length) return null;
  const maxEnd = Math.max(...meeting.segments.map((s) => s.end));
  return new Date(maxEnd * 1000);
}

/**
 * R2 (JSON bruto) ANTES, TX depois. Idempotente: insertEpisode dedup por (external_source, external_id).
 *
 * Funil ÚNICO de importação (3 chamadores) — por isso o piso mora aqui e não
 * nos call sites: abaixo dele a coleta vira `silent_room` em vez de episódio.
 */
export async function importCollectedMeeting(
  deps: MeetingsCollectDeps, row: CollectedMeetingRow, meeting: VexaMeeting,
): Promise<void> {
  const rawKey = `vexa/${meeting.id}.json`;
  const input = vexaMeetingToEpisodeInput(meeting, rawKey);
  if (!episodeHasEnoughContent(input)) {
    // Mesmo rótulo do caminho sem NENHUM segment: é o mesmo fenômeno (ninguém
    // falou), só que com um ruído no meio. Não sobe o JSON bruto — o log do bot
    // já é a evidência, e um objeto no R2 sem episódio é lixo órfão.
    await updateCollectedMeeting(deps.pool, row.id, {
      status: 'failed', failureReason: 'silent_room', vexaMeetingId: meeting.id,
      failureDetail: truncateDetail(`abaixo do piso de fala: ${input.turns.length} turnos; ultimo_status_vexa=${meeting.status}`),
    });
    deps.log?.info?.(
      { id: row.id, turns: input.turns.length },
      'meetings-collect: abaixo do piso de fala; não importado',
    );
    // Sem fala TRANSCRITA não quer dizer sem fala: com a transcrição ao vivo
    // quebrada a sala inteira conversa e nada chega aqui. A recuperação mede a
    // fala na gravação e decide.
    await enqueueRecoverySafe(deps, row, 'silent_room');
    return;
  }
  await deps.putAndVerify(rawKey, JSON.stringify(meeting), 'application/json');
  input.title = row.title ?? null; // título vem da entidade (agenda/painel), não do Vexa
  input.workspace_id = row.workspace_id;
  input.attribution_method = 'manual';
  const r = await deps.insertEpisode(input);
  await updateCollectedMeeting(deps.pool, row.id, {
    status: 'imported', episodeId: r.id, vexaMeetingId: meeting.id, failureReason: null,
  });
  // A conta caiu durante a reunião: a transcrição ao vivo está incompleta. A
  // recuperação refaz pela gravação e SUBSTITUI o episódio (mesma chave).
  if (await sttAffected(deps, row)) await enqueueRecoverySafe(deps, row, 'partial');
}

/**
 * Grava o status do Vexa visto neste tick; na MUDANÇA, anexa à trilha e loga.
 * Escrita própria (e não pega carona no update de cada ramo) porque o ramo
 * `completed` importa por outro caminho e o ramo de progresso nem sempre escreve —
 * o custo é 1 UPDATE por coleta ativa por minuto (≤ VEXA_MAX_CONCURRENT rows).
 * O poller é o único escritor de status_log, então ler-mexer-gravar não corre.
 */
async function recordVexaStatus(deps: MeetingsCollectDeps, row: CollectedMeetingRow, meeting: VexaMeeting): Promise<void> {
  const at = deps.now();
  const status = typeof meeting.status === 'string' ? meeting.status : 'desconhecido';
  const segments = meeting.segments?.length ?? 0;
  const changed = row.vexa_status !== status;
  await updateCollectedMeeting(deps.pool, row.id, {
    vexaStatus: status, vexaStatusAt: at,
    ...(changed ? { statusLog: appendStatusLog(row.status_log, { at: at.toISOString(), status, segments }) } : {}),
  });
  if (changed) {
    deps.log?.info?.(
      { id: row.id, meet_code: row.meet_code, de: row.vexa_status ?? null, para: status, segments },
      'meetings-collect: status vexa mudou',
    );
  }
}

export async function processCollectedMeeting(deps: MeetingsCollectDeps, row: CollectedMeetingRow): Promise<void> {
  let meeting: VexaMeeting;
  try {
    meeting = await deps.vexa.getTranscript(row.meet_code);
  } catch (err) {
    deps.log?.warn({ id: row.id, err: (err as Error).message }, 'getTranscript falhou; tenta no próximo tick');
    return;
  }

  await recordVexaStatus(deps, row, meeting);

  const now = deps.now().getTime();
  const lastSeg = lastSegmentDate(meeting);
  const hasSegments = (meeting.segments?.length ?? 0) > 0;

  if (meeting.status === 'failed') {
    await deps.vexa.stopBot(row.meet_code).catch(() => {});
    await updateCollectedMeeting(deps.pool, row.id, {
      status: 'failed', failureReason: 'vexa_failed', vexaMeetingId: meeting.id, failureDetail: vexaFailedDetail(meeting),
    });
    return;
  }

  if (meeting.status === 'completed') {
    await importCollectedMeeting(deps, row, meeting);
    return;
  }

  const startedMs = new Date(row.started_at ?? row.created_at).getTime();
  const sttMaxMs = (deps.sttDownMaxMin ?? 180) * 60_000;

  if (hasSegments) {
    const idleMs = now - (lastSeg ?? new Date(row.created_at)).getTime();
    // Silêncio de segmentos com a conta OpenAI fora não é silêncio da sala: a
    // transcrição parou, a reunião não. Fica até o teto; a gravação cobre o resto.
    if (idleMs > deps.inactivityStopMin * 60_000 && now - startedMs < sttMaxMs && await sttAffected(deps, row)) {
      await updateCollectedMeeting(deps.pool, row.id, { lastSegmentAt: lastSeg, vexaMeetingId: meeting.id });
      return;
    }
    if (idleMs > deps.inactivityStopMin * 60_000) {
      await deps.vexa.stopBot(row.meet_code).catch(() => {});
      await importCollectedMeeting(deps, row, meeting);
      return;
    }
    // segue coletando; registra progresso
    await updateCollectedMeeting(deps.pool, row.id, { lastSegmentAt: lastSeg, vexaMeetingId: meeting.id });
    return;
  }

  // Zero segments por `admissionTimeoutMin`. O rótulo é `silent_room` porque é
  // o que a condição de fato mede: ninguém falou. Chamava-se `not_admitted` e
  // isso mentia — desde o bot autenticado a admissão leva ~1s, e o carimbo
  // aparecia em sala vazia, sala muda e STT quebrado indistintamente, mandando
  // o diagnóstico pro lado errado. Rows antigas com `not_admitted` seguem no
  // banco (a causa real delas é ambígua); os mapas de rótulo traduzem as duas.
  //
  // Âncora = quando o bot foi ENVIADO (`started_at`, gravado na promoção), não quando
  // a coleta foi PEDIDA (`created_at`): desde a fila (mig 048), uma coleta que esperou
  // vaga morria aqui no mesmo tick em que ganhou o slot. Rows anteriores à mig 065
  // não têm `started_at` — pra elas `created_at` era a âncora certa.
  const waitedMs = now - startedMs;
  if (waitedMs > deps.admissionTimeoutMin * 60_000) {
    // Conta OpenAI fora: zero segmento é o esperado mesmo com a sala cheia. Até
    // 02/10/2026 o bot saía aqui com a reunião acontecendo, um bot novo entrava,
    // e os minutos entre os dois se perdiam. Fica até o teto; a gravação vira
    // transcrição depois (recuperação).
    if (waitedMs < sttMaxMs && await sttAffected(deps, row)) {
      await updateCollectedMeeting(deps.pool, row.id, { vexaMeetingId: meeting.id });
      return;
    }
    await deps.vexa.stopBot(row.meet_code).catch(() => {});
    await updateCollectedMeeting(deps.pool, row.id, {
      status: 'failed', failureReason: 'silent_room', vexaMeetingId: meeting.id,
      failureDetail: silentRoomDetail(meeting.status ?? null, waitedMs),
    });
    await enqueueRecoverySafe(deps, { ...row, vexa_meeting_id: meeting.id } as CollectedMeetingRow, 'silent_room');
    return;
  }
  await updateCollectedMeeting(deps.pool, row.id, { vexaMeetingId: meeting.id });
}

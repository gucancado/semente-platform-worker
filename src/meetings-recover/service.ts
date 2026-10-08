/**
 * src/meetings-recover/service.ts
 *
 * Transcrição pela GRAVAÇÃO de uma coleta cuja transcrição ao vivo falhou. É o
 * procedimento manual que recuperou 8 reuniões em 02–07/10/2026, virado job:
 *
 *   gravação do bot (Vexa) → mede fala → pedaços de 4 min → diarização com
 *   amostras de voz de quem o bot viu falar → episódio pelo funil único
 *   (`insertEpisodeWithTurns`, que já enfileira o digest) + áudio no R2.
 *
 * Por que não reaproveita a transcrição ao vivo: ela é exatamente o que falhou.
 */
import type { Pool } from 'pg';
import type { VexaClient } from '../integrations/vexa/client.js';
import type { insertEpisodeWithTurns } from '../episodes/db.js';
import { vexaMeetingToEpisodeInput, episodeHasEnoughContent, parseVexaTimestamp } from '../integrations/vexa/normalize.js';
import { audioKeyFor, pickAudioRecording } from '../meetings-audio/core.js';
import { classifySummaryError } from '../meetings-summary/error-class.js';
import { updateCollectedMeeting } from '../meetings-collect/db.js';
import type { HealthState } from '../openai-health/core.js';
import {
  CHUNK_S, MIN_SPEECH_S, MAX_REFS, UNKNOWN_SPEAKER, chunkStarts, nameLabels, pickReferenceClips, toRelativeActivity,
  type DiarSeg,
} from './core.js';
import {
  finishRecovery, retryRecovery, listSpeakerActivity, type RecoveryJob,
} from './db.js';
import type { RecordingFile } from './audio.js';

export const MAX_ATTEMPTS = 3;
const ITEM_BACKOFF_SEC = 600;
const SYSTEMIC_BACKOFF_SEC = 900;
/** O bot só sobe a gravação ao sair da sala; o job pode chegar antes. */
const NOT_READY_BACKOFF_SEC = 300;
const NOT_READY_MAX_H = 24;
const SYSTEMIC_MAX_AGE_H = 720;
const NEW_PREFIX = '__voz_nova__:';

export type Transcribe = (
  mp3: Buffer,
  refs: Array<{ name: string; wav: Buffer }>,
) => Promise<{ segments: DiarSeg[] }>;

export type RecoverDeps = {
  pool: Pool;
  vexa: Pick<VexaClient, 'listRecordings' | 'downloadRecordingAudio' | 'getMeeting'>;
  /** Repara (gravação sem cabeçalho) + remux (duração/índice). */
  remux: (b: Buffer) => Promise<{ bytes: Buffer; durationS: number | null }>;
  openRecording: (webm: Buffer) => Promise<RecordingFile>;
  transcribe: Transcribe;
  put: (key: string, body: Buffer | string, contentType: string) => Promise<void>;
  insertEpisode: typeof insertEpisodeWithTurns;
  health: () => Promise<{ state: HealthState }>;
  model: string;
  now: () => Date;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
};

export type RecoverResult = 'done' | 'no_speech' | 'retry' | 'failed';

export async function processRecoveryJob(deps: RecoverDeps, job: RecoveryJob): Promise<RecoverResult> {
  const id = job.collected_meeting_id;
  const ageH = (deps.now().getTime() - new Date(job.created_at).getTime()) / 3_600_000;

  // Conta fora: tentar agora só queimaria tentativas. Não conta como tentativa.
  if ((await deps.health()).state === 'down') {
    await retryRecovery(deps.pool, id, { backoffSec: SYSTEMIC_BACKOFF_SEC, consumeAttempt: false, error: 'conta OpenAI fora' });
    return 'retry';
  }
  const vexaId = job.vexa_meeting_id;
  if (vexaId == null) {
    await finishRecovery(deps.pool, id, { status: 'failed', error: 'coleta sem vexa_meeting_id' });
    return 'failed';
  }

  let rec: RecordingFile | null = null;
  try {
    const picked = pickAudioRecording(await deps.vexa.listRecordings(), vexaId);
    if (!picked) {
      if (ageH < NOT_READY_MAX_H) {
        await retryRecovery(deps.pool, id, { backoffSec: NOT_READY_BACKOFF_SEC, consumeAttempt: false, error: 'gravação ainda não disponível' });
        return 'retry';
      }
      await finishRecovery(deps.pool, id, { status: 'failed', error: 'sem gravação na Vexa' });
      return 'failed';
    }
    const raw = await deps.vexa.downloadRecordingAudio(picked.recordingId, picked.mediaFileId);
    const { bytes: webm, durationS } = await deps.remux(raw);
    if (!durationS || durationS <= 0) throw new Error('gravação ilegível (sem duração)');
    rec = await deps.openRecording(webm);

    const speech = await rec.speechSeconds(durationS);
    if (speech < MIN_SPEECH_S) {
      await finishRecovery(deps.pool, id, { status: 'no_speech', speechSeconds: speech });
      deps.log?.info({ id, vexaId, speech }, 'meetings-recover: gravação sem conversa');
      return 'no_speech';
    }

    // Início da gravação = entrada do bot ≈ start_time da reunião na Vexa
    // (medido <1 s em 25/09). É a âncora da linha do tempo de falantes.
    const vm = await deps.vexa.getMeeting(vexaId).catch(() => null);
    const recStart = parseVexaTimestamp(vm?.start_time ?? null) ?? new Date(job.started_at ?? job.requested_at);
    const activity = toRelativeActivity(await listSpeakerActivity(deps.pool, vexaId), recStart);

    // Referências: com linha do tempo, os nomes reais desde o 1º pedaço; sem ela,
    // cada voz nova ganha "Falante N" e vira referência dos pedaços seguintes.
    const refs: Array<{ name: string; wav: Buffer }> = [];
    for (const c of pickReferenceClips(activity, durationS)) {
      refs.push({ name: c.name, wav: await rec.clipWav(c.startS, c.lenS) });
    }
    const segments: Array<{ start: number; end: number; text: string; language: string; speaker: string }> = [];
    const t0 = recStart.getTime() / 1000;

    for (const cs of chunkStarts(durationS)) {
      const len = Math.min(CHUNK_S, durationS - cs);
      const mp3 = await rec.chunkMp3(cs, len);
      const res = await deps.transcribe(mp3, refs);
      const names = nameLabels(res.segments, cs, activity, refs.map((r) => r.name), (label) => `${NEW_PREFIX}${label}`);
      // Sem linha do tempo: voz nova só ganha nome ("Falante N") se virar
      // referência (máx 4) — é o que mantém o mesmo nome nos pedaços seguintes.
      // Voz que não cabe vira "Não identificado": numerar cada letra solta
      // fragmentava uma reunião de 5 pessoas em 16 "falantes" (Natura, 02/10).
      for (const [label, provisional] of names) {
        if (!provisional.startsWith(NEW_PREFIX)) continue;
        const best = res.segments.filter((s) => s.speaker === label).sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
        if (refs.length < MAX_REFS && best && best.end - best.start >= 2) {
          const name = `Falante ${refs.length + 1}`;
          refs.push({ name, wav: await rec.clipWav(cs + best.start, Math.min(8, best.end - best.start)) });
          names.set(label, name);
        } else {
          names.set(label, UNKNOWN_SPEAKER);
        }
      }
      for (const s of res.segments) {
        const text = (s.text ?? '').trim();
        if (!text) continue;
        segments.push({ start: t0 + cs + s.start, end: t0 + cs + s.end, text, language: 'pt', speaker: names.get(s.speaker) ?? s.speaker });
      }
    }
    segments.sort((a, b) => a.start - b.start);

    const meeting = {
      id: vexaId, platform: 'google_meet', native_meeting_id: job.meet_code, status: 'completed',
      start_time: recStart.toISOString(), end_time: new Date((t0 + durationS) * 1000).toISOString(), segments,
    };
    const rawKey = `vexa/recovered/${vexaId}.json`;
    const input = vexaMeetingToEpisodeInput(meeting, rawKey);
    if (!episodeHasEnoughContent(input)) {
      await finishRecovery(deps.pool, id, { status: 'no_speech', speechSeconds: speech });
      return 'no_speech';
    }
    input.title = job.title ?? null;
    input.workspace_id = job.workspace_id;
    input.attribution_method = 'manual';
    input.metadata = {
      ...input.metadata, audio_start_ms: 0, recovered_from_audio: true,
      recovery_reason: job.reason, transcription_model: deps.model, speaker_timeline: activity.length > 0,
    };

    await deps.put(rawKey, JSON.stringify({ recovered: true, meeting }), 'application/json');
    const audioKey = audioKeyFor(vexaId);
    await deps.put(audioKey, webm, 'audio/webm');
    input.audio_r2_key = audioKey;
    // 'partial': já existe episódio desta coleta (mesma chave vexa/<id>) com a
    // transcrição ao vivo incompleta — substitui.
    if (job.reason === 'partial') input.force = true;
    const r = await deps.insertEpisode(input);
    const episodeId = Number(r.id);

    await updateCollectedMeeting(deps.pool, id, { status: 'imported', episodeId, failureReason: null });
    await finishRecovery(deps.pool, id, { status: 'done', episodeId, speechSeconds: speech });
    deps.log?.info({ id, vexaId, episode: episodeId, turns: input.turns.length, speech }, 'meetings-recover: reunião transcrita pela gravação');
    return 'done';
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    const systemic = classifySummaryError(err) === 'systemic';
    if (systemic && ageH < SYSTEMIC_MAX_AGE_H) {
      await retryRecovery(deps.pool, id, { backoffSec: SYSTEMIC_BACKOFF_SEC, consumeAttempt: false, error: msg });
      return 'retry';
    }
    if (!systemic && job.attempts + 1 < MAX_ATTEMPTS) {
      await retryRecovery(deps.pool, id, { backoffSec: ITEM_BACKOFF_SEC, consumeAttempt: true, error: msg });
      return 'retry';
    }
    await finishRecovery(deps.pool, id, { status: 'failed', error: msg.slice(0, 1000) });
    deps.log?.warn({ id, vexaId, err: msg }, 'meetings-recover: falhou de vez');
    return 'failed';
  } finally {
    await rec?.dispose().catch(() => {});
  }
}

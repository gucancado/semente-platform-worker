/**
 * src/meetings-audio/poller.ts
 *
 * Ciclo de 2 min que copia pro R2 o áudio das reuniões importadas nas últimas
 * 24h. Fila por consulta, sem tabela própria: o estado "falta áudio" já é
 * `episodes.audio_r2_key IS NULL`, e a janela de 24h é o limite de insistência.
 */
import { pool } from '../db.js';
import { config } from '../config.js';
import { putAndVerify } from '../integrations/r2.js';
import { VexaClient } from '../integrations/vexa/client.js';
import { listPendingAudio, setEpisodeAudioKey } from './db.js';
import { remuxWebm } from './remux.js';
import { runAudioBatch, type AudioLogger } from './service.js';

export const POLL_INTERVAL_MS = 120_000;

export function startMeetingsAudioPoller(log: AudioLogger & { error: (o: unknown, m?: string) => void }): void {
  const vexa = new VexaClient(config.VEXA_API_URL!, config.VEXA_API_KEY!);
  const deps = {
    vexa,
    remux: (b: Buffer) => remuxWebm(b),
    put: (key: string, body: Buffer, ct: string) => putAndVerify(key, body, ct),
    setKey: (episodeId: number, key: string) => setEpisodeAudioKey(pool, episodeId, key),
    listPending: () => listPendingAudio(pool),
    log,
  };
  let running = false;
  const tick = async () => {
    if (running) return; // um download de 50 MB pode passar de um ciclo
    running = true;
    try { await runAudioBatch(deps); }
    catch (err) { log.error({ err: (err as Error).message }, 'meetings-audio poller tick falhou'); }
    finally { running = false; }
  };
  setInterval(tick, POLL_INTERVAL_MS);
  log.info({ intervalMs: POLL_INTERVAL_MS }, 'meetings-audio poller iniciado');
}

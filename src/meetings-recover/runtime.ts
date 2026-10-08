import OpenAI, { toFile } from 'openai';
import { pool } from '../db.js';
import { config } from '../config.js';
import { putAndVerify } from '../integrations/r2.js';
import { insertEpisodeWithTurns } from '../episodes/db.js';
import { VexaClient } from '../integrations/vexa/client.js';
import { remuxWebm } from '../meetings-audio/remux.js';
import { repairHeaderlessWebm } from '../meetings-audio/core.js';
import { getOpenAIHealth } from '../openai-health/service.js';
import { openRecording } from './audio.js';
import type { RecoverDeps, Transcribe } from './service.js';
import type { DiarSeg } from './core.js';

/**
 * Diarização pela OpenAI. Timeout de 280 s por pedaço: abaixo do headers
 * timeout de 300 s do fetch do Node, que mata a requisição sem resposta útil.
 */
export function makeOpenAIDiarizer(apiKey: string, model: string): Transcribe {
  const client = new OpenAI({ apiKey, timeout: 280_000, maxRetries: 2 });
  return async (mp3, refs) => {
    const params: Record<string, unknown> = {
      file: await toFile(mp3, 'chunk.mp3', { type: 'audio/mpeg' }),
      model,
      response_format: 'diarized_json',
      chunking_strategy: 'auto',
      language: 'pt',
    };
    if (refs.length > 0) {
      params.known_speaker_names = refs.map((r) => r.name);
      params.known_speaker_references = refs.map((r) => `data:audio/wav;base64,${r.wav.toString('base64')}`);
    }
    const res = (await client.audio.transcriptions.create(params as never)) as unknown as { segments?: DiarSeg[] };
    return { segments: Array.isArray(res.segments) ? res.segments : [] };
  };
}

export function buildRecoverDeps(log?: RecoverDeps['log']): RecoverDeps {
  return {
    pool,
    vexa: new VexaClient(config.VEXA_API_URL!, config.VEXA_API_KEY!),
    remux: async (b) => {
      const r = await remuxWebm(repairHeaderlessWebm(b).bytes);
      return { bytes: r.bytes, durationS: r.durationS };
    },
    openRecording,
    transcribe: makeOpenAIDiarizer(config.OPENAI_API_KEY!, config.MEETINGS_RECOVERY_MODEL),
    put: (key, body, ct) => putAndVerify(key, body, ct),
    insertEpisode: insertEpisodeWithTurns,
    health: () => getOpenAIHealth(pool),
    model: config.MEETINGS_RECOVERY_MODEL,
    now: () => new Date(),
    log,
  };
}

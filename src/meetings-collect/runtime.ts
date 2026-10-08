import { pool } from '../db.js';
import { config } from '../config.js';
import { putAndVerify } from '../integrations/r2.js';
import { insertEpisodeWithTurns } from '../episodes/db.js';
import { VexaClient } from '../integrations/vexa/client.js';
import { getOpenAIHealth } from '../openai-health/service.js';
import { enqueueRecovery } from '../meetings-recover/db.js';
import type { MeetingsCollectDeps } from './service.js';

/** Fábrica de deps reais a partir de env — usada pelo poller e pelas rotas (stop inline). */
export function buildMeetingsCollectDeps(): MeetingsCollectDeps {
  const vexa = new VexaClient(config.VEXA_API_URL!, config.VEXA_API_KEY!);
  const recovery = config.MEETINGS_RECOVERY_MODE === 'auto';
  return {
    pool,
    vexa,
    putAndVerify,
    insertEpisode: insertEpisodeWithTurns,
    inactivityStopMin: config.MEETINGS_INACTIVITY_STOP_MIN,
    admissionTimeoutMin: config.MEETINGS_ADMISSION_TIMEOUT_MIN,
    botName: 'BeeAds Notetaker',
    maxConcurrent: config.VEXA_MAX_CONCURRENT,
    queueMaxWaitMin: config.MEETINGS_QUEUE_MAX_WAIT_MIN,
    now: () => new Date(),
    // Sem sonda a tabela fica em 'unknown' e nada muda (comportamento antigo).
    sttHealth: () => getOpenAIHealth(pool),
    sttDownMaxMin: config.MEETINGS_STT_DOWN_MAX_MIN,
    ...(recovery ? { enqueueRecovery: (row, reason) => enqueueRecovery(pool, row.id, reason) } : {}),
  };
}

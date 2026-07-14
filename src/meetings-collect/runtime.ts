import { pool } from '../db.js';
import { config } from '../config.js';
import { putAndVerify } from '../integrations/r2.js';
import { insertEpisodeWithTurns } from '../episodes/db.js';
import { VexaClient } from '../integrations/vexa/client.js';
import type { MeetingsCollectDeps } from './service.js';

/** Fábrica de deps reais a partir de env — usada pelo poller e pelas rotas (stop inline). */
export function buildMeetingsCollectDeps(): MeetingsCollectDeps {
  const vexa = new VexaClient(config.VEXA_API_URL!, config.VEXA_API_KEY!);
  return {
    pool,
    vexa,
    putAndVerify,
    insertEpisode: insertEpisodeWithTurns,
    inactivityStopMin: config.MEETINGS_INACTIVITY_STOP_MIN,
    admissionTimeoutMin: config.MEETINGS_ADMISSION_TIMEOUT_MIN,
    now: () => new Date(),
  };
}

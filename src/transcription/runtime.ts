import { pool } from '../db.js';
import { config } from '../config.js';
import { putAndVerify, getObjectBuffer, presignGet, whatsappMediaBucket } from '../integrations/r2.js';
import { OpenAITranscriptionProvider } from './provider.js';
import type { ProcessDeps } from './service.js';

/** Fábrica de `ProcessDeps` a partir de env/config real — usada pelo poller e pelo CLI (DRY). */
export function buildProcessDeps(): ProcessDeps {
  return {
    pool,
    evolution: { baseUrl: config.EVOLUTION_API_URL, apiKey: config.EVOLUTION_API_KEY },
    provider: new OpenAITranscriptionProvider({ apiKey: config.OPENAI_API_KEY!, model: config.TRANSCRIBE_MODEL }),
    mode: config.TRANSCRIBE_MODE,
    maxAttempts: config.TRANSCRIBE_MAX_ATTEMPTS,
    maxDurationS: config.TRANSCRIBE_MAX_DURATION_S,
    debounceMs: config.TRIGGER_DEBOUNCE_MS,
    r2: { putAndVerify, getObjectBuffer, presignGet, bucket: whatsappMediaBucket()! },
  };
}

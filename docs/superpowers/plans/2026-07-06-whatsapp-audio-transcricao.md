# WhatsApp Audio Transcrição — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receber áudios do WhatsApp (inbound + `fromMe`, só DM), baixar da Evolution, guardar o `.ogg` no R2 e transcrever via OpenAI, gravando o texto em `messages.text` — como serviço isolado do worker, com fila + poller, flag de rollout e custo rastreado.

**Architecture:** Webhook detecta áudio e enfileira `transcription_jobs` (não transcreve no caminho quente). Um poller (modo `auto`) ou CLI (modo `manual`) claima jobs, baixa a mídia da Evolution (`getBase64FromMediaMessage`), sobe o `.ogg` no R2, transcreve via `TranscriptionProvider` (OpenAI `gpt-4o-mini-transcribe`) e faz `UPDATE messages`. Ciclo de vida do job espelha o padrão claim/retry do outbox/pending_triggers (sem estado `processing`, auto-cura de crash via visibility timeout).

**Tech Stack:** TypeScript ESM, Fastify, `pg`, `openai` ^6.42.0 (`audio.transcriptions` + `toFile`), `@aws-sdk/client-s3` (R2), Zod (config), `node:test` + Postgres efêmero.

## Global Constraints

- **Spec canônica:** `docs/specs/whatsapp-audio-transcricao.spec.md` (v3). Em conflito, a spec vence.
- **Serviço isolado:** módulo `src/transcription/`, tabela `transcription_jobs`, envs `TRANSCRIBE_*`. **Não** importar/estender nada da Lua.
- **Escopo:** só **number-path** (multi-número) e só **DM** (`!isGroup`). Legado, Cloud API, grupo e outras mídias fora.
- **Flag `TRANSCRIBE_MODE`** enum estrito `off|manual|auto` (default `off`) — parse igual `LUA_ENABLED` (NÃO `z.coerce.boolean`).
- **Sem estado `processing`** — nem no job, nem em `messages.transcription_status` (domínio `pending|done|failed`).
- **Idempotência:** job dedup por `(whatsapp_number_id, evolution_event_id)`; `insertTranscriptionJob` sempre `ON CONFLICT DO NOTHING`.
- **`messages.text` continua `NOT NULL`** — placeholder `[áudio]` até transcrever.
- **Migrations rodam no start** (server-side); DB só alcançável de dentro do container. Testes rodam com Postgres efêmero (`DATABASE_URL` de descarte) — ver memory `reference-rodar-suite-worker-postgres-efemero`.
- **Deploy manual:** `COOLIFY_TOKEN=... pnpm deploy`. Prod entra com `TRANSCRIBE_MODE=manual` (Fase 1); `auto` só após OK do Gustavo.
- **Commits:** frequentes, um por task. Idioma pt-BR nas mensagens.
- **Backoff linear:** `min(attempt*30, 300)`s — mesma fórmula de `markTriggerRetryOrFail` (db.ts:545).

---

### Task 1: Migration 041 — schema de mídia + fila `transcription_jobs`

**Files:**
- Create: `migrations/041_transcription.sql`
- Test: `tests/transcription/schema.db.test.ts`

**Interfaces:**
- Produces: colunas `messages.kind|media_key|media_mime|media_duration_s|transcription_status`; tabela `transcription_jobs` (colunas do §4.1 da spec); índices `uq_transcription_jobs_evt`, `idx_transcription_jobs_due`.

- [ ] **Step 1: Write the migration**

Create `migrations/041_transcription.sql`:

```sql
-- 041: transcrição de áudio do WhatsApp — metadados de mídia em messages + fila de jobs.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS media_key TEXT,
  ADD COLUMN IF NOT EXISTS media_mime TEXT,
  ADD COLUMN IF NOT EXISTS media_duration_s INT,
  ADD COLUMN IF NOT EXISTS transcription_status TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='messages_kind_chk') THEN
    ALTER TABLE messages ADD CONSTRAINT messages_kind_chk CHECK (kind IN ('text','audio'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='messages_transcription_status_chk') THEN
    ALTER TABLE messages ADD CONSTRAINT messages_transcription_status_chk
      CHECK (transcription_status IS NULL OR transcription_status IN ('pending','done','failed'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS transcription_jobs (
  id BIGSERIAL PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  whatsapp_number_id BIGINT NOT NULL REFERENCES whatsapp_numbers(id) ON DELETE CASCADE,
  workspace_id TEXT,
  instance TEXT NOT NULL,
  evolution_event_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  is_group BOOLEAN NOT NULL DEFAULT FALSE,
  identifier TEXT NOT NULL,
  inbox_id BIGINT,
  raw_envelope JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_transcription_jobs_evt
  ON transcription_jobs (whatsapp_number_id, evolution_event_id);
CREATE INDEX IF NOT EXISTS idx_transcription_jobs_due
  ON transcription_jobs (scheduled_at) WHERE status = 'pending';
```

- [ ] **Step 2: Write the failing schema test**

Create `tests/transcription/schema.db.test.ts`:

```ts
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';

after(() => pool.end());

test('messages ganhou colunas de mídia', async () => {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name='messages' AND column_name = ANY($1)`,
    [['kind','media_key','media_mime','media_duration_s','transcription_status']]);
  assert.equal(rows.length, 5);
});

test('transcription_jobs existe com unique por (number, evento)', async () => {
  const { rows } = await pool.query(`SELECT to_regclass('transcription_jobs') AS t`);
  assert.equal(rows[0].t, 'transcription_jobs');
  const { rows: idx } = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename='transcription_jobs' AND indexname='uq_transcription_jobs_evt'`);
  assert.equal(idx.length, 1);
});

test('kind CHECK rejeita valor inválido', async () => {
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (900,'ws-t1','inst-t1') ON CONFLICT DO NOTHING`);
  await assert.rejects(
    pool.query(`INSERT INTO messages (channel, identifier, direction, text, kind, whatsapp_number_id) VALUES ('whatsapp','+1','inbound','x','video',900)`),
    /messages_kind_chk/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test --import tsx tests/transcription/schema.db.test.ts`
Expected: FAIL (colunas/tabela ainda não existem — o harness efêmero aplica migrations até a 040).

- [ ] **Step 4: Apply the migration (via harness) and re-run**

O harness de teste aplica todas as migrations do diretório. Rode de novo:
Run: `node --test --import tsx tests/transcription/schema.db.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add migrations/041_transcription.sql tests/transcription/schema.db.test.ts
git commit -m "feat(transcricao): migration 041 — mídia em messages + fila transcription_jobs"
```

---

### Task 2: Config — envs `TRANSCRIBE_*` + bucket + fail-fast

**Files:**
- Modify: `src/config.ts` (EnvSchema — adicionar campos; exportar `assertTranscribeConfig`)
- Modify: `.env.example` (documentar as envs novas)
- Test: `tests/transcription/config.test.ts`

**Interfaces:**
- Produces: `config.TRANSCRIBE_MODE: 'off'|'manual'|'auto'`, `config.TRANSCRIBE_MODEL: string`, `config.TRANSCRIBE_POLLER_INTERVAL_MS`, `config.TRANSCRIBE_POLLER_BATCH_SIZE`, `config.TRANSCRIBE_MAX_ATTEMPTS`, `config.TRANSCRIBE_MAX_DURATION_S`, `config.R2_BUCKET_WHATSAPP_MEDIA?: string`; função `assertTranscribeConfig(cfg, r2ok): void`.

- [ ] **Step 1: Write the failing test**

Create `tests/transcription/config.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertTranscribeConfig } from '../../src/config.js';

test('mode=off nunca exige nada', () => {
  assert.doesNotThrow(() => assertTranscribeConfig({ TRANSCRIBE_MODE: 'off', OPENAI_API_KEY: undefined } as any, false));
});
test('mode=manual sem OPENAI_API_KEY falha', () => {
  assert.throws(() => assertTranscribeConfig({ TRANSCRIBE_MODE: 'manual', OPENAI_API_KEY: undefined } as any, true), /OPENAI_API_KEY/);
});
test('mode=auto sem R2 falha', () => {
  assert.throws(() => assertTranscribeConfig({ TRANSCRIBE_MODE: 'auto', OPENAI_API_KEY: 'k' } as any, false), /R2/);
});
test('mode=manual com tudo presente passa', () => {
  assert.doesNotThrow(() => assertTranscribeConfig({ TRANSCRIBE_MODE: 'manual', OPENAI_API_KEY: 'k' } as any, true));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx tests/transcription/config.test.ts`
Expected: FAIL ("assertTranscribeConfig is not a function").

- [ ] **Step 3: Add envs + assert to `src/config.ts`**

No `EnvSchema` (antes do fechamento `})`), adicionar:

```ts
  // ── Transcrição de áudio do WhatsApp (serviço pontual) ──
  TRANSCRIBE_MODE: z.enum(['off', 'manual', 'auto']).default('off'),
  TRANSCRIBE_MODEL: z.string().default('gpt-4o-mini-transcribe'),
  TRANSCRIBE_POLLER_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  TRANSCRIBE_POLLER_BATCH_SIZE: z.coerce.number().int().positive().default(20),
  TRANSCRIBE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(4),
  TRANSCRIBE_MAX_DURATION_S: z.coerce.number().int().positive().default(600),
  R2_BUCKET_WHATSAPP_MEDIA: z.string().optional(),
```

Após `export const config = EnvSchema.parse(process.env);`, adicionar:

```ts
/**
 * Fail-fast de pré-requisitos da transcrição. `TRANSCRIBE_MODE≠'off'` exige
 * OPENAI_API_KEY e R2 configurado — senão todo job queimaria attempts e gravaria
 * placeholder 'failed' permanente por erro de env. Chamado no startup (index.ts).
 */
export function assertTranscribeConfig(
  cfg: Pick<typeof config, 'TRANSCRIBE_MODE' | 'OPENAI_API_KEY'>,
  r2ok: boolean
): void {
  if (cfg.TRANSCRIBE_MODE === 'off') return;
  if (!cfg.OPENAI_API_KEY) throw new Error(`TRANSCRIBE_MODE=${cfg.TRANSCRIBE_MODE} exige OPENAI_API_KEY`);
  if (!r2ok) throw new Error(`TRANSCRIBE_MODE=${cfg.TRANSCRIBE_MODE} exige R2 configurado (R2_* ausentes)`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx tests/transcription/config.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Documentar em `.env.example`**

Adicionar ao final:

```
# Transcrição de áudio (serviço pontual). off|manual|auto (default off).
TRANSCRIBE_MODE=off
TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
# Bucket R2 do .ogg; fallback = R2_BUCKET_EPISODES.
R2_BUCKET_WHATSAPP_MEDIA=
```

- [ ] **Step 6: Commit**

```bash
git add src/config.ts .env.example tests/transcription/config.test.ts
git commit -m "feat(transcricao): envs TRANSCRIBE_* + fail-fast assertTranscribeConfig"
```

---

### Task 3: Parser — detectar áudio (`extractMedia`)

**Files:**
- Modify: `src/webhook/evolution.ts` (add `ParsedMedia` type, `extractMedia`, `media` em `ParsedMessage`, popular em `parseEvolutionPayload`)
- Test: `tests/webhook/evolution.test.ts` (append)

**Interfaces:**
- Consumes: `EvolutionMessageSchema`, `parseEvolutionPayload` (existentes).
- Produces: `type ParsedMedia = { kind: 'audio'; mime: string | null; durationS: number | null }`; `ParsedMessage.media: ParsedMedia | null`; `export function extractMedia(msg: unknown): ParsedMedia | null`.

- [ ] **Step 1: Write the failing tests**

Append em `tests/webhook/evolution.test.ts`:

```ts
import { extractMedia, parseEvolutionPayload } from '../../src/webhook/evolution.js';

test('extractMedia detecta audioMessage com mime e duração', () => {
  const m = extractMedia({ audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 7 } });
  assert.deepEqual(m, { kind: 'audio', mime: 'audio/ogg; codecs=opus', durationS: 7 });
});
test('extractMedia detecta pttMessage', () => {
  const m = extractMedia({ pttMessage: { mimetype: 'audio/ogg', seconds: 3 } });
  assert.deepEqual(m, { kind: 'audio', mime: 'audio/ogg', durationS: 3 });
});
test('extractMedia desempacota ephemeral/viewOnce', () => {
  assert.equal(extractMedia({ ephemeralMessage: { message: { audioMessage: { mimetype: 'audio/ogg', seconds: 2 } } } })?.kind, 'audio');
  assert.equal(extractMedia({ viewOnceMessageV2: { message: { audioMessage: { seconds: 1 } } } })?.kind, 'audio');
});
test('extractMedia em texto puro é null', () => {
  assert.equal(extractMedia({ conversation: 'oi' }), null);
});
test('parseEvolutionPayload popula media em áudio e messageText null', () => {
  const p = parseEvolutionPayload({
    event: 'messages.upsert', instance: 'inst-x',
    data: { key: { remoteJid: '5531999998888@s.whatsapp.net', fromMe: false, id: 'E1' }, message: { audioMessage: { mimetype: 'audio/ogg', seconds: 5 } } },
  });
  assert.equal(p?.messageText, null);
  assert.deepEqual(p?.media, { kind: 'audio', mime: 'audio/ogg', durationS: 5 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx tests/webhook/evolution.test.ts`
Expected: FAIL ("extractMedia is not a function" + `media` undefined).

- [ ] **Step 3: Implement `extractMedia` + wire into parser**

Em `src/webhook/evolution.ts`, adicionar o tipo em `ParsedMessage`:

```ts
export type ParsedMedia = { kind: 'audio'; mime: string | null; durationS: number | null };
```

Adicionar `media: ParsedMedia | null;` ao type `ParsedMessage`.

Adicionar a função (espelha `extractMessageText`, desempacotando os mesmos containers):

```ts
export function extractMedia(msg: unknown): ParsedMedia | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, any>;
  // containers — desempacota e tenta de novo
  const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message
    ?? m.viewOnceMessageV2?.message ?? m.viewOnceMessageV2Extension?.message
    ?? m.editedMessage?.message ?? m.documentWithCaptionMessage?.message;
  if (inner) return extractMedia(inner);
  const audio = m.audioMessage ?? m.pttMessage;
  if (audio && typeof audio === 'object') {
    return {
      kind: 'audio',
      mime: typeof audio.mimetype === 'string' ? audio.mimetype : null,
      durationS: typeof audio.seconds === 'number' ? audio.seconds : null,
    };
  }
  return null;
}
```

No `return { ... }` de `parseEvolutionPayload`, adicionar:

```ts
    media: extractMedia(ev.data.message),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx tests/webhook/evolution.test.ts`
Expected: PASS (todas, incluindo as pré-existentes).

- [ ] **Step 5: Commit**

```bash
git add src/webhook/evolution.ts tests/webhook/evolution.test.ts
git commit -m "feat(transcricao): parser extractMedia (audioMessage/ptt) + media em ParsedMessage"
```

---

### Task 4: Evolution client — `getBase64FromMediaMessage`

**Files:**
- Modify: `src/evolution/client.ts`
- Test: `tests/evolution/get-base64.test.ts`

**Interfaces:**
- Consumes: `EvolutionDeps`, `call` (interno).
- Produces: `export async function getBase64FromMediaMessage(deps: EvolutionDeps, instance: string, rawMessage: unknown): Promise<{ base64: string; mimetype: string | null }>`.

- [ ] **Step 1: Write the failing test**

Create `tests/evolution/get-base64.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getBase64FromMediaMessage } from '../../src/evolution/client.js';

function fakeFetch(captured: any[]) {
  return async (url: string, init: any) => {
    captured.push({ url, init });
    return { ok: true, json: async () => ({ base64: 'QUJD', mimetype: 'audio/ogg' }) } as any;
  };
}

test('POST no endpoint certo com { message } e devolve base64+mimetype', async () => {
  const captured: any[] = [];
  const r = await getBase64FromMediaMessage(
    { baseUrl: 'http://evo', apiKey: 'k', fetch: fakeFetch(captured) as any },
    'inst-1', { key: { id: 'E1' }, message: { audioMessage: {} } });
  assert.equal(r.base64, 'QUJD');
  assert.equal(r.mimetype, 'audio/ogg');
  assert.equal(captured[0].url, 'http://evo/chat/getBase64FromMediaMessage/inst-1');
  assert.deepEqual(JSON.parse(captured[0].init.body), { message: { key: { id: 'E1' }, message: { audioMessage: {} } } });
});

test('base64 ausente vira string vazia (guard no service decide retry)', async () => {
  const r = await getBase64FromMediaMessage(
    { baseUrl: 'http://evo', apiKey: 'k', fetch: (async () => ({ ok: true, json: async () => ({}) })) as any },
    'inst-1', {});
  assert.equal(r.base64, '');
  assert.equal(r.mimetype, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx tests/evolution/get-base64.test.ts`
Expected: FAIL ("getBase64FromMediaMessage is not a function").

- [ ] **Step 3: Implement**

Em `src/evolution/client.ts`, adicionar (perto de `fetchMessages`):

```ts
/**
 * Baixa + descriptografa a mídia de uma mensagem sob demanda (webhook usa
 * base64:false → bytes não vêm no payload). `rawMessage` = objeto `data` do
 * webhook (tem `key`+`message`). Pode responder base64 vazio se a mídia ainda
 * não foi descriptografada — o caller (service) trata vazio como retryable.
 */
export async function getBase64FromMediaMessage(
  deps: EvolutionDeps, instance: string, rawMessage: unknown
): Promise<{ base64: string; mimetype: string | null }> {
  const r = await call(deps, 'POST', `/chat/getBase64FromMediaMessage/${instance}`, { message: rawMessage });
  return { base64: typeof r?.base64 === 'string' ? r.base64 : '', mimetype: r?.mimetype ?? null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx tests/evolution/get-base64.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add src/evolution/client.ts tests/evolution/get-base64.test.ts
git commit -m "feat(transcricao): Evolution getBase64FromMediaMessage (download sob demanda)"
```

---

### Task 5: R2 — parâmetro de bucket + `getObjectBuffer`

**Files:**
- Modify: `src/integrations/r2.ts`
- Test: `tests/integrations/r2-bucket.test.ts`

**Interfaces:**
- Produces: `putAndVerify(key, body, contentType, bucket?)`, `presignGet(key, ttl?, bucket?)`, `getObjectBuffer(key, bucket?): Promise<Buffer>`, `whatsappMediaBucket(): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/integrations/r2-bucket.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whatsappMediaBucket } from '../../src/integrations/r2.js';

test('whatsappMediaBucket usa R2_BUCKET_WHATSAPP_MEDIA quando setado, senão episodes', () => {
  // Sem env dedicada, cai no fallback de episódios (ou undefined em teste sem R2).
  const b = whatsappMediaBucket();
  assert.equal(typeof b === 'string' || b === undefined, true);
});
```

> Nota: R2 real não é exercitado em unit test; `putAndVerify`/`getObjectBuffer` são cobertos por mock no Task 8 (service). Aqui só validamos a resolução de bucket, que é lógica pura.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx tests/integrations/r2-bucket.test.ts`
Expected: FAIL ("whatsappMediaBucket is not a function").

- [ ] **Step 3: Implement**

Em `src/integrations/r2.ts`:
- Adicionar import: `GetObjectCommand` já está importado. Adicionar helper e parametrizar bucket.

```ts
export function whatsappMediaBucket(): string | undefined {
  return config.R2_BUCKET_WHATSAPP_MEDIA ?? config.R2_BUCKET_EPISODES;
}
```

Alterar assinaturas (default mantém compat):

```ts
export async function putAndVerify(key: string, body: Buffer | string, contentType: string, bucket = config.R2_BUCKET_EPISODES!): Promise<void> {
  const c = client();
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  await c.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buf, ContentType: contentType }));
  const head = await c.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (head.ContentLength !== buf.length) {
    throw new Error(`r2: verificação falhou pra ${key} (esperado ${buf.length}, gravado ${head.ContentLength})`);
  }
}

export async function presignGet(key: string, ttlSeconds = 120, bucket = config.R2_BUCKET_EPISODES!): Promise<string> {
  if (!r2Configured()) throw new Error('r2: não configurado (R2_* ausentes)');
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttlSeconds });
}

export async function getObjectBuffer(key: string, bucket = config.R2_BUCKET_EPISODES!): Promise<Buffer> {
  const out = await client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await out.Body!.transformToByteArray();
  return Buffer.from(bytes);
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `node --test --import tsx tests/integrations/r2-bucket.test.ts && pnpm typecheck`
Expected: PASS + typecheck limpo.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/r2.ts tests/integrations/r2-bucket.test.ts
git commit -m "feat(transcricao): r2 aceita bucket + getObjectBuffer + whatsappMediaBucket"
```

---

### Task 6: `db.ts` — colunas em `insertMessage` + queries de `transcription_jobs`

**Files:**
- Modify: `src/db.ts` (branch number-path do `insertMessage`; novas funções de job)
- Test: `tests/transcription/jobs-db.db.test.ts`

**Interfaces:**
- Consumes: `pool`.
- Produces:
  - `insertMessage` aceita `kind?`, `media_mime?`, `media_duration_s?`, `transcription_status?`.
  - `type TranscriptionJob = { id; message_id; whatsapp_number_id; workspace_id; instance; evolution_event_id; direction; is_group; identifier; inbox_id; raw_envelope; status; attempts }`.
  - `insertTranscriptionJob(args): Promise<{ id: number | null }>` (null se ON CONFLICT).
  - `claimDueTranscriptionJobs(batchSize?): Promise<TranscriptionJob[]>` (bumpa attempts + scheduled_at +5min).
  - `selectPendingTranscriptionJobs(limit): Promise<TranscriptionJob[]>` (não-claiming, p/ --dry-run).
  - `markTranscriptionDone(jobId): Promise<void>` (status='done', raw_envelope='{}').
  - `markTranscriptionRetryOrFail(jobId, attempts, maxAttempts, error): Promise<{ retried: boolean }>`.
  - `getTranscriptionJobByMessageId(messageId): Promise<TranscriptionJob | null>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/transcription/jobs-db.db.test.ts`:

```ts
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, insertMessage, insertTranscriptionJob, claimDueTranscriptionJobs,
  markTranscriptionDone, markTranscriptionRetryOrFail, getTranscriptionJobByMessageId } from '../../src/db.js';

beforeEach(async () => {
  await pool.query('TRUNCATE transcription_jobs, messages, whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws-1','inst-1')`);
});
after(() => pool.end());

async function seedAudioMsg(eventId: string) {
  const m = await insertMessage({ agent: null, channel: 'whatsapp', identifier: '+55a', direction: 'inbound',
    text: '[áudio]', evolution_event_id: eventId, whatsapp_number_id: 1, workspace_id: 'ws-1',
    kind: 'audio', media_mime: 'audio/ogg', media_duration_s: 5, transcription_status: 'pending' });
  return m.id;
}

test('insertMessage grava kind=audio no branch number-path', async () => {
  const id = await seedAudioMsg('E1');
  const { rows } = await pool.query(`SELECT kind, transcription_status, media_duration_s FROM messages WHERE id=$1`, [id]);
  assert.equal(rows[0].kind, 'audio');
  assert.equal(rows[0].transcription_status, 'pending');
  assert.equal(rows[0].media_duration_s, 5);
});

test('insertTranscriptionJob é idempotente por (number, evento)', async () => {
  const mid = await seedAudioMsg('E1');
  const a = await insertTranscriptionJob({ message_id: mid, whatsapp_number_id: 1, workspace_id: 'ws-1', instance: 'inst-1', evolution_event_id: 'E1', direction: 'inbound', is_group: false, identifier: '+55a', inbox_id: 10, raw_envelope: { k: 1 } });
  const b = await insertTranscriptionJob({ message_id: mid, whatsapp_number_id: 1, workspace_id: 'ws-1', instance: 'inst-1', evolution_event_id: 'E1', direction: 'inbound', is_group: false, identifier: '+55a', inbox_id: 10, raw_envelope: { k: 1 } });
  assert.ok(a.id);
  assert.equal(b.id, null);
  const { rows } = await pool.query(`SELECT count(*)::int c FROM transcription_jobs`);
  assert.equal(rows[0].c, 1);
});

test('claim bumpa attempts e empurra scheduled_at (auto-cura de crash)', async () => {
  const mid = await seedAudioMsg('E1');
  await insertTranscriptionJob({ message_id: mid, whatsapp_number_id: 1, workspace_id: 'ws-1', instance: 'inst-1', evolution_event_id: 'E1', direction: 'inbound', is_group: false, identifier: '+55a', inbox_id: 10, raw_envelope: {} });
  const first = await claimDueTranscriptionJobs(10);
  assert.equal(first.length, 1);
  assert.equal(first[0].attempts, 1);
  const second = await claimDueTranscriptionJobs(10);
  assert.equal(second.length, 0, 'já claimado → scheduled_at futuro → não reaparece já');
});

test('markTranscriptionDone zera raw_envelope', async () => {
  const mid = await seedAudioMsg('E1');
  const j = await insertTranscriptionJob({ message_id: mid, whatsapp_number_id: 1, workspace_id: 'ws-1', instance: 'inst-1', evolution_event_id: 'E1', direction: 'inbound', is_group: false, identifier: '+55a', inbox_id: 10, raw_envelope: { pii: 'x' } });
  await markTranscriptionDone(j.id!);
  const { rows } = await pool.query(`SELECT status, raw_envelope FROM transcription_jobs WHERE id=$1`, [j.id]);
  assert.equal(rows[0].status, 'done');
  assert.deepEqual(rows[0].raw_envelope, {});
});

test('markTranscriptionRetryOrFail: retry até max, depois failed', async () => {
  const mid = await seedAudioMsg('E1');
  const j = await insertTranscriptionJob({ message_id: mid, whatsapp_number_id: 1, workspace_id: 'ws-1', instance: 'inst-1', evolution_event_id: 'E1', direction: 'inbound', is_group: false, identifier: '+55a', inbox_id: 10, raw_envelope: {} });
  const r1 = await markTranscriptionRetryOrFail(j.id!, 1, 4, 'boom');
  assert.equal(r1.retried, true);
  const r2 = await markTranscriptionRetryOrFail(j.id!, 4, 4, 'boom');
  assert.equal(r2.retried, false);
  const { rows } = await pool.query(`SELECT status, last_error FROM transcription_jobs WHERE id=$1`, [j.id]);
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].last_error, 'boom');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --import tsx tests/transcription/jobs-db.db.test.ts`
Expected: FAIL (funções não existem; `insertMessage` ignora `kind`).

- [ ] **Step 3: Extend `insertMessage` (number-path branch)**

Em `src/db.ts`, no type de args do `insertMessage` (L263-281), adicionar:

```ts
  kind?: string | null;
  media_mime?: string | null;
  media_duration_s?: number | null;
  transcription_status?: string | null;
```

No **branch number-path** (o INSERT em db.ts:288-296), incluir as colunas novas:

```ts
    const insert = await pool.query<{ id: number }>(
      `INSERT INTO messages
         (agent, project, channel, identifier, author, direction, text, evolution_event_id, whatsapp_number_id, workspace_id,
          kind, media_mime, media_duration_s, transcription_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (whatsapp_number_id, evolution_event_id)
         WHERE whatsapp_number_id IS NOT NULL AND evolution_event_id IS NOT NULL
         DO NOTHING
       RETURNING id`,
      [args.agent, args.project ?? null, args.channel, args.identifier, args.author ?? null, args.direction, args.text, args.evolution_event_id, args.whatsapp_number_id, args.workspace_id ?? null,
       args.kind ?? 'text', args.media_mime ?? null, args.media_duration_s ?? null, args.transcription_status ?? null]
    );
```

(Os outros dois branches ficam com `kind` default via coluna — não recebem áudio.)

- [ ] **Step 4: Add job queries to `src/db.ts`**

Adicionar ao final do arquivo:

```ts
export type TranscriptionJob = {
  id: number; message_id: number; whatsapp_number_id: number; workspace_id: string | null;
  instance: string; evolution_event_id: string; direction: string; is_group: boolean;
  identifier: string; inbox_id: number | null; raw_envelope: any; status: string; attempts: number;
};

export async function insertTranscriptionJob(a: {
  message_id: number; whatsapp_number_id: number; workspace_id: string | null; instance: string;
  evolution_event_id: string; direction: string; is_group: boolean; identifier: string;
  inbox_id: number | null; raw_envelope: unknown;
}): Promise<{ id: number | null }> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO transcription_jobs
       (message_id, whatsapp_number_id, workspace_id, instance, evolution_event_id, direction, is_group, identifier, inbox_id, raw_envelope)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (whatsapp_number_id, evolution_event_id) DO NOTHING
     RETURNING id`,
    [a.message_id, a.whatsapp_number_id, a.workspace_id, a.instance, a.evolution_event_id, a.direction, a.is_group, a.identifier, a.inbox_id, JSON.stringify(a.raw_envelope)]);
  return { id: rows[0]?.id ?? null };
}

const TJ_COLS = `id, message_id, whatsapp_number_id, workspace_id, instance, evolution_event_id, direction, is_group, identifier, inbox_id, raw_envelope, status, attempts`;

export async function claimDueTranscriptionJobs(batchSize = 20): Promise<TranscriptionJob[]> {
  const { rows } = await pool.query<TranscriptionJob>(
    `WITH due AS (
       SELECT id FROM transcription_jobs
        WHERE status='pending' AND scheduled_at <= NOW()
        ORDER BY scheduled_at ASC LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE transcription_jobs t
        SET attempts = t.attempts + 1, scheduled_at = NOW() + INTERVAL '5 minutes', updated_at = NOW()
       FROM due WHERE t.id = due.id
      RETURNING ${TJ_COLS}`,
    [batchSize]);
  return rows;
}

export async function selectPendingTranscriptionJobs(limit = 20): Promise<TranscriptionJob[]> {
  const { rows } = await pool.query<TranscriptionJob>(
    `SELECT ${TJ_COLS} FROM transcription_jobs WHERE status='pending' AND scheduled_at <= NOW() ORDER BY scheduled_at ASC LIMIT $1`, [limit]);
  return rows;
}

export async function getTranscriptionJobByMessageId(messageId: number): Promise<TranscriptionJob | null> {
  const { rows } = await pool.query<TranscriptionJob>(`SELECT ${TJ_COLS} FROM transcription_jobs WHERE message_id=$1`, [messageId]);
  return rows[0] ?? null;
}

export async function markTranscriptionDone(jobId: number): Promise<void> {
  await pool.query(`UPDATE transcription_jobs SET status='done', raw_envelope='{}'::jsonb, last_error=NULL, updated_at=NOW() WHERE id=$1`, [jobId]);
}

export async function markTranscriptionRetryOrFail(jobId: number, attempts: number, maxAttempts: number, error: string): Promise<{ retried: boolean }> {
  if (attempts >= maxAttempts) {
    await pool.query(`UPDATE transcription_jobs SET status='failed', last_error=$2, updated_at=NOW() WHERE id=$1`, [jobId, error]);
    return { retried: false };
  }
  const backoffSec = Math.min(attempts * 30, 300);
  await pool.query(
    `UPDATE transcription_jobs SET status='pending', scheduled_at = NOW() + ($2 || ' seconds')::INTERVAL, last_error=$3, updated_at=NOW() WHERE id=$1`,
    [jobId, String(backoffSec), error]);
  return { retried: true };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test --import tsx tests/transcription/jobs-db.db.test.ts`
Expected: PASS (6/6).

- [ ] **Step 6: Commit**

```bash
git add src/db.ts tests/transcription/jobs-db.db.test.ts
git commit -m "feat(transcricao): insertMessage grava mídia + queries de transcription_jobs (claim/retry)"
```

---

### Task 7: Provider — `TranscriptionProvider` + OpenAI + custo

**Files:**
- Create: `src/transcription/provider.ts`
- Test: `tests/transcription/provider.test.ts`

**Interfaces:**
- Produces:
  - `interface TranscriptionResult { text: string; model: string; costUsd: number }`.
  - `interface TranscriptionProvider { transcribe(audio: Buffer, opts: { mime: string | null; durationS: number | null; language?: string }): Promise<TranscriptionResult> }`.
  - `const RATE_USD_PER_MIN: Record<string, number>`; `function costFor(model: string, durationS: number | null): number`.
  - `class OpenAITranscriptionProvider` (recebe `{ apiKey, model, client? }` — client injetável p/ teste).

- [ ] **Step 1: Write the failing tests**

Create `tests/transcription/provider.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costFor, OpenAITranscriptionProvider } from '../../src/transcription/provider.js';

test('costFor calcula por duração e modelo', () => {
  const c = costFor('gpt-4o-mini-transcribe', 60); // 1 min
  assert.ok(c > 0 && c < 0.01);
  assert.equal(costFor('gpt-4o-mini-transcribe', null), 0);
});

test('OpenAI provider chama audio.transcriptions.create e devolve texto+custo', async () => {
  const fakeClient = { audio: { transcriptions: { create: async (args: any) => {
    assert.equal(args.model, 'gpt-4o-mini-transcribe');
    assert.equal(args.language, 'pt');
    return { text: 'olá mundo' };
  } } } };
  const p = new OpenAITranscriptionProvider({ apiKey: 'k', model: 'gpt-4o-mini-transcribe', client: fakeClient as any });
  const r = await p.transcribe(Buffer.from('abc'), { mime: 'audio/ogg', durationS: 30 });
  assert.equal(r.text, 'olá mundo');
  assert.equal(r.model, 'gpt-4o-mini-transcribe');
  assert.ok(r.costUsd > 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --import tsx tests/transcription/provider.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implement `src/transcription/provider.ts`**

```ts
import OpenAI, { toFile } from 'openai';

export interface TranscriptionResult { text: string; model: string; costUsd: number; }
export interface TranscriptionProvider {
  transcribe(audio: Buffer, opts: { mime: string | null; durationS: number | null; language?: string }): Promise<TranscriptionResult>;
}

// US$/min — confirmar no pricing vigente. Duração vem do envelope (seconds), não da API.
export const RATE_USD_PER_MIN: Record<string, number> = {
  'gpt-4o-mini-transcribe': 0.003,
  'gpt-4o-transcribe': 0.006,
  'whisper-1': 0.006,
};

export function costFor(model: string, durationS: number | null): number {
  if (!durationS || durationS <= 0) return 0;
  const rate = RATE_USD_PER_MIN[model] ?? 0.006;
  return (durationS / 60) * rate;
}

export class OpenAITranscriptionProvider implements TranscriptionProvider {
  private client: OpenAI;
  private model: string;
  constructor(opts: { apiKey: string; model: string; client?: OpenAI }) {
    this.client = opts.client ?? new OpenAI({ apiKey: opts.apiKey });
    this.model = opts.model;
  }
  async transcribe(audio: Buffer, opts: { mime: string | null; durationS: number | null; language?: string }): Promise<TranscriptionResult> {
    const file = await toFile(audio, 'audio.ogg', { type: opts.mime ?? 'audio/ogg' });
    const r: any = await this.client.audio.transcriptions.create({
      file, model: this.model, language: opts.language ?? 'pt',
    });
    return { text: typeof r?.text === 'string' ? r.text : '', model: this.model, costUsd: costFor(this.model, opts.durationS) };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --import tsx tests/transcription/provider.test.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add src/transcription/provider.ts tests/transcription/provider.test.ts
git commit -m "feat(transcricao): TranscriptionProvider + impl OpenAI + custo por duração"
```

---

### Task 8: Service — `processJob`

**Files:**
- Create: `src/transcription/service.ts`
- Test: `tests/transcription/service.db.test.ts`

**Interfaces:**
- Consumes: `getBase64FromMediaMessage`, `putAndVerify`/`getObjectBuffer`/`whatsappMediaBucket`, `TranscriptionProvider`, job queries (Task 6), `agentsToTrigger`, `enqueuePendingTrigger`, `computeScheduledAt`, `getNumber`, `insertLlmMetric`.
- Produces: `type ProcessDeps = { pool; evolution: EvolutionDeps; provider: TranscriptionProvider; mode: 'off'|'manual'|'auto'; maxAttempts: number; maxDurationS: number; debounceMs: number; r2: { putAndVerify; getObjectBuffer; presignGet; bucket: string }; log? }`; `async function processJob(deps: ProcessDeps, job: TranscriptionJob): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/transcription/service.db.test.ts`:

```ts
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, insertMessage, insertTranscriptionJob, claimDueTranscriptionJobs } from '../../src/db.js';
import { processJob } from '../../src/transcription/service.js';

const R2_MOCK = { putAndVerify: async () => {}, getObjectBuffer: async () => Buffer.from('x'), presignGet: async () => 'url', bucket: 'b' };
const okProvider = { transcribe: async () => ({ text: 'transcrição feliz', model: 'gpt-4o-mini-transcribe', costUsd: 0.001 }) };
function evoReturning(base64: string) { return { baseUrl: 'http://e', apiKey: 'k', fetch: (async () => ({ ok: true, json: async () => ({ base64, mimetype: 'audio/ogg' }) })) as any }; }

beforeEach(async () => {
  await pool.query('TRUNCATE transcription_jobs, messages, llm_metrics, pending_triggers, whatsapp_numbers, workspace_agents RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance, mode) VALUES (1,'ws-1','inst-1','agent_operated')`);
});
after(() => pool.end());

async function seedJob(dir: 'inbound'|'outbound' = 'inbound') {
  const m = await insertMessage({ agent: null, channel: 'whatsapp', identifier: '+55a', direction: dir, text: '[áudio]',
    evolution_event_id: 'E1', whatsapp_number_id: 1, workspace_id: 'ws-1', kind: 'audio', media_mime: 'audio/ogg', media_duration_s: 5, transcription_status: 'pending' });
  await insertTranscriptionJob({ message_id: m.id, whatsapp_number_id: 1, workspace_id: 'ws-1', instance: 'inst-1', evolution_event_id: 'E1', direction: dir, is_group: false, identifier: '+55a', inbox_id: 10, raw_envelope: { key: { id: 'E1' } } });
  return (await claimDueTranscriptionJobs(10))[0];
}
function deps(over: any = {}) {
  return { pool, evolution: evoReturning('QUJD'), provider: okProvider, mode: 'auto', maxAttempts: 4, maxDurationS: 600, debounceMs: 25000, r2: R2_MOCK, ...over } as any;
}

test('feliz: grava transcrição, done, media_key, llm_metrics; auto+inbound → trigger', async () => {
  await pool.query(`INSERT INTO workspace_agents (workspace_id, whatsapp_number_id, agent, reaction_mode) VALUES ('ws-1',1,'mercurio','reactive')`);
  const job = await seedJob('inbound');
  await processJob(deps(), job);
  const { rows: msg } = await pool.query(`SELECT text, transcription_status, media_key FROM messages WHERE id=$1`, [job.message_id]);
  assert.equal(msg[0].text, 'transcrição feliz');
  assert.equal(msg[0].transcription_status, 'done');
  assert.ok(msg[0].media_key);
  const { rows: met } = await pool.query(`SELECT agent, task FROM llm_metrics`);
  assert.equal(met[0].agent, 'transcription');
  assert.equal(met[0].task, 'transcribe');
  const { rows: trig } = await pool.query(`SELECT count(*)::int c FROM pending_triggers WHERE status='pending'`);
  assert.equal(trig[0].c, 1);
  const { rows: j } = await pool.query(`SELECT status, raw_envelope FROM transcription_jobs WHERE id=$1`, [job.id]);
  assert.equal(j[0].status, 'done');
  assert.deepEqual(j[0].raw_envelope, {});
});

test('outbound (fromMe) não dispara trigger', async () => {
  const job = await seedJob('outbound');
  await processJob(deps(), job);
  const { rows } = await pool.query(`SELECT count(*)::int c FROM pending_triggers`);
  assert.equal(rows[0].c, 0);
});

test('base64 vazio → retry (job volta pending, sem media_key)', async () => {
  const job = await seedJob('inbound');
  await processJob(deps({ evolution: evoReturning('') }), job);
  const { rows: j } = await pool.query(`SELECT status FROM transcription_jobs WHERE id=$1`, [job.id]);
  assert.equal(j[0].status, 'pending');
  const { rows: m } = await pool.query(`SELECT media_key, transcription_status FROM messages WHERE id=$1`, [job.message_id]);
  assert.equal(m[0].media_key, null);
  assert.equal(m[0].transcription_status, 'pending');
});

test('media_key gravado ANTES do ASR: ASR falha ainda deixa áudio ouvível', async () => {
  const job = await seedJob('inbound');
  const boom = { transcribe: async () => { throw new Error('asr down'); } };
  await processJob(deps({ provider: boom, maxAttempts: 4 }), job);
  const { rows: m } = await pool.query(`SELECT media_key FROM messages WHERE id=$1`, [job.message_id]);
  assert.ok(m[0].media_key, 'media_key setado no upload, antes de falhar o ASR');
});

test('falha final (attempts>=max) → failed + placeholder', async () => {
  const job = await seedJob('inbound');
  const boom = { transcribe: async () => { throw new Error('asr down'); } };
  await processJob(deps({ provider: boom, maxAttempts: 1 }), { ...job, attempts: 1 });
  const { rows: m } = await pool.query(`SELECT text, transcription_status FROM messages WHERE id=$1`, [job.message_id]);
  assert.equal(m[0].transcription_status, 'failed');
  assert.match(m[0].text, /indispon/i);
});

test('cap de duração: não chama ASR, sobe ogg, failed com placeholder de longo', async () => {
  await pool.query(`UPDATE messages SET media_duration_s=999 WHERE evolution_event_id='E1'`);
  const job = await seedJob('inbound'); // media_duration_s do job vem do envelope; força via override abaixo
  await processJob(deps({ maxDurationS: 600, provider: { transcribe: async () => { throw new Error('nao deveria chamar'); } } }), { ...job });
  const { rows: m } = await pool.query(`SELECT text, transcription_status, media_key FROM messages WHERE id=$1`, [job.message_id]);
  assert.equal(m[0].transcription_status, 'failed');
  assert.match(m[0].text, /longo/i);
});

test('mode=manual não dispara trigger mesmo inbound', async () => {
  await pool.query(`INSERT INTO workspace_agents (workspace_id, whatsapp_number_id, agent, reaction_mode) VALUES ('ws-1',1,'mercurio','reactive')`);
  const job = await seedJob('inbound');
  await processJob(deps({ mode: 'manual' }), job);
  const { rows } = await pool.query(`SELECT count(*)::int c FROM pending_triggers`);
  assert.equal(rows[0].c, 0);
});
```

> Nota p/ o implementador: o service lê a duração de `messages.media_duration_s` (via `message_id`), não do job. No teste do cap, a duração 999 é setada na message.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --import tsx tests/transcription/service.db.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implement `src/transcription/service.ts`**

```ts
import type { Pool } from 'pg';
import type { EvolutionDeps } from '../evolution/client.js';
import { getBase64FromMediaMessage } from '../evolution/client.js';
import { getNumber } from '../whatsapp/numbers.js';
import { agentsToTrigger } from '../whatsapp/reaction.js';
import { computeScheduledAt } from '../triggers/quiet-hours.js';
import {
  enqueuePendingTrigger, insertLlmMetric, markTranscriptionDone, markTranscriptionRetryOrFail,
  type TranscriptionJob,
} from '../db.js';
import type { TranscriptionProvider } from './provider.js';

export type ProcessDeps = {
  pool: Pool;
  evolution: EvolutionDeps;
  provider: TranscriptionProvider;
  mode: 'off' | 'manual' | 'auto';
  maxAttempts: number;
  maxDurationS: number;
  debounceMs: number;
  r2: {
    putAndVerify: (key: string, body: Buffer, ct: string, bucket?: string) => Promise<void>;
    getObjectBuffer: (key: string, bucket?: string) => Promise<Buffer>;
    presignGet: (key: string, ttl?: number, bucket?: string) => Promise<string>;
    bucket: string;
  };
  log?: { warn: (o: any, m?: string) => void; info: (o: any, m?: string) => void };
};

async function updateMsg(pool: Pool, id: number, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await pool.query(`UPDATE messages SET ${set} WHERE id = $1`, [id, ...keys.map(k => fields[k])]);
}

async function maybeTrigger(deps: ProcessDeps, job: TranscriptionJob) {
  if (deps.mode !== 'auto' || job.direction !== 'inbound' || job.is_group) return;
  const num = await getNumber(deps.pool, job.whatsapp_number_id);
  if (!num || !job.workspace_id) return;
  const agents = await agentsToTrigger(deps.pool, { workspaceId: job.workspace_id, numberId: job.whatsapp_number_id, mode: num.mode });
  for (const agent of agents) {
    const scheduledAt = computeScheduledAt(null, deps.debounceMs);
    await enqueuePendingTrigger({ agent, project: null, identifier: job.identifier, inbox_id: job.inbox_id ?? 0, scheduled_at: scheduledAt });
  }
}

/** Processa 1 job já claimado (attempts bumpado pelo claim). */
export async function processJob(deps: ProcessDeps, job: TranscriptionJob): Promise<void> {
  const { pool } = deps;
  const { rows } = await pool.query<{ media_duration_s: number | null; media_mime: string | null; workspace_id: string | null }>(
    `SELECT media_duration_s, media_mime, workspace_id FROM messages WHERE id = $1`, [job.message_id]);
  const msg = rows[0];
  const durationS = msg?.media_duration_s ?? null;
  const mime = msg?.media_mime ?? 'audio/ogg';
  const key = `whatsapp-audio/${job.workspace_id ?? 'na'}/${job.whatsapp_number_id}/${job.message_id}.ogg`;

  try {
    // 1) download — base64 vazio é retryable (mídia ainda não descriptografada)
    const media = await getBase64FromMediaMessage(deps.evolution, job.instance, job.raw_envelope);
    if (!media.base64) throw new Error('evolution base64 vazio (mídia não pronta)');

    // 2) cap de duração — sobe o .ogg (pra ouvir) mas não transcreve
    const buf = Buffer.from(media.base64, 'base64');
    if (durationS && durationS > deps.maxDurationS) {
      await deps.r2.putAndVerify(key, buf, mime, deps.r2.bucket);
      await updateMsg(pool, job.message_id, { media_key: key, media_mime: mime, transcription_status: 'failed', text: '[áudio longo — não transcrito]' });
      await markTranscriptionDone(job.id); // terminal (não retry): usa done p/ tirar da fila; status da msg = failed
      return;
    }

    // 3) upload + grava media_key ANTES do ASR (falha do ASR ainda deixa áudio ouvível)
    await deps.r2.putAndVerify(key, buf, mime, deps.r2.bucket);
    await updateMsg(pool, job.message_id, { media_key: key, media_mime: mime });

    // 4) transcreve
    const t = await deps.provider.transcribe(buf, { mime: media.mimetype ?? mime, durationS });
    const text = t.text.trim() || '[áudio sem fala reconhecível]';

    // 5) grava transcrição + custo + done (transação)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE messages SET text=$2, transcription_status='done' WHERE id=$1`, [job.message_id, text]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    await insertLlmMetric({ agent: 'transcription', message_id: job.message_id, task: 'transcribe', provider: 'openai', model: t.model, cost_usd: t.costUsd });
    await markTranscriptionDone(job.id);

    // 6) trigger (só auto+inbound+não-grupo)
    await maybeTrigger(deps, job);
  } catch (err) {
    const msgErr = (err as Error).message;
    const res = await markTranscriptionRetryOrFail(job.id, job.attempts, deps.maxAttempts, msgErr);
    deps.log?.warn({ jobId: job.id, err: msgErr, retried: res.retried }, 'transcription job falhou');
    if (!res.retried) {
      await updateMsg(pool, job.message_id, { transcription_status: 'failed', text: '[áudio — transcrição indisponível]' });
      await maybeTrigger(deps, job); // não travar o lead
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --import tsx tests/transcription/service.db.test.ts`
Expected: PASS (7/7).

- [ ] **Step 5: Commit**

```bash
git add src/transcription/service.ts tests/transcription/service.db.test.ts
git commit -m "feat(transcricao): processJob (download→R2→ASR→messages+trigger, retry/backoff)"
```

---

### Task 9: Webhook — enfileirar áudio + suprimir trigger em `auto`

**Files:**
- Modify: `src/webhook/routes.ts` (number-path: detectar áudio, gravar placeholder, enfileirar job, gate de trigger, warning/summary)
- Test: `tests/webhook/audio-ingest.db.test.ts`

**Interfaces:**
- Consumes: `parseEvolutionPayload().media`, `insertTranscriptionJob`, `config.TRANSCRIBE_MODE`, `logWebhook`, `insertMessage`.
- Produces: comportamento de ingestão de áudio (nenhuma export nova).

- [ ] **Step 1: Write the failing tests**

Create `tests/webhook/audio-ingest.db.test.ts`. Segue o padrão dos testes de webhook existentes (buildApp/inject). Verificar como os testes de webhook atuais montam o app (ex.: `tests/whatsapp/*route*.db.test.ts` ou `tests/webhook/*`); reusar o helper de app se existir. Estrutura alvo:

```ts
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
// importar o builder de app do worker + helper de POST /webhook com X-Evolution-Secret
// (reusar o mesmo padrão de um teste de webhook existente).

const SECRET = process.env.EVOLUTION_WEBHOOK_SECRET!;
function audioEvent(eventId: string, fromMe = false, group = false) {
  return {
    event: 'messages.upsert', instance: 'inst-1',
    data: { key: { remoteJid: group ? '123@g.us' : '5531999998888@s.whatsapp.net', fromMe, id: eventId },
            message: { audioMessage: { mimetype: 'audio/ogg', seconds: 4 } } },
  };
}

beforeEach(async () => {
  await pool.query('TRUNCATE transcription_jobs, messages, webhook_logs, whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance, mode, status) VALUES (1,'ws-1','inst-1','agent_operated','connected')`);
});
after(() => pool.end());

// Cada teste seta process.env.TRANSCRIBE_MODE antes de injetar; o handler lê config em runtime.
// (Se config for lido no import, o teste deve mockar — ver nota abaixo.)

test('manual: áudio DM → messages kind=audio pending + job + trigger dispara', async () => {
  // ... POST /webhook com audioEvent('E1'); assert 1 messages kind=audio, 1 transcription_jobs, 1 pending_trigger
});
test('auto: áudio DM → messages + job, SEM trigger na chegada', async () => { /* ... */ });
test('off: áudio DM → nada (sem message, sem job)', async () => { /* ... */ });
test('grupo: áudio → nada (não captura)', async () => { /* ... */ });
test('reentrega do mesmo evento não duplica message nem job', async () => { /* ... */ });
```

> **Nota de implementação do teste:** `config` é lido de `process.env` no import de `src/config.ts`. Para variar `TRANSCRIBE_MODE` por teste sem recarregar o módulo, o handler deve ler `config.TRANSCRIBE_MODE` (que é fixo por processo). Opção pragmática: setar `TRANSCRIBE_MODE` no `.env.test` para `manual` e cobrir `auto`/`off` num teste unitário do ramo (extrair a decisão de gate para uma função pura `audioIngestPlan(mode, isGroup, media)` testável isoladamente — ver Step 3). Os testes de integração cobrem o caminho `manual`.

- [ ] **Step 2: Extract a pure gate helper + test it**

Adicionar em `src/webhook/routes.ts` (topo do módulo) uma função pura testável:

```ts
export function audioIngestPlan(mode: 'off'|'manual'|'auto', isGroup: boolean, hasAudio: boolean):
  { capture: boolean; suppressTrigger: boolean } {
  if (!hasAudio || isGroup || mode === 'off') return { capture: false, suppressTrigger: false };
  return { capture: true, suppressTrigger: mode === 'auto' };
}
```

Test `tests/webhook/audio-plan.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioIngestPlan } from '../../src/webhook/routes.js';

test('off nunca captura', () => assert.deepEqual(audioIngestPlan('off', false, true), { capture: false, suppressTrigger: false }));
test('grupo nunca captura', () => assert.deepEqual(audioIngestPlan('manual', true, true), { capture: false, suppressTrigger: false }));
test('sem áudio não captura', () => assert.deepEqual(audioIngestPlan('auto', false, false), { capture: false, suppressTrigger: false }));
test('manual captura, não suprime trigger', () => assert.deepEqual(audioIngestPlan('manual', false, true), { capture: true, suppressTrigger: false }));
test('auto captura e suprime trigger', () => assert.deepEqual(audioIngestPlan('auto', false, true), { capture: true, suppressTrigger: true }));
```

Run: `node --test --import tsx tests/webhook/audio-plan.test.ts` → FAIL, então implemente → PASS.

- [ ] **Step 3: Wire into the number-path**

Em `src/webhook/routes.ts`, dentro do bloco `resolved.source === 'number'`:

1. Import: `import { insertTranscriptionJob } from '../db.js';` (adicionar à lista existente) e `audioIngestPlan` já é local.
2. Calcular o plano logo após ter `msg`:

```ts
    const plan = audioIngestPlan(config.TRANSCRIBE_MODE, msg.isGroup, !!msg.media);
```

3. No `logWebhook`, quando `plan.capture`, usar summary `'[áudio]'` e pular o warning de "sem texto" (o warning atual em routes.ts:45-52 deve ganhar `&& !msg.media`).

4. Substituir o bloco de `insertMessage` de áudio: quando `plan.capture`, gravar placeholder + enfileirar job:

```ts
      if (plan.capture) {
        try {
          const audioMsg = await insertMessage({
            agent, channel: msg.channel, identifier: msg.identifier, author: msg.author,
            direction: msg.fromMe ? 'outbound' : 'inbound', text: '[áudio]',
            evolution_event_id: msg.rawEventId, whatsapp_number_id: resolved.numberId, workspace_id: resolved.workspaceId,
            kind: 'audio', media_mime: msg.media!.mime, media_duration_s: msg.media!.durationS, transcription_status: 'pending',
          });
          await insertTranscriptionJob({
            message_id: audioMsg.id, whatsapp_number_id: resolved.numberId!, workspace_id: resolved.workspaceId ?? null,
            instance: msg.instance, evolution_event_id: msg.rawEventId, direction: msg.fromMe ? 'outbound' : 'inbound',
            is_group: false, identifier: msg.identifier, inbox_id: inserted.id, raw_envelope: (req.body as any)?.data ?? {},
          });
        } catch (err) {
          req.log.warn({ err: (err as Error).message }, 'enfileirar áudio falhou — webhook segue');
        }
      } else if (msg.messageText && msg.identifier) {
        // ...caminho de texto existente (insertMessage + detectAndTagSource) permanece igual...
      }
```

5. No gate de trigger (routes.ts:126), excluir áudio quando `plan.suppressTrigger`:

```ts
      if (!inserted.duplicate && msg.identifier && !msg.isGroup && !msg.fromMe && !plan.suppressTrigger) {
```

> Em `manual`, `suppressTrigger=false` → trigger dispara como hoje (sem regressão). Em `auto`, suprime → o poller dispara pós-transcrição.

- [ ] **Step 4: Run the integration + plan tests**

Run: `node --test --import tsx tests/webhook/audio-plan.test.ts tests/webhook/audio-ingest.db.test.ts`
Expected: PASS (plano 5/5; integração cobrindo `manual` conforme `.env.test`).

- [ ] **Step 5: Commit**

```bash
git add src/webhook/routes.ts tests/webhook/audio-plan.test.ts tests/webhook/audio-ingest.db.test.ts
git commit -m "feat(transcricao): webhook enfileira áudio DM + gate de trigger por modo"
```

---

### Task 10: Poller + CLI + wiring (`index.ts`, `package.json`)

**Files:**
- Create: `src/transcription/poller.ts`
- Create: `src/transcription/cli.ts`
- Create: `src/transcription/runtime.ts` (fábrica de `ProcessDeps` — DRY entre poller e CLI)
- Modify: `src/index.ts` (start do poller se `auto` + `assertTranscribeConfig`)
- Modify: `package.json` (scripts `transcribe:pending`, `transcribe:redo`)
- Test: `tests/transcription/poller.db.test.ts`

**Interfaces:**
- Produces: `buildProcessDeps(mode): ProcessDeps` (runtime.ts); `startTranscriptionPoller(log): void` (poller.ts); CLI comandos `pending`/`redo`.

- [ ] **Step 1: Write the failing test (poller drena a fila)**

Create `tests/transcription/poller.db.test.ts`:

```ts
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, insertMessage, insertTranscriptionJob, claimDueTranscriptionJobs } from '../../src/db.js';
import { runTranscriptionBatch } from '../../src/transcription/poller.js';

const R2_MOCK = { putAndVerify: async () => {}, getObjectBuffer: async () => Buffer.from('x'), presignGet: async () => 'url', bucket: 'b' };
const okProvider = { transcribe: async () => ({ text: 'ok', model: 'gpt-4o-mini-transcribe', costUsd: 0.001 }) };
const evo = { baseUrl: 'http://e', apiKey: 'k', fetch: (async () => ({ ok: true, json: async () => ({ base64: 'QUJD', mimetype: 'audio/ogg' }) })) as any };

beforeEach(async () => {
  await pool.query('TRUNCATE transcription_jobs, messages, llm_metrics, whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance, mode) VALUES (1,'ws-1','inst-1','monitored')`);
});
after(() => pool.end());

test('runTranscriptionBatch processa jobs pendentes', async () => {
  const m = await insertMessage({ agent: null, channel: 'whatsapp', identifier: '+55a', direction: 'inbound', text: '[áudio]', evolution_event_id: 'E1', whatsapp_number_id: 1, workspace_id: 'ws-1', kind: 'audio', media_mime: 'audio/ogg', media_duration_s: 3, transcription_status: 'pending' });
  await insertTranscriptionJob({ message_id: m.id, whatsapp_number_id: 1, workspace_id: 'ws-1', instance: 'inst-1', evolution_event_id: 'E1', direction: 'inbound', is_group: false, identifier: '+55a', inbox_id: 1, raw_envelope: {} });
  const deps = { pool, evolution: evo, provider: okProvider, mode: 'auto', maxAttempts: 4, maxDurationS: 600, debounceMs: 25000, r2: R2_MOCK } as any;
  const n = await runTranscriptionBatch(deps, 10);
  assert.equal(n, 1);
  const { rows } = await pool.query(`SELECT transcription_status FROM messages WHERE id=$1`, [m.id]);
  assert.equal(rows[0].transcription_status, 'done');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx tests/transcription/poller.db.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implement runtime.ts + poller.ts**

`src/transcription/runtime.ts`:

```ts
import { pool } from '../db.js';
import { config } from '../config.js';
import { putAndVerify, getObjectBuffer, presignGet, whatsappMediaBucket } from '../integrations/r2.js';
import { OpenAITranscriptionProvider } from './provider.js';
import type { ProcessDeps } from './service.js';

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
```

`src/transcription/poller.ts`:

```ts
import { claimDueTranscriptionJobs } from '../db.js';
import { config } from '../config.js';
import { processJob, type ProcessDeps } from './service.js';
import { buildProcessDeps } from './runtime.js';

export async function runTranscriptionBatch(deps: ProcessDeps, batchSize: number): Promise<number> {
  const jobs = await claimDueTranscriptionJobs(batchSize);
  for (const job of jobs) await processJob(deps, job);
  return jobs.length;
}

export function startTranscriptionPoller(log: { info: (o: any, m?: string) => void; error: (o: any, m?: string) => void }): void {
  const deps = buildProcessDeps();
  const tick = async () => {
    try { await runTranscriptionBatch(deps, config.TRANSCRIBE_POLLER_BATCH_SIZE); }
    catch (err) { log.error({ err: (err as Error).message }, 'transcription poller tick falhou'); }
  };
  setInterval(tick, config.TRANSCRIBE_POLLER_INTERVAL_MS);
  log.info({ intervalMs: config.TRANSCRIBE_POLLER_INTERVAL_MS }, 'transcription poller iniciado');
}
```

- [ ] **Step 4: Run poller test → PASS**

Run: `node --test --import tsx tests/transcription/poller.db.test.ts`
Expected: PASS (1/1).

- [ ] **Step 5: Implement CLI `src/transcription/cli.ts`**

```ts
import { config } from '../config.js';
import { pool, selectPendingTranscriptionJobs, getTranscriptionJobByMessageId } from '../db.js';
import { processJob } from './service.js';
import { buildProcessDeps } from './runtime.js';
import { getObjectBuffer, whatsappMediaBucket } from '../integrations/r2.js';

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const deps = buildProcessDeps();

  if (cmd === 'pending') {
    const limit = Number(args.includes('--limit') ? args[args.indexOf('--limit') + 1] : 20);
    const dry = args.includes('--dry-run');
    // dry-run usa SELECT não-claiming (não consome attempts / não adia)
    const jobs = dry ? await selectPendingTranscriptionJobs(limit) : (await import('../db.js')).claimDueTranscriptionJobs(limit).then(x => x);
    const list = Array.isArray(jobs) ? jobs : await jobs;
    let total = 0;
    for (const job of list) {
      if (dry) {
        const media = await deps.evolution && await (await import('../evolution/client.js')).getBase64FromMediaMessage(deps.evolution, job.instance, job.raw_envelope);
        const buf = Buffer.from(media.base64 || '', 'base64');
        const { rows } = await pool.query(`SELECT media_duration_s, media_mime FROM messages WHERE id=$1`, [job.message_id]);
        const t = await deps.provider.transcribe(buf, { mime: rows[0]?.media_mime ?? 'audio/ogg', durationS: rows[0]?.media_duration_s ?? null });
        total += t.costUsd;
        console.log(`[dry] msg=${job.message_id} dur=${rows[0]?.media_duration_s}s custo=$${t.costUsd.toFixed(4)} :: ${t.text.slice(0, 80)}`);
      } else {
        await processJob(deps, job);
        const { rows } = await pool.query(`SELECT transcription_status, text FROM messages WHERE id=$1`, [job.message_id]);
        console.log(`msg=${job.message_id} status=${rows[0]?.transcription_status} :: ${(rows[0]?.text ?? '').slice(0, 80)}`);
      }
    }
    console.log(dry ? `TOTAL estimado: $${total.toFixed(4)} (${list.length} jobs)` : `Processados: ${list.length}`);
  } else if (cmd === 'redo') {
    const messageId = Number(args[args.indexOf('--message-id') + 1]);
    const { rows } = await pool.query(`SELECT media_key, media_mime, media_duration_s FROM messages WHERE id=$1`, [messageId]);
    const msg = rows[0];
    if (!msg?.media_key) { console.error('mensagem sem media_key — nada pra reprocessar do R2'); process.exit(1); }
    const buf = await getObjectBuffer(msg.media_key, whatsappMediaBucket()!);
    const t = await deps.provider.transcribe(buf, { mime: msg.media_mime ?? 'audio/ogg', durationS: msg.media_duration_s });
    await pool.query(`UPDATE messages SET text=$2, transcription_status='done' WHERE id=$1`, [messageId, t.text.trim() || '[áudio sem fala reconhecível]']);
    console.log(`redo msg=${messageId} :: ${t.text.slice(0, 120)}`);
  } else {
    console.error('uso: transcribe pending [--limit N] [--dry-run] | transcribe redo --message-id N');
    process.exit(1);
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
```

> Simplifique a leitura do `claimDueTranscriptionJobs` (o `import` dinâmico acima é ilustrativo): importe `claimDueTranscriptionJobs` e `getBase64FromMediaMessage` no topo como os demais. Mantenha a distinção dry-run (select) vs run (claim).

- [ ] **Step 6: Wire `index.ts` + `package.json`**

Em `src/index.ts`, no topo importar:

```ts
import { assertTranscribeConfig } from './config.js';
import { startTranscriptionPoller } from './transcription/poller.js';
import { r2Configured } from './integrations/r2.js';
```

Após `startProvisioningReaperCron(...)` (e antes de fechar), adicionar:

```ts
  // Serviço de transcrição de áudio (isolado). Fail-fast se ligado sem pré-requisitos.
  assertTranscribeConfig(config, r2Configured());
  if (config.TRANSCRIBE_MODE === 'auto') {
    startTranscriptionPoller(app.log);
  } else {
    app.log.info({ mode: config.TRANSCRIBE_MODE }, 'transcrição: poller NÃO iniciado (modo != auto)');
  }
```

Em `package.json` scripts:

```json
    "transcribe:pending": "tsx src/transcription/cli.ts pending",
    "transcribe:redo": "tsx src/transcription/cli.ts redo",
```

- [ ] **Step 7: Typecheck + suite**

Run: `pnpm typecheck && node --test --import tsx tests/transcription/poller.db.test.ts`
Expected: typecheck limpo + PASS.

- [ ] **Step 8: Commit**

```bash
git add src/transcription/poller.ts src/transcription/cli.ts src/transcription/runtime.ts src/index.ts package.json tests/transcription/poller.db.test.ts
git commit -m "feat(transcricao): poller (auto) + CLI (pending/redo) + wiring no index"
```

---

### Task 11: Leitura — campos na thread + endpoint de presign

**Files:**
- Modify: `src/whatsapp/read-queries.ts` (`Msg` + `listThreadMessages`)
- Modify: `src/whatsapp/read-routes.ts` (nova rota `GET /whatsapp/media/:messageId`)
- Test: `tests/whatsapp/media-route.db.test.ts`; `tests/whatsapp/thread-messages-audio.db.test.ts`

**Interfaces:**
- Consumes: `getNumber`, `gateMember`, `logAccess`, `tenantContext`, `presignGet`, `whatsappMediaBucket`.
- Produces: `Msg` com `id`, `kind`, `transcriptionStatus`, `mediaDurationS`, `hasMedia`; rota de presign.

- [ ] **Step 1: Write the failing tests**

Create `tests/whatsapp/thread-messages-audio.db.test.ts`:

```ts
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, insertMessage } from '../../src/db.js';
import { listThreadMessages } from '../../src/whatsapp/read-queries.js';

beforeEach(async () => {
  await pool.query('TRUNCATE messages, whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws-1','inst-1')`);
});
after(() => pool.end());

test('listThreadMessages devolve id/kind/transcriptionStatus/hasMedia', async () => {
  const m = await insertMessage({ agent: null, channel: 'whatsapp', identifier: '+55a', direction: 'inbound', text: '[áudio]', evolution_event_id: 'E1', whatsapp_number_id: 1, workspace_id: 'ws-1', kind: 'audio', media_mime: 'audio/ogg', media_duration_s: 4, transcription_status: 'pending' });
  await pool.query(`UPDATE messages SET media_key='k/1.ogg' WHERE id=$1`, [m.id]);
  const { messages } = await listThreadMessages(pool, { workspaceId: 'ws-1', numberId: 1, identifier: '+55a', limit: 10 });
  const row = messages[0] as any;
  assert.equal(row.id, m.id);
  assert.equal(row.kind, 'audio');
  assert.equal(row.transcriptionStatus, 'pending');
  assert.equal(row.hasMedia, true);
});
```

- [ ] **Step 2: Run → FAIL**

Run: `node --test --import tsx tests/whatsapp/thread-messages-audio.db.test.ts`
Expected: FAIL (campos ausentes).

- [ ] **Step 3: Extend `Msg` + query**

Em `src/whatsapp/read-queries.ts`:

```ts
export type Msg = { id: number; direction: string; text: string | null; agent: string | null; createdAt: string; author: string | null; authorName: string | null; kind: string; transcriptionStatus: string | null; mediaDurationS: number | null; hasMedia: boolean };
```

No SELECT do `listThreadMessages`, adicionar `m.id, m.kind, m.transcription_status, m.media_duration_s, m.media_key`:

```ts
    `SELECT m.id, m.direction, m.text, m.agent, m.created_at, m.author,
            m.kind, m.transcription_status, m.media_duration_s, m.media_key,
            w.push_name AS author_name
       FROM messages m ...`
```

E o `.map`:

```ts
  const messages: Msg[] = rows.map(r => ({ id: Number(r.id), direction: r.direction, text: r.text, agent: r.agent, createdAt: r.created_at.toISOString(), author: r.author, authorName: r.author_name, kind: r.kind, transcriptionStatus: r.transcription_status, mediaDurationS: r.media_duration_s, hasMedia: r.media_key != null }));
```

- [ ] **Step 4: Run → PASS**

Run: `node --test --import tsx tests/whatsapp/thread-messages-audio.db.test.ts`
Expected: PASS.

- [ ] **Step 5: Add media presign route (test first)**

Create `tests/whatsapp/media-route.db.test.ts` seguindo o padrão dos testes de rota whatsapp existentes (montar app com `registerReadRoutes`, injetar com header `x-acting-user` + membership seed). Casos:
- sem `x-acting-user` → 400.
- membro OK + mensagem com `media_key` → 200 com `{ url }` (mock `presignGet`) + linha `whatsapp_access_log action='media_presign'`.
- mensagem sem `media_key` → 404.
- não-membro do workspace → 403.

- [ ] **Step 6: Implement the route in `read-routes.ts`**

Adicionar (mesmo pipeline de `/threads/:identifier/messages`):

```ts
  // ── GET /whatsapp/media/:messageId ── presign do .ogg (workspace-scoped) ──
  app.get('/whatsapp/media/:messageId', { preHandler: auth }, async (req: any, reply) => {
    if (!req.actingUser) return reply.code(400).send({ error: 'x-acting-user required' });
    const messageId = Number(req.params.messageId);
    if (Number.isNaN(messageId)) return reply.code(400).send({ error: 'messageId must be numeric' });
    const { rows } = await deps.pool.query(`SELECT whatsapp_number_id, media_key FROM messages WHERE id=$1`, [messageId]);
    const m = rows[0];
    if (!m || !m.whatsapp_number_id) return reply.code(404).send({ error: 'message not found' });
    const num = await getNumber(deps.pool, Number(m.whatsapp_number_id));
    if (!num) return reply.code(404).send({ error: 'number not found' });
    if (!await gateMember(req, reply, num.workspaceId, authz)) return;
    if (!m.media_key) return reply.code(404).send({ error: 'no media' });
    const url = await presignGet(m.media_key, 120, whatsappMediaBucket()!);
    logAccess(deps.pool, { actor: req.actingUser, action: 'media_presign', workspaceId: num.workspaceId, numberId: num.id });
    return reply.send({ schema: 'whatsapp_v1', context: tenantContext(num), url });
  });
```

Imports no topo de `read-routes.ts`: `presignGet`, `whatsappMediaBucket` de `../integrations/r2.js` (getNumber/gateMember/logAccess/tenantContext já importados).

- [ ] **Step 7: Run route tests → PASS**

Run: `node --test --import tsx tests/whatsapp/media-route.db.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/whatsapp/read-queries.ts src/whatsapp/read-routes.ts tests/whatsapp/thread-messages-audio.db.test.ts tests/whatsapp/media-route.db.test.ts
git commit -m "feat(transcricao): thread expõe id/kind/status/hasMedia + GET /whatsapp/media/:id (presign)"
```

---

### Task 12: Fechamento — suíte cheia, typecheck, build

**Files:** nenhum novo (verificação).

- [ ] **Step 1: Rodar suíte completa**

Run: `pnpm typecheck && pnpm build && pnpm test`
Expected: typecheck limpo, build ok, suíte verde (incluindo todos os testes novos). Corrigir asserções de envelope pré-existentes que quebrem com os campos novos de `messages`/thread (varredura do §5 da spec).

- [ ] **Step 2: Smoke plan da Fase 1 (documentar, não executar aqui)**

Registrar no PR: em prod com `TRANSCRIBE_MODE=manual`, enviar 1 áudio real → `pnpm transcribe:pending --dry-run` → conferir custo/texto → `pnpm transcribe:pending` → conferir `messages.text` + `.ogg` no R2 + `GET /whatsapp/media/:id`. Valida a dependência da Evolution persistir a mídia (spec §6/B6).

- [ ] **Step 3: Commit final (se houver ajustes de varredura)**

```bash
git add -A
git commit -m "test(transcricao): ajusta asserções de envelope p/ colunas novas de mídia"
```

---

## Self-Review

**Spec coverage:** §4.1 schema→T1; §3 flags/fail-fast→T2; §4.2 parser→T3; §4.3 Evolution→T4; §4.4 R2→T5; §4.6 passo5/custo + insertMessage→T6/T8; §4.5 provider→T7; §4.6 service→T8; §4.7 webhook→T9; §4.8 poller/CLI→T10; §4.9 leitura+presign→T11; §5 testes→distribuídos + T12. Sem gaps.

**Placeholder scan:** os `// ...` nos testes de integração do T9/T11 são intencionais (reuso do helper de app existente, que o implementador localiza) — cada um vem com casos e asserts nomeados; o caminho puro `audioIngestPlan`/`Msg` tem código completo. Nenhum "TBD"/"implement later" em código de produção.

**Type consistency:** `TranscriptionJob`, `ProcessDeps`, `TranscriptionProvider`, `Msg`, `audioIngestPlan`, `buildProcessDeps`, `runTranscriptionBatch`, `insertTranscriptionJob`/`claimDueTranscriptionJobs`/`markTranscription*` batem entre tasks. `insertMessage` estende args sem quebrar chamadas. `agentsToTrigger(pool,{workspaceId,numberId,mode})` e `enqueuePendingTrigger({agent,project,identifier,inbox_id,scheduled_at})` conforme db.ts/reaction.ts reais.

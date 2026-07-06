# Spec — Transcrição de áudio do WhatsApp (serviço pontual do worker)

> Status: draft v3 (2026-07-06) — revisada por Fable (4 ALTA + 7 MÉDIA + 8 BAIXA) e por 2ª passada
> adversarial Claude (3 MÉDIA + 3 BAIXA — stand-in do Codex, que não roda neste ambiente por falha de
> sandbox do Windows). APIs externas (Evolution `getBase64FromMediaMessage`, SDK OpenAI
> `audio.transcriptions` + `gpt-4o-mini-transcribe`) confirmadas contra o código/SDK instalado.
> Recebe notas de voz / áudios do WhatsApp (inbound **e** enviados/`fromMe`), baixa a mídia da
> Evolution, guarda o `.ogg` no R2 e **transcreve** via ASR (OpenAI, atrás de interface plugável).
> O texto vira `messages.text`, então painel/MCP/export/busca leem sem mudança. Serviço **isolado**:
> módulo próprio, tabela própria, poller próprio, envs próprias — **não** reusa Lua nem é um agente.
> Consumo: timeline (humanos/UI) **e** agentes reativos (via o trigger que já existe).
> Canon: `src/webhook/routes.ts` (number-path, gate de trigger em L126), `src/webhook/evolution.ts`
> (parser), `src/evolution/client.ts` (Evolution API), `src/db.ts` (`insertMessage` L263,
> `enqueuePendingTrigger` L461, `claimDuePendingTriggers` L496, `markTriggerRetryOrFail` L545,
> `insertLlmMetric` L585), `src/whatsapp/read-queries.ts` (L174, tipo `Msg`),
> `src/whatsapp/read-routes.ts` (L118-130, padrão actor→getNumber→gateMember→logAccess),
> `src/whatsapp/export.ts`, `src/whatsapp/reaction.ts` (`agentsToTrigger`), `src/integrations/r2.ts`,
> `src/lua/embeddings.ts` (uso atual do SDK OpenAI), `src/events/outbox.ts`+`dispatcher.ts` (padrão de
> poller claim/retry), `src/triggers/poller.ts`, `src/index.ts` (start de pollers), `src/config.ts`
> (flags estritas), `migrations/005_messages_and_metrics.sql`, `migrations/026_messages_whatsapp_columns.sql`.

## 1. Contexto e motivação

Hoje o worker é **cego a áudio**. O caminho de uma nota de voz:

1. Evolution manda `messages.upsert` pro `POST /webhook` — webhook registrado com `base64:false`
   (`evolution/client.ts:54`), então **os bytes do áudio NÃO vêm no payload**; chega só o envelope
   `audioMessage`/`pttMessage` (mimetype, `seconds`, `mediaKey`, url cifrada).
2. `extractMessageText` (`webhook/evolution.ts:97`) cobre texto, captions e botões, mas **não**
   `audioMessage`/`pttMessage` → `messageText = null`.
3. Com texto `null`, o handler loga warning ("mensagem chegou sem texto extraível"), grava
   `webhook_logs` com `payload_summary:'(sem texto)'`, e **pula o `insertMessage`** (guard
   `if (msg.messageText && msg.identifier)`, `routes.ts:96`). **O áudio nunca entra em `messages`.**
4. `messages.text` é `NOT NULL` e não há coluna de mídia/tipo/transcrição.

Consequência: quem só manda áudio some da timeline; o agente reativo **é disparado** (o trigger é
gated pelo insert em `webhook_logs`, não pelo texto — `routes.ts:126`) mas **lê `[áudio]` vazio**;
diagnóstico/qualificação de leads por conversa perde tudo que foi falado.

## 2. Escopo

**Dentro:**
- **Captura:** detectar áudio no parser (só **DM**, ver §3); baixar a mídia via Evolution
  `getBase64FromMediaMessage`; subir o `.ogg` no R2.
- **Persistência:** `messages` ganha `kind`/`media_*`/`transcription_status`; nova fila
  `transcription_jobs`. Transcrição vai pro `messages.text`.
- **Transcrição:** interface `TranscriptionProvider` + impl OpenAI (`gpt-4o-mini-transcribe`).
- **Duas fases:** Fase 1 **CLI manual** (`pnpm transcribe:pending`) pra validar custo/qualidade;
  Fase 2 **poller automático** + integração com o trigger reativo. Flag `TRANSCRIBE_MODE`.
- **Custo:** 1 linha em `llm_metrics` por transcrição.
- **Leitura:** `read-queries` + tools MCP `whatsapp_thread_messages` expõem
  `id`/`kind`/`transcription_status`/`hasMedia`; endpoint presign pra ouvir o áudio.

**Fora (não reabrir):**
- **Caminho legado** (`mercurio`/`saturno` via `AGENT_TOKENS_JSON`) — em sunset; áudio ali segue só
  logando. A captura é só no **number-path** (multi-número, o fluxo vivo).
- **WhatsApp Cloud API** (`webhook-cloud`) — áudio por lá fica pra depois (Cloud usa media id + Graph).
- **Áudio de grupo** — MVP transcreve **só DM** (`!isGroup`); grupo segue só logando (controla custo
  invisível; números de auditoria têm volume alto). Reversível quando quiser (ver §3). Decisão do owner.
- **Outras mídias** (imagem/documento/vídeo) — schema não trava, mas só áudio agora (YAGNI).
- **UI do painel** (repo `beeads-central-de-dados`) — só entregamos o contrato REST/MCP.
- **Self-host de Whisper** — a interface deixa a porta aberta; não implementado agora.

## 3. Decisões de design (fechadas com o owner + revisão Fable/Codex)

- **Serviço isolado, não-agente.** Módulo `src/transcription/`, tabela `transcription_jobs`, poller
  próprio, envs `TRANSCRIBE_*`. Não importa/estende nada da Lua. Único toque com agente: ao concluir,
  escreve texto em `messages` e (modo `auto`) enfileira o `pending_trigger` **existente**.
- **Assíncrono (fila + poller), nunca no caminho quente do webhook.** Webhook só enfileira e responde
  200. `getBase64` + ASR são 2 chamadas externas de segundos; síncrono arriscaria timeout → reenvio do
  webhook pela Evolution + sem retry pra mídia ainda-não-pronta.
- **Ciclo de vida do job = espelho do outbox/trigger (sem estado `processing`).** [Fable A1] O claim
  do poller/CLI **mantém `status='pending'`** e empurra `scheduled_at` no ato do claim (auto-cura de
  crash), igual `claimDuePendingTriggers` (db.ts:496) e `claimDueDeliveries` (outbox.ts:66). Estados:
  `pending` → `done` (sucesso) ou `failed` (attempts ≥ max). **Não existe `processing`** — nem no job,
  nem em `messages.transcription_status` (domínio: `pending|done|failed`).
- **Transcrição no próprio `messages.text`.** Placeholder `[áudio]` na chegada, substituído pela
  transcrição ao concluir. `messages.text` continua `NOT NULL`. O **texto** flui downstream sem
  mudança (painel, busca ILIKE, `firstInboundText` do skill S10). O `export` herda **só o texto** — os
  metadados novos (`kind`/status) **não** passam pelo `TranscriptMsg` [Fable M7].
- **Engine plugável, default OpenAI `gpt-4o-mini-transcribe`.** Interface `TranscriptionProvider`;
  trocar por `whisper-1`/Whisper self-hosted é 1 arquivo. `language:'pt'`. Modelo via
  `TRANSCRIBE_MODEL` (default `gpt-4o-mini-transcribe`).
- **`TRANSCRIBE_MODE` (enum estrito `off|manual|auto`, default `off`).** Padrão de parse estrito de
  `LUA_ENABLED` (config.ts:143). **Fail-fast no startup** [Fable M1]: `≠'off'` **exige**
  `OPENAI_API_KEY` **e** `r2Configured()`; senão o boot falha explícito (evita queimar attempts e
  gravar placeholder `failed` permanente por erro de env).
  - `off` (default, kill-switch): áudio segue o comportamento atual (loga, não grava, não enfileira).
  - `manual` (Fase 1): grava placeholder + enfileira job; **poller desligado**; CLI processa na mão.
    **Trigger reativo inalterado vs hoje** — o webhook segue disparando na chegada (agente lê `[áudio]`
    como já lê). Sem regressão pro lead que só manda áudio [Fable A2].
  - `auto` (Fase 2): grava placeholder + enfileira job; **poller processa**; **suprime** o trigger na
    chegada e dispara ao concluir (dentro do debounce de 25s).
- **Trigger — regra executável (não "fase")** [Fable A2/B3]: o webhook **só suprime** o trigger de
  áudio quando `TRANSCRIBE_MODE==='auto'`. O `processJob` **só dispara** trigger quando
  `TRANSCRIBE_MODE==='auto'` **E** `direction='inbound'` **E** `NOT is_group`. `fromMe`/grupo nunca
  disparam. (A CLI nunca dispara — roda em `manual`, onde o webhook já disparou.)
- **Custo por uso, rastreado em `llm_metrics`.** `agent='transcription'` (convenção fixa — a coluna é
  `NOT NULL` e o número pode ser `monitored` sem agente [Fable M4]), `task='transcribe'`, `provider`,
  `model`, `cost_usd` = `media_duration_s/60 × RATE[model]`, `latency_ms`, `message_id`. Consulta por
  workspace = join `message_id → messages.workspace_id` (`llm_metrics` não tem `workspace_id`).
- **Áudio guardado no R2 permanentemente** (owner: permite ouvir + reprocessar). Key
  `whatsapp-audio/<workspaceId>/<numberId>/<messageId>.ogg`. Bucket = `R2_BUCKET_WHATSAPP_MEDIA`
  (novo, opcional) com fallback pro `R2_BUCKET_EPISODES` já configurado — não exige infra nova.
- **Rollout global no MVP** (flag única). Opt-in por número (`whatsapp_numbers.transcribe_enabled`)
  fica como extensão trivial futura — **decisão pendente do Gustavo**.

## 4. Implementação

### 4.1 Schema (migration 041)

Idempotente inclusive nos `ADD CONSTRAINT` (Postgres não tem `IF NOT EXISTS` pra constraint; o repo já
queimou com reexecução parcial — memory da 037) [Fable B1]:

```sql
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text',        -- 'text' | 'audio'
  ADD COLUMN IF NOT EXISTS media_key TEXT,                           -- R2 key do .ogg (setado após upload)
  ADD COLUMN IF NOT EXISTS media_mime TEXT,
  ADD COLUMN IF NOT EXISTS media_duration_s INT,
  ADD COLUMN IF NOT EXISTS transcription_status TEXT;                -- null p/ text; 'pending'|'done'|'failed' p/ audio
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
  whatsapp_number_id BIGINT NOT NULL REFERENCES whatsapp_numbers(id) ON DELETE CASCADE, -- só number-path
  workspace_id TEXT,
  instance TEXT NOT NULL,                        -- p/ chamar Evolution getBase64
  evolution_event_id TEXT NOT NULL,
  direction TEXT NOT NULL,                       -- 'inbound' | 'outbound'
  is_group BOOLEAN NOT NULL DEFAULT FALSE,       -- gate de trigger (§4.6 passo 6); scaffolding p/ toggle de grupo (hoje sempre false, §2) [rev2 B2]
  identifier TEXT NOT NULL,                      -- número do lead (p/ enfileirar trigger)
  inbox_id BIGINT,                               -- webhook_logs.id — enqueuePendingTrigger exige (db.ts:461)
  raw_envelope JSONB NOT NULL,                   -- objeto `data` do webhook; limpo após 'done' (§4.6)
  status TEXT NOT NULL DEFAULT 'pending',        -- pending | done | failed
  attempts INT NOT NULL DEFAULT 0,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- idempotência: 1 job por (número, evento). Reentrega de webhook não duplica.
CREATE UNIQUE INDEX IF NOT EXISTS uq_transcription_jobs_evt
  ON transcription_jobs (whatsapp_number_id, evolution_event_id);
-- claim do poller/CLI: jobs pending prontos, por scheduled_at.
CREATE INDEX IF NOT EXISTS idx_transcription_jobs_due
  ON transcription_jobs (scheduled_at) WHERE status = 'pending';
```

`max_attempts` **não** é coluna por-row — é env `TRANSCRIBE_MAX_ATTEMPTS` (default 4), como
`OUTBOX_MAX_ATTEMPTS`/`TRIGGER_POLLER_MAX_ATTEMPTS` [Fable B2].

### 4.2 Parser — detectar áudio (`webhook/evolution.ts`)

`ParsedMessage` ganha `media: { kind:'audio'; mime: string|null; durationS: number|null } | null`.
Nova `extractMedia(msg)` espelhando `extractMessageText` (desempacota `ephemeral`/`viewOnce`/`edited`
recursivamente) e detectando `audioMessage` e `pttMessage`: `mime ← audioMessage.mimetype`,
`durationS ← audioMessage.seconds`. Áudio não tem caption → `messageText` fica `null` (esperado);
`messageText` e `media` são independentes.

### 4.3 Evolution client — download de mídia (`evolution/client.ts`)

```ts
export async function getBase64FromMediaMessage(
  deps: EvolutionDeps, instance: string, rawMessage: unknown
): Promise<{ base64: string; mimetype: string | null }> {
  const r = await call(deps, 'POST', `/chat/getBase64FromMediaMessage/${instance}`, { message: rawMessage });
  return { base64: r.base64 ?? '', mimetype: r.mimetype ?? null };
}
```

- `rawMessage` = o objeto `data` do webhook (guardado em `raw_envelope`). Evolution descriptografa sob
  demanda. **Depende** da Evolution ter persistido a mensagem na instância (o backfill via
  `/chat/findMessages` sugere que sim, mas **validar em smoke na Fase 1**) [Fable B6].
- **Race:** logo após o upsert a mídia pode não estar pronta → chamada falha/vazia → retry (backoff).

### 4.4 R2 — guardar o `.ogg` (`integrations/r2.ts`)

Generalizar os helpers pra aceitar bucket (default mantém compat com episódios) + adicionar um
`getObjectBuffer` (necessário pro `transcribe:redo` reprocessar a partir do `.ogg`, §4.8) [rev2 M1]:

```ts
export async function putAndVerify(key, body, contentType, bucket = config.R2_BUCKET_EPISODES!): Promise<void>
export async function presignGet(key, ttlSeconds = 120, bucket = config.R2_BUCKET_EPISODES!): Promise<string>
export async function getObjectBuffer(key, bucket = config.R2_BUCKET_EPISODES!): Promise<Buffer>  // GetObject → Buffer
```

`config.R2_BUCKET_WHATSAPP_MEDIA` (novo, opcional) resolve o bucket de áudio; fallback
`R2_BUCKET_EPISODES`. `r2Configured()` inalterado.

### 4.5 Provider de transcrição (`transcription/provider.ts`)

```ts
export interface TranscriptionResult { text: string; model: string; costUsd: number; }
export interface TranscriptionProvider {
  transcribe(audio: Buffer, opts: { mime: string|null; durationS: number|null; language?: string }): Promise<TranscriptionResult>;
}
export class OpenAITranscriptionProvider implements TranscriptionProvider { /* audio.transcriptions.create */ }
```

- OpenAI: `toFile(audio, 'audio.ogg', { type: mime ?? 'audio/ogg' })` →
  `client.audio.transcriptions.create({ file, model: config.TRANSCRIBE_MODEL, language: 'pt' })`.
  Texto ← `r.text`.
- `costUsd` = `(durationS ?? 0)/60 × RATE[model]` (const `RATE`, ~`0.003` p/ mini). Duração do envelope
  (`seconds`), não da API (não confiável entre modelos).

### 4.6 Service — processa 1 job (`transcription/service.ts`)

`processJob(job)` (chamado por CLI ou poller). O job já foi **claimado** (attempts bumpado,
`scheduled_at` empurrado) pelo claim que o entregou — o `processJob` não reclama:

1. `getBase64FromMediaMessage(instance, raw_envelope)` → **se `base64` vazio, `throw` (retryable)
   ANTES de qualquer upload** — a Evolution pode responder `200` com base64 vazio quando a mídia ainda
   não foi descriptografada; sem esse guard, subiria um `.ogg` vazio e gravaria `media_key` de lixo,
   só falhando lá no ASR [rev2 M3]. Só depois: `Buffer.from(base64,'base64')`.
2. **Cap de duração:** se `durationS > TRANSCRIBE_MAX_DURATION_S` (default 600) → ainda sobe o `.ogg`
   (passo 3, pra poder ouvir) mas **não** chama a API; grava `messages.text='[áudio longo — não
   transcrito]'`, `transcription_status='failed'`, `media_key`; job → `failed`. Sai [Fable B4].
   **Decisão do Gustavo:** manter o cap?
3. `putAndVerify('whatsapp-audio/<ws>/<numberId>/<messageId>.ogg', buf, mime, mediaBucket)` → **grava
   `messages.media_key`/`media_mime`/`media_duration_s` já aqui** (update próprio), antes de transcrever
   [Fable M3]. Assim, se o ASR falhar, o áudio continua ouvível.
4. `provider.transcribe(buf, { mime, durationS })` → `{ text, model, costUsd }`.
5. Transação: `UPDATE messages SET text=$text, transcription_status='done'` +
   `INSERT llm_metrics(agent='transcription', task='transcribe', ...)` +
   `UPDATE transcription_jobs SET status='done', raw_envelope='{}'::jsonb` (limpa PII do envelope após
   sucesso [Fable B7]).
   - `text` vazio (áudio sem fala) → `'[áudio sem fala reconhecível]'`, `status='done'`.
6. **Trigger** (regra §3): sse `TRANSCRIBE_MODE==='auto'` **E** `direction='inbound'` **E**
   `NOT is_group` → `agentsToTrigger` (re-resolve o `mode` do número — não vem no job) +
   `enqueuePendingTrigger({ inbox_id, identifier, ... })` + `computeScheduledAt`. [Fable A4]
7. **Erro** em qualquer passo → `markRetryOrFail`: se `attempts < TRANSCRIBE_MAX_ATTEMPTS`, job volta a
   `pending` com `scheduled_at = now + min(30s×attempts, 5min)` (linear, igual `markTriggerRetryOrFail`
   db.ts:545) [Fable B2] + `last_error`. Se esgotou → `status='failed'`,
   `messages.transcription_status='failed'`, `text='[áudio — transcrição indisponível]'`; e se
   inbound+não-grupo+`auto`, **dispara o trigger mesmo assim** (não travar o lead).

### 4.7 Webhook — enfileirar (`webhook/routes.ts`, number-path)

Quando `msg.media?.kind === 'audio'` **E** `!msg.isGroup` **E** `TRANSCRIBE_MODE !== 'off'`:

- `insertMessage({ ..., kind:'audio', text:'[áudio]', media_mime, media_duration_s,
  transcription_status:'pending' })` (dedup por `(whatsapp_number_id, evolution_event_id)` já existe).
- **Sempre** `insertTranscriptionJob({ message_id, ..., inbox_id, is_group:false, direction,
  raw_envelope: (req.body as any).data, ... })` com `ON CONFLICT DO NOTHING` — independente do
  `duplicate` do `insertMessage` (fecha o órfão de crash entre os dois inserts) [Fable M2].
  - **`inbox_id` = `webhook_logs.id`** (o `inserted.id` que vem do `logWebhook`, `routes.ts:81`) — **não**
    o `messages.id` do `insertMessage` (que no code é `msgInserted.id`). `enqueuePendingTrigger` espera o
    id do `webhook_logs` (db.ts:461) [rev2 B3].
  - **`message_id`** = o id do `insertMessage` (para o FK e o `UPDATE messages` do service).
- **Trigger:** só **suprime** (exclui áudio do gate `routes.ts:126`) quando `TRANSCRIBE_MODE==='auto'`.
  Em `manual`, o gate atual roda igual (sem regressão) [Fable A2].
- **Warning/summary:** quando `media≠null`, **não** logar "mensagem sem texto extraível" e usar
  `payload_summary='[áudio]'` [Fable B5].

`insertMessage` (`db.ts`) ganha `kind`/`media_mime`/`media_duration_s`/`transcription_status` opcionais
(default `text`/`null`) — sem quebrar chamadas existentes. **Atenção:** áudio cai no branch
**number-path** do `insertMessage` (db.ts:286-303, por ter `whatsapp_number_id`+`evolution_event_id`),
que tem lista de colunas própria e fixa — as 4 colunas novas têm que entrar **nesse INSERT**
(db.ts:288-289), não só no genérico (db.ts:329); senão o áudio grava `kind='text'` pelo DEFAULT [rev2 B1].

### 4.8 Poller (Fase 2) e CLI (Fase 1) — `transcription/db.ts`, `poller.ts`, `cli.ts`

- **Claim** (`claimDueTranscriptionJobs`, espelho de `claimDuePendingTriggers` db.ts:496): `SELECT ...
  WHERE status='pending' AND scheduled_at<=NOW() ORDER BY scheduled_at LIMIT $n FOR UPDATE SKIP
  LOCKED`, e no mesmo UPDATE bumpa `attempts` + `scheduled_at = now + 5min` (visibility timeout — se o
  processo cair, o job reaparece sozinho). Sem estado `processing` [Fable A1].
- **CLI** `src/transcription/cli.ts`:
  - `pnpm transcribe:pending [--limit N] [--dry-run]`: sem `--dry-run`, claima N (bumpa attempts +
    empurra `scheduled_at`, como o poller) e roda `processJob`. **Com `--dry-run`, usa um `SELECT`
    não-claiming** (não bumpa attempts nem adia o job) — baixa + transcreve mas **não** grava (nem
    `messages`, nem `llm_metrics`, nem job) [rev2 M2]. Imprime por job (`messageId`, duração, custo,
    status, preview) + custo total.
  - `pnpm transcribe:redo --message-id N` [Fable M5]: **reprocessa a partir do `.ogg` no R2**
    (`getObjectBuffer(media_key)` → `provider.transcribe` → `UPDATE messages.text`), **não** re-chama a
    Evolution — o `.ogg` é a fonte permanente e o `raw_envelope` já foi limpo no `done` (§4.6). Serve o
    caso primário: re-transcrever um `done` com modelo melhor. Se a mensagem não tem `media_key`
    (nunca subiu), o redo recai em resetar o job pra `pending` (envelope intacto só existe em job
    `failed`). [rev2 M1]
- **Poller** `startTranscriptionPoller` (`src/index.ts`, **só se** `TRANSCRIBE_MODE==='auto'`, espelha
  `startTriggerPoller`/`startOutboxDispatcher`): intervalo `TRANSCRIBE_POLLER_INTERVAL_MS` (default 5s),
  batch `TRANSCRIBE_POLLER_BATCH_SIZE` (default 20).

### 4.9 Leitura (contrato painel/MCP)

- `read-queries.ts` `listThreadMessages` (tipo `Msg`, L174) passa a devolver, por mensagem: **`id`**,
  `kind`, `transcription_status`, `media_duration_s`, e **`hasMedia`** (= `media_key IS NOT NULL`) — o
  `id` é o que a UI usa pra montar a URL do presign; `hasMedia` só deixa mostrar "play" quando o `.ogg`
  subiu [Fable A3]. Tudo aditivo. `whatsapp_thread_messages` herda via passthrough. **`export` não**
  herda os metadados (só o `text`) [Fable M7].
- Endpoint `GET /whatsapp/media/:messageId` — **mesmo pipeline de authz/audit das rotas vizinhas**
  [Fable M6]: `x-acting-user` obrigatório → resolve o número da mensagem → `gateMember(workspace)` →
  `logAccess(action:'media_presign')` → `presignGet(media_key, 120, mediaBucket)` → `{ url }`. Sem
  `media_key` → 404. Envelope `whatsapp_v1` + `context`.

## 5. Testes (Postgres efêmero, `tests/**`)

- **Parser** (`tests/webhook/*.test.ts`): `extractMedia` detecta `audioMessage`, `pttMessage`, e ambos
  dentro de `ephemeralMessage`/`viewOnceMessage`; texto puro → `media:null`; áudio → `media` populado,
  `messageText:null`.
- **Webhook** (Postgres efêmero): áudio DM (number-path) com `manual` → 1 row `messages`
  `kind='audio'`/`[áudio]`/`pending` + 1 `transcription_jobs` com `inbox_id`/`is_group=false`; **trigger
  disparado** (paridade com hoje). Com `auto` → mesmo, mas **sem** `pending_trigger` na chegada. Com
  `off` → sem row, sem job. **Áudio de grupo** → sem row/job (não transcreve). Reentrega do mesmo evento
  → sem duplicar message nem job. Crash simulado (message existe, job não) → reentrega cria o job.
- **Service** (Evolution + OpenAI mockados): feliz → `messages.text`=transcrição,
  `transcription_status='done'`, `media_key` setado, `raw_envelope` limpo, 1 `llm_metrics`
  `agent='transcription'`/`task='transcribe'`/`cost_usd` coerente; `auto`+inbound → 1 `pending_trigger`;
  `fromMe` e grupo → nenhum trigger. `media_key` gravado **antes** do ASR (falha do ASR ainda deixa
  `.ogg` ouvível). Falha do getBase64 → job volta a `pending` `attempts=1` `scheduled_at` futuro; após
  `TRANSCRIBE_MAX_ATTEMPTS` → `failed` + placeholder. Cap de duração → `failed` + `.ogg` no R2.
- **Claim/crash**: job claimado some do próximo claim por `scheduled_at` futuro; job "abandonado"
  (attempts bumpado, sem finalizar) reaparece após o visibility timeout.
- **CLI** `--dry-run`: não altera `messages`/`llm_metrics`/job — inclusive **não** consome `attempts`
  nem adia `scheduled_at` (usa SELECT não-claiming) [rev2 M2].
- **`transcribe:redo`**: sobre um `done` com `.ogg` no R2 → re-transcreve e reescreve `messages.text`
  sem chamar a Evolution.
- **Startup**: `TRANSCRIBE_MODE='manual'` sem `OPENAI_API_KEY` ou sem R2 → boot falha explícito.
- **Envelope existente:** varrer asserções estritas de `messages`/thread que quebrem com as colunas
  novas e ajustar.

## 6. Riscos e mitigação

- **Estado órfão de job** → resolvido por claim com visibility timeout (§4.8), sem `processing`.
- **Órfão message↔job** (crash entre inserts) → `insertTranscriptionJob` sempre idempotente (§4.7).
- **Env faltando corrompe dado** → fail-fast no startup (§3); poller/CLI não rodam sem pré-requisito.
- **Race mídia-não-pronta na Evolution** → retry backoff linear (`TRANSCRIBE_MAX_ATTEMPTS`=4); se
  estourar, `failed` com placeholder legível + `.ogg` ouvível.
- **`getBase64` depende da Evolution persistir a mensagem** (`DATABASE_SAVE_DATA_NEW_MESSAGE` na
  instância) → validar em smoke na Fase 1 [Fable B6].
- **Custo descontrolado** → `off` por padrão; Fase 1 manual valida gasto real; tudo em `llm_metrics`;
  cap de duração; grupo fora do MVP.
- **PII / LGPD** → `.ogg` em bucket R2 privado, servido só por presign TTL 120s sob `gateMember` +
  `logAccess`; `raw_envelope` (PII) limpo após `done`. Retention/lifecycle do `.ogg` = item futuro.
- **`gpt-4o-mini-transcribe` erro/indisponível** → `TRANSCRIBE_MODEL` troca pra `whisper-1`; erro
  transitório vira retry.
- **Ordem áudio↔texto no mesmo burst** → debounce de 25s do trigger absorve.

## 7. Critérios de aceite

1. Áudio **DM** inbound e `fromMe` (number-path) com `TRANSCRIBE_MODE≠off` viram row `messages`
   `kind='audio'` + `transcription_jobs` (com `inbox_id`/`is_group`); `off` mantém o comportamento
   atual; **áudio de grupo não é capturado**.
2. `manual` não regride o trigger (áudio dispara na chegada, como hoje). `auto` suprime na chegada e
   dispara só após transcrever, **só** inbound não-grupo. Falha final não trava (placeholder + trigger).
3. `processJob` baixa da Evolution, sobe `.ogg` no R2 (grava `media_key` **antes** do ASR), transcreve,
   grava a transcrição em `messages.text` (`done`), limpa `raw_envelope`, registra `llm_metrics`
   (`agent='transcription'`). Job segue o claim com visibility timeout (sem `processing`).
4. Fase 1: `pnpm transcribe:pending` processa a fila; `--dry-run` não grava; `transcribe:redo`
   reprocessa. Startup falha se `≠off` sem `OPENAI_API_KEY`/R2.
5. `whatsapp_thread_messages` expõe `id`/`kind`/`transcription_status`/`hasMedia`; `GET
   /whatsapp/media/:messageId` devolve presign sob `x-acting-user`+`gateMember`+`logAccess`.
6. Suíte do worker verde no Postgres efêmero (parser, webhook, service, claim/crash, CLI, startup) +
   `typecheck`/`build` verdes. MCP `typecheck`/`test` verdes se as tools mudarem.
7. Deploy do worker via Coolify (`pnpm deploy`); migration 041 aplicada no start (idempotente). Entra em
   prod com `TRANSCRIBE_MODE=manual` (Fase 1); `auto` só após OK de custo/qualidade do Gustavo.
```

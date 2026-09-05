import { z } from 'zod';

const AgentTokensSchema = z.record(
  z.string(),
  z.object({
    worker_token: z.string().min(8),
    // Bloquim sync é opcional a partir da v0.6 — worker é a inbox primária.
    bloquim_token: z.string().min(8).optional(),
    fallback_workspace_id: z.string().min(1).optional(),
    // v0.7 trigger-based: worker faz POST aqui quando webhook chega.
    trigger_url: z.string().url().optional(),
    trigger_secret: z.string().min(8).optional(),
    // Modo de operação do agente:
    //  - 'reactive' (default): responde inbound 1:1 (SDR/mercurio). Cria task
    //    Bloquim + enfileira trigger; ignora mensagens de grupo.
    //  - 'sweep': agente auditor (saturno). INGERE mensagens de grupo (@g.us)
    //    pra inbox, NÃO cria task nem dispara trigger reativo (varre por cron).
    mode: z.enum(['reactive', 'sweep']).default('reactive'),
  })
);

// Mapping de phone_number_id (WhatsApp Cloud) → { agent, project }.
// Permite múltiplos números numa mesma app Meta, cada um roteando pra agent/project diferente.
const CloudNumberMapSchema = z.record(
  z.string(),
  z.object({
    agent: z.string().min(1),
    project: z.string().min(1),
  })
);

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DATABASE_URL: z.string().url(),
  BLOQUIM_API_URL: z.string().url(),
  // Segredo compartilhado p/ chamar rotas internas do bloquim-api
  // (/api/internal/*), ex.: resolve-by-whatsapp. Mesmo valor no bloquim-api.
  INTERNAL_API_SECRET: z.string().optional(),
  AGENT_TOKENS_JSON: z.string().transform((s, ctx) => {
    try {
      return AgentTokensSchema.parse(JSON.parse(s));
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: `AGENT_TOKENS_JSON inválido: ${(e as Error).message}` });
      return z.NEVER;
    }
  }),
  EVOLUTION_WEBHOOK_SECRET: z.string().min(8),
  // Evolution API v2 (provisionamento + envio). Base e apikey global da app evolution-api.
  EVOLUTION_API_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(1),
  // URL pública do /webhook do worker, registrada como webhook POR-INSTÂNCIA na Evolution
  // no provisionamento (o webhook GLOBAL não envia X-Evolution-Secret → daria 401).
  WORKER_WEBHOOK_URL: z.string().url().default('https://agentes-worker.beeads.com.br/webhook'),

  // WhatsApp Cloud API (Meta) — opcional. Quando setado, ativa /webhook-cloud
  // e /send-cloud no worker. Tokens vivem aqui em vez de no orquestrador
  // pra centralizar rotação.
  WHATSAPP_CLOUD_APP_SECRET: z.string().optional(),
  WHATSAPP_CLOUD_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_CLOUD_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_CLOUD_GRAPH_VERSION: z.string().default('v22.0'),
  // JSON string mapeando phone_number_id → { agent, project }
  // Ex: {"1152130677980438":{"agent":"mercurio","project":"metido-a-gente"}}
  WHATSAPP_CLOUD_NUMBERS_JSON: z
    .string()
    .optional()
    .transform((s, ctx) => {
      if (!s) return {};
      try {
        return CloudNumberMapSchema.parse(JSON.parse(s));
      } catch (e) {
        ctx.addIssue({
          code: 'custom',
          message: `WHATSAPP_CLOUD_NUMBERS_JSON inválido: ${(e as Error).message}`,
        });
        return z.NEVER;
      }
    }),

  // Shared secret entre worker e GUI agentes.beeads.com.br para endpoints /admin/*.
  // Gerar com: openssl rand -hex 32
  OWNER_ADMIN_TOKEN: z.string().min(32),
  // Shared secret entre o painel central (beeads-central-de-dados) e o worker p/ /admin/whatsapp/* e /whatsapp/*.
  PANEL_TOKEN: z.string().min(1),

  // Google OAuth (Entrega 2). Sem default — se ausente, endpoints /admin/.../google/* falham
  // explicitamente em runtime.
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(10),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(10),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url(),
  // 32 bytes em base64 — openssl rand -base64 32
  GOOGLE_TOKEN_ENCRYPTION_KEY: z.string().min(40),
  GOOGLE_OAUTH_STATE_SECRET: z.string().min(40),

  // ── Keep-alive de presença WhatsApp ──
  // Reafirma `presence: unavailable` nas instâncias conectadas. Sem isso o estado
  // decai no servidor do WhatsApp e o push do celular do cliente é suprimido.
  // 5 min é conservador: ~8 instâncias × 12 ciclos/h ≈ 96 req/h (desprezível).
  WHATSAPP_PRESENCE_REFRESH_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),

  // ── Alerta de queda de conexão WhatsApp ──
  // Sweep varre números fora do ar; dispara alerta (outbox + WhatsApp) após o debounce.
  CONNECTION_ALERT_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  CONNECTION_ALERT_DEBOUNCE_MS: z.coerce.number().int().positive().default(300_000), // 5 min
  // Instância Evolution que envia o aviso (número-sistema, ex.: saturno-<algo>). Vazio → só painel.
  CONNECTION_ALERT_SENDER_INSTANCE: z.string().optional(),
  // Destino do aviso: telefone E.164 (com ou sem +) ou JID de grupo (...@g.us). Vazio → só painel.
  CONNECTION_ALERT_TARGET: z.string().optional(),

  // Burst smoothing / debounce: tempo de espera após cada msg recebida antes
  // de disparar trigger pro mercurio. Nova msg na janela reseta o timer.
  TRIGGER_DEBOUNCE_MS: z.coerce.number().int().positive().default(25_000),
  // Intervalo do poller que varre pending_triggers prontos pra disparar.
  TRIGGER_POLLER_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  // Tentativas máximas por trigger antes de marcar 'failed'.
  TRIGGER_POLLER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  // Quantos triggers o poller processa por ciclo.
  TRIGGER_POLLER_BATCH_SIZE: z.coerce.number().int().positive().default(50),

  // ── Outbox de eventos (spec transcrições §4) ──
  // JSON: { "<event_type>": { "<subscriber_key>": { "url": "...", "secrets": ["ativo","anterior?"] } } }
  EVENT_SUBSCRIBERS_JSON: z.string().optional().transform((s, ctx) => {
    if (!s) return {} as Record<string, Record<string, { url: string; secrets: string[] }>>;
    try {
      return z.record(z.string(), z.record(z.string(), z.object({
        url: z.string().url(),
        secrets: z.array(z.string().min(8)).min(1),
      }))).parse(JSON.parse(s));
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: `EVENT_SUBSCRIBERS_JSON inválido: ${(e as Error).message}` });
      return z.NEVER;
    }
  }),
  OUTBOX_POLLER_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  OUTBOX_POLLER_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),

  // ── Repositório de transcrições ──
  FIREFLIES_API_KEY: z.string().optional().transform((s) => s?.trim() || undefined),
  // ── Lua (memória) ── chave OpenAI p/ embeddings (text-embedding-3-large@1024).
  // Opcional: ausente não quebra startup; só o batch/bootstrap reais a exigem.
  OPENAI_API_KEY: z.string().optional(),
  // ── Lua (memória) ── chave Gemini p/ embeddings (gemini-embedding-001@1024).
  // Preferida sobre OpenAI quando presente. Opcional: ausente nao quebra startup.
  GEMINI_API_KEY: z.string().optional(),
  // ── Lua (memória) ── chave Anthropic p/ extração/judge/narrativa (Sonnet, spec §5.4).
  // Opcional: ausente não quebra startup; só o batch/bootstrap reais a exigem.
  ANTHROPIC_API_KEY: z.string().optional(),
  // ── Lua (memória) ── parâmetros do subsistema. Todos com default sensato pra
  // que o startup nunca quebre por falta de env. Modelos default Sonnet (§5.4).
  // Master switch: default OFF — nada roda até o gate de eval + OK humano.
  // Parse ESTRITO (NÃO z.coerce.boolean — que coage qualquer string não-vazia,
  // inclusive 'false', para true; com LUA_ENABLED=false no Coolify isso LIGARIA
  // a Lua acidentalmente — gasto + memória não-testada contaminando agentes).
  // Aceita só 'true'/'false' (default 'false'); qualquer outro valor reprova o
  // startup explicitamente (melhor falhar do que ligar por engano).
  LUA_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Convivência da inversão WhatsApp: quando true, ingestão de instância sem número
  // cadastrado cai no parse legado <agent>-<project> + contact_routes. Vira false no
  // cutover (Task 20) → instância desconhecida vai pra quarentena.
  // Parse ESTRITO (NÃO z.coerce.boolean — que coage 'false' p/ true; com
  // INGEST_LEGACY_PARSE_ENABLED=false no Coolify o corte falharia silenciosamente).
  INGEST_LEGACY_PARSE_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

  // ── Grupos de WhatsApp internos ↔ workspaces — avatares dos participantes ──
  // Teto de buscas por run do sweep (1 busca por telefone distinto). Sem teto,
  // um sweep saturaria o rate limit da Evolution.
  GROUP_AVATAR_BUDGET_PER_RUN: z.coerce.number().int().positive().default(30),

  // Janela noturna (hora local America/Sao_Paulo) [start, end).
  LUA_WINDOW_START: z.coerce.number().int().min(0).max(23).default(2),
  LUA_WINDOW_END: z.coerce.number().int().min(1).max(24).default(5),
  LUA_CONCURRENCY: z.coerce.number().int().positive().default(2),
  LUA_MAX_ATTEMPTS: z.coerce.number().int().positive().default(4),
  LUA_EXTRACTION_MODEL: z.string().default('claude-sonnet-4-6'),
  LUA_JUDGE_MODEL: z.string().default('claude-sonnet-4-6'),
  LUA_RECAP_MODEL: z.string().default('claude-sonnet-4-6'),
  LUA_EXTRACTION_MAX_INPUT: z.coerce.number().int().positive().default(60_000),
  R2_ENDPOINT: z.string().url().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_EPISODES: z.string().optional(),
  // ── Transcrição de áudio do WhatsApp (serviço pontual) ──
  TRANSCRIBE_MODE: z.enum(['off', 'manual', 'auto']).default('off'),
  TRANSCRIBE_MODEL: z.string().default('gpt-4o-mini-transcribe'),
  TRANSCRIBE_POLLER_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  TRANSCRIBE_POLLER_BATCH_SIZE: z.coerce.number().int().positive().default(20),
  TRANSCRIBE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(4),
  // Falha SISTÊMICA do provedor (429 sem crédito, 5xx, rede): pausa da fila
  // inteira (breaker) e teto de idade do retry que não consome tentativa.
  // Ver src/transcription/error-class.ts para o porquê.
  TRANSCRIBE_SYSTEMIC_COOLDOWN_MS: z.coerce.number().int().positive().default(600_000), // 10min
  TRANSCRIBE_SYSTEMIC_MAX_AGE_H: z.coerce.number().int().positive().default(72),
  TRANSCRIBE_MAX_DURATION_S: z.coerce.number().int().positive().default(600),
  // ── Digest de reunião por IA (resumo do card + pontos discutidos) ──
  // Só duas envs de propósito: com ~20 reuniões/mês, intervalo/batch/tentativas
  // nunca seriam ajustados e cada knob a mais é drift. Eles são constantes em
  // src/meetings-summary/{poller,db}.ts.
  MEETING_SUMMARY_MODE: z.enum(['off', 'auto']).default('off'),
  MEETING_SUMMARY_MODEL: z.string().default('gpt-5.4-mini'),
  R2_BUCKET_WHATSAPP_MEDIA: z.string().optional(),
  INTERNAL_WORKSPACE_ID: z.string().optional(),
  INTERNAL_DOMAINS: z.string().default('beeads.com.br').transform((s) => s.split(',').map((d) => d.trim()).filter(Boolean)),
  FREEMAIL_DOMAINS_EXTRA: z.string().optional().transform((s) => (s ? s.split(',').map((d) => d.trim()).filter(Boolean) : [])),

  // ── Coleta de reuniões (Vexa) ──
  VEXA_API_URL: z.string().url().optional(),
  VEXA_API_KEY: z.string().optional(),
  MEETINGS_INACTIVITY_STOP_MIN: z.coerce.number().int().positive().default(10),
  MEETINGS_ADMISSION_TIMEOUT_MIN: z.coerce.number().int().positive().default(10),
  MEETINGS_COLLECT_POLLER_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  MEETINGS_COLLECT_POLLER_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  // Fila de slots (preparo multibot): quantas coletas simultâneas o pool Vexa comporta
  // e por quanto tempo um pedido pode esperar na fila antes de expirar (no_slot).
  VEXA_MAX_CONCURRENT: z.coerce.number().int().min(1).default(1),
  MEETINGS_QUEUE_MAX_WAIT_MIN: z.coerce.number().int().positive().default(120),
  // ── Leitura de reuniões (contrato meetings_read_v1) ──
  // Master switch: default OFF. Parse ESTRITO (NÃO z.coerce.boolean — ver LUA_ENABLED acima).
  MEETINGS_READ_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),

  // ── Cron diário do import Fireflies (coleta contínua de transcrições) ──
  // Master switch: default OFF. Parse ESTRITO (NÃO z.coerce.boolean — ver LUA_ENABLED acima).
  FIREFLIES_IMPORT_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Hora LOCAL America/Sao_Paulo em que o import roda (0-23). Default ~04:00.
  FIREFLIES_IMPORT_HOUR: z.coerce.number().int().min(0).max(23).default(4),

  // ── CRM WhatsApp v3 (Fase B) — kill-switch dos pollers de criação de
  // oportunidade + auto-perda. Master switch: default ON (diferente de
  // LUA/FIREFLIES/MEETINGS_READ, que nascem OFF) — 'false' desliga ambos os
  // pollers no boot como resposta de emergência, sem redeploy de código. Parse
  // ESTRITO (NÃO z.coerce.boolean — ver LUA_ENABLED acima).
  CRM_PIPELINE_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

  // ── CRM WhatsApp v3 (Fase D) — motor de julgamento IA nível 1. Modelo LLM barato
  // (molde do TRANSCRIBE_MODEL): default gpt-4o-mini. A chave é OPENAI_API_KEY (mesma
  // da transcrição/Lua); o runner do julgamento só sobe se ela estiver presente. Os
  // demais parâmetros do runner (CRM_AI_TICK_MS, CRM_AI_MAX_CONVERSATIONS_PER_RUN) são
  // lidos direto de process.env pelo runner (módulo config-free, pureza dos testes).
  CRM_AI_MODEL: z.string().default('gpt-4o-mini'),

  // ── CRM WhatsApp v3 (Fase E) — motor de padrões IA nível 2 (semanal). Modelo LLM da
  // análise de padrões; ausente → cai no CRM_AI_MODEL (mesma família barata). A call é
  // única e maior que a do nível 1, mas 1x/workspace/semana — pode-se subir pra um modelo
  // mais capaz sem impacto de custo relevante. Resolvido na borda (index.ts / CLI).
  CRM_AI_PATTERN_MODEL: z.string().optional(),
});

export const config = EnvSchema.parse(process.env);

export type AgentConfig = z.infer<typeof AgentTokensSchema>[string];

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

/**
 * Fail-fast de pré-requisitos do digest de reunião. Esta é a ÚNICA política:
 * `index.ts` NÃO re-checa a chave antes de subir o poller, senão o mesmo estado
 * (modo auto sem chave) teria dois comportamentos possíveis — derrubar o boot ou
 * seguir em silêncio — dependendo de qual verificação rodasse primeiro.
 */
export function assertMeetingSummaryConfig(
  cfg: Pick<typeof config, 'MEETING_SUMMARY_MODE' | 'OPENAI_API_KEY'>,
): void {
  if (cfg.MEETING_SUMMARY_MODE === 'off') return;
  if (!cfg.OPENAI_API_KEY) {
    throw new Error(`MEETING_SUMMARY_MODE=${cfg.MEETING_SUMMARY_MODE} exige OPENAI_API_KEY`);
  }
}

/**
 * Fail-fast de pré-requisitos da coleta de reuniões (Vexa). Quando habilitada
 * (VEXA_API_URL + VEXA_API_KEY presentes), ambas são obrigatórias — senão as rotas
 * e o poller registrariam com um VexaClient quebrado. Chamado no startup (index.ts).
 */
export function assertMeetingsCollectConfig(
  cfg: Pick<typeof config, 'VEXA_API_URL' | 'VEXA_API_KEY'>, enabled: boolean,
): void {
  if (!enabled) return;
  if (!cfg.VEXA_API_URL || !cfg.VEXA_API_KEY) {
    throw new Error('meetings-collect ligado exige VEXA_API_URL + VEXA_API_KEY');
  }
}

/**
 * Fail-fast de pré-requisitos da leitura de reuniões (contrato meetings_read_v1).
 * Leitura só depende do pool (sempre presente); o assert existe pra manter o padrão
 * fail-fast/simetria com assertMeetingsCollectConfig. Chamado no startup (index.ts).
 */
export function assertMeetingsReadConfig(
  cfg: Pick<typeof config, 'MEETINGS_READ_ENABLED'>, enabled: boolean,
): void {
  if (enabled && cfg.MEETINGS_READ_ENABLED !== true) {
    throw new Error('meetings-read wiring inconsistente');
  }
}

/**
 * Resolve qual agente um token X-Agent-Token pertence.
 * Retorna o nome do agente + sua config, ou null se token desconhecido.
 */
export function resolveAgentFromToken(token: string): { name: string; cfg: AgentConfig } | null {
  for (const [name, cfg] of Object.entries(config.AGENT_TOKENS_JSON)) {
    if (cfg.worker_token === token) return { name, cfg };
  }
  return null;
}

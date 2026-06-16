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

  // Google OAuth (Entrega 2). Sem default — se ausente, endpoints /admin/.../google/* falham
  // explicitamente em runtime.
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(10),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(10),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url(),
  // 32 bytes em base64 — openssl rand -base64 32
  GOOGLE_TOKEN_ENCRYPTION_KEY: z.string().min(40),
  GOOGLE_OAUTH_STATE_SECRET: z.string().min(40),

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
  INTERNAL_WORKSPACE_ID: z.string().optional(),
  INTERNAL_DOMAINS: z.string().default('beeads.com.br').transform((s) => s.split(',').map((d) => d.trim()).filter(Boolean)),
  FREEMAIL_DOMAINS_EXTRA: z.string().optional().transform((s) => (s ? s.split(',').map((d) => d.trim()).filter(Boolean) : [])),
});

export const config = EnvSchema.parse(process.env);

export type AgentConfig = z.infer<typeof AgentTokensSchema>[string];

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

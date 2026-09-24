import { z } from 'zod';
import { DOWNLOADABLE_KINDS, MIN_RETENTION_DAYS, type DownloadableKind } from './whatsapp/media-policy.js';

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

// Instância vigiada pelo aviso de queda. O nome é interpolado em paths da
// Evolution sem encode — mesma allowlist do CLI de reconexão.
const SystemWatchSchema = z.array(
  z.object({
    instance: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    expected_phone: z.string().regex(/^\+\d{10,15}$/),
    label: z.string().min(1).optional(),
    // Perfil de tráfego do alvo. Padrão 'business_hours': só fala em horário
    // comercial (grupos de equipe), então o atraso do store só conta em expediente.
    // 'always' mede pelo relógio de parede — para alvo que recebe a qualquer hora.
    traffic: z.enum(['business_hours', 'always']).optional(),
  })
);

export type SystemWatchTarget = {
  instance: string;
  expectedPhone: string;
  label: string | null;
  traffic: 'business_hours' | 'always';
};

/** Parse do SYSTEM_INSTANCE_WATCH_JSON. Exportado para o teste travar a compatibilidade do formato. */
export function parseSystemWatch(json: string | undefined): SystemWatchTarget[] {
  if (!json) return [];
  return SystemWatchSchema.parse(JSON.parse(json)).map((w) => ({
    instance: w.instance,
    expectedPhone: w.expected_phone,
    label: w.label ?? null,
    traffic: w.traffic ?? 'business_hours',
  }));
}

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

  // ── Aviso de queda ao PRÓPRIO número que caiu (via Cloud API) ──
  // Sai por um número Cloud API — sem sessão Baileys para cair — e leva um link
  // de reconexão travado no telefone. Números de workspace só com 'on'; a vigia
  // de instância de sistema é ligada por SYSTEM_INSTANCE_WATCH_JSON.
  CONNECTION_NOTIFY_NUMBERS: z.enum(['off', 'on']).default('off'),
  // Agente cujo phone_number_id Cloud (WHATSAPP_CLOUD_NUMBERS_JSON) envia o aviso.
  CONNECTION_NOTIFY_CLOUD_AGENT: z.string().min(1).default('saturno'),
  // Template aprovado pela Meta — fora da janela de 24h só template chega. Vazio → só texto livre.
  CONNECTION_NOTIFY_TEMPLATE_NAME: z.string().optional(),
  CONNECTION_NOTIFY_TEMPLATE_LANG: z.string().default('pt_BR'),
  CONNECTION_NOTIFY_RENOTIFY_MS: z.coerce.number().int().positive().default(12 * 3_600_000),
  CONNECTION_NOTIFY_MAX: z.coerce.number().int().positive().default(6),
  // Base pública do painel — monta a URL do link de reconexão.
  PANEL_PUBLIC_URL: z.string().url().default('https://painel.beeads.com.br'),

  // ── Aviso de OPERAÇÃO do painel (POST /ops-notify) ──
  // O beeads-central-de-dados manda {titulo, detalhe} e este worker envia pelo
  // número Cloud — o MESMO remetente do aviso de queda (CONNECTION_NOTIFY_CLOUD_AGENT).
  // Segredo DEDICADO: não reusa PANEL_TOKEN (que vive no app web) nem X-Agent-Token
  // (que exigiria mexer em AGENT_TOKENS_JSON, cujo parse malformado derruba o boot).
  // Ausentes → a rota existe e responde 503 declarado, sem derrubar nada.
  OPS_NOTIFY_TOKEN: z.string().optional(),
  // Destino do aviso: E.164 sem '+' (ex.: 553196039118).
  OPS_NOTIFY_TO: z.string().optional(),

  // ── Vigia de instância de SISTEMA (ex.: saturno, fora de whatsapp_numbers por contrato) ──
  // JSON: [{"instance":"saturno","expected_phone":"+553195950748","label":"Monitor de grupos"}]
  // Opcional por alvo: "traffic":"always" (padrão "business_hours" — ver SystemWatchSchema).
  SYSTEM_INSTANCE_WATCH_JSON: z
    .string()
    .optional()
    .transform((s, ctx) => {
      try {
        return parseSystemWatch(s);
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: `SYSTEM_INSTANCE_WATCH_JSON inválido: ${(e as Error).message}` });
        return z.NEVER;
      }
    }),
  SYSTEM_INSTANCE_WATCH_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  // Store da instância atrás do de um par por mais que isto = sessão morta por dentro.
  // Para alvo 'business_hours' (o padrão) o atraso é contado em tempo de EXPEDIENTE
  // (seg–sex, 09h–18h de São Paulo, fora feriado nacional); para 'always', em relógio de parede.
  SYSTEM_INSTANCE_STORE_STALE_MS: z.coerce.number().int().positive().default(6 * 3_600_000),
  // Datas extras SEM expediente (yyyy-MM-dd de São Paulo, separadas por vírgula): feriado
  // municipal/estadual, ponto facultativo, véspera, recesso. Ex.: 2026-12-08,2026-12-24,2026-12-31
  // ⚠️ String crua DE PROPÓSITO: quem interpreta é `parseOffDates`, que ignora entrada inválida
  // com warn. Validar aqui faria um erro de digitação derrubar o boot do worker inteiro.
  BUSINESS_HOURS_EXTRA_OFF_DATES: z.string().optional(),

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
  // ── Mídia do WhatsApp além de áudio (imagem, vídeo, documento, figurinha) ──
  // Nasce 'off': com 'off' o ingest é byte-idêntico ao de antes (foto sem legenda
  // não vira mensagem; foto com legenda vira texto puro). 'on' grava a mensagem com
  // marcador e baixa o arquivo pro R2. Números e porquês em src/whatsapp/media-policy.ts.
  WHATSAPP_MEDIA_MODE: z.enum(['off', 'on']).default('off'),
  // Tipos BAIXADOS. Figurinha nunca é baixada (vira só marcador); áudio tem trilho próprio.
  WHATSAPP_MEDIA_KINDS: z.string().default('image,video,document')
    .transform((s) => s.split(',').map((k) => k.trim()).filter(Boolean))
    .refine((ks) => ks.every((k) => (DOWNLOADABLE_KINDS as readonly string[]).includes(k)), {
      message: 'WHATSAPP_MEDIA_KINDS aceita só image, video e document',
    })
    .transform((ks) => ks as DownloadableKind[]),
  // Teto por arquivo (bytes). Acima dele a mensagem existe e o arquivo não é guardado.
  WHATSAPP_MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(16 * 1024 * 1024),
  WHATSAPP_MEDIA_POLLER_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  WHATSAPP_MEDIA_POLLER_BATCH_SIZE: z.coerce.number().int().positive().default(5),
  WHATSAPP_MEDIA_MAX_ATTEMPTS: z.coerce.number().int().positive().default(4),
  // Expiração por idade dos arquivos de WhatsApp (mídia E áudio). 0 = DESLIGADA.
  // Decisão do owner (2026-09-16): liga em 180 só com aprovação dele, quando o uso
  // passar de 70% de WHATSAPP_MEDIA_BUDGET_GB. De 1 a 29 é recusado no boot — um
  // typo no lugar de 180 apagaria quase tudo numa varredura.
  WHATSAPP_MEDIA_RETENTION_DAYS: z.coerce.number().int().min(0).default(0)
    .refine((d) => d === 0 || d >= MIN_RETENTION_DAYS, {
      message: `WHATSAPP_MEDIA_RETENTION_DAYS deve ser 0 (desligada) ou >= ${MIN_RETENTION_DAYS}`,
    }),
  WHATSAPP_MEDIA_RETENTION_BUDGET_PER_RUN: z.coerce.number().int().positive().default(500),
  // Orçamento de armazenamento da mídia do WhatsApp — base do % do CLI whatsapp-media-usage.
  WHATSAPP_MEDIA_BUDGET_GB: z.coerce.number().positive().default(20),
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
 * Fail-fast da mídia do WhatsApp. Download ligado sem R2 queimaria as tentativas de
 * todo job e marcaria `failed` permanente por erro de env; expiração ligada sem R2
 * não teria como apagar os objetos.
 */
export function assertWhatsappMediaConfig(
  cfg: Pick<typeof config, 'WHATSAPP_MEDIA_MODE' | 'WHATSAPP_MEDIA_RETENTION_DAYS'>,
  r2ok: boolean,
): void {
  if (r2ok) return;
  if (cfg.WHATSAPP_MEDIA_MODE === 'on') throw new Error('WHATSAPP_MEDIA_MODE=on exige R2 configurado (R2_* ausentes)');
  if (cfg.WHATSAPP_MEDIA_RETENTION_DAYS > 0) throw new Error('WHATSAPP_MEDIA_RETENTION_DAYS>0 exige R2 configurado (R2_* ausentes)');
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

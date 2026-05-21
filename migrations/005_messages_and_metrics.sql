-- Fase 1 (plano de ação v1) — fundação de dados.
--
-- Duas tabelas novas:
--
-- 1. `messages` — linha do tempo conversacional (inbound + outbound).
--    Cada webhook de mensagem do lead vira 1 row inbound; cada reply que a
--    Mel manda via Evolution vira 1 row outbound. webhook_logs continua
--    existindo como audit técnico do webhook bruto (payload+dedup).
--
-- 2. `llm_metrics` — telemetria por chamada LLM (custo, latência, cache hit,
--    fallback). Independente de messages — classifier calls não geram message
--    mas geram métrica; responder calls geram ambos.
--
-- Sem foreign key formal entre messages e llm_metrics nem cross-table por
-- (agent, channel, identifier) — a tupla é "thread ID lógica" referenciada
-- por índices, não por FK. Decisão pragmática: evita migrations dolorosas
-- se a estrutura de identificação mudar (ex: WhatsApp Cloud API direto no
-- futuro).

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  agent TEXT NOT NULL,
  channel TEXT NOT NULL,                  -- whatsapp|email|...
  identifier TEXT NOT NULL,               -- número do lead, email, etc.
  direction TEXT NOT NULL,                -- 'inbound' | 'outbound'
  text TEXT NOT NULL,

  -- vínculo com Evolution (transporte)
  evolution_event_id TEXT,                -- inbound — id do webhook
  evolution_send_id TEXT,                 -- outbound — id devolvido pelo sendText

  -- metadata de outbound (NULL pra inbound)
  tier TEXT,                              -- low|medium|high
  model TEXT,
  provider TEXT,                          -- anthropic|google|openai
  classifier_intent TEXT,                 -- intent que disparou esta resposta
  cost_usd NUMERIC(10, 6),
  latency_ms INT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT messages_direction_chk CHECK (direction IN ('inbound', 'outbound'))
);

-- Thread query — mais comum: pega últimas N mensagens de um lead
CREATE INDEX IF NOT EXISTS idx_messages_thread
  ON messages (agent, channel, identifier, created_at DESC);

-- Dedup pra inbound: se Evolution re-emite mesmo evento, não duplica row em
-- messages. Índice parcial só sobre inbound com evolution_event_id presente.
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_inbound_event
  ON messages (agent, evolution_event_id)
  WHERE direction = 'inbound' AND evolution_event_id IS NOT NULL;

-- Custo por tier — comum em dashboards
CREATE INDEX IF NOT EXISTS idx_messages_tier_created
  ON messages (agent, tier, created_at DESC)
  WHERE direction = 'outbound' AND tier IS NOT NULL;


CREATE TABLE IF NOT EXISTS llm_metrics (
  id BIGSERIAL PRIMARY KEY,
  agent TEXT NOT NULL,

  -- vínculo opcional com messages.id (responder calls têm; classifier calls não)
  message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,

  task TEXT NOT NULL,                     -- classify | respond_low | respond_medium | respond_high
  provider TEXT NOT NULL,                 -- anthropic | google | openai
  model TEXT NOT NULL,
  tier TEXT,                              -- só preenchido pros responder_*

  -- tokens
  tokens_in INT,
  tokens_out INT,
  cache_read_tokens INT,
  cache_write_tokens INT,

  -- custo/latência
  cost_usd NUMERIC(10, 6),
  latency_ms INT,

  -- flags
  cache_hit BOOL DEFAULT FALSE,
  fallback_used BOOL DEFAULT FALSE,
  error TEXT,                             -- preenchido se a call falhou

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_llm_metrics_agent_created
  ON llm_metrics (agent, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_llm_metrics_task
  ON llm_metrics (agent, task, created_at DESC);

-- Índice pra agregações por modelo/provedor em dashboards
CREATE INDEX IF NOT EXISTS idx_llm_metrics_model
  ON llm_metrics (agent, provider, model, created_at DESC);

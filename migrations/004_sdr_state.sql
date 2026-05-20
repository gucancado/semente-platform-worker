-- Estado da conversa por lead (BANT, fatos coletados, temperatura, follow-ups).
-- lead_key = (agent, channel, identifier) — único por lead. State em JSONB pra
-- evolução de schema sem migration por campo novo.

CREATE TABLE IF NOT EXISTS lead_states (
  id BIGSERIAL PRIMARY KEY,
  agent TEXT NOT NULL,
  channel TEXT NOT NULL,
  identifier TEXT NOT NULL,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent, channel, identifier)
);

CREATE INDEX IF NOT EXISTS idx_lead_states_updated
  ON lead_states (agent, updated_at DESC);

-- Handoffs: pedidos da Mel pra humano resolver.
CREATE TABLE IF NOT EXISTS handoffs (
  id BIGSERIAL PRIMARY KEY,
  agent TEXT NOT NULL,
  channel TEXT NOT NULL,
  identifier TEXT NOT NULL,
  motivo TEXT NOT NULL,
  urgencia TEXT NOT NULL DEFAULT 'media',
  contexto_resumido TEXT,
  status TEXT NOT NULL DEFAULT 'open',  -- open|claimed|resolved|dismissed
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_handoffs_open
  ON handoffs (agent, created_at DESC)
  WHERE status = 'open';

-- Reuniões simuladas (sem Google Calendar ainda — apenas registro).
CREATE TABLE IF NOT EXISTS simulated_meetings (
  id BIGSERIAL PRIMARY KEY,
  agent TEXT NOT NULL,
  channel TEXT NOT NULL,
  identifier TEXT NOT NULL,
  slot_iso TIMESTAMPTZ NOT NULL,
  slot_human TEXT NOT NULL,
  lead_email TEXT,
  lead_name TEXT,
  company TEXT,
  contexto TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled|rescheduled|cancelled|completed|no_show
  rescheduled_to BIGINT REFERENCES simulated_meetings(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_simulated_meetings_lead
  ON simulated_meetings (agent, channel, identifier, status);

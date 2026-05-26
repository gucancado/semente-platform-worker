-- Schema do goal 'scheduling' (Google Calendar) — Entrega 1A do design
-- 2026-05-25-google-calendar-scheduling-design.md
--
-- 6 tabelas:
--   - projects: catálogo de projetos do agent (substitui parcialmente a
--     "verdade" implícita em PROJECT.md, especificamente pra config ops).
--   - project_goals: features habilitadas por projeto (MVP só 'scheduling').
--   - google_oauth_connections: tokens OAuth refresh, 1 por projeto.
--   - scheduling_agendas: calendars de profissionais (closer, médico, etc).
--   - meetings: reuniões agendadas (substituirá simulated_meetings em
--     entrega futura via flag GOAL_SCHEDULING_BACKEND).
--   - slot_holds: holds tentativos enquanto lead escolhe.
--
-- Tabelas legadas (simulated_meetings, lead_states) NÃO são alteradas aqui.

CREATE TABLE projects (
  id BIGSERIAL PRIMARY KEY,
  agent TEXT NOT NULL,
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent, slug)
);

CREATE TABLE project_goals (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  goal_type TEXT NOT NULL,             -- 'scheduling' por enquanto
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  config JSONB NOT NULL DEFAULT '{}',  -- ex: { "selection_strategy": "single" }
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, goal_type)
);

CREATE TABLE google_oauth_connections (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  google_email TEXT NOT NULL,
  refresh_token_encrypted BYTEA NOT NULL,
  scopes TEXT[] NOT NULL,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_refresh_at TIMESTAMPTZ,
  last_error TEXT
);

CREATE TABLE scheduling_agendas (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  person_name TEXT NOT NULL,           -- interno; não vaza pro chat
  person_email TEXT NOT NULL,          -- calendar_id no Google
  display_label TEXT NOT NULL,         -- o que o agente DIZ ("o time comercial")
  description TEXT,                    -- pra by_specialty e instruções específicas
  working_hours JSONB NOT NULL,        -- { mon:["09:00-12:00",...], ..., timezone:"America/Sao_Paulo" }
  meeting_duration_min INT NOT NULL DEFAULT 30,
  min_advance_hours INT NOT NULL DEFAULT 4,
  max_advance_business_days INT NOT NULL DEFAULT 10,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  round_robin_last_assigned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_scheduling_agendas_project_active ON scheduling_agendas (project_id) WHERE active = TRUE;

CREATE TABLE meetings (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id),
  agenda_id BIGINT NOT NULL REFERENCES scheduling_agendas(id),
  channel TEXT NOT NULL,
  identifier TEXT NOT NULL,
  slot_iso TIMESTAMPTZ NOT NULL,
  slot_human TEXT NOT NULL,
  lead_email TEXT,
  lead_name TEXT,
  company TEXT,
  contexto TEXT,
  google_event_id TEXT,
  google_meet_link TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
    -- 'scheduled' | 'rescheduled' | 'cancelled' | 'completed' | 'no_show' | 'cancelled_by_organizer'
  cancelled_by TEXT,
    -- 'lead' | 'agent' | 'organizer' | 'reset'
  rescheduled_to BIGINT REFERENCES meetings(id),
  last_reconciled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_meetings_lead ON meetings (project_id, channel, identifier, status);
CREATE INDEX idx_meetings_reconcile ON meetings (status, slot_iso) WHERE status = 'scheduled';

CREATE TABLE slot_holds (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id),
  agenda_id BIGINT NOT NULL REFERENCES scheduling_agendas(id),
  channel TEXT NOT NULL,
  identifier TEXT NOT NULL,
  slot_iso TIMESTAMPTZ NOT NULL,
  google_event_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_slot_holds_cleanup ON slot_holds (expires_at) WHERE consumed = FALSE;
CREATE INDEX idx_slot_holds_lead ON slot_holds (project_id, channel, identifier, consumed);

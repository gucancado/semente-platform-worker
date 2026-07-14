-- 044: coleta manual de reunioes (Vexa). Uma reuniao "em coleta" por vez (Vexa Lite = 1 simultanea).
CREATE TABLE IF NOT EXISTS collected_meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meet_code TEXT NOT NULL,
  vexa_meeting_id INT,
  workspace_id TEXT,                    -- uuid do Bloquim guardado como TEXT (padrao episodes.workspace_id)
  status TEXT NOT NULL DEFAULT 'collecting',
  failure_reason TEXT,
  requested_by TEXT NOT NULL,           -- userId do Bloquim
  last_segment_at TIMESTAMPTZ,
  episode_id BIGINT REFERENCES episodes(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT collected_meetings_status_chk
    CHECK (status IN ('collecting','stopping','imported','failed','canceled'))
);

-- Indice parcial: o poller varre so as ativas; tambem serve pro check de concorrencia global.
CREATE INDEX IF NOT EXISTS idx_collected_meetings_active
  ON collected_meetings (created_at) WHERE status IN ('collecting','stopping');

-- migrations/040_whatsapp_source_signals.sql
-- Config per-workspace de "mensagem-canônica → lead_source" (S4). Puramente aditivo:
-- 2 tabelas novas + template seedado. PK existe desde o CREATE → sem bug-trap de árbitro.

CREATE TABLE IF NOT EXISTS whatsapp_source_signal_defaults (
  pattern    TEXT PRIMARY KEY,   -- já normalizado (lowercase, sem acento, trim)
  source     TEXT NOT NULL,      -- 'site'|'indicacao'|'ads'|'organico'
  sort_order INT  NOT NULL DEFAULT 0
);

INSERT INTO whatsapp_source_signal_defaults (pattern, source, sort_order) VALUES
  ('vim pelo site', 'site', 1),
  ('vim pelo site institucional', 'site', 2),
  ('vi no site', 'site', 3),
  ('vim pelo instagram', 'ads', 4),
  ('vim pelo facebook', 'ads', 5),
  ('vim pela indicacao', 'indicacao', 6)
ON CONFLICT (pattern) DO NOTHING;

CREATE TABLE IF NOT EXISTS whatsapp_source_signals (
  workspace_id TEXT    NOT NULL,
  pattern      TEXT    NOT NULL,   -- normalizado
  source       TEXT    NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order   INT     NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, pattern)
);

-- migrations/058_whatsapp_group_participants.sql
-- Roster de participantes por grupo. Alimenta o painel read-only (avatar + nome)
-- e a resolução de identidade Bloquim. Participante que SAI do grupo não é
-- deletado: fica com last_seen_at velho (a UI mostra só quem foi visto no
-- último sync do grupo).

CREATE TABLE IF NOT EXISTS whatsapp_group_participants (
  id                 BIGSERIAL PRIMARY KEY,
  group_id           BIGINT NOT NULL REFERENCES whatsapp_groups(id) ON DELETE CASCADE,
  phone              TEXT NOT NULL,               -- E.164 ('+5531999998888') OU LID (ver is_lid)
  -- true = o WhatsApp entregou um LID de privacidade e a Evolution não mandou o
  -- número real no campo *Alt. NÃO é telefone: não casa com messages.author e
  -- não pode ir pro resolvedor de identidade do Bloquim.
  is_lid             BOOLEAN NOT NULL DEFAULT FALSE,
  push_name          TEXT,
  is_admin           BOOLEAN NOT NULL DEFAULT FALSE,
  avatar_key         TEXT,                        -- key no R2 (Task 4)
  avatar_fetched_at  TIMESTAMPTZ,
  avatar_attempts    INT NOT NULL DEFAULT 0,
  bloquim_user_id    TEXT,                        -- Task 5
  bloquim_name       TEXT,
  resolved_at        TIMESTAMPTZ,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_wa_group_participants_group
  ON whatsapp_group_participants (group_id);

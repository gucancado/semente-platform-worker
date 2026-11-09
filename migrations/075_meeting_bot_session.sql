-- 075: estado da sessão Google do bot de reuniões (configuracoes@beeads.com.br).
--
-- Por quê: a sessão cai (re-verificação do Google) e, caída, o bot entra como
-- convidado e depende de alguém clicar em Admitir. O estado só existia em arquivo
-- no host (/data/vexa-auth: sentinela + check-session.log), invisível pro painel.
-- Quem ESCREVE são os scripts do host (check-session.sh às 08:00 BRT e o vigia do
-- login-link.sh ao re-armar), por `docker exec psql`; o worker só lê e expõe pro
-- Painel tático (GET /meetings-bot/session).

CREATE TABLE IF NOT EXISTS meeting_bot_session (
  id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  account     TEXT NOT NULL DEFAULT 'configuracoes@beeads.com.br',
  state       TEXT NOT NULL DEFAULT 'unknown' CHECK (state IN ('unknown', 'connected', 'disconnected')),
  -- Desde quando está no estado atual (só muda na transição).
  since       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Última verificação, qualquer resultado. Velha demais = estado não confirmado.
  checked_at  TIMESTAMPTZ,
  detail      TEXT
);
INSERT INTO meeting_bot_session (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

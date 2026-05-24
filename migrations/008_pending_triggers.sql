-- Mitigação anti-detecção #2 + #3 (burst smoothing + quiet hours fail-safe).
--
-- Substitui o trigger HTTP fire-and-forget que rodava inline no webhook handler
-- por uma fila DB-backed processada por poller. Dois ganhos:
--
-- 1. **Burst smoothing**: se o lead manda várias msgs em sequência (<30s entre
--    elas), todas atualizam a MESMA row pending (via UPSERT no índice parcial
--    abaixo) e empurram scheduled_at pra frente. Mercurio só recebe 1 trigger
--    quando o lead "parar de digitar".
--
-- 2. **Quiet hours** (próxima migration): scheduled_at pode ser empurrada pro
--    fim do quiet pra evitar resposta de madrugada.
--
-- Robustez: status 'pending' até o poller disparar o trigger HTTP com sucesso.
-- Se worker reiniciar no meio, o próximo boot do poller pega tudo que estava
-- pending e dispara (zero perda).

CREATE TABLE IF NOT EXISTS pending_triggers (
  id BIGSERIAL PRIMARY KEY,
  agent TEXT NOT NULL,
  project TEXT,
  identifier TEXT NOT NULL,

  -- inbox_id da mensagem MAIS RECENTE que entrou nessa janela de debounce.
  -- Mercurio lê /inbox-unread então processa todas as não-lidas, esse campo é
  -- só pra log/debug — não pra dizer pro mercurio "responda só essa".
  last_inbox_id BIGINT NOT NULL,
  msg_count INT NOT NULL DEFAULT 1,

  -- Quando o poller deve disparar o trigger HTTP. Atualizado a cada nova msg
  -- na janela = debounce.
  scheduled_at TIMESTAMPTZ NOT NULL,

  -- Lifecycle: pending → fired (sucesso) | failed (após retries)
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  fired_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pending_triggers_status_chk CHECK (status IN ('pending', 'fired', 'failed'))
);

-- Garante 1 row 'pending' por (agent, identifier). UPSERT no webhook reusa
-- essa linha em vez de criar uma nova.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_triggers_pending_per_conv
  ON pending_triggers (agent, identifier)
  WHERE status = 'pending';

-- Poller: SELECT WHERE status='pending' AND scheduled_at <= NOW().
CREATE INDEX IF NOT EXISTS idx_pending_triggers_due
  ON pending_triggers (scheduled_at)
  WHERE status = 'pending';

-- Histórico/audit: queries em "últimos triggers do agente X"
CREATE INDEX IF NOT EXISTS idx_pending_triggers_history
  ON pending_triggers (agent, created_at DESC);

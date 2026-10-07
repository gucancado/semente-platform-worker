-- migrations/070_ops_notify_queue.sql
-- Fila dos avisos ao OPERADOR. Antes cada aviso (painel via POST /ops-notify,
-- cópia do aviso de queda, aviso da sonda) virava UMA mensagem na hora — ~5/dia
-- espalhadas pela madrugada, cada uma cobrada como template UTILITY. Agora tudo
-- entra aqui e sai em LOTE (ops-notify/flusher.ts): urgente em até alguns
-- minutos, o resto num resumo em horário fixo.

CREATE TABLE IF NOT EXISTS ops_notify_queue (
  id          BIGSERIAL PRIMARY KEY,
  titulo      TEXT NOT NULL,
  detalhe     TEXT NULL,
  urgency     TEXT NOT NULL CHECK (urgency IN ('urgent','digest')),
  -- Quem enfileirou (painel, down-notify, sonda) — só diagnóstico.
  source      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Lease do lote em envio. Falha NÃO zera: o lease vira o backoff (o lote só
  -- é re-tentado quando expira), senão uma recusa da Meta re-tentaria a cada tick.
  claimed_at  TIMESTAMPTZ NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  sent_at     TIMESTAMPTZ NULL,
  send_id     TEXT NULL,
  last_error  JSONB NULL
);

CREATE INDEX IF NOT EXISTS idx_ops_notify_queue_pending
  ON ops_notify_queue (created_at) WHERE sent_at IS NULL;

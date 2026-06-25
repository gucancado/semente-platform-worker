-- migrations/034_messages_provenance.sql
-- Proveniência da linha em messages: 'live' (webhook) vs 'backfill' (import do histórico Evolution).
-- DEFAULT 'live' cobre: todas as linhas existentes + todo INSERT futuro que omitir a coluna (insertMessage em db.ts).
-- O backfill (backfill.ts) passa 'backfill' explicitamente no INSERT mas NÃO no DO UPDATE SET —
-- garantindo que um re-backfill de uma linha já ingerida live não rebaixa o ingest_source.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ingest_source TEXT NOT NULL DEFAULT 'live';

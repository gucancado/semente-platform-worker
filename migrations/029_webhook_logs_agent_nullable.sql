-- migrations/029_webhook_logs_agent_nullable.sql
-- Número 'monitored' não tem agente operador → webhook_logs.agent passa a aceitar NULL.
-- Dedup agora é global por evolution_event_id (uq_webhook_logs_evt, migration 026).
ALTER TABLE webhook_logs ALTER COLUMN agent DROP NOT NULL;

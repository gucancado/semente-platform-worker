-- migrations/052_thread_meta_is_lead_nullable.sql
-- CRM WhatsApp v3 — Fase A: triagem tri-state (spec §4.8).
-- is_lead passa a aceitar NULL = "não triado" (indefinido), distinto de
-- TRUE=lead e FALSE=não-lead. Antes era NOT NULL DEFAULT TRUE, o que presumia
-- lead antes de qualquer triagem — a semântica v3 é a ausência de decisão.
-- O DEFAULT TRUE fica INTOCADO de propósito (linhas/derivadas legadas continuam
-- nascendo lead); só a obrigatoriedade cai. Idempotente: DROP NOT NULL num
-- coluna já nullable é no-op; COMMENT é sempre reescrito.

-- lock_timeout curto: falha rápido no boot se a tabela estiver sob lock, em vez de
-- segurar a janela de deploy — o runner re-tenta no próximo deploy (o runner envolve
-- cada migration em BEGIN/COMMIT; SET LOCAL vale só p/ esta tx).
SET LOCAL lock_timeout = '10s';

ALTER TABLE whatsapp_thread_meta ALTER COLUMN is_lead DROP NOT NULL;

COMMENT ON COLUMN whatsapp_thread_meta.is_lead IS
  'Triagem tri-state (v3): TRUE=lead, FALSE=não-lead, NULL=não triado (indefinido).';

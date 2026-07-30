-- migrations/052_thread_meta_is_lead_nullable.sql
-- CRM WhatsApp v3 — Fase A: triagem tri-state (spec §4.8).
-- is_lead passa a aceitar NULL = "não triado" (indefinido), distinto de
-- TRUE=lead e FALSE=não-lead. Antes era NOT NULL DEFAULT TRUE, o que presumia
-- lead antes de qualquer triagem — a semântica v3 é a ausência de decisão.
-- O DEFAULT TRUE fica INTOCADO de propósito (linhas/derivadas legadas continuam
-- nascendo lead); só a obrigatoriedade cai. Idempotente: DROP NOT NULL num
-- coluna já nullable é no-op; COMMENT é sempre reescrito.
ALTER TABLE whatsapp_thread_meta ALTER COLUMN is_lead DROP NOT NULL;

COMMENT ON COLUMN whatsapp_thread_meta.is_lead IS
  'Triagem tri-state (v3): TRUE=lead, FALSE=não-lead, NULL=não triado (indefinido).';

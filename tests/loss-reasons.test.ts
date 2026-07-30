import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CASCADE_LOSS_REASON,
  SYSTEM_LOSS_REASONS,
  slugifyLossCode,
  isValidLossReason,
} from '../src/whatsapp/loss-reasons.js';

test('slugifyLossCode remove acento, lower e vira snake_case', () => {
  assert.equal(slugifyLossCode('Sem orçamento'), 'sem_orcamento');
});

test('slugifyLossCode colapsa pontuação/espaços repetidos e apara bordas', () => {
  assert.equal(slugifyLossCode('  Preço   alto!!  '), 'preco_alto');
  assert.equal(slugifyLossCode('--Não é fit--'), 'nao_e_fit');
});

test('isValidLossReason: códigos de sistema são válidos sem tocar o banco', async () => {
  const pool = { query: async () => { throw new Error('não deveria consultar o banco'); } } as any;
  for (const reason of SYSTEM_LOSS_REASONS) {
    assert.equal(await isValidLossReason(pool, 'ws-1', reason.code), true);
  }
});

test('isValidLossReason: nao_lead (cascata) é sempre inválido, mesmo com row no catálogo', async () => {
  const pool = { query: async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }) } as any;
  assert.equal(await isValidLossReason(pool, 'ws-1', CASCADE_LOSS_REASON), false);
});

test('isValidLossReason: custom ativo do workspace é válido', async () => {
  const pool = { query: async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }) } as any;
  assert.equal(await isValidLossReason(pool, 'ws-1', 'sem_orcamento'), true);
});

test('isValidLossReason: custom inativo (ou de outro workspace, ou inexistente) é inválido', async () => {
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as any;
  assert.equal(await isValidLossReason(pool, 'ws-1', 'sem_orcamento'), false);
});

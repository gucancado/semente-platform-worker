/**
 * tests/whatsapp/group-identity.test.ts — DB-free.
 * `resolveByWhatsapp` colapsa "não achou" e "erro de rede" no mesmo null
 * (src/commands/identity.ts) — o teste fixa o comportamento ESCOLHIDO diante
 * disso: null carimba resolved_at e adia 30 dias, sem apagar match anterior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGroupIdentities } from '../../src/whatsapp/group-identity.js';

function pool(rows: any[]) {
  const updates: Array<{ sql: string; params: any[] }> = [];
  const p = {
    query: async (sql: string, params: any[]) => {
      if (sql.trim().startsWith('SELECT')) return { rows: rows.slice(0, params[0]) };
      updates.push({ sql, params });
      return { rows: [] };
    },
  } as any;
  return { pool: p, updates };
}

const CAND = { id: 1, phone: '+5531999998888' };

test('match grava bloquim_user_id + nome', async () => {
  const { pool: p, updates } = pool([CAND]);
  const out = await resolveGroupIdentities(p, 10, async () => ({
    userId: 'u-1', name: 'Gustavo Azevedo', email: 'g@x.com', whatsapp: '+55 31999998888', workspaces: [],
  }));
  assert.equal(out.matched, 1);
  assert.deepEqual(updates[0].params, [1, 'u-1', 'Gustavo Azevedo']);
});

test('sem match carimba resolved_at sem apagar identidade anterior', async () => {
  const { pool: p, updates } = pool([CAND]);
  const out = await resolveGroupIdentities(p, 10, async () => null);
  assert.equal(out.unmatched, 1);
  assert.match(updates[0].sql, /resolved_at = NOW\(\)/);
  assert.doesNotMatch(updates[0].sql, /bloquim_user_id = NULL/);
  assert.deepEqual(updates[0].params, [1]);
});

test('orçamento 0 não consulta o banco', async () => {
  const p = { query: async () => { throw new Error('não deveria consultar'); } } as any;
  assert.deepEqual(await resolveGroupIdentities(p, 0, async () => null), { attempted: 0, matched: 0, unmatched: 0 });
});

// LID não é telefone: mandar ao endpoint só gastaria chamada (e um dia poderia
// casar com o número errado de alguém).
test('participantes is_lid ficam fora da fila de identidade', async () => {
  let sql = '';
  const p = { query: async (s: string) => { sql = s; return { rows: [] }; } } as any;
  await resolveGroupIdentities(p, 10, async () => null);
  assert.match(sql, /is_lid = FALSE/);
});

test('exceção do resolver não derruba o lote', async () => {
  const { pool: p } = pool([CAND, { id: 2, phone: '+5531988887777' }]);
  let n = 0;
  const out = await resolveGroupIdentities(p, 10, async () => {
    n++; if (n === 1) throw new Error('rede'); return null;
  });
  assert.equal(out.attempted, 2);
  assert.equal(out.unmatched, 1);
});

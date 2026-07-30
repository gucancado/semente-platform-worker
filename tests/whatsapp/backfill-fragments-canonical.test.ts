// tests/whatsapp/backfill-fragments-canonical.test.ts
//
// Teste PURO (sem Postgres) do roteamento de markBackfillFragments pelo caminho
// canônico da triagem: garante que cada par selecionado passa por setLeadStatus
// (is_lead=false, updatedBy='system:backfill') e que um par cuja cascata lança
// possui_ganho (LeadCascadeGanhoError) é PULADO sem abortar os demais.
//
// backfill.ts só importa tipos de 'pg' + módulos puros (thread-meta →
// conversation-lock, numbers, access-log, evolution), então não carrega o env
// do servidor. setLeadStatus é injetado via deps (só pra teste).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markBackfillFragments } from '../../src/whatsapp/backfill.js';
import { LeadCascadeGanhoError } from '../../src/whatsapp/thread-meta.js';

// Fake pool: responde o SELECT de fragmentos com `identifiers`; tag INSERT e
// logAccess caem no ramo vazio.
function fakePool(identifiers: string[]) {
  const queries: string[] = [];
  const pool = {
    query: async (text: string, _params: any[] = []) => {
      queries.push(text);
      if (/GROUP BY m\.identifier/.test(text)) {
        return { rows: identifiers.map((identifier) => ({ identifier })), rowCount: identifiers.length };
      }
      return { rows: [], rowCount: 0 };
    },
  } as any;
  return { pool, queries };
}

test('markBackfillFragments: chama setLeadStatus(is_lead=false, system:backfill) por par selecionado', async () => {
  const { pool } = fakePool(['a@lid', 'b@lid']);
  const leadCalls: { identifier: string; isLead: boolean | null; updatedBy: string }[] = [];
  const fakeSetLead = async (_pool: any, p: any) => {
    leadCalls.push({ identifier: p.identifier, isLead: p.isLead, updatedBy: p.updatedBy });
  };

  const r = await markBackfillFragments(pool, 1, 'ws-1', () => {}, { setLeadStatus: fakeSetLead as any });

  assert.equal(r.marked, 2);
  assert.deepEqual(r.skippedGanho, []);
  assert.deepEqual(leadCalls.map((c) => c.identifier), ['a@lid', 'b@lid']);
  assert.ok(leadCalls.every((c) => c.isLead === false), 'sempre is_lead=false');
  assert.ok(leadCalls.every((c) => c.updatedBy === 'system:backfill'), 'proveniência preservada');
});

test('markBackfillFragments: par com ganho (LeadCascadeGanhoError) é pulado sem abortar os demais', async () => {
  const { pool } = fakePool(['a@lid', 'ganho@lid', 'c@lid']);
  const seen: string[] = [];
  const fakeSetLead = async (_pool: any, p: any) => {
    seen.push(p.identifier);
    if (p.identifier === 'ganho@lid') throw new LeadCascadeGanhoError('ganho@lid');
  };

  const r = await markBackfillFragments(pool, 1, 'ws-1', () => {}, { setLeadStatus: fakeSetLead as any });

  assert.equal(r.marked, 2, 'a e c marcados; ganho pulado');
  assert.deepEqual(r.skippedGanho, ['ganho@lid']);
  assert.deepEqual(seen, ['a@lid', 'ganho@lid', 'c@lid'], 'continua nos pares seguintes após o skip');
});

test('markBackfillFragments: erro não-ganho propaga (não é engolido como skip)', async () => {
  const { pool } = fakePool(['a@lid']);
  const fakeSetLead = async () => { throw new Error('db down'); };

  await assert.rejects(
    () => markBackfillFragments(pool, 1, 'ws-1', () => {}, { setLeadStatus: fakeSetLead as any }),
    /db down/,
  );
});

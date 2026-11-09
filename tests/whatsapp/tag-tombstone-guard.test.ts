// Tags tombadas (deleted_at) não podem aparecer em leituras, e o filtro/contagem por
// tag respeita a árvore do vocabulário (filha implica mãe).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { getStats } from '../../src/whatsapp/stats.js';
import { listThreads } from '../../src/whatsapp/read-queries.js';
import { listOpportunities } from '../../src/whatsapp/opportunities.js';

const FILES = ['tags', 'board', 'opportunities', 'read-queries', 'stats', 'ai-judgment-context', 'ai-judgment-apply', 'ai-pattern-context'];
const WRITE = /^\s*(\/\*[^*]*\*\/\s*)?(INSERT|UPDATE|DELETE)\b/i;

test('toda query que lê whatsapp_tags nesses arquivos filtra deleted_at', () => {
  const offenders: string[] = [];
  for (const f of FILES) {
    const src = readFileSync(new URL(`../../src/whatsapp/${f}.ts`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/`[^`]*`/g)) {
      const sql = m[0];
      if (!/whatsapp_tags/.test(sql)) continue;
      if (f === 'tags' && WRITE.test(sql.slice(1))) continue;
      if (!/deleted_at/.test(sql)) offenders.push(`${f}: ${sql.slice(0, 80).replace(/\s+/g, ' ')}`);
    }
  }
  assert.deepEqual(offenders, []);
});

function capture() {
  const sqls: string[] = [];
  const pool = {
    query: async (sql: string) => { sqls.push(sql); return { rows: [], rowCount: 0 }; },
  } as unknown as Pool;
  return { pool, sqls };
}

test('stats conta a oportunidade também em cada ancestral', async () => {
  const { pool, sqls } = capture();
  await getStats(pool, { workspaceId: 'w' }).catch(() => {});
  const sql = sqls.find((s) => s.includes('whatsapp_opportunity_tags'));
  assert.ok(sql, 'query de byOpportunityTag não encontrada');
  assert.match(sql!, /ancestor_external_ids/);
  assert.match(sql!, /COUNT\(DISTINCT o\.id\)/);
  assert.match(sql!, /t\.deleted_at IS NULL/);
  assert.match(sql!, /a\.deleted_at IS NULL/);
});

test('filtro por tag mãe traz oportunidade da filha (threads)', async () => {
  const { pool, sqls } = capture();
  await listThreads(pool, { workspaceId: 'w', numberId: 1, limit: 10, oppTagId: 5 }).catch(() => {});
  const sql = sqls.find((s) => s.includes('oft.tag_id') || s.includes('oftt'));
  assert.ok(sql);
  assert.match(sql!, /ancestor_external_ids/);
  assert.match(sql!, /oftt\.id = \$17/);
});

test('filtro por tag mãe traz oportunidade da filha (lista de oportunidades)', async () => {
  const { pool, sqls } = capture();
  await listOpportunities(pool, { numberId: 1, workspaceId: 'w', tagId: 5, limit: 10 });
  assert.match(sqls[0], /ancestor_external_ids/);
  assert.match(sqls[0], /ft\.id\s*=\s*\$3/);
});

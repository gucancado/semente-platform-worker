/**
 * tests/whatsapp/source-signals.db.test.ts — SERVER-GATED (Postgres efêmero).
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import {
  normalizePattern, matchSource, listSourceSignals, upsertSourceSignal,
  deactivateSourceSignal, seedDefaultSourceSignals, type SourceSignal,
} from '../../src/whatsapp/source-signals.js';

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_source_signals RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('normalizePattern: lowercase + strip acento + collapse espaços', () => {
  assert.equal(normalizePattern('  Vim  pela INDICAÇÃO '), 'vim pela indicacao');
});

test('matchSource: 1º pattern (por sortOrder) que é substring; sem match → null', () => {
  const signals: SourceSignal[] = [
    { pattern: 'vim pelo site', source: 'site', active: true, sortOrder: 1 },
    { pattern: 'vim pelo instagram', source: 'ads', active: true, sortOrder: 4 },
  ];
  assert.deepEqual(matchSource('Olá! Vim pelo site', signals), { source: 'site', pattern: 'vim pelo site' });
  assert.equal(matchSource('quero um orçamento', signals), null);
});

test('CRUD + seed per-workspace, anti-vazamento', async () => {
  await seedDefaultSourceSignals(pool, 'ws-1');
  const seeded = await listSourceSignals(pool, { workspaceId: 'ws-1' });
  assert.ok(seeded.some(s => s.pattern === 'vim pelo site' && s.source === 'site'));
  assert.equal((await listSourceSignals(pool, { workspaceId: 'ws-2' })).length, 0, 'não vaza entre workspaces');

  await upsertSourceSignal(pool, { workspaceId: 'ws-1', pattern: 'Vim pela FEIRA', source: 'organico' });
  const afterUpsert = await listSourceSignals(pool, { workspaceId: 'ws-1' });
  assert.ok(afterUpsert.some(s => s.pattern === 'vim pela feira' && s.source === 'organico'), 'pattern normalizado no upsert');

  await deactivateSourceSignal(pool, { workspaceId: 'ws-1', pattern: 'vim pela feira' });
  assert.ok(!(await listSourceSignals(pool, { workspaceId: 'ws-1' })).some(s => s.pattern === 'vim pela feira'), 'inativo some do default');
  assert.ok((await listSourceSignals(pool, { workspaceId: 'ws-1', includeInactive: true })).some(s => s.pattern === 'vim pela feira'), 'aparece com includeInactive');
});

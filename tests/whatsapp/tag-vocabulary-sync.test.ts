import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planVocabularySync, runVocabularySync, type MirrorRow, type VocabRow } from '../../src/whatsapp/tag-vocabulary-sync.js';

const v = (o: Partial<VocabRow> & { id: string }): VocabRow => ({
  workspaceId: 'w1', parentId: null, ancestorIds: [], name: 'Tag', color: 'blue',
  description: null, deletedAt: null, mergedIntoId: null, ...o,
});
const m = (o: Partial<MirrorRow> & { id: number }): MirrorRow => ({
  workspaceId: 'w1', externalId: null, name: 'Tag', color: 'blue', description: null,
  parentExternalId: null, ancestorExternalIds: [], deletedAt: null, ...o,
});

test('vincula por workspace+lower(name) quando external_id é nulo', () => {
  const ops = planVocabularySync([m({ id: 1, name: 'Quente' })], [v({ id: 'a', name: 'quente' })]);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'link');
  assert.equal((ops[0] as any).id, 1);
  assert.equal((ops[0] as any).externalId, 'a');
});

test('não vincula entre workspaces diferentes', () => {
  const ops = planVocabularySync([m({ id: 1, workspaceId: 'w2' })], [v({ id: 'a' })]);
  assert.deepEqual(ops.map((o) => o.op), ['insert']);
});

test('insere tag sem par', () => {
  assert.deepEqual(planVocabularySync([], [v({ id: 'a' })]).map((o) => o.op), ['insert']);
});

test('atualiza nome, cor, descrição, pai e ancestrais', () => {
  const ops = planVocabularySync(
    [m({ id: 1, externalId: 'a' })],
    [v({ id: 'a', name: 'Novo', color: 'red', description: 'd', parentId: 'p', ancestorIds: ['r', 'p'] })],
  );
  assert.deepEqual(ops, [{
    op: 'update', id: 1,
    fields: { name: 'Novo', color: 'red', description: 'd', parentExternalId: 'p', ancestorExternalIds: ['r', 'p'] },
  }]);
});

test('sem diferença não gera op', () => {
  assert.deepEqual(planVocabularySync([m({ id: 1, externalId: 'a' })], [v({ id: 'a' })]), []);
});

test('snapshot sem a tag não gera tombstone', () => {
  assert.deepEqual(planVocabularySync([m({ id: 1, externalId: 'a' })], []), []);
});

test('deleted_at gera tombstone', () => {
  const ops = planVocabularySync([m({ id: 1, externalId: 'a' })], [v({ id: 'a', deletedAt: '2026-11-01T00:00:00Z' })]);
  assert.deepEqual(ops, [{ op: 'tombstone', id: 1, deletedAt: '2026-11-01T00:00:00Z' }]);
});

test('merged_into_id gera merge antes do tombstone', () => {
  const ops = planVocabularySync(
    [m({ id: 1, externalId: 'a' }), m({ id: 2, externalId: 'b', name: 'Dest' })],
    [v({ id: 'a', mergedIntoId: 'b', deletedAt: '2026-11-01T00:00:00Z' }), v({ id: 'b', name: 'Dest' })],
  );
  assert.deepEqual(ops.map((o) => o.op), ['merge', 'tombstone']);
  assert.deepEqual(ops[0], { op: 'merge', fromId: 1, toExternalId: 'b' });
});

test('tag já tombada no espelho não gera op', () => {
  const ops = planVocabularySync(
    [m({ id: 1, externalId: 'a', deletedAt: '2026-10-01T00:00:00Z' })],
    [v({ id: 'a', deletedAt: '2026-11-01T00:00:00Z' })],
  );
  assert.deepEqual(ops, []);
});

test('merge cujo destino está no mesmo snapshot sai depois do insert do destino', () => {
  const ops = planVocabularySync(
    [m({ id: 1, externalId: 'a' })],
    [v({ id: 'a', mergedIntoId: 'b', deletedAt: '2026-11-01T00:00:00Z' }), v({ id: 'b', name: 'Dest' })],
  );
  assert.deepEqual(ops.map((o) => o.op), ['insert', 'merge', 'tombstone']);
});

test('tombstone simples vem antes do insert que reusa o nome', () => {
  const ops = planVocabularySync(
    [m({ id: 1, externalId: 'a', name: 'X' })],
    [v({ id: 'a', name: 'X', deletedAt: '2026-11-01T00:00:00Z' }), v({ id: 'c', name: 'X' })],
  );
  assert.deepEqual(ops.map((o) => o.op), ['tombstone', 'insert']);
});

test('runVocabularySync: falha de fetch não toca o banco', async () => {
  let connected = false;
  const pool = { connect: async () => { connected = true; } } as any;
  const r = await runVocabularySync(pool, async () => { throw new Error('rede'); });
  assert.deepEqual(r, { ops: 0, errors: 1 });
  assert.equal(connected, false);
});

test('runVocabularySync: violação de unicidade conta erro e segue', async () => {
  const calls: string[] = [];
  const client = {
    query: async (t: string) => {
      calls.push(t.trim().split(/\s+/)[0]);
      if (/FROM whatsapp_tags$/.test(t.trim())) return { rows: [], rowCount: 0 };
      if (t.includes('INSERT INTO whatsapp_tags') && calls.filter((c) => c === 'INSERT').length === 1) {
        throw Object.assign(new Error('dup'), { code: '23505' });
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  const r = await runVocabularySync({ connect: async () => client } as any, async () => [
    v({ id: 'a', name: 'A' }), v({ id: 'b', name: 'B' }),
  ]);
  assert.deepEqual(r, { ops: 1, errors: 1 });
  assert.ok(calls.includes('ROLLBACK'));
});

test('runVocabularySync: merge que falha não tomba a origem', async () => {
  const seen: string[] = [];
  const client = {
    query: async (t: string) => {
      const q = t.trim();
      if (q.endsWith('FROM whatsapp_tags') && q.startsWith('SELECT id')) {
        return { rows: [{ id: 1, workspace_id: 'w1', external_id: 'a', name: 'A', color: 'blue', description: null,
          parent_external_id: null, ancestor_external_ids: [], deleted_at: null }] };
      }
      if (q.startsWith('SELECT d.id')) return { rows: [] };
      if (q.startsWith('UPDATE whatsapp_tags SET deleted_at')) seen.push('tombstone');
      return { rows: [] };
    },
    release: () => {},
  };
  const r = await runVocabularySync({ connect: async () => client } as any, async () => [
    v({ id: 'a', mergedIntoId: 'b', deletedAt: '2026-11-01T00:00:00Z' }),
  ]);
  assert.deepEqual(r, { ops: 0, errors: 1 });
  assert.deepEqual(seen, []);
});

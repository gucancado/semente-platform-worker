import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  planMigration,
  type PlanInput,
} from '../../src/cli/migrate-opportunities.js';

const TS = '2026-07-20T15:00:00.000Z';

const emptyInput = (over: Partial<PlanInput> = {}): PlanInput => ({
  threads: [],
  threadTags: [],
  existingCatalogTags: [],
  migratedPairs: [],
  ...over,
});

test('mapeia stages: cliente→ganho fechado, qualificado→andamento aberto, perdido→perdido fechado', () => {
  const plan = planMigration(
    emptyInput({
      threads: [
        { numberId: 1, identifier: 'a', workspaceId: 'ws', leadStage: 'cliente', leadTemperature: null, updatedAt: TS },
        { numberId: 1, identifier: 'b', workspaceId: 'ws', leadStage: 'qualificado', leadTemperature: null, updatedAt: TS },
        { numberId: 1, identifier: 'c', workspaceId: 'ws', leadStage: 'perdido', leadTemperature: null, updatedAt: TS },
        { numberId: 1, identifier: 'd', workspaceId: 'ws', leadStage: 'desqualificado', leadTemperature: null, updatedAt: TS },
        { numberId: 1, identifier: 'e', workspaceId: 'ws', leadStage: null, leadTemperature: null, updatedAt: TS },
      ],
    }),
  );

  assert.equal(plan.workspaces.length, 1);
  const ws = plan.workspaces[0]!;
  // desqualificado + null ficam fora
  assert.equal(ws.opportunities.length, 3);
  assert.deepEqual(ws.eligibleByStage, { cliente: 1, qualificado: 1, perdido: 1 });
  assert.deepEqual(ws.oppsByStatus, { ganho: 1, em_andamento: 1, perdido: 1 });

  const byId = Object.fromEntries(ws.opportunities.map((o) => [o.identifier, o]));
  assert.deepEqual(
    { status: byId.a!.status, qualification: byId.a!.qualification, closed: byId.a!.closed, closedAt: byId.a!.closedAt, createdAt: byId.a!.createdAt },
    { status: 'ganho', qualification: 'qualificado', closed: true, closedAt: TS, createdAt: TS },
  );
  assert.deepEqual(
    { status: byId.b!.status, closed: byId.b!.closed, closedAt: byId.b!.closedAt },
    { status: 'em_andamento', closed: false, closedAt: null },
  );
  assert.deepEqual(
    { status: byId.c!.status, closed: byId.c!.closed, closedAt: byId.c!.closedAt },
    { status: 'perdido', closed: true, closedAt: TS },
  );
});

test('tags: colisão de casing dedupa por lower(name); menor tupla define casing', () => {
  const plan = planMigration(
    emptyInput({
      threads: [
        { numberId: 1, identifier: 'a', workspaceId: 'ws', leadStage: 'qualificado', leadTemperature: null, updatedAt: TS },
        { numberId: 1, identifier: 'b', workspaceId: 'ws', leadStage: 'qualificado', leadTemperature: null, updatedAt: TS },
        { numberId: 2, identifier: 'c', workspaceId: 'ws', leadStage: 'qualificado', leadTemperature: null, updatedAt: TS },
      ],
      threadTags: [
        // menor tupla = (1,'a','Cardio') → casing 'Cardio'
        { numberId: 1, identifier: 'a', tag: 'Cardio' },
        { numberId: 1, identifier: 'b', tag: 'cardio' },
        { numberId: 2, identifier: 'c', tag: '  cardio  ' },
      ],
    }),
  );

  const ws = plan.workspaces[0]!;
  assert.equal(ws.newTags.length, 1);
  assert.deepEqual(ws.newTags[0], { key: 'cardio', name: 'Cardio', color: 'red' }); // TAG_COLORS[0]
  // uma etiqueta por thread → 3 anexos, todos apontando pro mesmo catálogo
  assert.equal(ws.attachmentCount, 3);
  for (const o of ws.opportunities) {
    assert.deepEqual(o.attachments, [{ tagKey: 'cardio', tagName: 'Cardio' }]);
  }
});

test('temperature vira etiqueta: quente/morno/frio com cor fixa, lixo→slate', () => {
  const plan = planMigration(
    emptyInput({
      threads: [
        { numberId: 1, identifier: 'a', workspaceId: 'ws', leadStage: 'cliente', leadTemperature: 'quente', updatedAt: TS },
        { numberId: 1, identifier: 'b', workspaceId: 'ws', leadStage: 'qualificado', leadTemperature: 'morno', updatedAt: TS },
        { numberId: 1, identifier: 'c', workspaceId: 'ws', leadStage: 'perdido', leadTemperature: 'frio', updatedAt: TS },
        { numberId: 1, identifier: 'd', workspaceId: 'ws', leadStage: 'qualificado', leadTemperature: 'QUENTE ', updatedAt: TS },
        { numberId: 1, identifier: 'e', workspaceId: 'ws', leadStage: 'qualificado', leadTemperature: 'x', updatedAt: TS },
        { numberId: 1, identifier: 'f', workspaceId: 'ws', leadStage: 'qualificado', leadTemperature: '   ', updatedAt: TS },
      ],
    }),
  );

  const ws = plan.workspaces[0]!;
  // 'QUENTE ' normaliza pra 'QUENTE', mesma key 'quente' de 'quente' (menor tupla = id 'a' → 'quente')
  // '   ' → normalizeTagName null → não vira etiqueta
  const byKey = Object.fromEntries(ws.newTags.map((t) => [t.key, t]));
  assert.deepEqual(byKey.quente, { key: 'quente', name: 'quente', color: 'red' });
  assert.deepEqual(byKey.morno, { key: 'morno', name: 'morno', color: 'amber' });
  assert.deepEqual(byKey.frio, { key: 'frio', name: 'frio', color: 'blue' });
  assert.deepEqual(byKey.x, { key: 'x', name: 'x', color: 'slate' });
  assert.equal(ws.newTags.length, 4);
  // ordenação alfabética por key
  assert.deepEqual(ws.newTags.map((t) => t.key), ['frio', 'morno', 'quente', 'x']);
  // thread 'f' criou opp mas sem anexo (temperature em branco)
  const f = ws.opportunities.find((o) => o.identifier === 'f')!;
  assert.deepEqual(f.attachments, []);
});

test('cores ciclam a partir da contagem do catálogo; temperature não consome slot', () => {
  const plan = planMigration(
    emptyInput({
      threads: [
        { numberId: 1, identifier: 'a', workspaceId: 'ws', leadStage: 'qualificado', leadTemperature: 'quente', updatedAt: TS },
        { numberId: 1, identifier: 'b', workspaceId: 'ws', leadStage: 'qualificado', leadTemperature: null, updatedAt: TS },
        { numberId: 1, identifier: 'c', workspaceId: 'ws', leadStage: 'qualificado', leadTemperature: null, updatedAt: TS },
      ],
      threadTags: [
        { numberId: 1, identifier: 'b', tag: 'apple' },
        { numberId: 1, identifier: 'c', tag: 'banana' },
      ],
    }),
  );

  const ws = plan.workspaces[0]!;
  const byKey = Object.fromEntries(ws.newTags.map((t) => [t.key, t.color]));
  // ordem alfabética: apple(0=red), banana(1=orange); quente é temperature → red fixo, sem avançar cursor
  assert.equal(byKey.apple, 'red');
  assert.equal(byKey.banana, 'orange');
  assert.equal(byKey.quente, 'red');
});

test('catálogo pré-existente move o cursor de cor (N tags → próxima = TAG_COLORS[N])', () => {
  const plan = planMigration(
    emptyInput({
      threads: [
        { numberId: 1, identifier: 'a', workspaceId: 'ws', leadStage: 'qualificado', leadTemperature: null, updatedAt: TS },
      ],
      threadTags: [{ numberId: 1, identifier: 'a', tag: 'vip' }],
      // 3 tags já no catálogo → nova usa TAG_COLORS[3] = 'green'
      existingCatalogTags: [
        { workspaceId: 'ws', name: 'Alpha' },
        { workspaceId: 'ws', name: 'Beta' },
        { workspaceId: 'ws', name: 'Gama' },
      ],
    }),
  );
  const ws = plan.workspaces[0]!;
  assert.deepEqual(ws.newTags, [{ key: 'vip', name: 'vip', color: 'green' }]);
});

test('tag já existente no catálogo não é recriada; anexo aponta pra ela (casing existente)', () => {
  const plan = planMigration(
    emptyInput({
      threads: [
        { numberId: 1, identifier: 'a', workspaceId: 'ws', leadStage: 'qualificado', leadTemperature: null, updatedAt: TS },
      ],
      threadTags: [{ numberId: 1, identifier: 'a', tag: 'cardio' }],
      existingCatalogTags: [{ workspaceId: 'ws', name: 'Cardio' }],
    }),
  );
  const ws = plan.workspaces[0]!;
  assert.equal(ws.newTags.length, 0);
  assert.deepEqual(ws.opportunities[0]!.attachments, [{ tagKey: 'cardio', tagName: 'Cardio' }]);
});

test('idempotência: par já migrado é pulado, não gera opp nem tag', () => {
  const input = emptyInput({
    threads: [
      { numberId: 1, identifier: 'a', workspaceId: 'ws', leadStage: 'cliente', leadTemperature: 'quente', updatedAt: TS },
      { numberId: 1, identifier: 'b', workspaceId: 'ws', leadStage: 'qualificado', leadTemperature: null, updatedAt: TS },
    ],
    threadTags: [{ numberId: 1, identifier: 'a', tag: 'vip' }],
  });

  const first = planMigration(input);
  assert.equal(first.totals.opportunities, 2);
  assert.equal(first.totals.skipped, 0);

  // 2ª rodada: ambos os pares já têm opp de migração
  const second = planMigration({
    ...input,
    migratedPairs: [
      { numberId: 1, identifier: 'a' },
      { numberId: 1, identifier: 'b' },
    ],
  });
  assert.equal(second.totals.opportunities, 0);
  assert.equal(second.totals.newTags, 0);
  assert.equal(second.totals.attachments, 0);
  assert.equal(second.totals.skipped, 2);
  // stage ainda conta como elegível (candidato), mas nada é criado
  assert.deepEqual(second.workspaces[0]!.eligibleByStage, { cliente: 1, qualificado: 1 });
});

test('determinismo: ordem das arrays de entrada não muda o plano', () => {
  const base = emptyInput({
    threads: [
      { numberId: 2, identifier: 'z', workspaceId: 'wsB', leadStage: 'cliente', leadTemperature: 'morno', updatedAt: TS },
      { numberId: 1, identifier: 'a', workspaceId: 'wsA', leadStage: 'qualificado', leadTemperature: null, updatedAt: TS },
      { numberId: 1, identifier: 'b', workspaceId: 'wsA', leadStage: 'perdido', leadTemperature: null, updatedAt: TS },
    ],
    threadTags: [
      { numberId: 1, identifier: 'a', tag: 'Beta' },
      { numberId: 1, identifier: 'b', tag: 'alpha' },
      { numberId: 1, identifier: 'a', tag: 'alpha' },
    ],
  });
  const reversed: PlanInput = {
    threads: [...base.threads].reverse(),
    threadTags: [...base.threadTags].reverse(),
    existingCatalogTags: [...base.existingCatalogTags].reverse(),
    migratedPairs: [...base.migratedPairs].reverse(),
  };
  assert.deepEqual(planMigration(reversed), planMigration(base));
  // e idempotente sobre si mesmo
  assert.deepEqual(planMigration(base), planMigration(base));
});

test('parseArgs: default é dry-run, --apply executa, --dry-run vence conflito, --workspace filtra', () => {
  assert.deepEqual(parseArgs([]), { apply: false, dryRun: true, workspace: null });
  assert.deepEqual(parseArgs(['--dry-run']), { apply: false, dryRun: true, workspace: null });
  assert.deepEqual(parseArgs(['--apply']), { apply: true, dryRun: false, workspace: null });
  assert.deepEqual(parseArgs(['--apply', '--dry-run']), { apply: false, dryRun: true, workspace: null });
  assert.deepEqual(parseArgs(['--apply', '--workspace=ws-9']), {
    apply: true,
    dryRun: false,
    workspace: 'ws-9',
  });
});

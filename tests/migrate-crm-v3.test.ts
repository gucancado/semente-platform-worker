import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  planCutover,
  formatReport,
  readCandidates,
  readNumberWorkspaces,
  readExistingSettingsWorkspaces,
  type CutoverInput,
} from '../src/cli/migrate-crm-v3.js';

// ── readCandidates: SQL de seleção da promoção ──────────────────────────────
// Fake pool captura o SQL/params (mesmo padrão de tests/workspace-settings.test.ts)
// pra travar a query sem precisar de DATABASE_URL.

test('readCandidates: filtra created_by=migration E is_lead IS NULL (sem row OU row NULL) via LEFT JOIN', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  } as any;

  await readCandidates(pool, null);

  assert.equal(calls.length, 1);
  const { sql, params } = calls[0]!;
  assert.match(sql, /FROM whatsapp_opportunities o/);
  assert.match(sql, /LEFT JOIN whatsapp_thread_meta tm/);
  assert.match(sql, /o\.created_by = 'migration'/);
  assert.match(sql, /tm\.is_lead IS NULL/);
  assert.deepEqual(params, []);
});

test('readCandidates: --workspace filtra por o.workspace_id = $1', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  } as any;

  await readCandidates(pool, 'ws-9');

  const { sql, params } = calls[0]!;
  assert.match(sql, /o\.workspace_id = \$1/);
  assert.deepEqual(params, ['ws-9']);
});

test('readCandidates: mapeia rows snake→camel', async () => {
  const pool = {
    query: async () => ({
      rows: [{ whatsapp_number_id: '7', identifier: 'abc', workspace_id: 'ws-1' }],
    }),
  } as any;

  const rows = await readCandidates(pool, null);
  assert.deepEqual(rows, [{ numberId: 7, identifier: 'abc', workspaceId: 'ws-1' }]);
});

// ── readNumberWorkspaces / readExistingSettingsWorkspaces ───────────────────

test('readNumberWorkspaces: SELECT DISTINCT workspace_id de whatsapp_numbers, filtrável', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [{ workspace_id: 'ws-1' }, { workspace_id: 'ws-2' }] };
    },
  } as any;

  const rows = await readNumberWorkspaces(pool, null);
  assert.match(calls[0]!.sql, /FROM whatsapp_numbers/);
  assert.match(calls[0]!.sql, /DISTINCT workspace_id/);
  assert.deepEqual(rows, ['ws-1', 'ws-2']);

  await readNumberWorkspaces(pool, 'ws-9');
  assert.match(calls[1]!.sql, /workspace_id = \$1/);
  assert.deepEqual(calls[1]!.params, ['ws-9']);
});

test('readExistingSettingsWorkspaces: lê de whatsapp_workspace_settings, filtrável', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [{ workspace_id: 'ws-1' }] };
    },
  } as any;

  const rows = await readExistingSettingsWorkspaces(pool, null);
  assert.match(calls[0]!.sql, /FROM whatsapp_workspace_settings/);
  assert.deepEqual(rows, ['ws-1']);

  await readExistingSettingsWorkspaces(pool, 'ws-3');
  assert.match(calls[1]!.sql, /workspace_id = \$1/);
  assert.deepEqual(calls[1]!.params, ['ws-3']);
});

// ── planCutover: planejamento puro ───────────────────────────────────────────

const emptyInput = (over: Partial<CutoverInput> = {}): CutoverInput => ({
  candidates: [],
  numberWorkspaces: [],
  existingSettingsWorkspaces: [],
  ...over,
});

test('planCutover: agrupa pares por workspace, ordenado por workspaceId e depois (numberId, identifier)', () => {
  const plan = planCutover(
    emptyInput({
      candidates: [
        { numberId: 2, identifier: 'b', workspaceId: 'ws-b' },
        { numberId: 1, identifier: 'z', workspaceId: 'ws-a' },
        { numberId: 1, identifier: 'a', workspaceId: 'ws-a' },
      ],
      numberWorkspaces: ['ws-a', 'ws-b'],
    }),
  );

  assert.deepEqual(
    plan.workspaces.map((w) => w.workspaceId),
    ['ws-a', 'ws-b'],
  );
  const wsA = plan.workspaces[0]!;
  assert.deepEqual(wsA.pairs, [
    { numberId: 1, identifier: 'a', workspaceId: 'ws-a' },
    { numberId: 1, identifier: 'z', workspaceId: 'ws-a' },
  ]);
});

test('planCutover: needsSettings=true quando workspace ainda não tem row em whatsapp_workspace_settings', () => {
  const plan = planCutover(
    emptyInput({
      numberWorkspaces: ['ws-a', 'ws-b'],
      existingSettingsWorkspaces: ['ws-a'],
    }),
  );
  const byId = Object.fromEntries(plan.workspaces.map((w) => [w.workspaceId, w.needsSettings]));
  assert.equal(byId['ws-a'], false);
  assert.equal(byId['ws-b'], true);
});

test('planCutover: workspace só em candidates (sem estar em numberWorkspaces) ainda aparece no plano', () => {
  const plan = planCutover(
    emptyInput({
      candidates: [{ numberId: 1, identifier: 'a', workspaceId: 'ws-solo' }],
      numberWorkspaces: [],
      existingSettingsWorkspaces: [],
    }),
  );
  assert.equal(plan.workspaces.length, 1);
  assert.equal(plan.workspaces[0]!.workspaceId, 'ws-solo');
  assert.equal(plan.workspaces[0]!.pairs.length, 1);
  assert.equal(plan.workspaces[0]!.needsSettings, true);
});

test('planCutover: totals somam pares a promover e workspaces sem settings', () => {
  const plan = planCutover(
    emptyInput({
      candidates: [
        { numberId: 1, identifier: 'a', workspaceId: 'ws-a' },
        { numberId: 1, identifier: 'b', workspaceId: 'ws-a' },
        { numberId: 2, identifier: 'c', workspaceId: 'ws-b' },
      ],
      numberWorkspaces: ['ws-a', 'ws-b', 'ws-c'],
      existingSettingsWorkspaces: ['ws-a'],
    }),
  );
  assert.deepEqual(plan.totals, { pairsToPromote: 3, workspacesNeedingSettings: 2 });
});

test('planCutover: idempotência simulada — sem candidatos (já promovido) dá 0 pares', () => {
  const plan = planCutover(
    emptyInput({
      numberWorkspaces: ['ws-a'],
      existingSettingsWorkspaces: ['ws-a'],
    }),
  );
  assert.deepEqual(plan.totals, { pairsToPromote: 0, workspacesNeedingSettings: 0 });
});

test('planCutover: determinismo — ordem das arrays de entrada não muda o plano', () => {
  const base = emptyInput({
    candidates: [
      { numberId: 2, identifier: 'b', workspaceId: 'ws-b' },
      { numberId: 1, identifier: 'a', workspaceId: 'ws-a' },
    ],
    numberWorkspaces: ['ws-b', 'ws-a'],
    existingSettingsWorkspaces: ['ws-b'],
  });
  const reversed: CutoverInput = {
    candidates: [...base.candidates].reverse(),
    numberWorkspaces: [...base.numberWorkspaces].reverse(),
    existingSettingsWorkspaces: [...base.existingSettingsWorkspaces].reverse(),
  };
  assert.deepEqual(planCutover(reversed), planCutover(base));
});

// ── parseArgs ────────────────────────────────────────────────────────────────

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

// ── formatReport: formatação do dry-run report (contagens) ─────────────────

test('formatReport: modo DRY-RUN por padrão, lista contagens por workspace + totais', () => {
  const plan = planCutover({
    candidates: [
      { numberId: 1, identifier: 'a', workspaceId: 'ws-a' },
      { numberId: 1, identifier: 'b', workspaceId: 'ws-a' },
    ],
    numberWorkspaces: ['ws-a', 'ws-b'],
    existingSettingsWorkspaces: ['ws-a'],
  });
  const lines = formatReport(plan, { apply: false, dryRun: true, workspace: null });
  const text = lines.join('\n');

  assert.match(text, /DRY-RUN/);
  assert.doesNotMatch(text, /workspace=/);
  assert.match(text, /workspace ws-a/);
  assert.match(text, /pares a promover.*: 2/);
  assert.match(text, /já existe/);
  assert.match(text, /workspace ws-b/);
  assert.match(text, /sem row/);
  assert.match(text, /total: 2 pares a promover · 1 workspace\(s\) sem settings/);
});

test('formatReport: modo APPLY + --workspace aparece no cabeçalho', () => {
  const plan = planCutover({
    candidates: [],
    numberWorkspaces: ['ws-9'],
    existingSettingsWorkspaces: [],
  });
  const lines = formatReport(plan, { apply: true, dryRun: false, workspace: 'ws-9' });
  const text = lines.join('\n');
  assert.match(text, /APPLY/);
  assert.match(text, /workspace=ws-9/);
  assert.match(text, /total: 0 pares a promover · 1 workspace\(s\) sem settings/);
});

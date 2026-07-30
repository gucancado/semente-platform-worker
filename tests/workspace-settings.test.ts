import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapWorkspaceSettings, getOrCreateSettings } from '../src/whatsapp/workspace-settings.js';
import { validateSettingsPatch } from '../src/whatsapp/settings-routes.js';

// ── mapper snake→camel ────────────────────────────────────────────────────────

test('mapWorkspaceSettings: mapeia snake_case do banco pra camelCase, incluindo nulls', () => {
  const row = {
    workspace_id: 'ws-1',
    auto_loss_days: 7,
    new_opp_after_days: 30,
    ai_engine_enabled: false,
    ai_lead_guidance: null,
    ai_qualified_guidance: null,
    pipeline_since: '2026-01-01T00:00:00.000Z',
  };
  assert.deepEqual(mapWorkspaceSettings(row), {
    workspaceId: 'ws-1',
    autoLossDays: 7,
    newOppAfterDays: 30,
    aiEngineEnabled: false,
    aiLeadGuidance: null,
    aiQualifiedGuidance: null,
    pipelineSince: '2026-01-01T00:00:00.000Z',
  });
});

test('mapWorkspaceSettings: auto_loss_days NULL vira null (nunca 0/NaN)', () => {
  const row = {
    workspace_id: 'ws-1', auto_loss_days: null, new_opp_after_days: 30,
    ai_engine_enabled: true, ai_lead_guidance: 'seja gentil', ai_qualified_guidance: 'foque em ROI',
    pipeline_since: '2026-01-01T00:00:00.000Z',
  };
  const mapped = mapWorkspaceSettings(row);
  assert.equal(mapped.autoLossDays, null);
  assert.equal(mapped.aiEngineEnabled, true);
  assert.equal(mapped.aiLeadGuidance, 'seja gentil');
  assert.equal(mapped.aiQualifiedGuidance, 'foque em ROI');
});

test('mapWorkspaceSettings: pipeline_since como objeto Date usa toISOString', () => {
  const row = {
    workspace_id: 'ws-1', auto_loss_days: 7, new_opp_after_days: 30, ai_engine_enabled: false,
    ai_lead_guidance: null, ai_qualified_guidance: null,
    pipeline_since: new Date('2026-01-01T00:00:00.000Z'),
  };
  assert.equal(mapWorkspaceSettings(row).pipelineSince, '2026-01-01T00:00:00.000Z');
});

// ── getOrCreateSettings: INSERT-então-SELECT ──────────────────────────────────

test('getOrCreateSettings: faz INSERT ... ON CONFLICT DO NOTHING e depois SELECT — nesta ordem', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const settingsRow = {
    workspace_id: 'ws-42', auto_loss_days: 7, new_opp_after_days: 30, ai_engine_enabled: false,
    ai_lead_guidance: null, ai_qualified_guidance: null, pipeline_since: '2026-01-01T00:00:00.000Z',
  };
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (calls.length === 1) return { rows: [], rowCount: 0 };
      return { rows: [settingsRow], rowCount: 1 };
    },
  } as any;

  const result = await getOrCreateSettings(pool, 'ws-42');

  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /INSERT INTO whatsapp_workspace_settings/);
  assert.match(calls[0].sql, /ON CONFLICT \(workspace_id\) DO NOTHING/);
  assert.deepEqual(calls[0].params, ['ws-42']);
  assert.match(calls[1].sql, /SELECT/);
  assert.match(calls[1].sql, /FROM whatsapp_workspace_settings/);
  assert.deepEqual(calls[1].params, ['ws-42']);
  assert.equal(result.workspaceId, 'ws-42');
  assert.equal(result.pipelineSince, '2026-01-01T00:00:00.000Z');
});

// ── validateSettingsPatch: validação pura do PATCH ────────────────────────────

test('validateSettingsPatch: auto_loss_days = 0 é inválido (precisa ser >= 1)', () => {
  const result = validateSettingsPatch({ auto_loss_days: 0 });
  assert.equal(result.ok, false);
});

test('validateSettingsPatch: auto_loss_days = null é válido (nullable)', () => {
  const result = validateSettingsPatch({ auto_loss_days: null });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.patch.autoLossDays, null);
});

test('validateSettingsPatch: auto_loss_days float é inválido', () => {
  const result = validateSettingsPatch({ auto_loss_days: 2.5 });
  assert.equal(result.ok, false);
});

test('validateSettingsPatch: new_opp_after_days = null é inválido (não aceita null)', () => {
  const result = validateSettingsPatch({ new_opp_after_days: null });
  assert.equal(result.ok, false);
});

test('validateSettingsPatch: new_opp_after_days = 0 é inválido', () => {
  const result = validateSettingsPatch({ new_opp_after_days: 0 });
  assert.equal(result.ok, false);
});

test('validateSettingsPatch: new_opp_after_days float é inválido', () => {
  const result = validateSettingsPatch({ new_opp_after_days: 1.5 });
  assert.equal(result.ok, false);
});

test('validateSettingsPatch: new_opp_after_days inteiro >= 1 é válido', () => {
  const result = validateSettingsPatch({ new_opp_after_days: 45 });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.patch.newOppAfterDays, 45);
});

test('validateSettingsPatch: pipeline_since no body é sempre 400 (read-only, campo desconhecido)', () => {
  const result = validateSettingsPatch({ pipeline_since: '2026-01-01T00:00:00.000Z' } as any);
  assert.equal(result.ok, false);
});

test('validateSettingsPatch: campo desconhecido é 400', () => {
  const result = validateSettingsPatch({ nonsense: 1 } as any);
  assert.equal(result.ok, false);
});

test('validateSettingsPatch: body vazio (sem nenhum campo patchável) é 400', () => {
  const result = validateSettingsPatch({});
  assert.equal(result.ok, false);
});

test('validateSettingsPatch: number_id sozinho, sem campo patchável, é 400', () => {
  const result = validateSettingsPatch({ number_id: 5 });
  assert.equal(result.ok, false);
});

test('validateSettingsPatch: ai_engine_enabled não-boolean é 400', () => {
  const result = validateSettingsPatch({ ai_engine_enabled: 'true' as any });
  assert.equal(result.ok, false);
});

test('validateSettingsPatch: ai_lead_guidance aceita string ou null', () => {
  const asString = validateSettingsPatch({ ai_lead_guidance: 'seja objetivo' });
  assert.equal(asString.ok, true);
  const asNull = validateSettingsPatch({ ai_lead_guidance: null });
  assert.equal(asNull.ok, true);
});

test('validateSettingsPatch: ai_qualified_guidance não-string/não-null é 400', () => {
  const result = validateSettingsPatch({ ai_qualified_guidance: 42 as any });
  assert.equal(result.ok, false);
});

test('validateSettingsPatch: combinação válida com vários campos', () => {
  const result = validateSettingsPatch({
    number_id: 5, auto_loss_days: 10, new_opp_after_days: 60,
    ai_engine_enabled: true, ai_lead_guidance: 'foo', ai_qualified_guidance: null,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.patch, {
      autoLossDays: 10, newOppAfterDays: 60, aiEngineEnabled: true,
      aiLeadGuidance: 'foo', aiQualifiedGuidance: null,
    });
  }
});

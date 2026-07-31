// tests/whatsapp/run-ai-pattern-cli.test.ts  (PURO — só parse de args + resolução de período)
//
// O CLI real (main) importa ../db.js (exige DATABASE_URL) e é gated por invokedDirectly, então
// não roda em teste. Aqui provamos só as funções puras exportadas: parseArgs e resolvePeriod.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, resolvePeriod } from '../../src/cli/run-ai-pattern.js';

test('parseArgs: --workspace, --period-start (validado) e --dry-run', () => {
  assert.deepEqual(parseArgs(['--workspace=ws-1', '--period-start=2026-07-13', '--dry-run']), {
    workspace: 'ws-1', periodStart: '2026-07-13', dryRun: true,
  });
  assert.deepEqual(parseArgs(['--workspace=ws-1']), { workspace: 'ws-1', periodStart: null, dryRun: false });
  // period-start malformado é ignorado (cai no default depois).
  assert.equal(parseArgs(['--workspace=ws', '--period-start=13/07']).periodStart, null);
  assert.equal(parseArgs([]).workspace, null);
});

test('resolvePeriod: --period-start dado → seg→+6d; ausente → semana anterior', () => {
  assert.deepEqual(resolvePeriod('2026-07-13'), { periodStart: '2026-07-13', periodEnd: '2026-07-19' });
  // sem period-start, usa previousCompleteWeek do relógio injetado (domingo 2026-07-26).
  assert.deepEqual(resolvePeriod(null, new Date('2026-07-26T07:00:00Z')), {
    periodStart: '2026-07-13', periodEnd: '2026-07-19',
  });
});

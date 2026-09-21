// O `config` é parseado NO IMPORT (`EnvSchema.parse(process.env)`), e um throw ali
// derruba o worker inteiro — webhook, REST, MCP, tudo. Esta env é preenchida à mão
// com datas: erro de digitação nela tem que custar um warn, não o processo.
//
// `node --test` isola cada arquivo num processo, então dá para sujar o env ANTES do
// primeiro import do config sem vazar para o resto da suíte.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.BUSINESS_HOURS_EXTRA_OFF_DATES = 'lixo, 2026-12-08 ,2026-02-30,;;;,2026-12-24';

test('BUSINESS_HOURS_EXTRA_OFF_DATES malformada NÃO derruba o boot: config carrega e a string passa crua', async () => {
  const { config } = await import('../../src/config.js');
  assert.equal(config.BUSINESS_HOURS_EXTRA_OFF_DATES, 'lixo, 2026-12-08 ,2026-02-30,;;;,2026-12-24');
});

test('as opções do vigia saem com as datas válidas e UM warn listando as inválidas', async () => {
  const { buildSystemWatchOpts } = await import('../../src/whatsapp/down-notify-start.js');
  const warns: any[] = [];
  const opts = buildSystemWatchOpts({ info() {}, error() {}, warn: (...a: any[]) => warns.push(a) });

  assert.deepEqual([...(opts.offDates ?? [])].sort(), ['2026-12-08', '2026-12-24']);
  assert.equal(warns.length, 1);
  assert.deepEqual(warns[0][0].invalid, ['lixo', '2026-02-30', ';;;']);
  // o resto das opções vem do config, intacto
  assert.equal(opts.staleMs, 6 * 3_600_000);
  assert.equal(opts.intervalMs, 300_000);
});

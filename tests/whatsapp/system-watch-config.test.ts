import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystemWatch } from '../../src/config.js';

test('o JSON que JÁ ESTÁ em produção segue válido e cai no perfil de horário comercial', () => {
  // valor literal da env SYSTEM_INSTANCE_WATCH_JSON do worker — sem o campo novo
  const prod = '[{"instance":"saturno","expected_phone":"+553195950748","label":"Monitor de grupos"}]';
  assert.deepEqual(parseSystemWatch(prod), [
    { instance: 'saturno', expectedPhone: '+553195950748', label: 'Monitor de grupos', traffic: 'business_hours' },
  ]);
});

test('alvo que recebe a qualquer hora declara traffic=always', () => {
  const r = parseSystemWatch('[{"instance":"mercurio","expected_phone":"+5531900000000","traffic":"always"}]');
  assert.deepEqual(r, [{ instance: 'mercurio', expectedPhone: '+5531900000000', label: null, traffic: 'always' }]);
});

test('env ausente = nenhum alvo; perfil desconhecido ou JSON quebrado é erro de configuração', () => {
  assert.deepEqual(parseSystemWatch(undefined), []);
  assert.deepEqual(parseSystemWatch(''), []);
  assert.throws(() => parseSystemWatch('[{"instance":"saturno","expected_phone":"+553195950748","traffic":"noturno"}]'));
  assert.throws(() => parseSystemWatch('{nao-e-json'));
});

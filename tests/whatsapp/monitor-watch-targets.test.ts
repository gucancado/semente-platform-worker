import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSystemTargets } from '../../src/whatsapp/monitor-watch-targets.js';

const env = [{ instance: 'saturno', expectedPhone: '+553195950748', label: 'Monitor de grupos', traffic: undefined }];
test('slot não-número vira alvo; slot número fica com o vigia de números', () => {
  const r = mergeSystemTargets([], [
    { slot: 'A', instance: 'saturno', phone: '+553195950748' },
    { slot: 'B', instance: 'ws-a', phone: '+553196039118' },
  ], new Set(['ws-a']));
  assert.deepEqual(r, [{ instance: 'saturno', expectedPhone: '+553195950748', label: 'Monitor de grupos A' }]);
});
test('env e slot na mesma instância → um alvo só, label do slot, preserva traffic do env', () => {
  const r = mergeSystemTargets([{ ...env[0]!, traffic: 'always' as any }], [{ slot: 'A', instance: 'saturno', phone: '+553195950748' }], new Set());
  assert.equal(r.length, 1);
  assert.equal(r[0]!.label, 'Monitor de grupos A');
  assert.equal((r[0] as any).traffic, 'always');
});
test('env sem slot segue como está', () => {
  assert.deepEqual(mergeSystemTargets(env, [], new Set()), env);
});

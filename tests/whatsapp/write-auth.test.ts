// tests/whatsapp/write-auth.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentCanWrite } from '../../src/whatsapp/write-auth.js';

test('agentCanWrite: true só quando a flag é exatamente true', () => {
  assert.equal(agentCanWrite({ can_write_whatsapp_meta: true }), true);
  assert.equal(agentCanWrite({ can_write_whatsapp_meta: false }), false);
  assert.equal(agentCanWrite({}), false);
});

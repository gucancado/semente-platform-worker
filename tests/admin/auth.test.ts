import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { requireOwnerToken } from '../../src/admin/auth.js';

function buildApp(token: string) {
  const app = Fastify();
  process.env.OWNER_ADMIN_TOKEN = token;
  app.addHook('preHandler', requireOwnerToken);
  app.get('/protected', async () => ({ ok: true }));
  return app;
}

test('requireOwnerToken: rejeita sem header', async () => {
  const app = buildApp('a'.repeat(32));
  const res = await app.inject({ method: 'GET', url: '/protected' });
  assert.equal(res.statusCode, 401);
  assert.match(res.body, /missing X-Owner-Token/);
});

test('requireOwnerToken: rejeita header errado', async () => {
  const app = buildApp('a'.repeat(32));
  const res = await app.inject({
    method: 'GET',
    url: '/protected',
    headers: { 'x-owner-token': 'b'.repeat(32) },
  });
  assert.equal(res.statusCode, 401);
  assert.match(res.body, /invalid X-Owner-Token/);
});

test('requireOwnerToken: aceita header correto', async () => {
  const token = 'a'.repeat(32);
  const app = buildApp(token);
  const res = await app.inject({
    method: 'GET',
    url: '/protected',
    headers: { 'x-owner-token': token },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
});

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const AGENT = 'mercurio';
const TOKEN = 'a'.repeat(32);

process.env.AGENT_TOKENS_JSON ||= JSON.stringify({
  [AGENT]: { worker_token: TOKEN },
});
process.env.BLOQUIM_API_URL ||= 'http://localhost:9999';
process.env.EVOLUTION_WEBHOOK_SECRET ||= 'x'.repeat(16);
process.env.OWNER_ADMIN_TOKEN ||= 'o'.repeat(32);

const Fastify = (await import('fastify')).default;
const { registerDebugRoutes } = await import('../../src/debug/routes.js');
const { testPool } = await import('../_helpers/db.js');

function buildApp() {
  const app = Fastify();
  app.register(registerDebugRoutes);
  return app;
}

const auth = { 'x-agent-token': TOKEN };

async function cleanInbox() {
  await testPool.query(`DELETE FROM webhook_logs WHERE agent = $1`, [AGENT]);
}

async function seedMessage(args: {
  identifier: string;
  text: string | null;
  push_name?: string | null;
  instance?: string;
  created_at?: Date;
  processed?: boolean;
}): Promise<number> {
  const { rows } = await testPool.query<{ id: number }>(
    `INSERT INTO webhook_logs
       (agent, channel, instance, identifier, push_name, message_text,
        payload_summary, fallback_used, created_at, processed_at, processed_by)
     VALUES ($1, 'whatsapp', $2, $3, $4, $5, $6, false, $7,
             CASE WHEN $8::bool THEN NOW() ELSE NULL END,
             CASE WHEN $8::bool THEN 'seed' ELSE NULL END)
     RETURNING id`,
    [
      AGENT,
      args.instance ?? 'mercurio-metido-a-gente',
      args.identifier,
      args.push_name ?? null,
      args.text,
      (args.text ?? '').slice(0, 80),
      args.created_at ?? new Date(),
      args.processed === true,
    ]
  );
  return rows[0]!.id;
}

before(async () => {
  // Sanity: confere que o env de teste tem o token registrado
  assert.ok(process.env.AGENT_TOKENS_JSON?.includes(TOKEN));
});

beforeEach(async () => {
  await cleanInbox();
});

// ── grouped=false (default — comportamento legado preservado) ──────────

test('GET /inbox-debug sem grouped retorna flat list (compat)', async () => {
  const app = buildApp();
  await seedMessage({ identifier: '+5511000001', text: 'oi 1' });
  await seedMessage({ identifier: '+5511000001', text: 'oi 2' });

  const res = await app.inject({ method: 'GET', url: '/inbox-debug?unread_only=true', headers: auth });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.messages.length, 2);
  // Cada item tem `id`, não `ids`
  assert.ok(typeof body.messages[0].id === 'number');
  assert.equal(body.messages[0].ids, undefined);
});

// ── grouped=true ───────────────────────────────────────────────────────

test('GET /inbox-debug?grouped=true agrupa por (channel, identifier)', async () => {
  const app = buildApp();
  const t0 = new Date(Date.now() - 30_000);
  const t1 = new Date(Date.now() - 20_000);
  const t2 = new Date(Date.now() - 10_000);

  // Lead A: 3 msgs
  const a1 = await seedMessage({ identifier: '+5511000001', text: 'Bom dia', push_name: 'Ana', created_at: t0 });
  const a2 = await seedMessage({ identifier: '+5511000001', text: 'Tudo bem?', push_name: null, created_at: t1 });
  const a3 = await seedMessage({ identifier: '+5511000001', text: 'Estou aí?', push_name: 'Ana Maria', created_at: t2 });
  // Lead B: 1 msg
  const b1 = await seedMessage({ identifier: '+5511000002', text: 'oi', push_name: 'Bia' });

  const res = await app.inject({
    method: 'GET',
    url: '/inbox-debug?grouped=true&unread_only=true',
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.messages.length, 2, 'esperava 2 grupos');

  // Ordem: last_received_at DESC. Lead A foi atualizado por último (t2 mais recente que B sem ts explícito = NOW)
  // Como B usa NOW() (mais recente), B vem primeiro.
  const groupB = body.messages.find((m: any) => m.identifier === '+5511000002');
  const groupA = body.messages.find((m: any) => m.identifier === '+5511000001');
  assert.ok(groupB && groupA);

  assert.deepEqual(groupA.ids, [a1, a2, a3]);
  assert.equal(groupA.count, 3);
  assert.equal(groupA.message_text, 'Bom dia\n\nTudo bem?\n\nEstou aí?');
  // push_name: mais recente NÃO-nulo (t2 > t1, mas t1 é null então pega t2 que é "Ana Maria")
  assert.equal(groupA.push_name, 'Ana Maria');
  assert.equal(groupA.instance, 'mercurio-metido-a-gente');

  assert.deepEqual(groupB.ids, [b1]);
  assert.equal(groupB.count, 1);
  assert.equal(groupB.message_text, 'oi');
  assert.equal(groupB.push_name, 'Bia');
});

test('grouped=true ignora message_text NULL/vazio no concat', async () => {
  const app = buildApp();
  const t0 = new Date(Date.now() - 30_000);
  const t1 = new Date(Date.now() - 20_000);
  const t2 = new Date(Date.now() - 10_000);
  await seedMessage({ identifier: '+5511000003', text: 'antes', created_at: t0 });
  await seedMessage({ identifier: '+5511000003', text: null, created_at: t1 });
  await seedMessage({ identifier: '+5511000003', text: 'depois', created_at: t2 });

  const res = await app.inject({
    method: 'GET',
    url: '/inbox-debug?grouped=true&unread_only=true',
    headers: auth,
  });
  const body = JSON.parse(res.body);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].count, 3);
  assert.equal(body.messages[0].message_text, 'antes\n\ndepois');
});

test('grouped=true: se TODAS msgs são null → message_text vazio (curto-circuito do agente trata)', async () => {
  const app = buildApp();
  await seedMessage({ identifier: '+5511000004', text: null });
  await seedMessage({ identifier: '+5511000004', text: null });

  const res = await app.inject({
    method: 'GET',
    url: '/inbox-debug?grouped=true&unread_only=true',
    headers: auth,
  });
  const body = JSON.parse(res.body);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].message_text, '');
});

test('grouped=true exclui mensagens já processadas', async () => {
  const app = buildApp();
  await seedMessage({ identifier: '+5511000005', text: 'lida', processed: true });
  await seedMessage({ identifier: '+5511000005', text: 'nao lida' });

  const res = await app.inject({
    method: 'GET',
    url: '/inbox-debug?grouped=true&unread_only=true',
    headers: auth,
  });
  const body = JSON.parse(res.body);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].count, 1);
  assert.equal(body.messages[0].message_text, 'nao lida');
});

test('grouped=true respeita limit (de grupos, não mensagens)', async () => {
  const app = buildApp();
  await seedMessage({ identifier: '+5511000010', text: 'a' });
  await seedMessage({ identifier: '+5511000010', text: 'b' });
  await seedMessage({ identifier: '+5511000011', text: 'c' });
  await seedMessage({ identifier: '+5511000012', text: 'd' });

  const res = await app.inject({
    method: 'GET',
    url: '/inbox-debug?grouped=true&unread_only=true&limit=2',
    headers: auth,
  });
  const body = JSON.parse(res.body);
  assert.equal(body.messages.length, 2);
});

// ── mark-read: aceita {id} OU {ids} ───────────────────────────────────

test('POST mark-read aceita {id} (compat)', async () => {
  const app = buildApp();
  const id = await seedMessage({ identifier: '+5511000020', text: 'oi' });
  const res = await app.inject({
    method: 'POST',
    url: '/inbox-debug/mark-read',
    headers: auth,
    payload: { id },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.marked, 1);
  assert.equal(body.ok, true);
});

test('POST mark-read aceita {ids} e marca múltiplos', async () => {
  const app = buildApp();
  const i1 = await seedMessage({ identifier: '+5511000030', text: 'a' });
  const i2 = await seedMessage({ identifier: '+5511000030', text: 'b' });
  const i3 = await seedMessage({ identifier: '+5511000030', text: 'c' });

  const res = await app.inject({
    method: 'POST',
    url: '/inbox-debug/mark-read',
    headers: auth,
    payload: { ids: [i1, i2] },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.marked, 2);

  // i3 segue não-lida
  const left = await app.inject({
    method: 'GET',
    url: '/inbox-debug?grouped=true&unread_only=true',
    headers: auth,
  });
  const leftBody = JSON.parse(left.body);
  assert.equal(leftBody.messages.length, 1);
  assert.deepEqual(leftBody.messages[0].ids, [i3]);
});

test('POST mark-read rejeita body vazio (nem id nem ids)', async () => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/inbox-debug/mark-read',
    headers: auth,
    payload: {},
  });
  assert.equal(res.statusCode, 500); // zod parse error vira 500 no error handler default do Fastify
});

test('POST mark-read rejeita id E ids juntos', async () => {
  const app = buildApp();
  const id = await seedMessage({ identifier: '+5511000040', text: 'oi' });
  const res = await app.inject({
    method: 'POST',
    url: '/inbox-debug/mark-read',
    headers: auth,
    payload: { id, ids: [id] },
  });
  assert.equal(res.statusCode, 500);
});

test('mark-read não afeta mensagens de outro agente', async () => {
  const app = buildApp();
  const i1 = await seedMessage({ identifier: '+5511000050', text: 'oi' });
  // injeta msg de outro agente com mesmo id-range
  const { rows } = await testPool.query<{ id: number }>(
    `INSERT INTO webhook_logs (agent, channel, instance, identifier, message_text, payload_summary, fallback_used)
     VALUES ('outroagente', 'whatsapp', 'outroagente-x', '+5511000050', 'nao mexer', 'nao', false)
     RETURNING id`
  );
  const otherId = rows[0]!.id;

  const res = await app.inject({
    method: 'POST',
    url: '/inbox-debug/mark-read',
    headers: auth,
    payload: { ids: [i1, otherId] },
  });
  const body = JSON.parse(res.body);
  assert.equal(body.marked, 1, 'só mercurio.i1 deve ter sido marcada');

  // Cleanup do outroagente
  await testPool.query(`DELETE FROM webhook_logs WHERE agent = 'outroagente'`);
});

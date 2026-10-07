/**
 * Rota POST /ops-notify — wiring, auth, a escada de 503 e o ENFILEIRAMENTO.
 * Desde 2026-10-07 a rota não envia: grava na fila (mig 070) e o flusher manda
 * em lote. Sem config, sem banco, sem rede: o `enqueue` é injetado.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerOpsNotifyRoute, type OpsNotifyDeps } from '../../src/ops-notify/routes.js';

const TOKEN = 'ops-secret-token';
const TO = '553196039118';
const PNID = '111222333';

type Enq = Parameters<OpsNotifyDeps['enqueue']>[0];

function appFor(over: Partial<OpsNotifyDeps> = {}, fail = false) {
  const calls: Enq[] = [];
  const app = Fastify({ logger: false });
  registerOpsNotifyRoute(app, {
    token: TOKEN,
    to: TO,
    phoneNumberId: PNID,
    cloudConfigured: true,
    enqueue: async (n) => {
      if (fail) throw new Error('db down');
      calls.push(n);
      return calls.length;
    },
    ...over,
  });
  return { app, calls };
}

const post = (app: any, body: unknown, headers: Record<string, string> = { 'x-ops-notify-token': TOKEN }) =>
  app.inject({ method: 'POST', url: '/ops-notify', headers, payload: body });

test('sem urgencia: enfileira como URGENTE e responde 202 (compatível com o painel antigo)', async () => {
  const { app, calls } = appFor();
  const r = await post(app, { titulo: '3 erros novos no painel', detalhe: 'TypeError · 12x' });
  assert.equal(r.statusCode, 202);
  assert.equal(r.json().queued, true);
  assert.deepEqual(calls, [{ titulo: '3 erros novos no painel', detalhe: 'TypeError · 12x', urgency: 'urgent' }]);
});

test("urgencia 'resumo' vai pro resumo; valor desconhecido é 400", async () => {
  const { app, calls } = appFor();
  assert.equal((await post(app, { titulo: 'saldo baixo', urgencia: 'resumo' })).statusCode, 202);
  assert.equal(calls[0].urgency, 'digest');
  assert.equal((await post(app, { titulo: 'x', urgencia: 'agora' })).statusCode, 400);
  assert.equal(calls.length, 1);
});

test('falha ao gravar na fila: 500 (o painel NÃO marca como avisado)', async () => {
  const { app } = appFor({}, true);
  const r = await post(app, { titulo: 'x' });
  assert.equal(r.statusCode, 500);
});

test('token ausente ou errado: 401, nada enfileirado', async () => {
  for (const headers of [{}, { 'x-ops-notify-token': 'errado' }, { 'x-ops-notify-token': `${TOKEN}x` }]) {
    const { app, calls } = appFor();
    const r = await post(app, { titulo: 'x' }, headers as Record<string, string>);
    assert.equal(r.statusCode, 401, JSON.stringify(headers));
    assert.equal(calls.length, 0);
  }
});

test('PANEL_TOKEN/X-Agent-Token não abrem esta rota', async () => {
  const { app } = appFor();
  const r = await post(app, { titulo: 'x' }, { 'x-panel-token': TOKEN, 'x-agent-token': TOKEN });
  assert.equal(r.statusCode, 401);
});

test('sem OPS_NOTIFY_TOKEN: 503 antes do 401 (não há com o que autenticar)', async () => {
  const { app } = appFor({ token: undefined });
  const r = await post(app, { titulo: 'x' }, {});
  assert.equal(r.statusCode, 503);
  assert.match(r.json().error, /OPS_NOTIFY_TOKEN/);
});

test('config faltando depois da auth: 503 declarado, nada enfileirado (aviso que nunca sairia)', async () => {
  const casos: Array<[Partial<OpsNotifyDeps>, RegExp]> = [
    [{ to: undefined }, /OPS_NOTIFY_TO/],
    [{ cloudConfigured: false }, /access token/],
    [{ phoneNumberId: null }, /phone_number_id/],
  ];
  for (const [over, re] of casos) {
    const { app, calls } = appFor(over);
    const r = await post(app, { titulo: 'x' });
    assert.equal(r.statusCode, 503, JSON.stringify(over));
    assert.match(r.json().error, re);
    assert.equal(calls.length, 0);
  }
});

test('titulo ausente ou em branco: 400, nada enfileirado', async () => {
  for (const body of [{}, { titulo: '' }, { titulo: '   ' }, { titulo: 42 }, { detalhe: 'só detalhe' }]) {
    const { app, calls } = appFor();
    const r = await post(app, body);
    assert.equal(r.statusCode, 400, JSON.stringify(body));
    assert.equal(calls.length, 0);
  }
});

test('o chamador NÃO escolhe destino nem remetente — campos extras são ignorados', async () => {
  const { app, calls } = appFor();
  const r = await post(app, { titulo: 'x', to: '5511999999999', phone_number_id: '999' });
  assert.equal(r.statusCode, 202);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['detalhe', 'titulo', 'urgency']);
});

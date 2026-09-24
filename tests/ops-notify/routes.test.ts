/**
 * Rota POST /ops-notify — wiring, auth e a escada de 503. Sem config e sem rede:
 * as deps são injetadas, como nas demais rotas do repo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerOpsNotifyRoute, type OpsNotifyDeps } from '../../src/ops-notify/routes.js';
import type { CloudSendResult, CloudTemplateMessage } from '../../src/webhook-cloud/send.js';
import { OPS_ALERT_TEMPLATE_NAME, renderOpsAlertText } from '../../src/webhook-cloud/templates.js';

const TOKEN = 'ops-secret-token';
const TO = '553196039118';
const PNID = '111222333';

const OK = (id: string): CloudSendResult => ({ ok: true, send_id: id });
const HTTP = (status: number): CloudSendResult => ({ ok: false, send_id: null, status, detail: { error: { code: status } } });

type Script = { template?: CloudSendResult | 'throw'; text?: CloudSendResult | 'throw' };

function appFor(script: Script = {}, over: Partial<OpsNotifyDeps> = {}) {
  const calls: Array<{ kind: 'template' | 'text'; pnid: string; to: string; arg: unknown }> = [];
  const run = (r: CloudSendResult | 'throw' | undefined) => {
    if (r === 'throw') throw new Error('socket hang up');
    return r ?? HTTP(500);
  };
  const app = Fastify({ logger: false });
  registerOpsNotifyRoute(app, {
    token: TOKEN,
    to: TO,
    phoneNumberId: PNID,
    cloudConfigured: true,
    sendTemplate: async (pnid: string, to: string, t: CloudTemplateMessage) => {
      calls.push({ kind: 'template', pnid, to, arg: t });
      return run(script.template);
    },
    sendText: async (pnid: string, to: string, text: string) => {
      calls.push({ kind: 'text', pnid, to, arg: text });
      return run(script.text);
    },
    ...over,
  });
  return { app, calls };
}

const post = (app: any, body: unknown, headers: Record<string, string> = { 'x-ops-notify-token': TOKEN }) =>
  app.inject({ method: 'POST', url: '/ops-notify', headers, payload: body });

test('template aceito: só o template sai, com o remetente e o destino do worker', async () => {
  const { app, calls } = appFor({ template: OK('wamid.1') });
  const r = await post(app, { titulo: '3 erros novos no painel', detalhe: 'TypeError · 12x' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, via: 'template', send_id: 'wamid.1' });
  assert.deepEqual(calls.map((c) => c.kind), ['template']);
  assert.equal(calls[0].pnid, PNID);
  assert.equal(calls[0].to, TO);
  const t = calls[0].arg as CloudTemplateMessage;
  assert.equal(t.name, OPS_ALERT_TEMPLATE_NAME);
  assert.equal(t.language, 'pt_BR');
  assert.deepEqual(t.bodyParams, ['3 erros novos no painel', 'TypeError · 12x']);
  assert.equal(t.urlButtonParam, undefined);
});

test('template recusado (PENDING na Meta): cai no texto livre com o MESMO corpo', async () => {
  const { app, calls } = appFor({ template: HTTP(400), text: OK('wamid.2') });
  const r = await post(app, { titulo: 'ciclo abortou', detalhe: 'ECONNRESET' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, via: 'text', send_id: 'wamid.2' });
  assert.deepEqual(calls.map((c) => c.kind), ['template', 'text']);
  assert.equal(calls[1].arg, renderOpsAlertText({ titulo: 'ciclo abortou', detalhe: 'ECONNRESET' }));
});

test('os dois caminhos falham: 502 com o detalhe dos dois', async () => {
  const { app } = appFor({ template: HTTP(400), text: HTTP(470) });
  const r = await post(app, { titulo: 'x' });
  assert.equal(r.statusCode, 502);
  assert.equal(r.json().template.status, 400);
  assert.equal(r.json().text.status, 470);
});

test('exceção de rede não escapa: vira 502, nunca 500', async () => {
  const { app, calls } = appFor({ template: 'throw', text: 'throw' });
  const r = await post(app, { titulo: 'x' });
  assert.equal(r.statusCode, 502);
  assert.deepEqual(calls.map((c) => c.kind), ['template', 'text']);
});

test('token ausente ou errado: 401, sem nenhum envio', async () => {
  for (const headers of [{}, { 'x-ops-notify-token': 'errado' }, { 'x-ops-notify-token': `${TOKEN}x` }]) {
    const { app, calls } = appFor({ template: OK('nao-deveria') });
    const r = await post(app, { titulo: 'x' }, headers as Record<string, string>);
    assert.equal(r.statusCode, 401, JSON.stringify(headers));
    assert.equal(calls.length, 0);
  }
});

test('PANEL_TOKEN/X-Agent-Token não abrem esta rota', async () => {
  const { app } = appFor({ template: OK('nao-deveria') });
  const r = await post(app, { titulo: 'x' }, { 'x-panel-token': TOKEN, 'x-agent-token': TOKEN });
  assert.equal(r.statusCode, 401);
});

test('sem OPS_NOTIFY_TOKEN: 503 antes do 401 (não há com o que autenticar)', async () => {
  const { app } = appFor({}, { token: undefined });
  const r = await post(app, { titulo: 'x' }, {});
  assert.equal(r.statusCode, 503);
  assert.match(r.json().error, /OPS_NOTIFY_TOKEN/);
});

test('config faltando depois da auth: 503 declarado, um motivo por vez', async () => {
  const casos: Array<[Partial<OpsNotifyDeps>, RegExp]> = [
    [{ to: undefined }, /OPS_NOTIFY_TO/],
    [{ cloudConfigured: false }, /access token/],
    [{ phoneNumberId: null }, /phone_number_id/],
  ];
  for (const [over, re] of casos) {
    const { app, calls } = appFor({ template: OK('nao-deveria') }, over);
    const r = await post(app, { titulo: 'x' });
    assert.equal(r.statusCode, 503, JSON.stringify(over));
    assert.match(r.json().error, re);
    assert.equal(calls.length, 0);
  }
});

test('titulo ausente ou em branco: 400, sem envio', async () => {
  for (const body of [{}, { titulo: '' }, { titulo: '   ' }, { titulo: 42 }, { detalhe: 'só detalhe' }]) {
    const { app, calls } = appFor({ template: OK('nao-deveria') });
    const r = await post(app, body);
    assert.equal(r.statusCode, 400, JSON.stringify(body));
    assert.equal(calls.length, 0);
  }
});

test('detalhe ausente ainda envia — o travessão preserva o parâmetro', async () => {
  const { app, calls } = appFor({ template: OK('wamid.3') });
  const r = await post(app, { titulo: 'PLATFORM_TOKEN_KEY inválida' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual((calls[0].arg as CloudTemplateMessage).bodyParams, ['PLATFORM_TOKEN_KEY inválida', '—']);
});

test('o chamador NÃO escolhe destino nem remetente', async () => {
  const { app, calls } = appFor({ template: OK('wamid.4') });
  const r = await post(app, { titulo: 'x', to: '5511999999999', phone_number_id: '999' });
  assert.equal(r.statusCode, 200);
  assert.equal(calls[0].to, TO);
  assert.equal(calls[0].pnid, PNID);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCloudDownSender } from '../../src/whatsapp/down-notify-sender.js';
import type { CloudSendResult, CloudTemplateMessage } from '../../src/webhook-cloud/send.js';
import { renderConnectionDownText } from '../../src/webhook-cloud/templates.js';

const target = {
  phone: '+553195950748',
  name: 'Monitor de grupos',
  downSince: new Date('2026-09-09T21:10:00.000Z'),
  token: 'tok123',
  link: 'https://painel.beeads.com.br/reconectar-whatsapp/tok123',
};

type Script = { template?: CloudSendResult | 'throw'; text?: CloudSendResult | 'throw' };

function wire(script: Script, templateName: string | undefined) {
  const calls: Array<{ kind: 'template' | 'text'; pnid: string; to: string; arg: unknown }> = [];
  const run = (r: CloudSendResult | 'throw' | undefined) => {
    if (r === 'throw') throw new Error('socket hang up');
    return r ?? { ok: false, send_id: null, status: 500 };
  };
  const send = makeCloudDownSender({
    phoneNumberId: '222',
    templateName,
    templateLang: 'pt_BR',
    sendTemplate: async (pnid: string, to: string, t: CloudTemplateMessage) => {
      calls.push({ kind: 'template', pnid, to, arg: t });
      return run(script.template);
    },
    sendText: async (pnid: string, to: string, text: string) => {
      calls.push({ kind: 'text', pnid, to, arg: text });
      return run(script.text);
    },
  });
  return { send, calls };
}

const OK = (id: string): CloudSendResult => ({ ok: true, send_id: id });
const HTTP = (status: number): CloudSendResult => ({ ok: false, send_id: null, status, detail: { error: { code: status } } });

test('template configurado e aceito: só o template sai', async () => {
  const { send, calls } = wire({ template: OK('w1') }, 'conexao_whatsapp_caiu');
  const r = await send(target);
  assert.deepEqual(r, { ok: true, sendId: 'w1', via: 'template' });
  assert.deepEqual(calls.map((c) => c.kind), ['template']);
});

test('template com a forma aprovada: nome, idioma e corpo com o token, sem botão', async () => {
  const { send, calls } = wire({ template: OK('w1') }, 'conexao_whatsapp_caiu');
  await send(target);
  assert.equal(calls[0].pnid, '222');
  assert.equal(calls[0].to, '+553195950748');
  assert.deepEqual(calls[0].arg, {
    name: 'conexao_whatsapp_caiu',
    language: 'pt_BR',
    bodyParams: ['Monitor de grupos (+553195950748)', '09/09 às 18:10', 'tok123'],
  });
});

test('template recusado cai no texto livre, que leva o link', async () => {
  const { send, calls } = wire({ template: HTTP(400), text: OK('w2') }, 'conexao_whatsapp_caiu');
  const r = await send(target);
  assert.deepEqual(r, { ok: true, sendId: 'w2', via: 'text' });
  assert.deepEqual(calls.map((c) => c.kind), ['template', 'text']);
  assert.match(String(calls[1].arg), /reconectar-whatsapp\/tok123/);
  // O texto livre é o corpo aprovado renderizado — encaminhar um ou outro dá no mesmo.
  assert.equal(calls[1].arg, renderConnectionDownText(target));
});

test('sem template configurado vai direto no texto', async () => {
  const { send, calls } = wire({ text: OK('w3') }, undefined);
  const r = await send(target);
  assert.deepEqual(r, { ok: true, sendId: 'w3', via: 'text' });
  assert.deepEqual(calls.map((c) => c.kind), ['text']);
});

test('falha transitória no template prevalece sobre 4xx do texto (retenta no próximo tick)', async () => {
  const { send } = wire({ template: 'throw', text: HTTP(400) }, 'conexao_whatsapp_caiu');
  const r = await send(target);
  assert.equal(r.ok, false);
  assert.equal(r.via, null);
  assert.equal((r as { networkError?: boolean }).networkError, true);
});

test('as duas vias com 4xx: falha definitiva com o status do texto', async () => {
  const { send } = wire({ template: HTTP(400), text: HTTP(400) }, 'conexao_whatsapp_caiu');
  const r = await send(target);
  assert.equal(r.ok, false);
  assert.equal((r as { status?: number }).status, 400);
  assert.equal((r as { networkError?: boolean }).networkError, undefined);
});

test('erro de rede no texto vira networkError, nunca exceção', async () => {
  const { send } = wire({ text: 'throw' }, undefined);
  const r = await send(target);
  assert.equal(r.ok, false);
  assert.equal((r as { networkError?: boolean }).networkError, true);
});

test('destinatário de teste recebe o conteúdo do alvo, sem trocar o número exibido', async () => {
  const { send, calls } = wire({ template: HTTP(400), text: OK('w9') }, 'conexao_whatsapp_caiu_v2');
  await send({ ...target, to: '+5531999594121' });
  assert.deepEqual(calls.map((c) => c.to), ['+5531999594121', '+5531999594121']);
  assert.deepEqual((calls[0].arg as { bodyParams: string[] }).bodyParams, [
    'Monitor de grupos (+553195950748)',
    '09/09 às 18:10',
    'tok123',
  ]);
  assert.match(String(calls[1].arg), /Monitor de grupos \(\+553195950748\)/);
});

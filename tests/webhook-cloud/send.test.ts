import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCloudTemplatePayload,
  cloudPhoneNumberIdForAgent,
  sendCloudTemplate,
  sendCloudText,
} from '../../src/webhook-cloud/send.js';

function mockFetch(handler: (url: string, init: any) => { status: number; body: any }) {
  return (async (url: string, init: any) => {
    const r = handler(url, init);
    return { ok: r.status < 400, status: r.status, json: async () => r.body } as any;
  }) as any;
}

const deps = (fetch: any) => ({ token: 'T', graphVersion: 'v22.0', fetch });

test('cloudPhoneNumberIdForAgent acha o phone_number_id do agente', () => {
  const map = { '111': { agent: 'mercurio', project: 'x' }, '222': { agent: 'saturno', project: '_' } };
  assert.equal(cloudPhoneNumberIdForAgent(map, 'saturno'), '222');
  assert.equal(cloudPhoneNumberIdForAgent(map, 'ninguem'), null);
  assert.equal(cloudPhoneNumberIdForAgent({}, 'saturno'), null);
});

test('payload de template: corpo com parâmetros e botão de URL dinâmico', () => {
  const p = buildCloudTemplatePayload('+553195950748', {
    name: 'conexao_whatsapp_caiu',
    language: 'pt_BR',
    bodyParams: ['Monitor (+553195950748)', '09/09 às 18:10'],
    urlButtonParam: 'tok123',
  });
  assert.equal(p.messaging_product, 'whatsapp');
  assert.equal(p.to, '553195950748');
  assert.equal(p.type, 'template');
  assert.equal(p.template.name, 'conexao_whatsapp_caiu');
  assert.deepEqual(p.template.language, { code: 'pt_BR' });
  assert.deepEqual(p.template.components[0], {
    type: 'body',
    parameters: [
      { type: 'text', text: 'Monitor (+553195950748)' },
      { type: 'text', text: '09/09 às 18:10' },
    ],
  });
  assert.deepEqual(p.template.components[1], {
    type: 'button',
    sub_type: 'url',
    index: '0',
    parameters: [{ type: 'text', text: 'tok123' }],
  });
});

test('payload de template sem botão não inclui o componente de botão', () => {
  const p = buildCloudTemplatePayload('5531', { name: 'n', language: 'pt_BR', bodyParams: ['a'] });
  assert.equal(p.template.components.length, 1);
});

test('sendCloudTemplate posta em /<pnid>/messages com Bearer e devolve send_id', async () => {
  let seen: any = null;
  const r = await sendCloudTemplate(
    '222',
    '+5531',
    { name: 'n', language: 'pt_BR', bodyParams: ['a'] },
    deps(mockFetch((url, init) => {
      seen = { url, init };
      return { status: 200, body: { messages: [{ id: 'wamid.1' }] } };
    })),
  );
  assert.deepEqual(r, { ok: true, send_id: 'wamid.1' });
  assert.equal(seen.url, 'https://graph.facebook.com/v22.0/222/messages');
  assert.equal(seen.init.headers.Authorization, 'Bearer T');
  assert.equal(JSON.parse(seen.init.body).type, 'template');
});

test('sendCloudTemplate devolve status e detalhe no erro HTTP', async () => {
  const r = await sendCloudTemplate(
    '222',
    '5531',
    { name: 'n', language: 'pt_BR', bodyParams: ['a'] },
    deps(mockFetch(() => ({ status: 400, body: { error: { code: 131047 } } }))),
  );
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.deepEqual(r.detail, { error: { code: 131047 } });
});

test('sem token não chama a rede', async () => {
  let called = false;
  const r = await sendCloudTemplate(
    '222',
    '5531',
    { name: 'n', language: 'pt_BR', bodyParams: [] },
    { token: undefined, graphVersion: 'v22.0', fetch: (async () => { called = true; }) as any },
  );
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test('sendCloudText aceita fetch injetado e mantém o payload de texto', async () => {
  let body: any = null;
  const r = await sendCloudText(
    '222',
    '+5531',
    'oi',
    deps(mockFetch((_u, init) => {
      body = JSON.parse(init.body);
      return { status: 200, body: { messages: [{ id: 'w2' }] } };
    })),
  );
  assert.deepEqual(r, { ok: true, send_id: 'w2' });
  assert.deepEqual(body, { messaging_product: 'whatsapp', to: '5531', type: 'text', text: { body: 'oi' } });
});

// tests/webhook/own-cloud-gate.db.test.ts
//
// SERVER-GATED (Postgres efêmero) — porta anti-CRM do /webhook: DM do nosso
// número Cloud (aviso de queda, cópia, sonda) sai ANTES do resolveIngest, sem
// tocar webhook_logs/messages/gatilho/IA, e chama o handler da sonda quando o
// texto traz o marcador com código. Cobre LID com e sem remoteJidAlt.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { pool } from '../../src/db.js';
import { registerWebhookRoutes, setOwnCloudProbeHandler } from '../../src/webhook/routes.js';

const SECRET = process.env.EVOLUTION_WEBHOOK_SECRET!;
const probeEvent = (withAlt: boolean) => ({
  event: 'messages.upsert',
  instance: 'inst-1',
  data: {
    key: {
      remoteJid: '216578842964141@lid', fromMe: false, id: 'C1B31D8C9D4FCE7090', addressingMode: 'lid',
      ...(withAlt ? { remoteJidAlt: '553190858510@s.whatsapp.net' } : {}),
    },
    message: { templateMessage: { templateId: '1896879847947648', hydratedTemplate: {
      templateId: '1896879847947648',
      hydratedContentText: 'Aviso do painel BeeAds: Teste de conexão do WhatsApp X (+551)\nDetalhe: Código P7K3. Não é preciso responder.\nMensagem automática da BeeAds.',
    } } },
  },
});

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query('TRUNCATE webhook_logs RESTART IDENTITY CASCADE');
  await pool.query(
    `INSERT INTO whatsapp_numbers (workspace_id, evolution_instance, phone, status) VALUES ('ws-1','inst-1','+5531000','connected')`,
  );
});
after(() => pool.end());

for (const withAlt of [true, false]) {
  test(`DM do nosso Cloud (alt=${withAlt}) não entra em webhook_logs nem messages e chama o handler`, async () => {
    const seen: string[] = [];
    setOwnCloudProbeHandler(async (instance, code) => { seen.push(`${instance}:${code}`); });
    const app = Fastify({ logger: false });
    await registerWebhookRoutes(app);
    const r = await app.inject({ method: 'POST', url: '/webhook', headers: { 'x-evolution-secret': SECRET }, payload: probeEvent(withAlt) });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().ignored, true);
    assert.equal(r.json().reason, 'own_cloud');
    assert.deepEqual(seen, ['inst-1:P7K3']);
    const logs = await pool.query(`SELECT count(*)::int AS n FROM webhook_logs`);
    const msgs = await pool.query(`SELECT count(*)::int AS n FROM messages`);
    assert.equal(logs.rows[0].n, 0);
    assert.equal(msgs.rows[0].n, 0);
    setOwnCloudProbeHandler(null);
  });
}

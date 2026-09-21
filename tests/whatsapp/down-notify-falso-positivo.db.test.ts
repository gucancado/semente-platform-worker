// tests/whatsapp/down-notify-falso-positivo.db.test.ts
//
// Regressão dos FALSOS POSITIVOS do vigia de sistema, medidos em prod entre 15/09 e
// 21/09/2026: a instância `saturno` (monitor de grupos de equipe) nunca caiu e
// mesmo assim recebeu 11 avisos e ganhou 8 episódios em `instance_outages`.
//
// Aqui o caminho é o REAL de ponta a ponta — client da Evolution (com fetch falso
// servindo um store em memória) → sonda → decisão → banco. Só o envio é falso, e
// ele faz o que a Cloud API faz de verdade: entrega o aviso NO STORE DO ALVO.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { runSystemInstanceWatch, type DownNotifyDeps } from '../../src/whatsapp/down-notify-service.js';
import { makeEvolutionProbe } from '../../src/whatsapp/down-notify-probe.js';
import { renderConnectionDownText } from '../../src/webhook-cloud/templates.js';
import type { DownNotifyTarget, DownSendResult } from '../../src/whatsapp/down-notify-sender.js';
import type { SystemTarget } from '../../src/whatsapp/down-notify-store.js';

const H = 3_600_000;
const TICK = 5 * 60_000; // intervalo do vigia de sistema em prod
const brt = (s: string) => new Date(`${s}-03:00`);
const secs = (d: Date) => Math.floor(d.getTime() / 1000);

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_provision_links');
  await pool.query('TRUNCATE system_instance_health, instance_outages RESTART IDENTITY');
});
after(() => pool.end());

const saturno: SystemTarget = { instance: 'saturno', expectedPhone: '+553195950748', label: 'Monitor de grupos' };

type Rec = { key: { remoteJid: string; fromMe: boolean; id: string }; message: unknown; messageTimestamp: number };
const groupMsg = (at: Date): Rec => ({
  key: { remoteJid: '120363424016852722@g.us', fromMe: false, id: `g-${secs(at)}` },
  message: { conversation: 'bom dia, pessoal' },
  messageTimestamp: secs(at),
});
const leadDm = (at: Date): Rec => ({
  key: { remoteJid: '5531977776666@s.whatsapp.net', fromMe: false, id: `d-${secs(at)}` },
  message: { conversation: 'oi, quanto custa?' },
  messageTimestamp: secs(at),
});

/** Evolution falsa: store por instância + estado por instância (mutáveis entre ticks). */
function world(init: { stores: Record<string, Rec[]>; states?: Record<string, string>; target?: SystemTarget }) {
  const stores = init.stores;
  const states = init.states ?? {};
  const target = init.target ?? saturno;
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as any;
  const fetch = (async (url: string, reqInit: any) => {
    const find = /\/chat\/findMessages\/([^/?]+)$/.exec(url);
    if (find) {
      const { offset } = JSON.parse(reqInit.body);
      const records = [...(stores[find[1]] ?? [])].sort((a, b) => b.messageTimestamp - a.messageTimestamp).slice(0, offset);
      return ok({ messages: { records, total: records.length, pages: 1 } });
    }
    const st = /\/instance\/connectionState\/([^/?]+)$/.exec(url);
    if (st) return ok({ instance: { state: states[st[1]] ?? 'open' } });
    throw new Error(`chamada inesperada à Evolution: ${url}`);
  }) as any;

  const sent: DownNotifyTarget[] = [];
  let deliverAt: Date | null = null;
  const deps: DownNotifyDeps = {
    pool,
    // A Cloud API ENTREGA o aviso ao próprio número vigiado: ele cai no store do alvo.
    send: async (t): Promise<DownSendResult> => {
      sent.push(t);
      stores[saturno.instance] = [
        ...(stores[saturno.instance] ?? []),
        {
          key: { remoteJid: '553190858510@s.whatsapp.net', fromMe: false, id: `wamid-${sent.length}` },
          message: { conversation: renderConnectionDownText({ name: t.name, phone: t.phone, downSince: t.downSince, token: t.token }) },
          messageTimestamp: secs(deliverAt ?? new Date()),
        },
      ];
      return { ok: true, sendId: 'wamid', via: 'template' };
    },
    now: () => new Date(),
    panelBaseUrl: 'https://painel.beeads.com.br',
    cadence: { debounceMs: 5 * 60_000, renotifyMs: 12 * H, maxNotifies: 6 },
    link: { maxClicks: 10, ttlDays: 7 },
    log: { info() {}, warn() {}, error() {} },
  };
  const watch = { ...deps, probe: makeEvolutionProbe({ baseUrl: 'http://evo', apiKey: 'k', fetch }, async () => ['ws-peer']), staleMs: 6 * H, intervalMs: TICK };
  return {
    sent,
    stores,
    states,
    deliverAt: (d: Date) => { deliverAt = d; },
    tick: () => runSystemInstanceWatch(watch, [target]),
    /** Um intervalo do vigia se passa: recua o `checked_at`, o relógio da suspeita. */
    elapse: () => pool.query(`UPDATE system_instance_health SET checked_at = NOW() - INTERVAL '5 minutes'`),
  };
}

const health = async () =>
  (await pool.query(`SELECT last_state, last_reason, down_since, down_notify_count FROM system_instance_health`)).rows[0];
const outages = async () => (await pool.query(`SELECT * FROM instance_outages ORDER BY id`)).rows;
const links = async () => Number((await pool.query(`SELECT count(*)::int c FROM whatsapp_provision_links`)).rows[0].c);

test('[defeito 1] madrugada de segunda (21/09 06:24): alvo só-de-grupos mudo desde domingo NÃO vira episódio nem aviso', async () => {
  const w = world({
    stores: {
      saturno: [groupMsg(brt('2026-09-20T20:06:00'))], // domingo à noite
      'ws-peer': [leadDm(brt('2026-09-21T06:20:00'))], // número de atendimento recebe lead de madrugada
    },
  });
  for (let i = 0; i < 3; i++) assert.deepEqual(await w.tick(), []);

  const h = await health();
  assert.equal(h.last_reason, null);
  assert.equal(h.down_since, null);
  assert.equal((await outages()).length, 0);
  assert.equal(w.sent.length, 0);
  assert.equal(await links(), 0);
});

test('[defeito 1] alvo marcado como tráfego contínuo mantém a regra antiga, pelo relógio de parede', async () => {
  const w = world({
    stores: { saturno: [groupMsg(brt('2026-09-20T20:06:00'))], 'ws-peer': [leadDm(brt('2026-09-21T06:20:00'))] },
    target: { ...saturno, traffic: 'always' },
  });
  await w.tick();
  await w.elapse();
  await w.tick();
  assert.equal((await health()).last_reason, 'store_stale');
  assert.equal((await outages()).length, 1);
});

test('[defeito 2] o aviso entregue ao próprio número NÃO fecha o episódio, NÃO zera a contagem e NÃO data o seguinte', async () => {
  // Zumbi de verdade, em dia útil: terça 15/09, parou de receber às 10:00; o par seguiu até 16:30.
  const lastReal = brt('2026-09-15T10:00:00');
  const w = world({ stores: { saturno: [groupMsg(lastReal)], 'ws-peer': [leadDm(brt('2026-09-15T16:30:00'))] } });
  w.deliverAt(brt('2026-09-15T16:36:00'));

  assert.deepEqual(await w.tick(), []); //                       1º tick: só suspeita
  await w.elapse();
  assert.deepEqual((await w.tick()).map((a) => a.outcome), ['sent']); // 2º tick: confirma, abre e avisa
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].downSince.getTime(), lastReal.getTime());
  // o aviso está mesmo no store do alvo, como a mensagem MAIS RECENTE dele
  assert.equal(w.stores.saturno.length, 2);

  // 3º tick: era aqui que o episódio se "curava" sozinho (os 8 episódios falsos fecharam em 5min)
  assert.deepEqual(await w.tick(), []);
  let h = await health();
  assert.equal(h.last_reason, 'store_stale');
  assert.equal((h.down_since as Date).getTime(), lastReal.getTime());
  assert.equal(h.down_notify_count, 1);
  let rows = await outages();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ended_at, null);
  assert.equal((rows[0].started_at as Date).getTime(), lastReal.getTime());
  assert.equal(w.sent.length, 1); // re-aviso só em 12h — a contagem segue valendo

  // Tráfego DE VERDADE ainda cura: chega mensagem de grupo e o episódio fecha.
  w.stores.saturno.push(groupMsg(brt('2026-09-15T16:50:00')));
  assert.deepEqual(await w.tick(), []);
  h = await health();
  assert.equal(h.down_since, null);
  assert.equal(h.down_notify_count, 0);
  rows = await outages();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].ended_at, null);
});

test('[defeito 2] queda seguinte começa na última mensagem REAL, não no horário do aviso anterior (episódios 77 e 78)', async () => {
  // Store como ficou em prod: o aviso de 19/09 17:09:39 é a mensagem mais recente do alvo.
  const lastReal = brt('2026-09-18T17:58:00');
  const w = world({
    stores: {
      saturno: [
        groupMsg(lastReal),
        {
          key: { remoteJid: '553190858510@s.whatsapp.net', fromMe: false, id: 'wamid-antigo' },
          message: { conversation: renderConnectionDownText({ name: 'Monitor de grupos', phone: '+553195950748', downSince: brt('2026-09-19T12:03:00'), token: 'tok' }) },
          messageTimestamp: secs(brt('2026-09-19T17:09:39')),
        },
      ],
      'ws-peer': [leadDm(brt('2026-09-21T11:00:00'))],
    },
    states: { saturno: 'close' },
  });
  await w.tick();
  await w.elapse();
  await w.tick();
  const rows = await outages();
  assert.equal(rows.length, 1);
  assert.equal((rows[0].started_at as Date).getTime(), lastReal.getTime());
  assert.equal(rows[0].started_at_source, 'observed_store');
});

test('[defeito 3] flap connecting→open de 1s (17/09 18:39:35): um tick fora NÃO abre episódio, NÃO emite link, NÃO avisa', async () => {
  // A última mensagem do store já tem mais de 5min — era isso que fazia o debounce "passar" na hora.
  const w = world({
    stores: { saturno: [groupMsg(brt('2026-09-17T18:20:00'))], 'ws-peer': [leadDm(brt('2026-09-17T18:39:00'))] },
    states: { saturno: 'connecting' },
  });
  assert.deepEqual(await w.tick(), []);
  let h = await health();
  assert.equal(h.last_state, 'connecting');
  assert.equal(h.last_reason, 'state'); // a suspeita fica registrada…
  assert.equal(h.down_since, null); //     …mas não é episódio
  assert.equal((await outages()).length, 0);
  assert.equal(await links(), 0);
  assert.equal(w.sent.length, 0);

  w.states.saturno = 'open'; // 1s depois já tinha voltado; o tick seguinte vem um intervalo depois
  await w.elapse();
  assert.deepEqual(await w.tick(), []);
  h = await health();
  assert.equal(h.last_reason, null);
  assert.equal(h.down_since, null);
  assert.equal((await outages()).length, 0);
  assert.equal(w.sent.length, 0);

  // Outro flap no dia seguinte (o de ~15:1x é quase diário): continua sem abrir nada.
  w.states.saturno = 'connecting';
  await w.elapse();
  await w.tick();
  w.states.saturno = 'open';
  await w.elapse();
  await w.tick();
  assert.equal((await outages()).length, 0);
  assert.equal(w.sent.length, 0);
});

test('[defeito 3] o flap de 1s não volta pela porta dos fundos: tick + boot do 2º container + dry-run no MESMO segundo são UMA observação', async () => {
  const w = world({
    stores: { saturno: [groupMsg(brt('2026-09-17T18:20:00'))], 'ws-peer': [leadDm(brt('2026-09-17T18:39:00'))] },
    states: { saturno: 'connecting' },
  });
  // três gravações dentro do mesmo flap — concorrentes, como num rolling deploy
  const attempts = await Promise.all([w.tick(), w.tick(), w.tick()]);
  assert.deepEqual(attempts, [[], [], []]);
  assert.equal((await health()).down_since, null);
  assert.equal((await outages()).length, 0);
  assert.equal(await links(), 0);
  assert.equal(w.sent.length, 0);

  w.states.saturno = 'open'; // o tick seguinte, um intervalo depois, já vê a instância de volta
  await w.elapse();
  assert.deepEqual(await w.tick(), []);
  assert.equal((await health()).last_reason, null);
  assert.equal((await outages()).length, 0);
  assert.equal(w.sent.length, 0);
});

test('[defeito 3] queda de verdade: dois ticks consecutivos fora abrem UM episódio e avisam', async () => {
  const lastReal = brt('2026-09-17T18:20:00');
  const w = world({
    stores: { saturno: [groupMsg(lastReal)], 'ws-peer': [leadDm(brt('2026-09-17T18:39:00'))] },
    states: { saturno: 'close' },
  });
  assert.deepEqual(await w.tick(), []);
  await w.elapse();
  assert.deepEqual((await w.tick()).map((a) => a.outcome), ['sent']);
  await w.tick();
  const rows = await outages();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'state');
  assert.equal(rows[0].ended_at, null);
  assert.equal(w.sent.length, 1);
  assert.equal(await links(), 1);
});

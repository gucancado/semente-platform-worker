// tests/whatsapp/connection-probe-service.db.test.ts
// Task 9: orquestração por tick da sonda de conexão (vereditos → reconciliação →
// gatilhos → envio) e o recebimento pelo webhook. Evolution, envio Cloud e aviso
// operacional são FALSOS e gravam as chamadas; o banco é o real (worker_test_sonda).
// Ver spec 2026-09-25-sonda-conexao-whatsapp-design.md §4–§8, §12.
//
// Idades de sonda são medidas pelo NOW() do BANCO — para simular "6 minutos
// depois" o teste recua `sent_at`/`created_at` no banco, nunca o `now` falso.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { upsertConnectedNumber } from '../../src/whatsapp/numbers.js';
import { listDownNumbers, type SystemTarget } from '../../src/whatsapp/down-notify-store.js';
import {
  createProbe,
  markProbeSent,
  recordCloudStatuses,
  setVerdict,
} from '../../src/whatsapp/connection-probe-store.js';
import {
  handleProbeReceipt,
  listProbeTargets,
  newProbeMemo,
  runProbeTick,
  type ProbeDeps,
  type ProbeTarget,
} from '../../src/whatsapp/connection-probe-service.js';
import type { MessageKey } from '../../src/evolution/client.js';

const H = 3_600_000;
const sp = (s: string) => new Date(`${s}-03:00`);
// Quarta 23/09/2026, 12:00 de São Paulo (15:00Z) — dentro da janela 08–20h.
const NOON = sp('2026-09-23T12:00:00');
const NIGHT = sp('2026-09-23T22:00:00');
const RECENT = sp('2026-09-23T11:59:00');
// Terça 12:00 → quarta 11:59 = 6h + 2h59 de EXPEDIENTE atrás do par: store_stale.
const STALE = sp('2026-09-22T12:00:00');
// Terça 23:00: só 2h59 de expediente atrás do par (não é store_stale), 13h de relógio: quiet.
const QUIET = sp('2026-09-22T23:00:00');

const MIRROR = '553196039118';

beforeEach(async () => {
  await pool.query(
    'TRUNCATE connection_probes, whatsapp_numbers, instance_outages, system_instance_health RESTART IDENTITY CASCADE',
  );
});
after(() => pool.end());

type World = {
  state: Record<string, 'open' | 'connecting' | 'close' | '404'>;
  store: Record<string, Date | null>;
  owner: Record<string, string | null>;
  storeSeen: Record<string, boolean>;
  /** Instâncias cujo findMessages responde 404 (sumiram da Evolution). */
  gone?: Set<string>;
  /** Chamado dentro de latestStoreTs (simula corrida com o webhook). */
  onStore?: (i: string) => Promise<void>;
};

function harness(w: World, opts: { now?: Date } = {}) {
  const calls = {
    sendProbe: [] as { to: string; titulo: string; detalhe: string }[],
    sendOps: [] as { titulo: string; detalhe: string }[],
    markRead: [] as { i: string; key: MessageKey }[],
    archive: [] as { i: string; key: MessageKey }[],
    findProbe: [] as { i: string; code: string; sinceSec: number }[],
    updateNumberStatus: [] as { i: string; s: string }[],
    errors: [] as unknown[],
  };
  let wamidSeq = 0;
  const memo = newProbeMemo();
  const deps: ProbeDeps = {
    pool,
    log: { info() {}, warn() {}, error: (...a: unknown[]) => calls.errors.push(a) },
    now: () => opts.now ?? NOON,
    rand: Math.random,
    evolution: {
      connectionState: async (i) => {
        const s = w.state[i];
        if (!s || s === '404') throw new Error(`Evolution GET /instance/connectionState/${i} → 404`);
        return s;
      },
      latestStoreTs: async (i) => {
        if (w.onStore) await w.onStore(i);
        return w.store[i] ?? null;
      },
      owner: async (i) => w.owner[i] ?? null,
      findProbe: async (i, code, sinceSec) => {
        calls.findProbe.push({ i, code, sinceSec });
        if (w.gone?.has(i)) throw new Error(`Evolution POST /chat/findMessages/${i} → 404`);
        return w.storeSeen[i] ?? false;
      },
      markRead: async (i, key) => {
        calls.markRead.push({ i, key });
      },
      archive: async (i, key) => {
        calls.archive.push({ i, key });
      },
    },
    sendProbe: async (to, titulo, detalhe) => {
      calls.sendProbe.push({ to, titulo, detalhe });
      return { ok: true, wamid: `wamid.${++wamidSeq}.${Math.random().toString(36).slice(2, 8)}` };
    },
    sendOps: async (titulo, detalhe) => {
      calls.sendOps.push({ titulo, detalhe });
    },
    mirrorTo: MIRROR,
    resolveName: async (t) => t.label,
    staleMs: 6 * H,
    offDates: new Set(),
    updateNumberStatus: async (i, s) => {
      calls.updateNumberStatus.push({ i, s });
    },
    memo,
  };
  return { deps, calls };
}

const seed = (instance: string, phone: string) =>
  upsertConnectedNumber(pool, { workspaceId: 'ws-1', evolutionInstance: instance, phone, createdBy: null });

const probes = async () =>
  (await pool.query(`SELECT * FROM connection_probes ORDER BY id`)).rows as any[];

/** "6 minutos depois", pelo relógio do banco. */
const age = (min: number) =>
  pool.query(
    `UPDATE connection_probes SET sent_at = sent_at - make_interval(mins => $1), created_at = created_at - make_interval(mins => $1)`,
    [min],
  );

const delivered = async (wamid: string) => recordCloudStatuses(pool, [{ id: wamid, status: 'delivered', errors: [] }]);

const keyOf = (id: string): MessageKey => ({ id, remoteJid: '123@lid', fromMe: false });

/** Zumbi (store 9h de expediente atrás) + par saudável. */
async function zombieWorld() {
  await seed('i-zumbi', '+5531911110000');
  await seed('i-par', '+5531922220000');
  const w: World = {
    state: { 'i-zumbi': 'open', 'i-par': 'open' },
    store: { 'i-zumbi': STALE, 'i-par': RECENT },
    owner: { 'i-zumbi': '5531911110000', 'i-par': '5531922220000' },
    storeSeen: {},
  };
  const targets = await listProbeTargets(pool, []);
  return { w, targets };
}

async function driveToDown(h: ReturnType<typeof harness>, targets: ProbeTarget[]) {
  const t1 = await runProbeTick(h.deps, targets);
  assert.equal(t1.sent, 1);
  let rows = await probes();
  assert.equal(rows.length, 1);
  await age(6);
  await delivered(rows[0].wamid);
  await runProbeTick(h.deps, targets);
  rows = await probes();
  assert.equal(rows.length, 2);
  await age(6);
  await delivered(rows[1].wamid);
  const t3 = await runProbeTick(h.deps, targets);
  assert.equal(t3.verdicts.down, 1);
  return await probes();
}

test('listProbeTargets: sistema + números com telefone, sem removidos e sem telefone', async () => {
  await seed('i-a', '+5531900000001');
  const b = await seed('i-b', '+5531900000002');
  await seed('i-sem-tel', undefined);
  await pool.query(`UPDATE whatsapp_numbers SET removed_at = NOW() WHERE id = $1`, [b.id]);
  const sys: SystemTarget = { instance: 'saturno', expectedPhone: '+553195950748', label: 'Monitor' };
  const t = await listProbeTargets(pool, [sys]);
  assert.deepEqual(
    t.map((x) => [x.instance, x.kind]),
    [
      ['saturno', 'system'],
      ['i-a', 'number'],
    ],
  );
  assert.equal(t[0].systemTarget, sys);
  assert.equal(t[0].numberId, null);
  assert.equal(t[1].status, 'connected');
  assert.equal(t[1].workspaceId, 'ws-1');
});

test('zumbi: 1ª sonda + espelho → repeated → 2ª (parent_id) → down abre episódio probe e entra em listDownNumbers', async () => {
  const { w, targets } = await zombieWorld();
  const h = harness(w);

  const t1 = await runProbeTick(h.deps, targets);
  assert.equal(t1.sent, 1);
  assert.equal(h.calls.sendProbe.length, 2, 'sonda + espelho');
  assert.equal(h.calls.sendProbe[0].to, '+5531911110000');
  assert.equal(h.calls.sendProbe[1].to, MIRROR);
  assert.deepEqual(h.calls.sendProbe[0].titulo, h.calls.sendProbe[1].titulo);
  let rows = await probes();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trigger, 'store_stale');
  assert.equal(rows[0].verdict, null);
  assert.ok(rows[0].wamid);
  assert.ok(rows[0].mirror_wamid);
  assert.match(h.calls.sendProbe[0].detalhe, new RegExp(`Código ${rows[0].code}\\.`));

  // 6 min depois, entregue e fora do store → repeated e 2ª sonda
  await age(6);
  await delivered(rows[0].wamid);
  await runProbeTick(h.deps, targets);
  rows = await probes();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].verdict, 'repeated');
  assert.equal(Number(rows[1].parent_id), Number(rows[0].id));
  assert.equal(rows[1].trigger, 'store_stale');
  assert.notEqual(rows[1].code, rows[0].code);
  assert.equal(h.calls.sendProbe.length, 4);
  // sinceSec = floor(sent_at/1000) − 120 (margem de relógio)
  const f = h.calls.findProbe[0];
  const sentSec = Math.floor(new Date(rows[0].sent_at).getTime() / 1000);
  assert.equal(f.sinceSec, sentSec - 120);

  // mais 6 min, entregue de novo → down
  await age(6);
  await delivered(rows[1].wamid);
  const t3 = await runProbeTick(h.deps, targets);
  assert.equal(t3.verdicts.down, 1);
  rows = await probes();
  assert.equal(rows[1].verdict, 'down');
  const { rows: out } = await pool.query(`SELECT * FROM instance_outages WHERE instance = 'i-zumbi'`);
  assert.equal(out.length, 1);
  assert.equal(out[0].started_at_source, 'probe');
  assert.equal(out[0].ended_at, null);
  assert.equal(out[0].reason, 'store_stale');
  assert.equal(new Date(out[0].started_at).getTime(), STALE.getTime(), 'início = última msg real do store');
  const down = await listDownNumbers(pool);
  assert.deepEqual(down.map((d) => d.instance), ['i-zumbi']);
  // nenhuma sonda nova com episódio aberto; nenhum aviso operacional
  assert.equal(h.calls.sendProbe.length, 4);
  assert.equal(h.calls.sendOps.length, 0);
  assert.equal(h.calls.errors.length, 0);
});

test('recebimento pelo webhook antes do tick → alive, lida e arquivada, sem episódio', async () => {
  const { w, targets } = await zombieWorld();
  const h = harness(w);
  await runProbeTick(h.deps, targets);
  const [p] = await probes();

  await handleProbeReceipt(h.deps, 'i-zumbi', p.code, keyOf('MSG1'));
  assert.equal(h.calls.markRead.length, 1);
  assert.equal(h.calls.archive.length, 1);
  assert.equal(h.calls.markRead[0].key.id, 'MSG1');

  await age(6);
  const t = await runProbeTick(h.deps, targets);
  assert.equal(t.verdicts.alive, 1);
  const [row] = await probes();
  assert.equal(row.verdict, 'alive');
  assert.equal(h.calls.findProbe.length, 0, 'recebida não varre o store');
  const { rows: out } = await pool.query(`SELECT * FROM instance_outages`);
  assert.equal(out.length, 0);
  assert.ok(h.calls.markRead.length >= 1 && h.calls.archive.length >= 1);
  // alive dá cooldown de 24h: nenhuma sonda nova
  assert.equal(h.calls.sendProbe.length, 2);
});

test('Review Focus 2: recebimento TARDIO depois do down fecha o episódio e zera a contagem de aviso', async () => {
  const { w, targets } = await zombieWorld();
  const h = harness(w);
  const rows = await driveToDown(h, targets);
  await pool.query(
    `UPDATE whatsapp_numbers SET down_notified_at = NOW(), down_notify_count = 2 WHERE evolution_instance = 'i-zumbi'`,
  );

  await handleProbeReceipt(h.deps, 'i-zumbi', rows[1].code, keyOf('LATE'));

  const { rows: out } = await pool.query(`SELECT ended_at FROM instance_outages WHERE instance = 'i-zumbi'`);
  assert.equal(out.length, 1);
  assert.notEqual(out[0].ended_at, null);
  const { rows: n } = await pool.query(
    `SELECT down_notified_at, down_notify_count FROM whatsapp_numbers WHERE evolution_instance = 'i-zumbi'`,
  );
  assert.equal(n[0].down_notify_count, 0);
  assert.equal(n[0].down_notified_at, null);
  assert.deepEqual(await listDownNumbers(pool), []);
  const [, child] = await probes();
  assert.ok(child.received_at);
  assert.equal(child.verdict, 'down', 'veredito gravado não é reescrito');
});

test('recebimento tardio da 1ª (repeated) dá alive à 2ª ainda aberta — sem down falso', async () => {
  const { w, targets } = await zombieWorld();
  const h = harness(w);
  await runProbeTick(h.deps, targets);
  let rows = await probes();
  await age(6);
  await delivered(rows[0].wamid);
  await runProbeTick(h.deps, targets);
  rows = await probes();
  assert.equal(rows[0].verdict, 'repeated');

  await handleProbeReceipt(h.deps, 'i-zumbi', rows[0].code, keyOf('LATE1'));
  rows = await probes();
  assert.equal(rows[1].verdict, 'alive');
});

test('Review Focus 3: dono da instância diverge do telefone → não sonda, grava identity_mismatch e avisa operador', async () => {
  const { w, targets } = await zombieWorld();
  w.owner['i-zumbi'] = '5531988887777';
  const h = harness(w);
  await runProbeTick(h.deps, targets);
  assert.equal(h.calls.sendProbe.length, 0);
  const rows = await probes();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, 'identity_mismatch');
  assert.equal(rows[0].sent_at, null);
  assert.equal(h.calls.sendOps.length, 1);
  assert.match(h.calls.sendOps[0].detalhe, /5531988887777/);

  // cooldown de 24h: tick seguinte não repete o aviso nem grava outra linha
  await runProbeTick(h.deps, targets);
  assert.equal((await probes()).length, 1);
  assert.equal(h.calls.sendOps.length, 1);
});

test('Review Focus 5: dois ticks concorrentes criam e enviam exatamente UMA sonda', async () => {
  const { w, targets } = await zombieWorld();
  const a = harness(w);
  const b = harness(w);
  await Promise.all([runProbeTick(a.deps, targets), runProbeTick(b.deps, targets)]);
  const rows = await probes();
  assert.equal(rows.length, 1);
  const toTarget = [...a.calls.sendProbe, ...b.calls.sendProbe].filter((c) => c.to === '+5531911110000');
  assert.equal(toTarget.length, 1);
  assert.equal(a.calls.errors.length + b.calls.errors.length, 0);
});

test('fora da janela (22:00 SP): nenhuma sonda nova, mas a sonda aberta tem veredito avaliado', async () => {
  const { w, targets } = await zombieWorld();
  const zumbi = targets.find((t) => t.instance === 'i-zumbi')!;
  const p = await createProbe(pool, {
    instance: 'i-zumbi', kind: 'number', numberId: zumbi.numberId, phone: zumbi.phone, label: null,
    trigger: 'store_stale', code: 'ABCD',
  });
  await markProbeSent(pool, p!.id, { wamid: 'wamid.night', mirrorWamid: null, sendError: null });
  await delivered('wamid.night');
  await age(6);

  const h = harness(w, { now: NIGHT });
  const t = await runProbeTick(h.deps, targets);
  assert.equal(t.sent, 0);
  assert.equal(h.calls.sendProbe.length, 0);
  const rows = await probes();
  assert.equal(rows.length, 1, 'a 2ª do par não sai fora da janela');
  assert.equal(rows[0].verdict, 'repeated');
});

test('reconciliação: estado close com status connected → updateNumberStatus(disconnected); 404 é ignorado', async () => {
  await seed('i-caiu', '+5531933330000');
  await seed('i-sumiu', '+5531944440000');
  const w: World = {
    state: { 'i-caiu': 'close', 'i-sumiu': '404' },
    store: {},
    owner: {},
    storeSeen: {},
  };
  const targets = await listProbeTargets(pool, []);
  const h = harness(w);
  await runProbeTick(h.deps, targets);
  assert.deepEqual(h.calls.updateNumberStatus, [{ i: 'i-caiu', s: 'disconnected' }]);
  assert.equal(h.calls.sendProbe.length, 0);
  assert.equal(h.calls.errors.length, 0);
});

test('silêncio geral: 4 de 6 alvos quiet → nenhuma sonda quiet; aviso operacional só a partir das 12h de SP e 1 por 24h', async () => {
  // Terça 20:00: 13h de relógio antes de quarta 09:00, zero expediente até o par das 08:59.
  const QUIET_EARLY = sp('2026-09-22T20:00:00');
  const w: World = { state: {}, store: {}, owner: {}, storeSeen: {} };
  for (let i = 1; i <= 6; i++) {
    const inst = `i-${i}`;
    const phone = `+55319000000${i}0`;
    await seed(inst, phone);
    w.state[inst] = 'open';
    w.store[inst] = i <= 4 ? QUIET_EARLY : sp('2026-09-23T08:59:00');
    w.owner[inst] = phone.slice(1);
  }
  const targets = await listProbeTargets(pool, []);
  const clock: { now?: Date } = { now: sp('2026-09-23T09:00:00') };
  const h = harness(w, clock);

  // 09:00: silêncio geral detectado, quiet suspensas, mas SEM aviso (é só a noite).
  await runProbeTick(h.deps, targets);
  assert.equal(h.calls.sendProbe.length, 0);
  assert.equal((await probes()).length, 0);
  assert.equal(h.calls.sendOps.length, 0, 'antes das 12h não avisa');

  // 12:00: continua silêncio geral → 1 aviso.
  clock.now = NOON;
  for (let i = 5; i <= 6; i++) w.store[`i-${i}`] = RECENT;
  await runProbeTick(h.deps, targets);
  assert.equal(h.calls.sendProbe.length, 0);
  assert.equal((await probes()).length, 0);
  assert.equal(h.calls.sendOps.length, 1);
  assert.match(h.calls.sendOps[0].titulo, /Silêncio geral/);

  await runProbeTick(h.deps, targets);
  assert.equal(h.calls.sendOps.length, 1, 'no máximo 1 por 24h');
});

test('saturno: down da 2ª sonda abre o episódio de sistema com down_source=probe', async () => {
  const sys: SystemTarget = { instance: 'saturno', expectedPhone: '+553195950748', label: 'Monitor' };
  const targets = await listProbeTargets(pool, [sys]);
  const w: World = { state: { saturno: 'open' }, store: { saturno: STALE }, owner: { saturno: '553195950748' }, storeSeen: {} };
  const parent = await createProbe(pool, {
    instance: 'saturno', kind: 'system', numberId: null, phone: sys.expectedPhone, label: sys.label,
    trigger: 'store_stale', code: 'PPPP',
  });
  await markProbeSent(pool, parent!.id, { wamid: 'wamid.p', mirrorWamid: null, sendError: null });
  assert.equal(await setVerdict(pool, parent!.id, 'repeated'), 'set');
  const child = await createProbe(pool, {
    instance: 'saturno', kind: 'system', numberId: null, phone: sys.expectedPhone, label: sys.label,
    trigger: 'store_stale', code: 'QQQQ', parentId: parent!.id,
  });
  await markProbeSent(pool, child!.id, { wamid: 'wamid.c', mirrorWamid: null, sendError: null });
  await delivered('wamid.c');
  await age(6);

  const h = harness(w);
  const t = await runProbeTick(h.deps, targets);
  assert.equal(t.verdicts.down, 1);
  const { rows: hh } = await pool.query(`SELECT down_since, down_source FROM system_instance_health WHERE instance = 'saturno'`);
  assert.equal(hh[0].down_source, 'probe');
  assert.notEqual(hh[0].down_since, null);
  const { rows: out } = await pool.query(`SELECT kind, started_at_source FROM instance_outages WHERE instance = 'saturno' AND ended_at IS NULL`);
  assert.deepEqual(out, [{ kind: 'system', started_at_source: 'probe' }]);
});

test('corrida: recebimento durante a abertura do down não deixa episódio aberto', async () => {
  const { w, targets } = await zombieWorld();
  const h = harness(w);
  await runProbeTick(h.deps, targets);
  let rows = await probes();
  await age(6);
  await delivered(rows[0].wamid);
  await runProbeTick(h.deps, targets);
  rows = await probes();
  assert.equal(rows.length, 2);
  await age(6);
  await delivered(rows[1].wamid);

  // O webhook entrega a 2ª sonda enquanto o tick lê o store para abrir a queda.
  const childCode = rows[1].code;
  w.onStore = async (i) => {
    if (i !== 'i-zumbi') return;
    w.onStore = undefined;
    await handleProbeReceipt(h.deps, 'i-zumbi', childCode, keyOf('RACE'));
  };
  await runProbeTick(h.deps, targets);
  const { rows: out } = await pool.query(`SELECT ended_at FROM instance_outages WHERE instance = 'i-zumbi'`);
  assert.ok(out.every((o) => o.ended_at != null), 'nenhum episódio aberto');
  assert.deepEqual(await listDownNumbers(pool), []);
});

test('down contrariado: tráfego real no store DEPOIS do 1º envio → veredito down sem episódio', async () => {
  const { w, targets } = await zombieWorld();
  const h = harness(w);
  await runProbeTick(h.deps, targets);
  let rows = await probes();
  await age(6);
  await delivered(rows[0].wamid);
  await runProbeTick(h.deps, targets);
  rows = await probes();
  await age(6);
  await delivered(rows[1].wamid);
  // Relógio local ~40s atrás do banco; a 1ª saiu há ~12 min pelo banco: Date.now() é depois dela.
  w.store['i-zumbi'] = new Date();
  await runProbeTick(h.deps, targets);
  rows = await probes();
  assert.equal(rows[1].verdict, 'down');
  const { rows: out } = await pool.query(`SELECT * FROM instance_outages`);
  assert.equal(out.length, 0);
  assert.deepEqual(await listDownNumbers(pool), []);
});

test('episódio probe de número fecha por tráfego real no store posterior ao início', async () => {
  const { w, targets } = await zombieWorld();
  const h = harness(w);
  await driveToDown(h, targets);
  assert.deepEqual((await listDownNumbers(pool)).map((d) => d.instance), ['i-zumbi']);

  // Mesmo store: nada muda.
  await runProbeTick(h.deps, targets);
  assert.deepEqual((await listDownNumbers(pool)).map((d) => d.instance), ['i-zumbi']);

  // Mensagem real nova (depois do início = STALE): fecha.
  w.store['i-zumbi'] = sp('2026-09-23T11:58:00');
  await runProbeTick(h.deps, targets);
  const { rows: out } = await pool.query(`SELECT ended_at FROM instance_outages WHERE instance = 'i-zumbi'`);
  assert.equal(out.length, 1);
  assert.notEqual(out[0].ended_at, null);
  assert.deepEqual(await listDownNumbers(pool), []);
});

test('sonda aberta de instância que sumiu (findMessages 404) → inconclusive, sem episódio nem aviso; erro transitório só pula', async () => {
  const { w, targets } = await zombieWorld();
  const h = harness(w);
  await runProbeTick(h.deps, targets);
  const [p] = await probes();
  await age(6);
  await delivered(p.wamid);
  w.state = {}; // a instância também some do connectionState

  // Transitório: pula o tick, sonda segue aberta.
  const flaky = harness(w);
  flaky.deps.evolution.findProbe = async () => {
    throw new Error('Evolution POST /chat/findMessages/i-zumbi → 500');
  };
  await runProbeTick(flaky.deps, targets);
  assert.equal((await probes())[0].verdict, null);

  w.gone = new Set(['i-zumbi']);
  await runProbeTick(h.deps, targets);
  const rows = await probes();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, 'inconclusive');
  assert.equal((await pool.query(`SELECT * FROM instance_outages`)).rows.length, 0);
  assert.equal(h.calls.sendOps.length, 0);
});

test('pipeline_broken / send_failed / inconclusive não abrem episódio nem entram em listDownNumbers', async () => {
  const nums = [
    await seed('i-pipe', '+5531955550000'),
    await seed('i-fail', '+5531966660000'),
    await seed('i-inc', '+5531977770000'),
  ];
  const mk = async (n: (typeof nums)[number], code: string, parentId: number | null) =>
    (await createProbe(pool, {
      instance: n.evolutionInstance, kind: 'number', numberId: n.id, phone: n.phone!, label: null,
      trigger: 'store_stale', code, parentId,
    }))!;
  // pipeline_broken: 2ª sonda que está no store.
  const mom = await mk(nums[0], 'MMMM', null);
  await markProbeSent(pool, mom.id, { wamid: 'w.mom', mirrorWamid: null, sendError: null });
  await setVerdict(pool, mom.id, 'repeated');
  const kid = await mk(nums[0], 'KKKK', mom.id);
  await markProbeSent(pool, kid.id, { wamid: 'w.kid', mirrorWamid: null, sendError: null });
  // send_failed: Cloud devolveu failed.
  const f = await mk(nums[1], 'FFFF', null);
  await markProbeSent(pool, f.id, { wamid: 'w.fail', mirrorWamid: null, sendError: null });
  await recordCloudStatuses(pool, [{ id: 'w.fail', status: 'failed', errors: [{ code: 131026 }] }]);
  // inconclusive: nada em 30 min.
  const inc = await mk(nums[2], 'IIII', null);
  await markProbeSent(pool, inc.id, { wamid: 'w.inc', mirrorWamid: null, sendError: null });
  await age(31);

  const w: World = { state: {}, store: {}, owner: {}, storeSeen: { 'i-pipe': true } };
  const h = harness(w);
  const t = await runProbeTick(h.deps, await listProbeTargets(pool, []));
  assert.deepEqual(t.verdicts, { pipeline_broken: 1, send_failed: 1, inconclusive: 1 });
  assert.equal((await pool.query(`SELECT * FROM instance_outages`)).rows.length, 0);
  assert.deepEqual(await listDownNumbers(pool), []);
  assert.equal(h.calls.sendOps.length, 2, 'pipeline_broken e send_failed avisam; 1 inconclusive não');
});

test('espelho dispensado quando o alvo já é o número do operador', async () => {
  await seed('i-op', '+' + MIRROR);
  await seed('i-par', '+5531922220000');
  const w: World = {
    state: { 'i-op': 'open', 'i-par': 'open' },
    store: { 'i-op': STALE, 'i-par': RECENT },
    owner: { 'i-op': MIRROR, 'i-par': '5531922220000' },
    storeSeen: {},
  };
  const h = harness(w);
  const t = await runProbeTick(h.deps, await listProbeTargets(pool, []));
  assert.equal(t.sent, 1);
  assert.equal(h.calls.sendProbe.length, 1);
  const [row] = await probes();
  assert.equal(row.mirror_wamid, null);
});

test('reconciliação: estado open com status disconnected → updateNumberStatus(connected)', async () => {
  await seed('i-voltou', '+5531988880000');
  await pool.query(`UPDATE whatsapp_numbers SET status = 'disconnected' WHERE evolution_instance = 'i-voltou'`);
  const w: World = { state: { 'i-voltou': 'open' }, store: { 'i-voltou': RECENT }, owner: {}, storeSeen: {} };
  const h = harness(w);
  await runProbeTick(h.deps, await listProbeTargets(pool, []));
  assert.deepEqual(h.calls.updateNumberStatus, [{ i: 'i-voltou', s: 'connected' }]);
});

test('status delivered que chega DURANTE o envio do espelho cai na sonda (wamid gravado antes do espelho)', async () => {
  const { w, targets } = await zombieWorld();
  const h = harness(w);
  const orig = h.deps.sendProbe;
  let applied = -1;
  h.deps.sendProbe = async (to, titulo, detalhe) => {
    if (to === MIRROR) {
      // Medido: enviado em 7s, entregue em 8s — o status do alvo bate antes do espelho voltar.
      const [row] = await probes();
      applied = row?.wamid ? await delivered(row.wamid) : 0;
    }
    return orig(to, titulo, detalhe);
  };
  const t = await runProbeTick(h.deps, targets);
  assert.equal(t.sent, 1);
  assert.equal(applied, 1, 'o wamid do alvo já deveria estar gravado quando o espelho sai');
  const [row] = await probes();
  assert.equal(row.cloud_status, 'delivered');
  assert.ok(row.wamid);
  assert.ok(row.mirror_wamid);
  assert.notEqual(row.mirror_wamid, row.wamid);
});

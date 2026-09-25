import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import { upsertConnectedNumber } from '../../src/whatsapp/numbers.js';
import {
  runSystemInstanceWatch,
  sweepDownNumbers,
  type DownNotifyDeps,
  type SystemProbe,
} from '../../src/whatsapp/down-notify-service.js';
import type { DownNotifyTarget, DownSendResult } from '../../src/whatsapp/down-notify-sender.js';

const H = 3_600_000;
const TICK = 5 * 60_000; // intervalo do vigia de sistema

/** Faz o tempo passar para a suspeita: recua o `checked_at`, que é o relógio dela. */
const elapse = (interval = '5 minutes') =>
  pool.query(`UPDATE system_instance_health SET checked_at = NOW() - $1::interval`, [interval]);

beforeEach(async () => {
  await pool.query('TRUNCATE whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query('TRUNCATE whatsapp_provision_links');
  await pool.query('TRUNCATE system_instance_health');
});
after(() => pool.end());

function harness(results: DownSendResult[] = []) {
  const sent: DownNotifyTarget[] = [];
  let i = 0;
  const deps: DownNotifyDeps = {
    pool,
    send: async (t) => {
      sent.push(t);
      return results[i++] ?? { ok: true, sendId: 'wamid', via: 'template' };
    },
    now: () => new Date(),
    panelBaseUrl: 'https://painel.beeads.com.br',
    cadence: { debounceMs: 5 * 60_000, renotifyMs: 12 * H, maxNotifies: 6 },
    link: { maxClicks: 10, ttlDays: 7 },
    log: { info() {}, warn() {}, error() {} },
  };
  return { deps, sent };
}

async function downNumber(minutes: number) {
  const n = await upsertConnectedNumber(pool, {
    workspaceId: 'ws-1',
    evolutionInstance: 'ws-inst-1',
    phone: '+5524999422282',
    createdBy: null,
  });
  await pool.query(
    `UPDATE whatsapp_numbers
        SET status = 'connecting', label = 'Atendimento Pousada',
            disconnected_since = NOW() - ($2 || ' minutes')::interval
      WHERE id = $1`,
    [n.id, String(minutes)],
  );
  return n;
}

async function count(): Promise<number> {
  const { rows } = await pool.query(`SELECT down_notify_count FROM whatsapp_numbers`);
  return Number(rows[0].down_notify_count);
}

test('número fora do ar recebe o aviso no PRÓPRIO telefone, com link travado nele', async () => {
  await downNumber(30);
  const { deps, sent } = harness();
  const attempts = await sweepDownNumbers(deps);

  assert.deepEqual(attempts.map((a) => a.outcome), ['sent']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].phone, '+5524999422282');
  assert.equal(sent[0].name, 'Atendimento Pousada');
  assert.match(sent[0].link, /^https:\/\/painel\.beeads\.com\.br\/reconectar-whatsapp\/[A-Za-z0-9_-]{43}$/);
  assert.ok(sent[0].link.endsWith(sent[0].token));

  const { rows } = await pool.query(
    `SELECT target_instance, expected_phone, workspace_id FROM whatsapp_provision_links WHERE token = $1`,
    [sent[0].token],
  );
  assert.deepEqual(rows[0], { target_instance: 'ws-inst-1', expected_phone: '+5524999422282', workspace_id: 'ws-1' });
  assert.equal(await count(), 1);
});

test('segunda passada no mesmo intervalo não reenvia', async () => {
  await downNumber(30);
  const { deps, sent } = harness();
  await sweepDownNumbers(deps);
  assert.deepEqual(await sweepDownNumbers(deps), []);
  assert.equal(sent.length, 1);
});

test('dentro do debounce não avisa', async () => {
  await downNumber(2);
  const { deps, sent } = harness();
  assert.deepEqual(await sweepDownNumbers(deps), []);
  assert.equal(sent.length, 0);
});

test('re-aviso depois do intervalo reusa o MESMO link', async () => {
  await downNumber(30 * 60);
  const { deps, sent } = harness();
  await sweepDownNumbers(deps);
  await pool.query(`UPDATE whatsapp_numbers SET down_notified_at = NOW() - INTERVAL '13 hours'`);
  const again = await sweepDownNumbers(deps);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].token, sent[0].token);
  assert.equal(again[0].reusedLink, true);
  assert.equal(await count(), 2);
});

test('falha transitória devolve o claim e o próximo tick tenta de novo', async () => {
  await downNumber(30);
  const { deps, sent } = harness([{ ok: false, networkError: true, via: null }]);
  assert.deepEqual((await sweepDownNumbers(deps)).map((a) => a.outcome), ['released']);
  assert.equal(await count(), 0);
  assert.deepEqual((await sweepDownNumbers(deps)).map((a) => a.outcome), ['sent']);
  assert.equal(sent.length, 2);
  assert.equal(await count(), 1);
});

test('recusa 4xx mantém o claim e espera o re-aviso', async () => {
  await downNumber(30);
  const { deps, sent } = harness([{ ok: false, status: 400, via: null }]);
  assert.deepEqual((await sweepDownNumbers(deps)).map((a) => a.outcome), ['failed']);
  assert.equal(await count(), 1);
  assert.deepEqual(await sweepDownNumbers(deps), []);
  assert.equal(sent.length, 1);
});

// `traffic: 'always'` = atraso do store pelo relógio de parede. Estes testes usam instantes
// relativos a Date.now(); com o relógio de expediente (o padrão) o resultado dependeria do
// dia e da hora em que a suíte roda. O expediente é coberto com datas fixas em
// down-notify-falso-positivo.db.test.ts e down-notify.test.ts.
const saturno = { instance: 'saturno', expectedPhone: '+553195950748', label: 'Monitor de grupos', traffic: 'always' as const };

function probe(p: {
  state?: SystemProbe['connectionState'];
  store?: Record<string, Date | null>;
  peers?: string[];
}): SystemProbe {
  return {
    connectionState: p.state ?? (async () => 'open'),
    latestStoreTs: async (i) => (p.store ?? {})[i] ?? null,
    listPeerInstances: async () => p.peers ?? [],
  };
}

test('instância de sistema fechada: 1º tick é suspeita, o 2º abre o episódio e, passado o debounce, avisa o telefone travado', async () => {
  const { deps, sent } = harness();
  const watch = { ...deps, probe: probe({ state: async () => 'close' }), staleMs: 6 * H, intervalMs: TICK };

  // 1º tick: suspeita — nada aberto
  assert.deepEqual(await runSystemInstanceWatch(watch, [saturno]), []);
  assert.equal((await pool.query(`SELECT down_since FROM system_instance_health`)).rows[0].down_since, null);
  // 2ª observação, 3min depois (já conta como outra, mas ainda DENTRO do debounce de 5min):
  // abre — o início é o instante da 1ª observação, porque sem par não há início estimado
  await elapse('3 minutes');
  assert.deepEqual(await runSystemInstanceWatch(watch, [saturno]), []);
  assert.notEqual((await pool.query(`SELECT down_since FROM system_instance_health`)).rows[0].down_since, null);
  assert.equal(sent.length, 0);

  await pool.query(`UPDATE system_instance_health SET down_since = NOW() - INTERVAL '10 minutes'`);
  const r = await runSystemInstanceWatch(watch, [saturno]);
  assert.deepEqual(r.map((a) => a.outcome), ['sent']);
  assert.equal(sent[0].phone, '+553195950748');

  const { rows } = await pool.query(
    `SELECT target_instance, expected_phone, workspace_id FROM whatsapp_provision_links WHERE token = $1`,
    [sent[0].token],
  );
  assert.deepEqual(rows[0], { target_instance: 'saturno', expected_phone: '+553195950748', workspace_id: null });
});

test('open com store atrás do par é só GATILHO de sonda (não abre episódio); par emparelhado segue saudável', async () => {
  const { deps } = harness();
  const stale = new Date(Date.now() - 96 * H);

  const staleWatch = {
    ...deps,
    probe: probe({ store: { saturno: stale, 'ws-peer': new Date() }, peers: ['ws-peer'] }),
    staleMs: 6 * H, intervalMs: TICK,
  };
  await runSystemInstanceWatch(staleWatch, [saturno]);
  await elapse();
  await runSystemInstanceWatch(staleWatch, [saturno]);
  let h = (await pool.query(`SELECT last_reason, down_since FROM system_instance_health`)).rows[0];
  // Sonda de conexão (spec 2026-09-25 §7): store_stale não vira suspeita nem episódio.
  assert.equal(h.last_reason, null);
  assert.equal(h.down_since, null);

  await runSystemInstanceWatch(
    {
      ...deps,
      probe: probe({ store: { saturno: stale, 'ws-peer': new Date(stale.getTime() + H) }, peers: ['ws-peer'] }),
      staleMs: 6 * H, intervalMs: TICK,
    },
    [saturno],
  );
  h = (await pool.query(`SELECT last_reason, down_since FROM system_instance_health`)).rows[0];
  assert.equal(h.last_reason, null);
  assert.equal(h.down_since, null);
});

test('sonda com erro não mexe no episódio nem avisa', async () => {
  const { deps, sent } = harness();
  const closed = { ...deps, probe: probe({ state: async () => 'close' }), staleMs: 6 * H, intervalMs: TICK };
  await runSystemInstanceWatch(closed, [saturno]);
  await elapse();
  // A confirmação abre o episódio com início na 1ª observação (5min atrás): o debounce já
  // está cumprido, então ESTE tick avisa. O que o teste mede é a sonda com erro, logo abaixo.
  await runSystemInstanceWatch(closed, [saturno]);
  const before = (await pool.query(`SELECT down_since FROM system_instance_health`)).rows[0].down_since as Date;
  assert.notEqual(before, null);
  const sentBefore = sent.length;

  const broken = probe({
    state: async () => {
      throw new Error('evolution fora');
    },
  });
  assert.deepEqual(await runSystemInstanceWatch({ ...deps, probe: broken, staleMs: 6 * H, intervalMs: TICK }, [saturno]), []);

  const later = (await pool.query(`SELECT down_since FROM system_instance_health`)).rows[0].down_since as Date;
  assert.equal(later.getTime(), before.getTime());
  assert.equal(sent.length, sentBefore);
});

test('suspeita → sondas com erro por horas → nova leitura fora: NÃO abre com a suspeita velha; recomeça', async () => {
  const { deps, sent } = harness();
  const closed = { ...deps, probe: probe({ state: async () => 'close' }), staleMs: 6 * H, intervalMs: TICK };
  const broken = {
    ...deps,
    probe: probe({
      state: async () => {
        throw new Error('evolution fora');
      },
    }),
    staleMs: 6 * H, intervalMs: TICK,
  };

  await runSystemInstanceWatch(closed, [saturno]); //  suspeita
  await runSystemInstanceWatch(broken, [saturno]); //  sonda com erro: linha intocada…
  await runSystemInstanceWatch(broken, [saturno]);
  await elapse('4 hours'); //                          …e o tempo passando
  assert.deepEqual(await runSystemInstanceWatch(closed, [saturno]), []);
  assert.equal((await pool.query(`SELECT down_since FROM system_instance_health`)).rows[0].down_since, null);
  assert.equal(sent.length, 0);

  // a leitura de agora virou a 1ª observação: confirmada um intervalo depois, aí sim abre
  await elapse();
  await runSystemInstanceWatch(closed, [saturno]);
  assert.notEqual((await pool.query(`SELECT down_since FROM system_instance_health`)).rows[0].down_since, null);
});

test('rodada manual (CLI --dry-run) colada num tick do vigia NÃO confirma a suspeita dele', async () => {
  const { deps, sent } = harness();
  const closed = { ...deps, probe: probe({ state: async () => 'close' }), staleMs: 6 * H, intervalMs: TICK };
  await runSystemInstanceWatch(closed, [saturno]); // tick do daemon vê o flap
  await runSystemInstanceWatch(closed, [saturno]); // 2s depois: dry-run, ou o tick de boot do 2º container
  await runSystemInstanceWatch(closed, [saturno]);
  assert.equal((await pool.query(`SELECT down_since FROM system_instance_health`)).rows[0].down_since, null);
  assert.equal(sent.length, 0);
  assert.equal(Number((await pool.query(`SELECT count(*)::int c FROM whatsapp_provision_links`)).rows[0].c), 0);
});

test('instância que já estava fora começa na última mensagem, não na detecção', async () => {
  const { deps } = harness();
  const lastMsg = new Date(Date.now() - 80 * H);
  const watch = {
    ...deps,
    probe: probe({ state: async () => 'connecting', store: { saturno: lastMsg, 'ws-peer': new Date() }, peers: ['ws-peer'] }),
    staleMs: 6 * H, intervalMs: TICK,
  };
  await runSystemInstanceWatch(watch, [saturno]);
  await elapse();
  await runSystemInstanceWatch(watch, [saturno]);
  const h = (await pool.query(`SELECT down_since FROM system_instance_health`)).rows[0];
  assert.equal((h.down_since as Date).getTime(), lastMsg.getTime());
});

test('com resolvedor, o aviso e o link levam o NOME DO WORKSPACE no lugar do rótulo', async () => {
  await downNumber(30);
  const { deps, sent } = harness();
  const asked: string[] = [];
  await sweepDownNumbers({
    ...deps,
    resolveWorkspaceName: async (id) => {
      asked.push(id);
      return 'Pousada Recanto de Moriá';
    },
  });
  assert.deepEqual(asked, ['ws-1']);
  assert.equal(sent[0].name, 'Pousada Recanto de Moriá');
  const { rows } = await pool.query(`SELECT target_label FROM whatsapp_provision_links WHERE token = $1`, [sent[0].token]);
  assert.equal(rows[0].target_label, 'Pousada Recanto de Moriá');
});

test('resolvedor falhando cai no rótulo e o aviso sai mesmo assim', async () => {
  await downNumber(30);
  const { deps, sent } = harness();
  const r = await sweepDownNumbers({
    ...deps,
    resolveWorkspaceName: async () => {
      throw new Error('bloquim fora');
    },
  });
  assert.deepEqual(r.map((a) => a.outcome), ['sent']);
  assert.equal(sent[0].name, 'Atendimento Pousada');
});

test('instância de sistema não consulta workspace: usa o rótulo configurado', async () => {
  const { deps, sent } = harness();
  let called = false;
  const watch = {
    ...deps,
    resolveWorkspaceName: async () => {
      called = true;
      return 'X';
    },
    probe: probe({
      state: async () => 'close' as const,
      store: { saturno: new Date(Date.now() - 80 * H), 'ws-peer': new Date() },
      peers: ['ws-peer'],
    }),
    staleMs: 6 * H, intervalMs: TICK,
  };
  await runSystemInstanceWatch(watch, [saturno]);
  await elapse();
  await runSystemInstanceWatch(watch, [saturno]);
  assert.equal(called, false);
  assert.equal(sent[0].name, 'Monitor de grupos');
});

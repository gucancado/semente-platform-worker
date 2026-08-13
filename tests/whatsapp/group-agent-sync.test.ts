/**
 * tests/whatsapp/group-agent-sync.test.ts — DB-free (fake pool + fetch mock).
 *
 * Cobre `syncAgentGroupParticipants` (escopo 'agent', linhas legadas de
 * `whatsapp_groups` sem `whatsapp_number_id` — hoje só `agent='saturno'`).
 * Espelha as invariantes de `group-sync.test.ts` (timestamp único
 * roster+marcador, marcador só avança com ≥1 participante persistido), mas
 * aqui cada grupo é uma requisição HTTP SEPARADA (`fetchGroupParticipants`
 * por jid, não um `fetchAllGroups` só) — então o timestamp é capturado POR
 * GRUPO, não uma vez pro sync inteiro.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncAgentGroupParticipants, syncNumberGroupParticipants } from '../../src/whatsapp/agent-group-sync.js';

const GROUP_ROWS = [
  { id: 11, jid: '+120363099' },
  { id: 12, jid: '+120363100' },
];

const RAW_PARTICIPANT = {
  id: '166730898927796@lid', phoneNumber: '553196039118@s.whatsapp.net',
  admin: 'admin', name: 'Gustavo Cançado',
};

function makePool(opts: { participantsByJid: Record<string, any[] | undefined> }) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pool = {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT id, jid') && sql.includes('whatsapp_groups')) return { rows: GROUP_ROWS };
      if (sql.includes('INSERT INTO whatsapp_group_participants')) return { rows: [] };
      if (sql.includes('SET participants_synced_at')) return { rows: [] };
      throw new Error(`query inesperada: ${sql}`);
    },
  } as any;
  return { pool, calls };
}

function makeEvolutionDeps(participantsByJid: Record<string, any[]>) {
  return {
    baseUrl: 'https://evo', apiKey: 'k',
    fetch: (async (url: string) => {
      const m = /groupJid=(\d+)@g\.us/.exec(url);
      const digits = m ? m[1] : '';
      const jid = `+${digits}`;
      const participants = participantsByJid[jid];
      if (!participants) return { ok: false, status: 404, json: async () => ({}) } as any;
      return { ok: true, status: 200, json: async () => ({ participants }) } as any;
    }) as any,
  };
}

function participantInserts(calls: Array<{ sql: string; params: any[] }>) {
  return calls.filter((c) => c.sql.includes('INSERT INTO whatsapp_group_participants'));
}
function markerUpdates(calls: Array<{ sql: string; params: any[] }>) {
  return calls.filter((c) => c.sql.includes('SET participants_synced_at'));
}

test('syncAgentGroupParticipants busca cada grupo vinculado do agent por jid e grava o roster', async () => {
  const { pool, calls } = makePool({ participantsByJid: {} });
  const deps = makeEvolutionDeps({ '+120363099': [RAW_PARTICIPANT], '+120363100': [RAW_PARTICIPANT] });

  const out = await syncAgentGroupParticipants(pool, deps, 'saturno');

  assert.equal(out.groupsAttempted, 2);
  assert.equal(out.groupsSynced, 2);
  assert.equal(out.participants, 2);
  assert.equal(out.failed, 0);
  assert.equal(participantInserts(calls).length, 2);
  assert.equal(markerUpdates(calls).length, 2);

  // A query de descoberta dos grupos filtra pelo agent, exige vínculo e exclui escopo 'number'.
  const discoverCall = calls.find((c) => c.sql.includes('SELECT id, jid'))!;
  assert.match(discoverCall.sql, /linked_workspace_id IS NOT NULL/);
  assert.match(discoverCall.sql, /whatsapp_number_id IS NULL/);
  assert.match(discoverCall.sql, /agent = \$1/);
  assert.deepEqual(discoverCall.params, ['saturno']);
});

test('syncAgentGroupParticipants: roster e marcador do MESMO grupo usam o MESMO timestamp explícito', async () => {
  const { pool, calls } = makePool({ participantsByJid: {} });
  const deps = makeEvolutionDeps({ '+120363099': [RAW_PARTICIPANT], '+120363100': [RAW_PARTICIPANT] });

  await syncAgentGroupParticipants(pool, deps, 'saturno');

  const inserts = participantInserts(calls);
  const markers = markerUpdates(calls);
  assert.equal(inserts.length, 2);
  assert.equal(markers.length, 2);

  for (let i = 0; i < 2; i++) {
    const insertTs = inserts[i]!.params.at(-1);
    const markerTs = markers[i]!.params.at(-1);
    assert.ok(insertTs instanceof Date, 'upsert do participante recebe timestamp explícito');
    assert.ok(markerTs instanceof Date, 'UPDATE do marcador recebe timestamp explícito');
    assert.equal((insertTs as Date).getTime(), (markerTs as Date).getTime(), 'roster e marcador do MESMO grupo têm que gravar o mesmo instante');
  }

  // Nenhuma query pode depender do NOW() do SQL pros campos de tempo do sync.
  assert.doesNotMatch(inserts[0]!.sql, /last_seen_at\s*=\s*NOW\(\)/i);
  assert.doesNotMatch(markers[0]!.sql, /participants_synced_at\s*=\s*NOW\(\)/i);
});

test('syncAgentGroupParticipants: grupo sem roster (404) não persiste nem carimba o marcador', async () => {
  const { pool, calls } = makePool({ participantsByJid: {} });
  // Nenhum dos dois jids tem participantes cadastrados no mock → ambos 404.
  const deps = makeEvolutionDeps({});

  const out = await syncAgentGroupParticipants(pool, deps, 'saturno');

  assert.equal(out.groupsAttempted, 2);
  assert.equal(out.groupsSynced, 0, 'sem roster, nenhum grupo conta como sincronizado');
  assert.equal(out.participants, 0);
  assert.equal(out.failed, 0, '404 é resultado (roster vazio), não falha');
  assert.equal(participantInserts(calls).length, 0);
  assert.equal(markerUpdates(calls).length, 0, 'marcador não avança sem roster persistido');
});

test('syncAgentGroupParticipants: falha num grupo não derruba o sync dos outros', async () => {
  const { pool, calls } = makePool({ participantsByJid: {} });
  const deps = {
    baseUrl: 'https://evo', apiKey: 'k',
    fetch: (async (url: string) => {
      if (url.includes('120363099')) throw new Error('timeout');
      return { ok: true, status: 200, json: async () => ({ participants: [RAW_PARTICIPANT] }) } as any;
    }) as any,
  };

  const out = await syncAgentGroupParticipants(pool, deps, 'saturno');

  assert.equal(out.groupsAttempted, 2);
  assert.equal(out.failed, 1, 'o grupo que deu timeout conta como falha');
  assert.equal(out.groupsSynced, 1, 'o outro grupo sincroniza normalmente');
  assert.equal(participantInserts(calls).length, 1);
});

test('syncAgentGroupParticipants: nenhum grupo vinculado do agent → resultado zerado sem chamar a Evolution', async () => {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pool = {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  } as any;
  const deps = { baseUrl: 'https://evo', apiKey: 'k', fetch: (async () => { throw new Error('não deveria chamar a Evolution'); }) as any };

  const out = await syncAgentGroupParticipants(pool, deps, 'saturno');
  assert.deepEqual(out, { groupsAttempted: 0, groupsSynced: 0, participants: 0, failed: 0 });
});

test('syncNumberGroupParticipants: seleciona por whatsapp_number_id e usa a instância do número', async () => {
  const { pool, calls } = makePool({ participantsByJid: {} });
  const urls: string[] = [];
  const deps = {
    baseUrl: 'https://evo', apiKey: 'k',
    fetch: (async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => ({ participants: [RAW_PARTICIPANT] }) } as any;
    }) as any,
  };

  const out = await syncNumberGroupParticipants(pool, deps, 'ws-abc-123', 7);

  const discover = calls.find((c) => c.sql.includes('whatsapp_number_id = $1'))!;
  assert.ok(discover, 'SELECT de descoberta filtra pelo número');
  assert.match(discover.sql, /linked_workspace_id IS NOT NULL/);
  assert.deepEqual(discover.params, [7]);
  assert.ok(urls.length > 0 && urls.every((u) => u.includes('/group/participants/ws-abc-123')),
    `toda chamada usa a instância do número (${urls.join(', ')})`);
  assert.equal(out.groupsAttempted, 2);
  assert.equal(out.groupsSynced, 2);
});

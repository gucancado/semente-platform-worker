/**
 * tests/whatsapp/group-sync.test.ts — DB-free (fake pool + fetch mock).
 *
 * Cobre o bug do fix round 1: `syncGroupSubjects` só pode avançar
 * `participants_synced_at` (e gravar roster) quando `opts.participants` é
 * `true`. A chamada sem esse opt — o caminho quente do on-connect
 * (`syncGroupSubjectsDebounced`) — tem que deixar o marcador e o roster
 * intocados, senão `listParticipants` esvazia o roster inteiro assim que uma
 * reconexão qualquer acontece depois do cron de participantes.
 *
 * Fix round 2 (review final): dois cuidados a mais.
 *  - `participantScope`: a persistência do roster fica restrita aos jids
 *    vinculados daquele número — o subject de um grupo fora do escopo ainda
 *    sincroniza, o roster dele não (LGPD: não coletar telefone de gente em
 *    grupos alheios à feature).
 *  - O marcador só avança quando `upsertParticipants` de fato GRAVOU ≥1 linha
 *    — não basta `participants: true`. Se a Evolution devolver roster vazio
 *    (ou o upsert falhar), o marcador fica intocado; senão `listParticipants`
 *    devolveria lista vazia até o próximo sync bom, sem sinal na tela. Por
 *    isso o marcador agora é uma query SEPARADA (`SET participants_synced_at`
 *    isolado), nunca embutida no upsert do grupo.
 *
 * Fix round 3 (regressão pós-round-2): a query separada do marcador rodava
 * com seu PRÓPRIO `NOW()`, independente do `NOW()` de cada upsert de
 * participante — dois statements sequenciais sem transação, então o `NOW()`
 * do marcador (gravado DEPOIS) ficava sempre um pouco à frente do
 * `last_seen_at` do lote. Isso invertia o corte `last_seen_at >=
 * participants_synced_at` de `listParticipants` e devolvia lista VAZIA logo
 * após um sync bem-sucedido. Fake pool não modela `NOW()` do Postgres, então
 * essa regressão passava batido nos rounds 1-2. O teste abaixo trava a
 * invariante sem banco: exige que a implementação passe um timestamp
 * EXPLÍCITO (mesmo valor) pros dois writes, em vez de confiar em `NOW()` do
 * SQL em qualquer um dos dois.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncGroupSubjects } from '../../src/whatsapp/group-sync.js';

const NUMBER_ROW = {
  id: 3, workspace_id: 'ws-saturno', phone: '+553100000000', evolution_instance: 'saturno-inst',
  label: null, status: 'connected', mode: 'monitored', expose_groups_in_mcp: false,
  created_by: null, created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date('2026-01-01T00:00:00Z'),
  removed_at: null,
};

const RAW_PARTICIPANTS = [{ id: '5531999998888@s.whatsapp.net', admin: 'admin' }];

/** Evolution devolve o roster só quando a URL pede `getParticipants=true`. */
function makeEvolutionDeps() {
  return {
    baseUrl: 'https://evo', apiKey: 'k',
    fetch: (async (url: string) => {
      const withPeople = /getParticipants=true/.test(url);
      return {
        ok: true, status: 200,
        json: async () => ([{
          id: '120363001@g.us', subject: 'Grupo Teste',
          ...(withPeople ? { participants: RAW_PARTICIPANTS } : {}),
        }]),
      } as any;
    }) as any,
  };
}

function makePool() {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pool = {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('whatsapp_group_participants')) return { rows: [] };
      if (sql.includes('whatsapp_numbers')) return { rows: [NUMBER_ROW] };
      if (sql.includes('whatsapp_groups')) return { rows: [{ id: 7 }] }; // RETURNING id do upsert
      throw new Error(`query inesperada: ${sql}`);
    },
  } as any;
  return { pool, calls };
}

/** Query dedicada que carimba o marcador — separada do upsert do grupo (fix round 2). */
function markerUpdates(calls: Array<{ sql: string; params: any[] }>) {
  return calls.filter((c) => c.sql.includes('SET participants_synced_at'));
}
function participantInserts(calls: Array<{ sql: string; params: any[] }>) {
  return calls.filter((c) => c.sql.includes('INSERT INTO whatsapp_group_participants'));
}

test('syncGroupSubjects: só a chamada com participants:true grava o roster e avança o marcador', async () => {
  const { pool, calls } = makePool();
  const deps = makeEvolutionDeps();

  // 1ª chamada — cron/rota admin manual, pede o roster.
  const first = await syncGroupSubjects(pool, deps, 3, { participants: true });
  assert.equal(first.synced, 1);
  assert.equal(first.participants, 1, '1ª chamada grava o participante do roster');
  assert.equal(participantInserts(calls).length, 1, '1ª chamada grava 1 participante');
  assert.equal(markerUpdates(calls)[0]!.params[0], 7, '1ª chamada: roster persistido → marcador avança para o grupo 7');
  assert.equal(markerUpdates(calls).length, 1);

  calls.length = 0; // isola a 2ª chamada

  // 2ª chamada — on-connect (debounce), SEM participants: é o caminho quente,
  // não pode herdar `participants: true` (custo mais caro da Evolution).
  const second = await syncGroupSubjects(pool, deps, 3);
  assert.equal(second.synced, 1);
  assert.equal(second.participants, 0, '2ª chamada NÃO grava participante nenhum — é o bug corrigido');
  assert.equal(participantInserts(calls).length, 0, '2ª chamada não deve tocar whatsapp_group_participants');
  assert.equal(markerUpdates(calls).length, 0, '2ª chamada: sem roster persistido → marcador fica intocado');
});

// Correção 2 (LGPD/escopo): a chamada à Evolution é uma só e devolve o roster
// de todos os grupos do número, mas a PERSISTÊNCIA fica restrita aos jids
// vinculados. O subject sincroniza igual; o roster de fora do escopo não é
// gravado nem avança o marcador.
test('syncGroupSubjects: grupo FORA do participantScope sincroniza subject mas não persiste roster', async () => {
  const { pool, calls } = makePool();
  const deps = makeEvolutionDeps();
  const out = await syncGroupSubjects(pool, deps, 3, {
    participants: true,
    participantScope: new Set(['+999999999999']), // não contém o jid devolvido ('+120363001')
  });
  assert.equal(out.synced, 1, 'subject sincroniza mesmo fora do escopo');
  assert.equal(out.participants, 0, 'roster NÃO persiste fora do escopo');
  assert.equal(participantInserts(calls).length, 0);
  assert.equal(markerUpdates(calls).length, 0, 'sem persistência, marcador não avança');
});

test('syncGroupSubjects: grupo DENTRO do participantScope persiste roster normalmente', async () => {
  const { pool, calls } = makePool();
  const deps = makeEvolutionDeps();
  const out = await syncGroupSubjects(pool, deps, 3, {
    participants: true,
    participantScope: new Set(['+120363001']), // contém o jid devolvido
  });
  assert.equal(out.participants, 1);
  assert.equal(participantInserts(calls).length, 1);
  assert.equal(markerUpdates(calls).length, 1);
});

// Correção 4: `participants: true` sozinho não basta. Se a Evolution devolver
// roster vazio/ausente para um grupo, `upsertParticipants` nunca roda — e o
// marcador não pode avançar mesmo assim (senão `listParticipants` esvaziaria
// a tela até o próximo sync bom, sem sinal do porquê).
test('syncGroupSubjects: roster vazio da Evolution não avança o marcador', async () => {
  const { pool, calls } = makePool();
  const deps = {
    baseUrl: 'https://evo', apiKey: 'k',
    fetch: (async () => ({
      ok: true, status: 200,
      json: async () => ([{ id: '120363001@g.us', subject: 'Grupo Teste', participants: [] }]),
    })) as any,
  };
  const out = await syncGroupSubjects(pool, deps, 3, { participants: true });
  assert.equal(out.synced, 1);
  assert.equal(out.participants, 0);
  assert.equal(participantInserts(calls).length, 0);
  assert.equal(markerUpdates(calls).length, 0);
});

// Fix round 3: regressão do "listParticipants sempre vazio logo após o sync".
// Sem banco real não dá pra observar dois NOW() divergindo, mas dá pra travar
// a PRECONDIÇÃO que os elimina: nenhuma das duas escritas pode confiar no
// `NOW()` do SQL (que rodaria em instantes diferentes) — as duas têm que
// receber o MESMO timestamp como parâmetro explícito.
test('syncGroupSubjects: roster e marcador usam o MESMO timestamp explícito (não dois NOW() do SQL)', async () => {
  const { pool, calls } = makePool();
  const deps = makeEvolutionDeps();

  await syncGroupSubjects(pool, deps, 3, { participants: true });

  const insertCall = participantInserts(calls)[0]!;
  const markerCall = markerUpdates(calls)[0]!;

  // Nenhuma das duas queries pode ter o `last_seen_at`/`participants_synced_at`
  // fixado via NOW() do SQL — senão nada garante que sejam o mesmo instante.
  assert.doesNotMatch(insertCall.sql, /last_seen_at\s*=\s*NOW\(\)/i, 'upsert do participante não pode depender do NOW() do banco');
  assert.doesNotMatch(markerCall.sql, /participants_synced_at\s*=\s*NOW\(\)/i, 'UPDATE do marcador não pode depender do NOW() do banco');

  // Os dois últimos parâmetros são o timestamp explícito de cada escrita.
  const insertTs = insertCall.params.at(-1);
  const markerTs = markerCall.params.at(-1);
  assert.ok(insertTs instanceof Date, 'upsert do participante recebe um timestamp explícito');
  assert.ok(markerTs instanceof Date, 'UPDATE do marcador recebe um timestamp explícito');

  // A invariante que corrige o bug: MESMO instante nas duas escritas, não
  // apenas "próximo" — é o que faz last_seen_at >= participants_synced_at
  // valer pro lote inteiro do sync corrente.
  assert.equal((insertTs as Date).getTime(), (markerTs as Date).getTime(), 'roster e marcador têm que gravar o MESMO instante');
});

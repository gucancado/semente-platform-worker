/**
 * tests/whatsapp/group-participants.test.ts — DB-free (fake pool).
 * Cobre: parsing dos participantes da Evolution (o telefone tem que sair no
 * MESMO formato de messages.author, senão o roster não casa com quem falou),
 * upsert idempotente e o mapeamento da leitura.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseParticipants } from '../../src/evolution/client.js';
import { upsertParticipants, listParticipants } from '../../src/whatsapp/group-participants.js';

test('parseParticipants normaliza o jid pro mesmo formato de messages.author', () => {
  const out = parseParticipants([
    { id: '5531999998888@s.whatsapp.net', admin: 'admin' },
    { id: '5531988887777@s.whatsapp.net', admin: null },
    { id: '5531977776666@s.whatsapp.net' },
  ]);
  assert.deepEqual(out, [
    { phone: '+5531999998888', isAdmin: true, isLid: false, lid: null, pushName: null },
    { phone: '+5531988887777', isAdmin: false, isLid: false, lid: null, pushName: null },
    { phone: '+5531977776666', isAdmin: false, isLid: false, lid: null, pushName: null },
  ]);
});

// O author das mensagens é normalizeGroupJid(canonicalJid(participant, participantAlt))
// (src/webhook/evolution.ts:63-65). Um participante @lid COM alt tem que produzir o
// mesmo telefone que a mensagem — senão o roster não casa com quem aparece falando.
test('parseParticipants resolve LID pelo campo alt (casa com messages.author)', () => {
  const out = parseParticipants([{ id: '12345@lid', jidAlt: '5531999998888@s.whatsapp.net', admin: 'admin' }]);
  assert.deepEqual(out, [{ phone: '+5531999998888', isAdmin: true, isLid: false, lid: '12345', pushName: null }]);
});

test('parseParticipants marca isLid quando o LID vem SEM alt (não é telefone)', () => {
  const out = parseParticipants([{ id: '12345@lid', admin: null }]);
  assert.deepEqual(out, [{ phone: '+12345', isAdmin: false, isLid: true, lid: '12345', pushName: null }]);
});

test('parseParticipants trata superadmin como admin e ignora entrada sem id', () => {
  const out = parseParticipants([{ id: '5531999998888@s.whatsapp.net', admin: 'superadmin' }, { admin: 'admin' } as any]);
  assert.deepEqual(out, [{ phone: '+5531999998888', isAdmin: true, isLid: false, lid: null, pushName: null }]);
});

test('parseParticipants devolve [] para entrada não-array', () => {
  assert.deepEqual(parseParticipants(undefined as any), []);
  assert.deepEqual(parseParticipants(null as any), []);
});

// Shape MEDIDO em produção: GET /group/participants/{instance}?groupJid=...
// na instância 'saturno' devolve `id` LID + `phoneNumber` real NO MESMO
// objeto (diferente do shape de fetchAllGroups, que não traz phoneNumber nem
// name). `lid` tem que sair preenchido MESMO com o telefone resolvido via
// phoneNumber — é o par (LID, telefone) que sustenta a resolução de menções
// `@<lid>` no texto das mensagens.
test('parseParticipants extrai lid E pushName do shape medido de GET /group/participants', () => {
  const out = parseParticipants([
    { id: '166730898927796@lid', phoneNumber: '553196039118@s.whatsapp.net', admin: 'admin', name: 'Gustavo Cançado', imgUrl: 'https://pps.whatsapp.net/x' },
  ]);
  assert.deepEqual(out, [{
    phone: '+553196039118',
    isAdmin: true,
    isLid: false,        // telefone real foi resolvido via phoneNumber
    lid: '166730898927796',
    pushName: 'Gustavo Cançado',
  }]);
});

test('parseParticipants trata name ausente/vazio como pushName null', () => {
  const out = parseParticipants([
    { id: '166730898927796@lid', phoneNumber: '553196039118@s.whatsapp.net', admin: null, name: null },
    { id: '5531988887777@s.whatsapp.net', admin: null, name: '' },
  ]);
  assert.equal(out[0]!.pushName, null);
  assert.equal(out[1]!.pushName, null);
});

test('upsertParticipants faz um upsert por pessoa, grava lid e devolve a contagem', async () => {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pool = { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows: [] }; } } as any;
  const n = await upsertParticipants(pool, 7, [
    { phone: '+5531999998888', pushName: 'Gustavo', isAdmin: true, isLid: false, lid: '166730898927796' },
    { phone: '+5531988887777', pushName: null, isAdmin: false, isLid: false, lid: null },
  ]);
  assert.equal(n, 2);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /ON CONFLICT \(group_id, phone\)/);
  assert.match(calls[0].sql, /last_seen_at = NOW\(\)/);
  assert.match(calls[0].sql, /lid = COALESCE\(EXCLUDED\.lid, whatsapp_group_participants\.lid\)/);
  assert.deepEqual(calls[0].params, [7, '+5531999998888', 'Gustavo', true, false, '166730898927796']);
  assert.deepEqual(calls[1].params, [7, '+5531988887777', null, false, false, null]);
});

test('upsertParticipants sem lid informado grava null (COALESCE preserva o já persistido)', async () => {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pool = { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows: [] }; } } as any;
  await upsertParticipants(pool, 7, [{ phone: '+5531999998888', pushName: 'Gustavo', isAdmin: true, isLid: false }]);
  assert.equal(calls[0]!.params.at(-1), null);
});

test('upsertParticipants com lista vazia não toca o banco', async () => {
  const pool = { query: async () => { throw new Error('não deveria consultar'); } } as any;
  assert.equal(await upsertParticipants(pool, 7, []), 0);
});

test('listParticipants mapeia snake→camel e serializa a data', async () => {
  const pool = {
    query: async () => ({ rows: [{
      phone: '+5531999998888', push_name: 'Gustavo', is_admin: true, is_lid: false, lid: '166730898927796',
      avatar_key: 'group-avatars/7/5531999998888.jpg',
      bloquim_user_id: 'u-1', bloquim_name: 'Gustavo Azevedo',
      last_seen_at: new Date('2026-08-10T12:00:00Z'),
    }] }),
  } as any;
  const [p] = await listParticipants(pool, 7);
  assert.equal(p.phone, '+5531999998888');
  assert.equal(p.isAdmin, true);
  assert.equal(p.bloquimName, 'Gustavo Azevedo');
  assert.equal(p.lid, '166730898927796');
  assert.equal(p.lastSeenAt, '2026-08-10T12:00:00.000Z');
});

test('listParticipants mapeia lid nulo pra null', async () => {
  const pool = {
    query: async () => ({ rows: [{
      phone: '+5531999998888', push_name: null, is_admin: false, is_lid: false, lid: null,
      last_seen_at: new Date('2026-08-10T12:00:00Z'),
    }] }),
  } as any;
  const [p] = await listParticipants(pool, 7);
  assert.equal(p.lid, null);
});

// Quem saiu do grupo tem last_seen_at do sync ANTERIOR, menor que o
// participants_synced_at que o upsert do grupo acabou de gravar. É esse o
// marcador de "roster visto agora" — deliberadamente NÃO é `updated_at`
// (esse avança em todo sync de subject, mesmo sem tocar participante nenhum;
// usá-lo esvaziaria o roster a cada reconexão que não pediu participantes).
test('listParticipants filtra por last_seen_at >= participants_synced_at do grupo', async () => {
  let sql = '';
  const pool = { query: async (s: string) => { sql = s; return { rows: [] }; } } as any;
  await listParticipants(pool, 7);
  assert.match(sql, /whatsapp_groups/);
  assert.match(sql, /last_seen_at\s*>=\s*g\.participants_synced_at/);
});

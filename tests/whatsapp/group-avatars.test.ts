/**
 * tests/whatsapp/group-avatars.test.ts — DB-free.
 * O que importa: a key é determinística (retry sobrescreve o mesmo objeto, não
 * cria lixo), o orçamento é respeitado (um sweep sem teto satura o rate limit da
 * Evolution) e "sem foto" é resultado LEGÍTIMO — grava o carimbo pra não
 * re-tentar todo ciclo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avatarKey, sweepGroupAvatars } from '../../src/whatsapp/group-avatars.js';

// A key é por PESSOA, não por participação: a mesma pessoa em 40 grupos tem UMA
// foto, uma busca e um objeto no R2.
test('avatarKey é determinística, por telefone, só dígitos', () => {
  assert.equal(avatarKey('+5531999998888'), 'group-avatars/5531999998888.jpg');
  assert.equal(avatarKey('5531999998888'), 'group-avatars/5531999998888.jpg');
});

function poolWithCandidates(rows: any[]) {
  const updates: Array<{ sql: string; params: any[] }> = [];
  const pool = {
    query: async (sql: string, params: any[]) => {
      if (sql.trim().startsWith('SELECT')) {
        assert.match(sql, /LIMIT \$1/, 'o orçamento tem que ir pro SQL, não filtrar em JS');
        assert.match(sql, /DISTINCT ON \(phone\)/, 'a fila conta pessoas, não participações');
        return { rows: rows.slice(0, params[0]) };
      }
      updates.push({ sql, params });
      return { rows: [] };
    },
  } as any;
  return { pool, updates };
}

const CAND = { phone: '+5531999998888' };

test('sweep respeita o orçamento (passa o teto pro LIMIT)', async () => {
  const { pool } = poolWithCandidates([CAND, { phone: '+5531988887777' }, { phone: '+5531977776666' }]);
  const out = await sweepGroupAvatars(pool, {} as any, 'inst', 2, {
    fetchUrl: async () => null,
    download: async () => Buffer.alloc(0),
    upload: async () => {},
  });
  assert.equal(out.attempted, 2);
});

test('sweep com orçamento 0 não faz nada', async () => {
  const pool = { query: async () => { throw new Error('não deveria consultar'); } } as any;
  const out = await sweepGroupAvatars(pool, {} as any, 'inst', 0, {
    fetchUrl: async () => null, download: async () => Buffer.alloc(0), upload: async () => {},
  });
  assert.deepEqual(out, { attempted: 0, stored: 0, missing: 0, failed: 0 });
});

test('foto encontrada → upload + grava avatar_key e zera tentativas', async () => {
  const { pool, updates } = poolWithCandidates([CAND]);
  const uploaded: string[] = [];
  const out = await sweepGroupAvatars(pool, {} as any, 'inst', 5, {
    fetchUrl: async () => 'https://cdn/pic.jpg',
    download: async () => Buffer.from('img'),
    upload: async (key) => { uploaded.push(key); },
  });
  assert.deepEqual(uploaded, ['group-avatars/5531999998888.jpg']);
  assert.equal(out.stored, 1);
  assert.match(updates[0].sql, /avatar_key = \$2/);
  assert.match(updates[0].sql, /avatar_attempts = 0/);
  // Uma busca serve todas as participações daquela pessoa.
  assert.match(updates[0].sql, /WHERE phone = \$1/);
});

test('sem foto pública → grava carimbo com key nula (não re-tenta todo ciclo)', async () => {
  const { pool, updates } = poolWithCandidates([CAND]);
  const out = await sweepGroupAvatars(pool, {} as any, 'inst', 5, {
    fetchUrl: async () => null, download: async () => Buffer.alloc(0), upload: async () => {},
  });
  assert.equal(out.missing, 1);
  assert.equal(out.stored, 0);
  assert.match(updates[0].sql, /avatar_fetched_at = NOW\(\)/);
  assert.match(updates[0].sql, /avatar_key = NULL/);
});

// A fila é por avatar_fetched_at, NÃO por "avatar_key IS NULL". Um predicado
// baseado na key re-selecionaria em todo run quem já foi confirmado sem foto —
// exatamente o que o carimbo do teste acima tenta evitar.
test('a fila elege por avatar_fetched_at, não pela ausência de avatar_key', async () => {
  let sql = '';
  const pool = {
    query: async (s: string, p: any[]) => {
      if (s.trim().startsWith('SELECT')) { sql = s; return { rows: [] }; }
      return { rows: [] };
    },
  } as any;
  await sweepGroupAvatars(pool, {} as any, 'inst', 5, {
    fetchUrl: async () => null, download: async () => Buffer.alloc(0), upload: async () => {},
  });
  assert.match(sql, /avatar_fetched_at IS NULL/);
  assert.doesNotMatch(sql, /avatar_key IS NULL/);
});

// Mesmo argumento de group-identity.ts: um LID de privacidade não é telefone.
// `fetchProfilePictureUrl(number)` com um LID queima orçamento à toa e pode
// trazer a foto de OUTRA pessoa.
test('a fila exclui participantes is_lid', async () => {
  let sql = '';
  const pool = {
    query: async (s: string) => {
      if (s.trim().startsWith('SELECT')) { sql = s; return { rows: [] }; }
      return { rows: [] };
    },
  } as any;
  await sweepGroupAvatars(pool, {} as any, 'inst', 5, {
    fetchUrl: async () => null, download: async () => Buffer.alloc(0), upload: async () => {},
  });
  assert.match(sql, /is_lid = FALSE/);
});

test('erro na Evolution → incrementa avatar_attempts e o sweep continua', async () => {
  const { pool, updates } = poolWithCandidates([CAND, { phone: '+5531988887777' }]);
  let calls = 0;
  const out = await sweepGroupAvatars(pool, {} as any, 'inst', 5, {
    fetchUrl: async () => { calls++; if (calls === 1) throw new Error('502'); return null; },
    download: async () => Buffer.alloc(0), upload: async () => {},
  });
  assert.equal(out.failed, 1);
  assert.equal(out.missing, 1, 'o segundo candidato ainda foi processado');
  assert.match(updates[0].sql, /avatar_attempts = whatsapp_group_participants\.avatar_attempts \+ 1/);
});

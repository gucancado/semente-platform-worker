import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processMediaJob, type MediaIo, type MediaProcessDeps } from '../../src/whatsapp/media-service.js';
import type { WhatsappMediaJob } from '../../src/whatsapp/media-jobs.js';

type Row = { media_mime: string | null; media_filename: string | null; media_key: string | null; media_status: string | null };

function fakePool(msg: Row | null) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      const flat = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: flat, params });
      if (flat.startsWith('SELECT media_mime')) return { rows: msg ? [msg] : [], rowCount: msg ? 1 : 0 };
      return { rows: [], rowCount: 1 };
    },
  };
  return { pool: pool as unknown as MediaProcessDeps['pool'], calls };
}

const job = (over: Partial<WhatsappMediaJob> = {}): WhatsappMediaJob => ({
  id: 7, message_id: 10, whatsapp_number_id: 1, workspace_id: 'ws-1', instance: 'ws-1-abc',
  evolution_event_id: 'EV', kind: 'image', raw_envelope: { key: { id: 'EV' } }, status: 'pending',
  attempts: 1, created_at: new Date('2026-09-16T10:00:00Z'), ...over,
});
const pendingImage: Row = { media_mime: 'image/jpeg', media_filename: null, media_key: null, media_status: 'pending' };

function io(over: Partial<MediaIo> = {}) {
  const uploads: { key: string; size: number; contentType: string }[] = [];
  let downloads = 0;
  const value: MediaIo = {
    download: async () => { downloads += 1; return { base64: Buffer.from('abc').toString('base64'), mimetype: 'image/jpeg' }; },
    upload: async (key, body, contentType) => { uploads.push({ key, size: body.length, contentType }); },
    ...over,
  };
  return { value, uploads, downloads: () => downloads };
}

function deps(pool: MediaProcessDeps['pool'], mediaIo: MediaIo, over: Partial<MediaProcessDeps> = {}): MediaProcessDeps {
  return { pool, io: mediaIo, maxBytes: 1024, maxAttempts: 4, now: () => new Date('2026-09-16T11:00:00Z'), ...over };
}

test('baixa, sobe e grava a key ANTES de fechar o job', async () => {
  const { pool, calls } = fakePool(pendingImage);
  const fake = io();
  const out = await processMediaJob(deps(pool, fake.value), job());
  assert.equal(out, 'stored');
  assert.deepEqual(fake.uploads, [{ key: 'whatsapp-media/ws-1/1/10.jpg', size: 3, contentType: 'image/jpeg' }]);
  const msgUpdate = calls.findIndex((c) => c.sql.startsWith('UPDATE messages SET media_key'));
  const jobDone = calls.findIndex((c) => c.sql.includes("SET status = 'done'"));
  assert.ok(msgUpdate > 0 && jobDone > msgUpdate, 'mensagem atualizada antes do job sair da fila');
  assert.deepEqual(calls[msgUpdate]!.params, [10, 'whatsapp-media/ws-1/1/10.jpg', 'image/jpeg', 3]);
});

test('mensagem já resolvida não baixa de novo (crash entre as duas escritas)', async () => {
  const { pool, calls } = fakePool({ ...pendingImage, media_key: 'whatsapp-media/ws-1/1/10.jpg', media_status: 'stored' });
  const fake = io();
  const out = await processMediaJob(deps(pool, fake.value), job());
  assert.equal(out, 'already_resolved');
  assert.equal(fake.downloads(), 0);
  assert.ok(calls.some((c) => c.sql.includes("SET status = 'done'")));
});

test('arquivo real acima do teto não sobe, mesmo com tamanho declarado menor', async () => {
  const { pool, calls } = fakePool(pendingImage);
  const fake = io();
  const out = await processMediaJob(deps(pool, fake.value, { maxBytes: 2 }), job());
  assert.equal(out, 'skipped_size');
  assert.equal(fake.uploads.length, 0);
  assert.ok(calls.some((c) => c.sql.includes("media_status = 'skipped_size'") && c.params[1] === 3));
});

test('base64 vazio consome tentativa e volta pra fila', async () => {
  const { pool, calls } = fakePool(pendingImage);
  let systemic = 0;
  const fake = io({ download: async () => ({ base64: '', mimetype: null }) });
  const out = await processMediaJob(deps(pool, fake.value, { onSystemicFailure: () => { systemic += 1; } }), job({ attempts: 1 }));
  assert.equal(out, 'retry');
  assert.equal(systemic, 0);
  const retry = calls.find((c) => c.sql.includes("SET status = 'pending'"))!;
  assert.match(retry.sql, /attempts = attempts,/);
  assert.equal(retry.params[1], '60');
});

test('Evolution fora (503) não consome tentativa e avisa o disjuntor', async () => {
  const { pool, calls } = fakePool(pendingImage);
  let systemic = 0;
  const fake = io({ download: async () => { throw new Error('Evolution POST /chat/getBase64FromMediaMessage/ws-4001-x → 503'); } });
  const out = await processMediaJob(deps(pool, fake.value, { onSystemicFailure: () => { systemic += 1; } }), job());
  assert.equal(out, 'retry');
  assert.equal(systemic, 1);
  const retry = calls.find((c) => c.sql.includes("SET status = 'pending'"))!;
  assert.match(retry.sql, /GREATEST\(attempts - 1, 0\)/);
  assert.equal(retry.params[1], '900');
});

test('falha do arquivo na última tentativa marca a mensagem como failed', async () => {
  const { pool, calls } = fakePool(pendingImage);
  const fake = io({ download: async () => { throw new Error('Evolution POST /chat/getBase64FromMediaMessage/ws-500a → 400'); } });
  const out = await processMediaJob(deps(pool, fake.value), job({ attempts: 4 }));
  assert.equal(out, 'failed');
  assert.ok(calls.some((c) => c.sql.includes("SET status = 'failed'")));
  assert.ok(calls.some((c) => c.sql === "UPDATE messages SET media_status = 'failed' WHERE id = $1"));
});

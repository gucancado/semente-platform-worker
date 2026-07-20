// tests/meetings-collect/queue-db.db.test.ts
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import {
  createCollectedMeeting, countActiveCollections, listQueuedMeetings, updateCollectedMeeting,
} from '../../src/meetings-collect/db.js';

beforeEach(async () => {
  await pool.query('TRUNCATE collected_meetings, facts, episode_turns, episodes RESTART IDENTITY CASCADE');
});
after(() => pool.end());

test('create nasce queued com title e expiração; fila é FIFO', async () => {
  const exp = new Date('2026-07-21T15:00:00Z');
  const a = await createCollectedMeeting(pool, { meetCode: 'aaa-bbbb-ccc', workspaceId: 'ws-1', requestedBy: 'u1', title: 'Hoenka + BeeAds', queueExpiresAt: exp });
  assert.equal(a.status, 'queued');
  assert.equal(a.title, 'Hoenka + BeeAds');
  assert.equal(a.queue_expires_at?.toISOString(), exp.toISOString());
  const b = await createCollectedMeeting(pool, { meetCode: 'ddd-eeee-fff', workspaceId: null, requestedBy: 'u1' });
  assert.equal(b.title, null);
  const fila = await listQueuedMeetings(pool);
  assert.deepEqual(fila.map((r) => r.meet_code), ['aaa-bbbb-ccc', 'ddd-eeee-fff']);
});

test('countActiveCollections conta só collecting/stopping', async () => {
  const a = await createCollectedMeeting(pool, { meetCode: 'aaa-bbbb-ccc', workspaceId: null, requestedBy: 'u1' });
  assert.equal(await countActiveCollections(pool), 0); // queued não conta
  await updateCollectedMeeting(pool, a.id, { status: 'collecting' });
  assert.equal(await countActiveCollections(pool), 1);
  await updateCollectedMeeting(pool, a.id, { status: 'imported' });
  assert.equal(await countActiveCollections(pool), 0);
});

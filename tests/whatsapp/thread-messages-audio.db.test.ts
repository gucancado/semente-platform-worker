import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, insertMessage } from '../../src/db.js';
import { listThreadMessages } from '../../src/whatsapp/read-queries.js';

beforeEach(async () => {
  await pool.query('TRUNCATE messages, whatsapp_numbers RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO whatsapp_numbers (id, workspace_id, evolution_instance) VALUES (1,'ws-1','inst-1')`);
});
after(() => pool.end());

test('listThreadMessages devolve id/kind/transcriptionStatus/hasMedia', async () => {
  const m = await insertMessage({ agent: null, channel: 'whatsapp', identifier: '+55a', direction: 'inbound', text: '[áudio]', evolution_event_id: 'E1', whatsapp_number_id: 1, workspace_id: 'ws-1', kind: 'audio', media_mime: 'audio/ogg', media_duration_s: 4, transcription_status: 'pending' });
  await pool.query(`UPDATE messages SET media_key='k/1.ogg' WHERE id=$1`, [m.id]);
  const { messages } = await listThreadMessages(pool, { workspaceId: 'ws-1', numberId: 1, identifier: '+55a', limit: 10 });
  const row = messages[0] as any;
  // Msg.id é number (read-queries embrulha o BIGINT em Number()); insertMessage
  // devolve o BIGINT cru do node-postgres como string ('1'). Comparar como number.
  assert.equal(row.id, Number(m.id));
  assert.equal(row.kind, 'audio');
  assert.equal(row.transcriptionStatus, 'pending');
  assert.equal(row.hasMedia, true);
});

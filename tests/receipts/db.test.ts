import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../../src/db.js';
import {
  insertReceipt,
  claimDueReceipts,
  markReceiptRetryOrDead,
  markReceiptProcessed,
} from '../../src/receipts/db.js';

beforeEach(async () => {
  await pool.query('TRUNCATE webhook_receipts RESTART IDENTITY CASCADE');
});

after(() => pool.end());

// ── Case 1: Idempotência ──────────────────────────────────────────────────────
test('insertReceipt: duplicata retorna {duplicate:true} com mesmo id', async () => {
  const first = await insertReceipt({
    provider: 'recall',
    external_event_id: 'evt-001',
    payload: { foo: 'bar' },
  });
  assert.equal(first.duplicate, false);
  assert.ok(first.id > 0);

  const second = await insertReceipt({
    provider: 'recall',
    external_event_id: 'evt-001',
    payload: { foo: 'bar' },
  });
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);
});

// ── Case 2: Claim com lease ───────────────────────────────────────────────────
test('claimDueReceipts: claim incrementa attempt_count; segundo claim imediato retorna []', async () => {
  await insertReceipt({
    provider: 'recall',
    external_event_id: 'evt-002',
    payload: { x: 1 },
  });

  const batch1 = await claimDueReceipts('w1');
  assert.equal(batch1.length, 1);
  assert.equal(batch1[0]!.attempt_count, 1);
  assert.equal(batch1[0]!.claimed_by, 'w1');
  assert.ok(batch1[0]!.claimed_at !== null);

  const batch2 = await claimDueReceipts('w2');
  assert.equal(batch2.length, 0);
});

// ── Case 3: markReceiptRetryOrDead ────────────────────────────────────────────
test('markReceiptRetryOrDead: abaixo do max → {dead:false} status=failed com next_attempt futuro; no max → {dead:true} status=dead', async () => {
  const { id } = await insertReceipt({
    provider: 'recall',
    external_event_id: 'evt-003',
    payload: { y: 2 },
  });

  // currentAttempt=1, maxAttempts=3 → não morreu ainda
  const r1 = await markReceiptRetryOrDead(id, 1, 3, 'timeout');
  assert.equal(r1.dead, false);

  const { rows: [row1] } = await pool.query(
    `SELECT status, next_attempt_at FROM webhook_receipts WHERE id=$1`, [id]
  );
  assert.equal(row1!.status, 'failed');
  assert.ok(new Date(row1!.next_attempt_at) > new Date(), 'next_attempt_at deve ser no futuro');

  // currentAttempt=3, maxAttempts=3 → morreu
  const r2 = await markReceiptRetryOrDead(id, 3, 3, 'fatal');
  assert.equal(r2.dead, true);

  const { rows: [row2] } = await pool.query(
    `SELECT status, last_error FROM webhook_receipts WHERE id=$1`, [id]
  );
  assert.equal(row2!.status, 'dead');
  assert.equal(row2!.last_error, 'fatal');
});

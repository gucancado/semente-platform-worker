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
  const { id: idRetry } = await insertReceipt({
    provider: 'recall',
    external_event_id: 'evt-003a',
    payload: { y: 2 },
  });

  const claimedRetry = await claimDueReceipts('w1');
  assert.equal(claimedRetry.length, 1);
  const rowRetry = claimedRetry[0]!;

  // currentAttempt=1, maxAttempts=3 → não morreu ainda
  const r1 = await markReceiptRetryOrDead(idRetry, rowRetry.attempt_count, 3, 'timeout', rowRetry.claimed_by!, rowRetry.attempt_count);
  assert.equal(r1.dead, false);
  assert.equal(r1.stale, undefined);

  const { rows: [row1] } = await pool.query(
    `SELECT status, next_attempt_at FROM webhook_receipts WHERE id=$1`, [idRetry]
  );
  assert.equal(row1!.status, 'failed');
  assert.ok(new Date(row1!.next_attempt_at) > new Date(), 'next_attempt_at deve ser no futuro');

  // Usar um segundo receipt para testar o caminho dead (evita esperar next_attempt_at)
  const { id: idDead } = await insertReceipt({
    provider: 'recall',
    external_event_id: 'evt-003b',
    payload: { y: 3 },
  });
  const claimedDead = await claimDueReceipts('w1');
  assert.equal(claimedDead.length, 1);
  const rowDead = claimedDead[0]!;

  // currentAttempt>=maxAttempts → morreu
  const r2 = await markReceiptRetryOrDead(idDead, 3, 3, 'fatal', rowDead.claimed_by!, rowDead.attempt_count);
  assert.equal(r2.dead, true);

  const { rows: [row2] } = await pool.query(
    `SELECT status, last_error FROM webhook_receipts WHERE id=$1`, [idDead]
  );
  assert.equal(row2!.status, 'dead');
  assert.equal(row2!.last_error, 'fatal');
});

// ── Case 4: stale-write guard ─────────────────────────────────────────────────
test('markReceiptProcessed com attempt_count stale retorna false e status inalterado', async () => {
  const { id } = await insertReceipt({
    provider: 'recall',
    external_event_id: 'evt-004',
    payload: { z: 3 },
  });

  const claimed = await claimDueReceipts('w1');
  assert.equal(claimed.length, 1);
  const row = claimed[0]!;

  // Chamar com attempt_count+1 (stale)
  const ok = await markReceiptProcessed(id, row.claimed_by!, row.attempt_count + 1);
  assert.equal(ok, false);

  // Status deve continuar sendo 'received' (não 'processed')
  const { rows: [current] } = await pool.query(
    `SELECT status FROM webhook_receipts WHERE id=$1`, [id]
  );
  assert.equal(current!.status, 'received');
});

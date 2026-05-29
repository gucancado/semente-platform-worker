import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileMeetings } from '../../../src/goals/scheduling/reconcile.js';

const NOW = new Date('2026-05-29T12:00:00-03:00');
const FIXED_NOW = () => NOW;

function makeLogger() {
  const calls = { info: [] as any[], warn: [] as any[], error: [] as any[] };
  return {
    logger: {
      info: (...a: any[]) => calls.info.push(a),
      warn: (...a: any[]) => calls.warn.push(a),
      error: (...a: any[]) => calls.error.push(a),
    },
    calls,
  };
}

/** Pool stub que captura todas as queries (pool + client da txn). */
function makePool(handlers: Array<{ matcher: RegExp; result: any }>) {
  const captured: Array<{ via: 'pool' | 'client'; sql: string; params: any[] }> = [];
  function dispatch(sql: string, _params: any[] = []) {
    for (const h of handlers) if (h.matcher.test(sql)) return h.result;
    return { rows: [], rowCount: 0 };
  }
  return {
    pool: {
      query: async (sql: string, params: any[] = []) => {
        captured.push({ via: 'pool', sql, params });
        return dispatch(sql, params);
      },
      connect: async () => ({
        query: async (sql: string, params: any[] = []) => {
          captured.push({ via: 'client', sql, params });
          return dispatch(sql, params);
        },
        release: () => {},
      }),
    } as any,
    captured,
  };
}

test('scan vazio retorna zeros e não chama UPDATE', async () => {
  const { pool, captured } = makePool([
    { matcher: /SELECT[\s\S]*FROM meetings/i, result: { rows: [], rowCount: 0 } },
  ]);
  const { logger } = makeLogger();
  const result = await reconcileMeetings({
    pool,
    getConn: async () => null,
    getAgenda: async () => null,
    getEvent: async () => null,
    now: FIXED_NOW,
    logger,
  });
  assert.deepEqual(result, { scanned: 0, cancelled: 0, moved: 0, skipped: 0 });
  assert.ok(!captured.some((c) => /UPDATE meetings/i.test(c.sql)));
});

test('SELECT filtra status IN scheduled|rescheduled e google_event_id NOT NULL', async () => {
  const { pool, captured } = makePool([
    { matcher: /SELECT[\s\S]*FROM meetings/i, result: { rows: [], rowCount: 0 } },
  ]);
  const { logger } = makeLogger();
  await reconcileMeetings({
    pool,
    getConn: async () => null,
    getAgenda: async () => null,
    getEvent: async () => null,
    now: FIXED_NOW,
    logger,
  });
  const selectSql = captured.find((c) => /SELECT[\s\S]*FROM meetings/i.test(c.sql))?.sql ?? '';
  assert.ok(selectSql.includes("'scheduled'"));
  assert.ok(selectSql.includes("'rescheduled'"));
  assert.ok(/google_event_id IS NOT NULL/i.test(selectSql));
  assert.ok(/JOIN projects/i.test(selectSql));
});

function meetingFixture(overrides: Partial<any> = {}): any {
  return {
    id: 17,
    project_id: 1,
    channel: 'whatsapp',
    identifier: '5531999998888',
    slot_iso: '2026-05-30T10:00:00-03:00',
    google_event_id: 'evt-1',
    status: 'scheduled',
    agent: 'mercurio',
    project_slug: 'metido-a-gente',
    ...overrides,
  };
}

const fakeConn: any = { project_id: 1, scopes: [], google_email: 'x@y' };
const fakeAgenda: any = { id: 1, project_id: 1, person_email: 'closer@beeads.com.br', active: true };

test('event.status="cancelled" dispara handleCancelled (UPDATE + enqueueReconcileTrigger)', async () => {
  const m = meetingFixture();
  const { pool, captured } = makePool([
    { matcher: /SELECT[\s\S]*FROM meetings/i, result: { rows: [m], rowCount: 1 } },
    { matcher: /^BEGIN/i, result: { rows: [] } },
    { matcher: /UPDATE meetings/i, result: { rowCount: 1, rows: [] } },
    { matcher: /INSERT INTO pending_triggers/i, result: { rows: [{ id: 99 }], rowCount: 1 } },
    { matcher: /^COMMIT/i, result: { rows: [] } },
    { matcher: /UPDATE meetings.*last_reconciled_at/i, result: { rowCount: 1, rows: [] } },
  ]);
  const { logger } = makeLogger();

  const result = await reconcileMeetings({
    pool,
    getConn: async () => fakeConn,
    getAgenda: async () => fakeAgenda,
    getEvent: async () => ({ id: 'evt-1', status: 'cancelled', start: { dateTime: m.slot_iso } } as any),
    now: FIXED_NOW,
    logger,
  });

  assert.equal(result.cancelled, 1);
  assert.equal(result.moved, 0);
  assert.equal(result.skipped, 0);

  const updateStatusCall = captured.find((c) =>
    /UPDATE meetings[\s\S]*cancelled_by_organizer/i.test(c.sql),
  );
  assert.ok(updateStatusCall, 'deve UPDATE status cancelled_by_organizer');
  assert.ok(updateStatusCall!.params.includes(m.id));

  const insertCall = captured.find((c) => /INSERT INTO pending_triggers/i.test(c.sql));
  assert.ok(insertCall, 'deve INSERT pending_triggers');
  const payload = insertCall!.params.find((p: any) => typeof p === 'object' && p?.event === 'cancelled_by_organizer');
  assert.ok(payload, 'payload com event=cancelled_by_organizer');
  assert.equal(payload.meeting_id, m.id);
  assert.equal(payload.old_slot_iso, m.slot_iso);

  // O INSERT deve usar o client da txn (não pool direto)
  assert.equal(insertCall!.via, 'client');
});

test('getEvent=null (404/410) também dispara handleCancelled', async () => {
  const m = meetingFixture({ id: 18, google_event_id: 'evt-404' });
  const { pool } = makePool([
    { matcher: /SELECT[\s\S]*FROM meetings/i, result: { rows: [m], rowCount: 1 } },
    { matcher: /^BEGIN|UPDATE meetings|INSERT INTO pending_triggers|^COMMIT|UPDATE meetings.*last_reconciled_at/i, result: { rowCount: 1, rows: [{ id: 1 }] } },
  ]);
  const { logger } = makeLogger();
  const result = await reconcileMeetings({
    pool,
    getConn: async () => fakeConn,
    getAgenda: async () => fakeAgenda,
    getEvent: async () => null,
    now: FIXED_NOW,
    logger,
  });
  assert.equal(result.cancelled, 1);
  assert.equal(result.skipped, 0);
});

test('start.dateTime diferente dispara handleMoved (UPDATE slot_iso + trigger moved)', async () => {
  const m = meetingFixture({ id: 19, slot_iso: '2026-05-30T10:00:00-03:00' });
  const newIso = '2026-05-30T14:00:00-03:00';
  const { pool, captured } = makePool([
    { matcher: /SELECT[\s\S]*FROM meetings/i, result: { rows: [m], rowCount: 1 } },
    { matcher: /^BEGIN|^COMMIT/i, result: { rows: [] } },
    { matcher: /UPDATE meetings(?![\s\S]*last_reconciled_at)/i, result: { rowCount: 1, rows: [] } },
    { matcher: /INSERT INTO pending_triggers/i, result: { rows: [{ id: 1 }], rowCount: 1 } },
    { matcher: /UPDATE meetings.*last_reconciled_at/i, result: { rowCount: 1, rows: [] } },
  ]);
  const { logger } = makeLogger();
  const result = await reconcileMeetings({
    pool,
    getConn: async () => fakeConn,
    getAgenda: async () => fakeAgenda,
    getEvent: async () => ({ id: 'x', status: 'confirmed', start: { dateTime: newIso } } as any),
    now: FIXED_NOW,
    logger,
  });
  assert.equal(result.moved, 1);
  assert.equal(result.cancelled, 0);

  const updateSlot = captured.find((c) => /rescheduled_by_organizer/i.test(c.sql));
  assert.ok(updateSlot);
  const ps = JSON.stringify(updateSlot!.params);
  assert.ok(ps.includes(newIso));

  const insertCall = captured.find((c) => /INSERT INTO pending_triggers/i.test(c.sql));
  const payload = insertCall!.params.find((p: any) => typeof p === 'object' && p?.event === 'moved_by_organizer');
  assert.ok(payload);
  assert.equal(payload.meeting_id, m.id);
  assert.equal(payload.old_slot_iso, m.slot_iso);
  assert.equal(payload.new_slot_iso, newIso);
});

test('mesmo instante em offsets diferentes (-03 vs Z) NÃO dispara moved', async () => {
  const m = meetingFixture({ id: 20, slot_iso: '2026-05-30T10:00:00-03:00' });
  const sameInstant = '2026-05-30T13:00:00.000Z';
  const { pool } = makePool([
    { matcher: /SELECT[\s\S]*FROM meetings/i, result: { rows: [m], rowCount: 1 } },
    { matcher: /UPDATE meetings.*last_reconciled_at/i, result: { rowCount: 1, rows: [] } },
  ]);
  const { logger } = makeLogger();
  const result = await reconcileMeetings({
    pool,
    getConn: async () => fakeConn,
    getAgenda: async () => fakeAgenda,
    getEvent: async () => ({ id: 'x', status: 'confirmed', start: { dateTime: sameInstant } } as any),
    now: FIXED_NOW,
    logger,
  });
  assert.equal(result.moved, 0);
  assert.equal(result.cancelled, 0);
  assert.equal(result.skipped, 0);
});

test('sem conn → skipped, sem getEvent', async () => {
  const m = meetingFixture({ id: 21 });
  const { pool, captured } = makePool([
    { matcher: /SELECT[\s\S]*FROM meetings/i, result: { rows: [m], rowCount: 1 } },
    { matcher: /UPDATE meetings.*last_reconciled_at/i, result: { rowCount: 1, rows: [] } },
  ]);
  const { logger } = makeLogger();
  let getEventCalled = false;
  const result = await reconcileMeetings({
    pool,
    getConn: async () => null,
    getAgenda: async () => fakeAgenda,
    getEvent: async () => { getEventCalled = true; return null; },
    now: FIXED_NOW,
    logger,
  });
  assert.equal(result.skipped, 1);
  assert.equal(getEventCalled, false);
  assert.ok(!captured.some((c) => /cancelled_by_organizer|rescheduled_by_organizer/.test(c.sql)));
});

test('sem agenda → skipped', async () => {
  const m = meetingFixture({ id: 22 });
  const { pool } = makePool([
    { matcher: /SELECT[\s\S]*FROM meetings/i, result: { rows: [m], rowCount: 1 } },
    { matcher: /UPDATE meetings.*last_reconciled_at/i, result: { rowCount: 1, rows: [] } },
  ]);
  const { logger } = makeLogger();
  const result = await reconcileMeetings({
    pool,
    getConn: async () => fakeConn,
    getAgenda: async () => null,
    getEvent: async () => null,
    now: FIXED_NOW,
    logger,
  });
  assert.equal(result.skipped, 1);
});

test('getEvent throws (não-404) → skipped, logger.warn chamado, outras meetings prosseguem', async () => {
  const ok = meetingFixture({ id: 30, google_event_id: 'evt-ok' });
  const fail = meetingFixture({ id: 31, google_event_id: 'evt-fail' });
  const { pool } = makePool([
    { matcher: /SELECT[\s\S]*FROM meetings/i, result: { rows: [ok, fail], rowCount: 2 } },
    { matcher: /^BEGIN|^COMMIT|INSERT INTO pending_triggers|UPDATE meetings(?![\s\S]*last_reconciled_at)/i, result: { rowCount: 1, rows: [{ id: 1 }] } },
    { matcher: /UPDATE meetings.*last_reconciled_at/i, result: { rowCount: 2, rows: [] } },
  ]);
  const { logger, calls } = makeLogger();
  const result = await reconcileMeetings({
    pool,
    getConn: async () => fakeConn,
    getAgenda: async () => fakeAgenda,
    getEvent: async (_c, _cal, evtId) => {
      if (evtId === 'evt-fail') throw new Error('token_revoked');
      return null; // ok = cancelled
    },
    now: FIXED_NOW,
    logger,
  });
  assert.equal(result.cancelled, 1);
  assert.equal(result.skipped, 1);
  assert.ok(calls.warn.length >= 1);
});

test('INSERT pending_triggers falha → ROLLBACK + erro propaga', async () => {
  const m = meetingFixture({ id: 40 });
  const captured: Array<{ sql: string }> = [];
  const fakePool: any = {
    query: async (sql: string) => {
      captured.push({ sql });
      if (/SELECT[\s\S]*FROM meetings/i.test(sql)) return { rows: [m], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: async (sql: string) => {
        captured.push({ sql });
        if (/INSERT INTO pending_triggers/i.test(sql)) throw new Error('boom');
        return { rowCount: 1, rows: [] };
      },
      release: () => {},
    }),
  };
  const { logger } = makeLogger();
  await assert.rejects(
    () => reconcileMeetings({
      pool: fakePool,
      getConn: async () => fakeConn,
      getAgenda: async () => fakeAgenda,
      getEvent: async () => null, // dispara handleCancelled
      now: FIXED_NOW,
      logger,
    }),
    /boom/,
  );
  const sqls = captured.map((c) => c.sql.trim().toUpperCase());
  assert.ok(sqls.some((s) => s.startsWith('BEGIN')));
  assert.ok(sqls.some((s) => s.startsWith('ROLLBACK')));
  assert.ok(!sqls.some((s) => s.startsWith('COMMIT')));
});

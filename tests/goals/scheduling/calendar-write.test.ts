import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.GOOGLE_OAUTH_CLIENT_ID = 'fake-client-id';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'fake-client-secret';
process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost:3001/cb';
process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.from('a'.repeat(32)).toString('base64');
process.env.GOOGLE_OAUTH_STATE_SECRET = 'state-secret-at-least-40-chars-long-aaaa';

type EventsApi = {
  insert: (args: unknown) => Promise<{ data: { id?: string; conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] } } }>;
  patch: (args: unknown) => Promise<{ data: { conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] } } }>;
  delete: (args: unknown) => Promise<void>;
};

let insertCalls: unknown[] = [];
let patchCalls: unknown[] = [];
let deleteCalls: unknown[] = [];
let insertResponse: { id?: string; conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] } } = {};
let patchResponse: { conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] } } = {};
let deleteError: { code?: number } | null = null;

const fakeEvents: EventsApi = {
  insert: async (args) => { insertCalls.push(args); return { data: insertResponse }; },
  patch: async (args) => { patchCalls.push(args); return { data: patchResponse }; },
  delete: async (args) => {
    deleteCalls.push(args);
    if (deleteError) throw deleteError;
  },
};

const fakeCal = { events: fakeEvents };

const {
  createHold,
  confirmHold,
  createEventDirect,
  patchEvent,
  deleteEvent,
  _setCalClientFactory,
} = await import('../../../src/goals/scheduling/calendar-write.js');

// Inject fake cal client factory — bypasses auth + googleapis entirely
_setCalClientFactory(async () => fakeCal as unknown as import('googleapis').calendar_v3.Calendar);

const FAKE_CONN = {
  id: 1, project_id: 1, google_email: 'agent@beeads.com.br',
  refresh_token_encrypted: Buffer.from('x'), scopes: [], connected_at: new Date(),
  last_refresh_at: null, last_error: null,
} as Parameters<typeof createHold>[0];

beforeEach(() => {
  insertCalls = [];
  patchCalls = [];
  deleteCalls = [];
  insertResponse = {};
  patchResponse = {};
  deleteError = null;
});

afterEach(() => {
  // keep factory in place — all tests in this file share it
});

test('createHold: chama events.insert com status=tentative + transparency=opaque', async () => {
  insertResponse = { id: 'evt-1' };
  const result = await createHold(FAKE_CONN, {
    calendarId: 'rod@x.com',
    slotIso: '2026-06-02T10:00:00-03:00',
    durationMin: 30,
    label: '[HOLD] whatsapp:+5531999',
  });
  assert.equal(result.eventId, 'evt-1');
  assert.equal(insertCalls.length, 1);
  const args = insertCalls[0] as { calendarId: string; requestBody: { status?: string; transparency?: string; summary?: string } };
  assert.equal(args.calendarId, 'rod@x.com');
  assert.equal(args.requestBody.status, 'tentative');
  assert.equal(args.requestBody.transparency, 'opaque');
  assert.equal(args.requestBody.summary, '[HOLD] whatsapp:+5531999');
});

test('confirmHold: chama events.patch com conferenceDataVersion=1 + sendUpdates=all', async () => {
  patchResponse = { conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc' }] } };
  const result = await confirmHold(FAKE_CONN, 'rod@x.com', 'evt-1', {
    attendees: ['lead@x.com', 'rod@x.com'],
    summary: 'Conversa com Rodrigo',
    description: 'contexto',
    conferenceRequestId: 'req-1',
  });
  assert.equal(result.meetLink, 'https://meet.google.com/abc');
  const args = patchCalls[0] as { conferenceDataVersion: number; sendUpdates: string; calendarId: string };
  assert.equal(args.conferenceDataVersion, 1);
  assert.equal(args.sendUpdates, 'all');
  assert.equal(args.calendarId, 'rod@x.com');
});

test('confirmHold: meetLink null se sem entryPoints', async () => {
  patchResponse = {};
  const result = await confirmHold(FAKE_CONN, 'rod@x.com', 'evt-1', {
    attendees: [], summary: 'x', conferenceRequestId: 'r',
  });
  assert.equal(result.meetLink, null);
});

test('createEventDirect: chama events.insert com conferenceDataVersion=1 + status=confirmed', async () => {
  insertResponse = { id: 'evt-2', conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/xyz' }] } };
  const result = await createEventDirect(FAKE_CONN, {
    calendarId: 'rod@x.com',
    slotIso: '2026-06-02T10:00:00-03:00',
    durationMin: 45,
    label: 'Conversa',
    attendees: ['lead@x.com', 'rod@x.com'],
    summary: 'Conversa com Rodrigo',
    conferenceRequestId: 'req-x',
  });
  assert.equal(result.eventId, 'evt-2');
  assert.equal(result.meetLink, 'https://meet.google.com/xyz');
  const args = insertCalls[0] as { conferenceDataVersion: number; sendUpdates: string; requestBody: { status?: string } };
  assert.equal(args.conferenceDataVersion, 1);
  assert.equal(args.sendUpdates, 'all');
  assert.equal(args.requestBody.status, 'confirmed');
});

test('patchEvent: chama events.patch com sendUpdates=all', async () => {
  await patchEvent(FAKE_CONN, 'rod@x.com', 'evt-1', {
    startIso: '2026-06-03T10:00:00-03:00',
    endIso: '2026-06-03T10:30:00-03:00',
  });
  const args = patchCalls[0] as { sendUpdates: string; requestBody: { start?: unknown; end?: unknown } };
  assert.equal(args.sendUpdates, 'all');
  assert.ok(args.requestBody.start);
  assert.ok(args.requestBody.end);
});

test('deleteEvent: chama events.delete com sendUpdates=all', async () => {
  await deleteEvent(FAKE_CONN, 'rod@x.com', 'evt-1');
  const args = deleteCalls[0] as { sendUpdates: string };
  assert.equal(args.sendUpdates, 'all');
});

test('deleteEvent: swallows 404', async () => {
  deleteError = { code: 404 };
  await deleteEvent(FAKE_CONN, 'rod@x.com', 'evt-1');
  assert.equal(deleteCalls.length, 1);
});

test('deleteEvent: swallows 410', async () => {
  deleteError = { code: 410 };
  await deleteEvent(FAKE_CONN, 'rod@x.com', 'evt-1');
});

test('deleteEvent: propaga 500', async () => {
  deleteError = { code: 500 };
  await assert.rejects(() => deleteEvent(FAKE_CONN, 'rod@x.com', 'evt-1'));
});

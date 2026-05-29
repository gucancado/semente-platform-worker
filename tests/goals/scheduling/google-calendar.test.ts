import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.GOOGLE_OAUTH_CLIENT_ID = 'fake-client-id';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'fake-client-secret';
process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost:3001/cb';
process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.from('a'.repeat(32)).toString('base64');
process.env.GOOGLE_OAUTH_STATE_SECRET = 'state-secret-at-least-40-chars-long-aaaa';

type EventsApi = {
  get: (args: unknown) => Promise<{ data: unknown }>;
};

let getCalls: unknown[] = [];
let getResponse: unknown = {};
let getError: { code?: number } | null = null;

const fakeEvents: EventsApi = {
  get: async (args) => {
    getCalls.push(args);
    if (getError) throw getError;
    return { data: getResponse };
  },
};

const fakeCal = { events: fakeEvents };

const {
  getEvent,
  _setCalClientFactory,
} = await import('../../../src/goals/scheduling/google-calendar.js');

_setCalClientFactory(async () => fakeCal as unknown as import('googleapis').calendar_v3.Calendar);

const FAKE_CONN = {
  id: 1, project_id: 1, google_email: 'agent@beeads.com.br',
  refresh_token_encrypted: Buffer.from('x'), scopes: [], connected_at: new Date(),
  last_refresh_at: null, last_error: null,
} as Parameters<typeof getEvent>[0];

beforeEach(() => {
  getCalls = [];
  getResponse = {};
  getError = null;
});

test('getEvent retorna evento quando existe', async () => {
  const evt = { id: 'evt-1', summary: 'Reunião', status: 'confirmed' };
  getResponse = evt;
  const result = await getEvent(FAKE_CONN, 'rod@x.com', 'evt-1');
  assert.deepEqual(result, evt);
  assert.equal(getCalls.length, 1);
  const args = getCalls[0] as { calendarId: string; eventId: string };
  assert.equal(args.calendarId, 'rod@x.com');
  assert.equal(args.eventId, 'evt-1');
});

test('getEvent retorna null em 404', async () => {
  getError = { code: 404 };
  const result = await getEvent(FAKE_CONN, 'rod@x.com', 'evt-missing');
  assert.equal(result, null);
});

test('getEvent retorna null em 410', async () => {
  getError = { code: 410 };
  const result = await getEvent(FAKE_CONN, 'rod@x.com', 'evt-gone');
  assert.equal(result, null);
});

test('getEvent propaga erros não-404/410', async () => {
  getError = { code: 401 };
  await assert.rejects(() => getEvent(FAKE_CONN, 'rod@x.com', 'evt-1'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VexaClient } from '../../../src/integrations/vexa/client.js';

function fakeFetch(capture: any[], response: { status?: number; json?: unknown; text?: string }) {
  return async (url: string, init: any) => {
    capture.push({ url, init });
    return {
      ok: (response.status ?? 200) < 400,
      status: response.status ?? 200,
      json: async () => response.json ?? {},
      text: async () => response.text ?? JSON.stringify(response.json ?? {}),
    } as any;
  };
}

test('sendBot faz POST /bots com header X-API-Key e body correto', async () => {
  const calls: any[] = [];
  const meeting = { id: 7, native_meeting_id: 'abc-defg-hij', status: 'joining', start_time: null, end_time: null, segments: [] };
  const client = new VexaClient('http://vexa.local:8056', 'KEY123', fakeFetch(calls, { json: meeting }) as any);
  const out = await client.sendBot('abc-defg-hij', 'BeeAds Notetaker', 'pt');
  assert.equal(out.id, 7);
  assert.equal(calls[0].url, 'http://vexa.local:8056/bots');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['X-API-Key'], 'KEY123');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { platform: 'google_meet', native_meeting_id: 'abc-defg-hij', bot_name: 'BeeAds Notetaker', language: 'pt' });
});

test('getTranscript faz GET no path do meet e retorna o meeting', async () => {
  const calls: any[] = [];
  const meeting = { id: 7, native_meeting_id: 'abc-defg-hij', status: 'active', start_time: '2026-07-10T21:58:25.5', end_time: null, segments: [{ start: 1, end: 2, text: 'oi', language: null, speaker: 'Ana' }] };
  const client = new VexaClient('http://vexa.local:8056', 'KEY123', fakeFetch(calls, { json: meeting }) as any);
  const out = await client.getTranscript('abc-defg-hij');
  assert.equal(out.segments.length, 1);
  assert.equal(calls[0].url, 'http://vexa.local:8056/transcripts/google_meet/abc-defg-hij');
  assert.equal(calls[0].init.method, 'GET');
});

test('stopBot faz DELETE e não estoura em 200', async () => {
  const calls: any[] = [];
  const client = new VexaClient('http://vexa.local:8056', 'KEY123', fakeFetch(calls, { json: {} }) as any);
  await client.stopBot('abc-defg-hij');
  assert.equal(calls[0].url, 'http://vexa.local:8056/bots/google_meet/abc-defg-hij');
  assert.equal(calls[0].init.method, 'DELETE');
});

test('erro HTTP não-2xx estoura com status e corpo', async () => {
  const calls: any[] = [];
  const client = new VexaClient('http://vexa.local:8056', 'KEY123', fakeFetch(calls, { status: 500, text: 'boom' }) as any);
  await assert.rejects(() => client.getTranscript('abc-defg-hij'), /HTTP 500/);
});

test('construtor exige baseUrl e apiKey', () => {
  assert.throws(() => new VexaClient('', 'k'), /VEXA_API_URL/);
  assert.throws(() => new VexaClient('http://x', ''), /VEXA_API_KEY/);
});

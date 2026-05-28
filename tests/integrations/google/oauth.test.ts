import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const STATE_SECRET = randomBytes(32).toString('base64');

process.env.GOOGLE_OAUTH_CLIENT_ID = 'fake-client-id';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'fake-client-secret';
process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost:3001/admin/google-oauth/callback';
process.env.GOOGLE_OAUTH_STATE_SECRET = STATE_SECRET;

const {
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  revoke,
  _internal,
} = await import('../../../src/integrations/google/oauth.js');
const { InvalidStateError, TokenRevokedError, GoogleApiError } = await import(
  '../../../src/integrations/google/types.js'
);

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[] = [];
let responses: { status: number; body: string }[] = [];
const originalFetch = global.fetch;

function queue(status: number, body: unknown) {
  responses.push({ status, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

beforeEach(() => {
  calls = [];
  responses = [];
  global.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift();
    if (!r) throw new Error('no response queued');
    return new Response(r.body, { status: r.status });
  }) as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

test('buildAuthorizeUrl: gera URL com state assinado', () => {
  const { url, state } = buildAuthorizeUrl({ projectId: 42, returnTo: '/agentes/mercurio/projetos/x' });
  assert.match(url, /accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.match(url, /client_id=fake-client-id/);
  assert.match(url, /access_type=offline/);
  assert.match(url, /prompt=consent/);
  const verified = _internal.verifyState(state, STATE_SECRET);
  assert.equal(verified.project_id, 42);
  assert.equal(verified.return_to, '/agentes/mercurio/projetos/x');
});

test('verifyState: HMAC inválido → InvalidStateError', () => {
  const { state } = buildAuthorizeUrl({ projectId: 1, returnTo: '/' });
  const tampered = state.slice(0, -2) + 'xx';
  assert.throws(() => _internal.verifyState(tampered, STATE_SECRET), InvalidStateError);
});

test('verifyState: state expirado → InvalidStateError', () => {
  const expired = _internal.signState(
    { project_id: 1, return_to: '/', ts: Date.now() - 11 * 60 * 1000, nonce: 'x' },
    STATE_SECRET
  );
  assert.throws(() => _internal.verifyState(expired, STATE_SECRET), /expired/);
});

test('exchangeCode: troca code + chama userinfo + retorna ExchangeResult', async () => {
  const { state } = buildAuthorizeUrl({ projectId: 99, returnTo: '/back' });
  queue(200, {
    access_token: 'at1',
    refresh_token: 'rt1',
    expires_in: 3600,
    scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.send',
    token_type: 'Bearer',
  });
  queue(200, { email: 'comercial@beeads.com.br' });

  const result = await exchangeCode('fake-code', state);

  assert.equal(result.project_id, 99);
  assert.equal(result.return_to, '/back');
  assert.equal(result.google_email, 'comercial@beeads.com.br');
  assert.equal(result.refresh_token, 'rt1');
  assert.equal(result.access_token, 'at1');
  assert.deepEqual(result.scopes_granted, [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/gmail.send',
  ]);
  assert.equal(calls.length, 2);
  assert.match(calls[0]!.url, /oauth2\.googleapis\.com\/token/);
  assert.match(calls[1]!.url, /userinfo/);
});

test('exchangeCode: state inválido → InvalidStateError sem chamar fetch', async () => {
  await assert.rejects(
    () => exchangeCode('code', 'bogus.state'),
    InvalidStateError
  );
  assert.equal(calls.length, 0);
});

test('exchangeCode: token endpoint retorna 400 → GoogleApiError', async () => {
  const { state } = buildAuthorizeUrl({ projectId: 1, returnTo: '/' });
  queue(400, '{"error":"invalid_grant"}');
  await assert.rejects(
    () => exchangeCode('bad-code', state),
    GoogleApiError
  );
});

test('exchangeCode: token sem refresh_token → GoogleApiError', async () => {
  const { state } = buildAuthorizeUrl({ projectId: 1, returnTo: '/' });
  queue(200, {
    access_token: 'at',
    expires_in: 3600,
    scope: 'openid email',
    token_type: 'Bearer',
  });
  await assert.rejects(
    () => exchangeCode('code', state),
    (err: unknown) => {
      assert.ok(err instanceof GoogleApiError);
      assert.match((err as Error).message, /no refresh_token/);
      return true;
    }
  );
});

test('refreshAccessToken: sucesso devolve novo access_token', async () => {
  queue(200, { access_token: 'newAT', expires_in: 3600 });
  const r = await refreshAccessToken('rt-original');
  assert.equal(r.access_token, 'newAT');
  assert.equal(r.new_refresh_token, undefined);
  assert.ok(r.expires_at > new Date());
});

test('refreshAccessToken: Google rotaciona refresh_token', async () => {
  queue(200, { access_token: 'newAT', expires_in: 3600, refresh_token: 'rotated-rt' });
  const r = await refreshAccessToken('rt-original');
  assert.equal(r.new_refresh_token, 'rotated-rt');
});

test('refreshAccessToken: 400 invalid_grant → TokenRevokedError', async () => {
  queue(400, '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}');
  await assert.rejects(() => refreshAccessToken('rt-revoked'), TokenRevokedError);
});

test('refreshAccessToken: 500 → GoogleApiError', async () => {
  queue(500, 'internal error');
  await assert.rejects(() => refreshAccessToken('rt'), GoogleApiError);
});

test('revoke: 200 → ok', async () => {
  queue(200, '');
  await revoke('rt-anything');
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /oauth2\.googleapis\.com\/revoke/);
});

test('revoke: 400 (token desconhecido) é swallowed', async () => {
  queue(400, '{"error":"invalid_token"}');
  await revoke('rt-unknown');
});

test('revoke: 500 → GoogleApiError', async () => {
  queue(500, 'oops');
  await assert.rejects(() => revoke('rt'), GoogleApiError);
});

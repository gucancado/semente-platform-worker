import { createHmac, timingSafeEqual } from 'node:crypto';
import { REQUIRED_SCOPES, InvalidStateError, TokenRevokedError, GoogleApiError } from './types.js';

const STATE_TTL_MS = 10 * 60 * 1000; // 10min

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

type StatePayload = {
  project_id: number;
  return_to: string;
  ts: number;
  nonce: string;
};

function b64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return b.toString('base64url');
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function signState(payload: StatePayload, secret: string): string {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(state: string, secret: string): StatePayload {
  const dot = state.indexOf('.');
  if (dot < 1) throw new InvalidStateError('state: malformed (no separator)');
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  // timing-safe compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new InvalidStateError('state: HMAC mismatch');
  }
  let payload: StatePayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8'));
  } catch {
    throw new InvalidStateError('state: invalid JSON');
  }
  if (Date.now() - payload.ts > STATE_TTL_MS) {
    throw new InvalidStateError('state: expired (>10min)');
  }
  return payload;
}

export function buildAuthorizeUrl(args: {
  projectId: number;
  returnTo: string;
}): { url: string; state: string } {
  const secret = process.env.GOOGLE_OAUTH_STATE_SECRET;
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!secret || !clientId || !redirectUri) {
    throw new Error('GOOGLE_OAUTH_* env not configured');
  }

  const nonce = Math.random().toString(36).slice(2);
  const state = signState(
    { project_id: args.projectId, return_to: args.returnTo, ts: Date.now(), nonce },
    secret
  );

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: REQUIRED_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });

  return { url: `${AUTH_ENDPOINT}?${params.toString()}`, state };
}

export type ExchangeResult = {
  project_id: number;
  return_to: string;
  google_email: string;
  refresh_token: string;
  access_token: string;
  expires_at: Date;
  scopes_granted: string[];
};

export async function exchangeCode(code: string, state: string): Promise<ExchangeResult> {
  const secret = process.env.GOOGLE_OAUTH_STATE_SECRET;
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!secret || !clientId || !clientSecret || !redirectUri) {
    throw new Error('GOOGLE_OAUTH_* env not configured');
  }

  const statePayload = verifyState(state, secret);

  const tokenRes = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new GoogleApiError(tokenRes.status, body);
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    token_type: string;
  };

  if (!tokens.refresh_token) {
    // Google só devolve refresh_token na 1ª autorização ou quando prompt=consent.
    // Como sempre passamos prompt=consent, isso só acontece se algo estranho.
    throw new GoogleApiError(400, 'no refresh_token in token response');
  }

  // Buscar email do usuário via userinfo (precisa do access_token).
  const userRes = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userRes.ok) {
    throw new GoogleApiError(userRes.status, await userRes.text());
  }
  const user = (await userRes.json()) as { email: string };

  return {
    project_id: statePayload.project_id,
    return_to: statePayload.return_to,
    google_email: user.email,
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000),
    scopes_granted: tokens.scope.split(' '),
  };
}

export type RefreshResult = {
  access_token: string;
  expires_at: Date;
  new_refresh_token?: string;
};

export async function refreshAccessToken(refreshToken: string): Promise<RefreshResult> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID/SECRET not configured');
  }

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 400 && body.includes('invalid_grant')) {
      throw new TokenRevokedError(`refresh failed: ${body.slice(0, 200)}`);
    }
    throw new GoogleApiError(res.status, body);
  }

  const tokens = (await res.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };

  return {
    access_token: tokens.access_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000),
    new_refresh_token: tokens.refresh_token,
  };
}

export async function revoke(token: string): Promise<void> {
  const res = await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  // Google retorna 200 mesmo se token já estava revogado. 400 quando token desconhecido —
  // swallowed: caller só quer garantir que Google esqueceu o token.
  if (!res.ok && res.status !== 400) {
    throw new GoogleApiError(res.status, await res.text());
  }
}

/** Exportado pra testes. */
export const _internal = { signState, verifyState };

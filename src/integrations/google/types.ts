/**
 * Tipos compartilhados da integração Google. Sem dependência de googleapis SDK.
 * Importados por: integrations/google/* + goals/scheduling/google-calendar.ts +
 * goals/email/gmail-client.ts + admin/routes.ts.
 */

// Scopes "future-proof" pra plataforma de agentes (não só mercurio).
// - calendar (full): substitui calendar.events + calendar.readonly. Read + write.
// - gmail.modify: read + send + organize (labels, mark read, trash). Cobre future
//   uso onde agente lê inbox do usuário Google e organiza/responde.
// - drive (full): read + write em todos arquivos do usuário. Pra futuros agentes
//   que vão ler/criar arquivos arbitrários.
// - openid + email: identifica o usuário Google conectado (google_email).
//
// Decisão (2026-05-29): adicionar tudo upfront pra evitar reconnect quando agentes
// novos precisarem desses scopes. Custo: consent dialog mais longo na 1ª conexão.
// Aceito porque uso é interno BeeAds (test users em OAuth Consent "Testing" mode).
export const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive',
  'openid',
  'email',
] as const;

export type GoogleOAuthConnection = {
  id: number;
  project_id: number;
  google_email: string;
  refresh_token_encrypted: Buffer;
  scopes: string[];
  connected_at: Date;
  last_refresh_at: Date | null;
  last_error: string | null;
};

/** Versão non-secret pra retornar pela GUI/API (sem refresh_token). */
export type GoogleOAuthConnectionPublic = Omit<
  GoogleOAuthConnection,
  'refresh_token_encrypted'
>;

export class InvalidStateError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'InvalidStateError';
  }
}

export class TokenRevokedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TokenRevokedError';
  }
}

export class GoogleApiError extends Error {
  constructor(public status: number, public bodyMessage: string) {
    super(`google api error ${status}: ${bodyMessage.slice(0, 200)}`);
    this.name = 'GoogleApiError';
  }
}

export function toPublic(c: GoogleOAuthConnection): GoogleOAuthConnectionPublic {
  const { refresh_token_encrypted, ...rest } = c;
  void refresh_token_encrypted;
  return rest;
}

import { google, type Auth } from 'googleapis';
import { decrypt, encrypt, loadEncryptionKey } from './crypto.js';
import { refreshAccessToken, type RefreshResult } from './oauth.js';
import { updateLastRefresh, markError } from './db.js';
import { TokenRevokedError } from './types.js';
import type { GoogleOAuthConnection } from './types.js';

/**
 * Constrói um OAuth2Client googleapis com refresh token decifrado e listener
 * que persiste tokens novos quando Google rotaciona. Em refresh failure marca
 * last_error no DB e propaga TokenRevokedError pro caller.
 */
export async function getAuthedOAuth2Client(
  conn: GoogleOAuthConnection
): Promise<Auth.OAuth2Client> {
  const key = loadEncryptionKey();
  const refreshToken = decrypt(conn.refresh_token_encrypted, key);

  const client = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT_URI
  );
  client.setCredentials({ refresh_token: refreshToken });

  // Listener pra rotação de refresh_token. googleapis emite 'tokens' event
  // quando faz refresh internamente.
  client.on('tokens', (tokens) => {
    void (async () => {
      try {
        if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
          // Google rotacionou. Re-criptografa e persiste.
          const newEncrypted = encrypt(tokens.refresh_token, key);
          await updateLastRefresh(conn.project_id, newEncrypted);
        } else {
          await updateLastRefresh(conn.project_id);
        }
      } catch (e) {
        // Nunca lançar daqui — listener async é fire-and-forget. Loga e segue.
        console.error('[google client-factory] failed to persist rotated tokens', e);
      }
    })();
  });

  return client;
}

/**
 * Helper que faz refresh manual (sem usar o auto-refresh do OAuth2Client),
 * persiste resultado, e devolve access_token. Útil pra endpoints como
 * /test que precisam validar que refresh funciona sem fazer chamada de API.
 */
export async function ensureFreshAccessToken(
  conn: GoogleOAuthConnection
): Promise<string> {
  const key = loadEncryptionKey();
  const refreshToken = decrypt(conn.refresh_token_encrypted, key);

  try {
    const result: RefreshResult = await refreshAccessToken(refreshToken);
    if (result.new_refresh_token) {
      const newEncrypted = encrypt(result.new_refresh_token, key);
      await updateLastRefresh(conn.project_id, newEncrypted);
    } else {
      await updateLastRefresh(conn.project_id);
    }
    return result.access_token;
  } catch (e) {
    if (e instanceof TokenRevokedError) {
      await markError(conn.project_id, e.message);
    }
    throw e;
  }
}

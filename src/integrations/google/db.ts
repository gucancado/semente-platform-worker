import { pool } from '../../db.js';
import type { GoogleOAuthConnection } from './types.js';

export async function upsertConnection(args: {
  project_id: number;
  google_email: string;
  refresh_token_encrypted: Buffer;
  scopes: string[];
}): Promise<GoogleOAuthConnection> {
  const { rows } = await pool.query<GoogleOAuthConnection>(
    `INSERT INTO google_oauth_connections (project_id, google_email, refresh_token_encrypted, scopes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id) DO UPDATE SET
       google_email = EXCLUDED.google_email,
       refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
       scopes = EXCLUDED.scopes,
       last_error = NULL,
       connected_at = NOW(),
       last_refresh_at = NULL
     RETURNING *`,
    [args.project_id, args.google_email, args.refresh_token_encrypted, args.scopes]
  );
  return rows[0]!;
}

export async function getConnectionByProjectId(
  project_id: number
): Promise<GoogleOAuthConnection | null> {
  const { rows } = await pool.query<GoogleOAuthConnection>(
    `SELECT * FROM google_oauth_connections WHERE project_id = $1 LIMIT 1`,
    [project_id]
  );
  return rows[0] ?? null;
}

export async function updateLastRefresh(
  project_id: number,
  newRefreshTokenEncrypted?: Buffer
): Promise<void> {
  if (newRefreshTokenEncrypted) {
    await pool.query(
      `UPDATE google_oauth_connections
          SET last_refresh_at = NOW(),
              refresh_token_encrypted = $2,
              last_error = NULL
        WHERE project_id = $1`,
      [project_id, newRefreshTokenEncrypted]
    );
  } else {
    await pool.query(
      `UPDATE google_oauth_connections
          SET last_refresh_at = NOW(),
              last_error = NULL
        WHERE project_id = $1`,
      [project_id]
    );
  }
}

export async function markError(project_id: number, error: string): Promise<void> {
  await pool.query(
    `UPDATE google_oauth_connections
        SET last_error = $2,
            last_refresh_at = NOW()
      WHERE project_id = $1`,
    [project_id, error.slice(0, 500)]
  );
}

export async function deleteConnection(project_id: number): Promise<void> {
  await pool.query(
    `DELETE FROM google_oauth_connections WHERE project_id = $1`,
    [project_id]
  );
}

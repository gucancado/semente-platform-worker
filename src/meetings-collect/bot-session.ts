// src/meetings-collect/bot-session.ts
// Estado da sessão Google do bot de reuniões (mig 075). Escrito pelos scripts do
// host (/data/vexa-auth), lido aqui para o Painel tático.
import type { Pool } from 'pg';

export type BotSession = {
  account: string;
  status: 'connected' | 'disconnected' | 'unknown';
  since: string | null;
  checkedAt: string | null;
};

const iso = (v: unknown): string | null => (v ? new Date(v as any).toISOString() : null);

export async function getBotSession(pool: Pool): Promise<BotSession> {
  const { rows } = await pool.query(
    `SELECT account, state, since, checked_at FROM meeting_bot_session WHERE id = 1`,
  );
  const r = rows[0];
  if (!r) return { account: 'configuracoes@beeads.com.br', status: 'unknown', since: null, checkedAt: null };
  return { account: String(r.account), status: r.state, since: iso(r.since), checkedAt: iso(r.checked_at) };
}

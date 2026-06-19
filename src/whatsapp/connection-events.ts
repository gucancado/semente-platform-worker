import type { Pool } from 'pg';
import { updateNumberStatus } from './numbers.js';

const STATE_MAP: Record<string, 'connected'|'connecting'|'disconnected'> = {
  open: 'connected', connecting: 'connecting', close: 'disconnected',
};
const INSTANCE_EVENTS = new Set(['connection.update', 'qrcode.updated']);

function extractPhone(data: any): string | undefined {
  const wuid: string | undefined = data?.wuid ?? data?.me?.id ?? data?.owner;
  if (!wuid) return undefined;
  const digits = (wuid.split('@')[0] ?? '').split(':')[0]?.replace(/\D/g, '') ?? '';
  return digits ? `+${digits}` : undefined;
}

export async function handleConnectionEvent(pool: Pool, payload: any): Promise<boolean> {
  if (!INSTANCE_EVENTS.has(payload?.event)) return false;
  const status = STATE_MAP[payload?.data?.state];
  if (status) {
    await updateNumberStatus(pool, payload.instance, { status, phone: extractPhone(payload.data) });
  }
  return true; // tratado (mesmo que instância desconhecida = no-op no UPDATE)
}

import type { Pool } from 'pg';
import { updateNumberStatus, getNumberByInstance } from './numbers.js';
import { config } from '../config.js';
import { syncGroupSubjectsDebounced } from './group-sync.js';

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
    if (status === 'connected') {
      const num = await getNumberByInstance(pool, payload.instance);
      if (num) {
        const deps = { baseUrl: config.EVOLUTION_API_URL, apiKey: config.EVOLUTION_API_KEY };
        syncGroupSubjectsDebounced(pool, deps, num.id).catch((err) =>
          console.error('[group-sync] on-connect falhou (não-fatal):', (err as Error).message)
        );
      }
    }
  }
  return true; // tratado (mesmo que instância desconhecida = no-op no UPDATE)
}

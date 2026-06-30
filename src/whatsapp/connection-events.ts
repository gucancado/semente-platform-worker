import type { Pool } from 'pg';
import { updateNumberStatus, getNumberByInstance, upsertConnectedNumber } from './numbers.js';
import { getProvisioning, deleteProvisioning } from './provisioning.js';
import { seedDefaultReasons } from './disqualify-reasons.js';
import { config } from '../config.js';
import { syncGroupSubjectsDebounced } from './group-sync.js';

const STATE_MAP: Record<string, 'connected' | 'connecting' | 'disconnected'> = {
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
  if (!status) return true;

  const instance: string = payload.instance;

  if (status !== 'connected') {
    // connecting/disconnected só afetam números já existentes; sem linha = no-op.
    // (instância em staging aguardando scan NÃO vira linha em whatsapp_numbers aqui.)
    await updateNumberStatus(pool, instance, { status });
    return true;
  }

  // status === 'connected'
  let numberId: number | null = null;
  const existing = await getNumberByInstance(pool, instance);
  if (existing) {
    // Reconexão / número legado já materializado.
    await updateNumberStatus(pool, instance, { status, phone: extractPhone(payload.data) });
    numberId = existing.id;
  } else {
    // Onboarding QR-first: commita a partir do staging, se houver.
    const prov = await getProvisioning(pool, instance);
    if (prov) {
      const num = await upsertConnectedNumber(pool, {
        workspaceId: prov.workspaceId,
        evolutionInstance: instance,
        phone: extractPhone(payload.data),
        createdBy: prov.createdBy,
      });
      await deleteProvisioning(pool, instance);
      await seedDefaultReasons(pool, prov.workspaceId);
      numberId = num.id;
    }
    // sem staging e sem número = instância desconhecida → no-op
  }

  if (numberId !== null) {
    const deps = { baseUrl: config.EVOLUTION_API_URL, apiKey: config.EVOLUTION_API_KEY };
    syncGroupSubjectsDebounced(pool, deps, numberId).catch((err) =>
      console.error('[group-sync] on-connect falhou (não-fatal):', (err as Error).message),
    );
  }
  return true;
}

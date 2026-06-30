import type { Pool } from 'pg';
import { updateNumberStatus, getNumberByInstance, upsertConnectedNumber, reviveByWorkspacePhone, normalizePhone } from './numbers.js';
import { getProvisioning, deleteProvisioning } from './provisioning.js';
import { seedDefaultReasons } from './disqualify-reasons.js';
import { config } from '../config.js';
import { deleteInstance } from '../evolution/client.js';
import { syncGroupSubjectsDebounced } from './group-sync.js';

const STATE_MAP: Record<string, 'connected' | 'connecting' | 'disconnected'> = {
  open: 'connected', connecting: 'connecting', close: 'disconnected',
};
const INSTANCE_EVENTS = new Set(['connection.update', 'qrcode.updated']);

function extractPhone(data: any): string | undefined {
  return normalizePhone(data?.wuid ?? data?.me?.id ?? data?.owner);
}

export async function handleConnectionEvent(pool: Pool, payload: any): Promise<boolean> {
  if (!INSTANCE_EVENTS.has(payload?.event)) return false;
  const status = STATE_MAP[payload?.data?.state];
  if (!status) return true;

  const instance: string = payload.instance;

  if (status !== 'connected') {
    await updateNumberStatus(pool, instance, { status });
    return true;
  }

  // status === 'connected'
  let numberId: number | null = null;
  const existing = await getNumberByInstance(pool, instance);
  if (existing) {
    await updateNumberStatus(pool, instance, { status, phone: extractPhone(payload.data) });
    numberId = existing.id;
  } else {
    const prov = await getProvisioning(pool, instance);
    if (prov) {
      const phone = extractPhone(payload.data);
      const evoDeps = { baseUrl: config.EVOLUTION_API_URL, apiKey: config.EVOLUTION_API_KEY };
      // Continuidade de histórico: revive ficha existente do MESMO telefone NESSE workspace.
      const revived = phone
        ? await reviveByWorkspacePhone(pool, { workspaceId: prov.workspaceId, phone, evolutionInstance: instance })
        : null;
      if (revived) {
        numberId = revived.number.id;
        if (revived.oldInstance && revived.oldInstance !== instance) {
          deleteInstance(evoDeps, revived.oldInstance).catch(() => { /* instância antiga órfã — best-effort */ });
        }
      } else {
        try {
          const num = await upsertConnectedNumber(pool, {
            workspaceId: prov.workspaceId, evolutionInstance: instance, phone, createdBy: prov.createdBy,
          });
          numberId = num.id;
        } catch (e) {
          // Telefone já ativo no ws via outra instância (partial unique). A instância nova é
          // descartável; a ficha ativa permanece. Não materializa duplicata.
          if ((e as any)?.code === '23505') {
            deleteInstance(evoDeps, instance).catch(() => {});
          } else { throw e; }
        }
      }
      await deleteProvisioning(pool, instance);
      await seedDefaultReasons(pool, prov.workspaceId);
    }
  }

  if (numberId !== null) {
    const deps = { baseUrl: config.EVOLUTION_API_URL, apiKey: config.EVOLUTION_API_KEY };
    syncGroupSubjectsDebounced(pool, deps, numberId).catch((err) =>
      console.error('[group-sync] on-connect falhou (não-fatal):', (err as Error).message),
    );
  }
  return true;
}

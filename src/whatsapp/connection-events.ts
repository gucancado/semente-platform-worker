import type { Pool } from 'pg';
import { updateNumberStatus, getNumberByInstance, upsertConnectedNumber, claimNumberByPhone, normalizePhone } from './numbers.js';
import { getProvisioning, deleteProvisioning, markProvisioningBlocked } from './provisioning.js';
import { markLinkConsumed } from './provision-links.js';
import { seedDefaultReasons } from './disqualify-reasons.js';
import { seedDefaultSourceSignals } from './source-signals.js';
import { config } from '../config.js';
import { deleteInstance } from '../evolution/client.js';
import { syncGroupSubjectsDebounced } from './group-sync.js';
import { enqueueConnectionEvent } from './connection-alerts.js';

async function insertFirstTime(
  pool: Pool, evoDeps: { baseUrl: string; apiKey: string },
  prov: { workspaceId: string; createdBy: string | null }, instance: string, phone: string | undefined,
): Promise<number | null> {
  try {
    const num = await upsertConnectedNumber(pool, { workspaceId: prov.workspaceId, evolutionInstance: instance, phone, createdBy: prov.createdBy });
    return num.id;
  } catch (e) {
    // corrida no unique global (23505): a instância nova é descartável; não duplica.
    if ((e as any)?.code === '23505') { deleteInstance(evoDeps, instance).catch(() => {}); return null; }
    throw e;
  }
}

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
    const t = await updateNumberStatus(pool, instance, { status, phone: extractPhone(payload.data) });
    numberId = existing.id;
    // Reconectou após um alerta de queda já disparado → limpa o alerta no painel.
    if (t && t.newStatus === 'connected' && t.wasAlerted) {
      await enqueueConnectionEvent(pool, {
        status: 'resolved', workspaceId: t.workspaceId, numberId: t.numberId,
        phone: t.phone, label: t.label, state: t.newStatus, since: null,
      }).catch((err) => console.error('[connection-alerts] resolve enqueue falhou:', (err as Error).message));
    }
  } else {
    const prov = await getProvisioning(pool, instance);
    if (prov) {
      const phone = extractPhone(payload.data);
      const evoDeps = { baseUrl: config.EVOLUTION_API_URL, apiKey: config.EVOLUTION_API_KEY };
      if (phone) {
        const claim = await claimNumberByPhone(pool, { phone, newWorkspaceId: prov.workspaceId, evolutionInstance: instance });
        if (claim.kind === 'blocked') {
          // Número já ATIVO em outro workspace: desfaz a instância nova (device recém-linkado),
          // marca o staging pra o painel avisar. NÃO move, NÃO apaga o staging, NÃO faz seed.
          deleteInstance(evoDeps, instance).catch(() => {});
          await markProvisioningBlocked(pool, instance, claim.currentWorkspaceId);
          return true;
        }
        if (claim.kind === 'moved') {
          numberId = claim.number.id;
          if (claim.oldInstance && claim.oldInstance !== instance) {
            deleteInstance(evoDeps, claim.oldInstance).catch(() => {});
          }
        } else {
          numberId = await insertFirstTime(pool, evoDeps, prov, instance, phone);
        }
      } else {
        numberId = await insertFirstTime(pool, evoDeps, prov, instance, undefined);
      }
      await deleteProvisioning(pool, instance);
      await seedDefaultReasons(pool, prov.workspaceId);
      await seedDefaultSourceSignals(pool, prov.workspaceId);
      if (prov.provisionLinkToken && numberId !== null) {
        await markLinkConsumed(pool, prov.provisionLinkToken, numberId).catch((err) =>
          console.error('[provision-link] markConsumed falhou (não-fatal):', (err as Error).message),
        );
      }
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

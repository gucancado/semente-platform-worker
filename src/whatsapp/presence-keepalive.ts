// Reafirma periodicamente a presença `unavailable` das instâncias conectadas.
//
// POR QUE: o Baileys emite presença UMA única vez, na transição pra `open`
// (`sendPresenceUpdate(markOnlineOnConnect ? 'available' : 'unavailable')`), e
// esse estado DECAI no servidor do WhatsApp. Quando decai, o WhatsApp passa a
// tratar o companion como ativo e SUPRIME o push no celular do cliente.
// Keep-alive de socket (30s) mantém a conexão, NÃO a presença.
//
// Contraintuitivo: quanto mais ESTÁVEL a sessão, pior — uma sessão que cai e
// reconecta se auto-cura (novo `open` ⇒ novo `unavailable`). Por isso o sintoma
// aparece nos clientes de sessão longa e NÃO reproduz em sessão nova.

import type { Pool } from 'pg';
import { config } from '../config.js';
import { setPresenceUnavailable } from '../evolution/client.js';
import { listConnectedInstances } from './numbers.js';

export type PresenceRefreshDeps = {
  listConnectedInstances: () => Promise<string[]>;
  setPresence: (instance: string) => Promise<void>;
  onError?: (instance: string, err: Error) => void;
};

/**
 * Um ciclo: reafirma `unavailable` em cada instância conectada.
 *
 * Best-effort e SERIAL — uma instância que falha não impede as demais (típico:
 * instância sem sessão devolve 400 `Cannot read properties of undefined
 * (reading 'name')`, que é `authState.creds.me` undefined; é no-op esperado,
 * não incidente).
 */
export async function refreshPresenceOnce(deps: PresenceRefreshDeps): Promise<{ refreshed: number; failed: number }> {
  const instances = await deps.listConnectedInstances();
  let refreshed = 0;
  let failed = 0;
  for (const instance of instances) {
    try {
      await deps.setPresence(instance);
      refreshed++;
    } catch (err) {
      failed++;
      deps.onError?.(instance, err as Error);
    }
  }
  return { refreshed, failed };
}

/**
 * Inicia o keep-alive: `setInterval` + flag `running` pra não sobrepor ticks
 * (padrão canônico do repo — ver `transcription/poller.ts`). Um tick que falha
 * NUNCA derruba o processo.
 */
export function startPresenceKeepalive(
  pool: Pool,
  log: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void; error: (o: any, m?: string) => void },
): void {
  const evolution = { baseUrl: config.EVOLUTION_API_URL, apiKey: config.EVOLUTION_API_KEY };
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await refreshPresenceOnce({
        listConnectedInstances: () => listConnectedInstances(pool),
        setPresence: (instance) => setPresenceUnavailable(evolution, instance),
        // Instância sem sessão viva devolve 400 — esperado, não incidente. Fica em debug-nível warn
        // pra não poluir, mas sem sumir (se TODAS falharem, algo maior quebrou).
        onError: (instance, err) => log.warn({ instance, err: err.message }, 'presence keep-alive: instância falhou'),
      });
      if (r.refreshed || r.failed) log.info(r, 'presence keep-alive: ciclo concluído');
    } catch (err) {
      log.error({ err: (err as Error).message }, 'presence keep-alive tick falhou');
    } finally {
      running = false;
    }
  };
  setInterval(tick, config.WHATSAPP_PRESENCE_REFRESH_INTERVAL_MS);
  log.info({ intervalMs: config.WHATSAPP_PRESENCE_REFRESH_INTERVAL_MS }, 'presence keep-alive iniciado');
}

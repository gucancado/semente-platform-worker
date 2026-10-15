// src/whatsapp/qr-cache.ts
// QR de pareamento SEM abrir conexão nova a cada consulta.
//
// `GET /instance/connect/<i>` da Evolution v2 inicia um socket NOVO a cada
// chamada. As telas de QR consultam a cada 2,5 s, então um pareamento deixava
// 4-5 sockets com a mesma credencial — e depois do scan eles se derrubam em
// loop (`stream:error conflict type=replaced`, medido em 15/10/2026: 532
// `connecting` em 2 min no monitor de grupos B). Aqui o QR vem primeiro do
// evento `qrcode.updated` (a Evolution rotaciona o QR no MESMO socket e manda
// por webhook) e o connect só é chamado quando não há QR recente — uma chamada
// por vez por instância.
import type { EvolutionDeps } from '../evolution/client.js';
import { getQrCode } from '../evolution/client.js';

export type Qr = { base64: string; pairingCode?: string };

/** Sem evento de QR há mais que isto, o socket provavelmente morreu → connect de novo. */
const FRESH_MS = 60_000;

export function qrFromWebhook(data: any): Qr | null {
  const q = data?.qrcode ?? data;
  const base64 = typeof q?.base64 === 'string' && q.base64 ? q.base64 : null;
  if (!base64) return null;
  return { base64, pairingCode: q?.pairingCode ?? q?.code ?? undefined };
}

export function createQrCache(deps: { connect: (instance: string) => Promise<Qr>; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const latest = new Map<string, { qr: Qr; at: number }>();
  const inflight = new Map<string, Promise<Qr>>();

  return {
    remember(instance: string, qr: Qr) {
      latest.set(instance, { qr, at: now() });
    },
    forget(instance: string) {
      latest.delete(instance);
    },
    async get(instance: string): Promise<Qr> {
      const hit = latest.get(instance);
      if (hit && now() - hit.at < FRESH_MS) return hit.qr;
      const running = inflight.get(instance);
      if (running) return running;
      const p = deps
        .connect(instance)
        .then((qr) => {
          latest.set(instance, { qr, at: now() });
          return qr;
        })
        .finally(() => inflight.delete(instance));
      inflight.set(instance, p);
      return p;
    },
  };
}

let shared: ReturnType<typeof createQrCache> | null = null;
let sharedDeps: EvolutionDeps | null = null;

/** Instância do processo: o webhook alimenta, as rotas de QR leem. */
export function sharedQrCache(evolution?: EvolutionDeps) {
  if (evolution) sharedDeps = evolution;
  if (!shared) {
    shared = createQrCache({
      connect: (instance) => {
        if (!sharedDeps) throw new Error('qr-cache: EvolutionDeps não configurado');
        return getQrCode(sharedDeps, instance);
      },
    });
  }
  return shared;
}

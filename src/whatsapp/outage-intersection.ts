// src/whatsapp/outage-intersection.ts
// Buraco de monitoramento num grupo do escopo do monitor = instantes em que
// TODOS os monitores (slots A/B) estavam fora ao mesmo tempo.
import type { OutageRow } from './instance-outages.js';

type Iv = { s: number; e: number }; // e = Infinity para aberto

function toIvs(list: OutageRow[]): Iv[] {
  return list
    .map((r) => ({ s: Date.parse(r.startedAt), e: r.endedAt ? Date.parse(r.endedAt) : Infinity }))
    .filter((iv) => iv.e > iv.s)
    .sort((a, b) => a.s - b.s);
}

function intersectTwo(a: Iv[], b: Iv[]): Iv[] {
  const out: Iv[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i]!.s, b[j]!.s);
    const e = Math.min(a[i]!.e, b[j]!.e);
    if (e > s) out.push({ s, e });
    if (a[i]!.e < b[j]!.e) i++;
    else j++;
  }
  return out;
}

export function intersectOutages(lists: OutageRow[][], label: string): OutageRow[] {
  if (lists.length === 0) return [];
  let acc = toIvs(lists[0]!);
  for (const l of lists.slice(1)) acc = intersectTwo(acc, toIvs(l));
  return acc
    .sort((x, y) => y.s - x.s)
    .map((iv) => ({
      instance: label,
      startedAt: new Date(iv.s).toISOString(),
      endedAt: iv.e === Infinity ? null : new Date(iv.e).toISOString(),
      startedAtSource: 'intersection',
      reason: null,
    }));
}

/**
 * Número-monitor fora do ar SEM episódio aberto (caiu antes da mig 066 ou o
 * episódio nunca foi aberto) conta como fora desde `disconnectedSince`
 * (fallback `fallbackSince`). Mesma regra de `deriveMonitorStatus`.
 */
export function withImplicitOpenOutage(
  list: OutageRow[],
  p: { instance: string; isNumber: boolean; status: string | null; disconnectedSince: string | null; fallbackSince: string | null },
): OutageRow[] {
  if (!p.isNumber || p.status === 'connected') return list;
  if (list.some((r) => r.endedAt === null)) return list;
  const since = p.disconnectedSince ?? p.fallbackSince;
  if (!since) return list;
  return [
    { instance: p.instance, startedAt: since, endedAt: null, startedAtSource: 'detected_now', reason: 'implicit_not_connected' },
    ...list,
  ];
}

/**
 * Abaixo disto, queda não é buraco de monitoramento. A Evolution oscila
 * `connecting`→`open` em segundos várias vezes por dia em todo número (medido
 * 15/10/2026: ~1.400 episódios < 1 min em 14 instâncias) e a mensagem enviada
 * nesse intervalo chega na reconexão — a do Vemcurtir das 18:08, no meio de uma
 * rajada de quedas de 2 s, foi capturada. Sem o filtro cada oscilação virava um
 * card "Sem monitoramento · 0min" na conversa do grupo.
 */
export const OUTAGE_MIN_MS = 5 * 60_000;

/**
 * Tira o ruído antes de exibir: descarta episódio fechado mais curto que
 * `OUTAGE_MIN_MS` e aberto há menos que isso (ainda pode ser oscilação), e funde
 * episódios separados por menos que isso. Devolve DESC por início.
 */
export function denoiseOutages(list: OutageRow[], nowMs: number, minMs = OUTAGE_MIN_MS): OutageRow[] {
  const kept = list
    .map((r) => ({ r, s: Date.parse(r.startedAt), e: r.endedAt ? Date.parse(r.endedAt) : Infinity }))
    .filter(({ s, e }) => Number.isFinite(s) && (e === Infinity ? nowMs - s >= minMs : e - s >= minMs))
    .sort((a, b) => a.s - b.s);
  const merged: typeof kept = [];
  for (const cur of kept) {
    const last = merged[merged.length - 1];
    if (last && cur.s - last.e < minMs) {
      if (cur.e > last.e) last.e = cur.e;
    } else {
      merged.push({ ...cur });
    }
  }
  return merged
    .sort((a, b) => b.s - a.s)
    .map(({ r, s, e }) => ({
      ...r,
      startedAt: new Date(s).toISOString(),
      endedAt: e === Infinity ? null : new Date(e).toISOString(),
    }));
}

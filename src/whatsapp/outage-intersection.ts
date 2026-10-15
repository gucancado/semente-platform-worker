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

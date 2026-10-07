import { DateTime } from 'luxon';
import { OPS_DIGEST_DETALHE_MAX } from '../webhook-cloud/templates.js';

/**
 * Regras PURAS do agrupamento de avisos ao operador — quando um lote sai e como
 * ele vira UMA mensagem. Sem pool, sem rede, sem config: o teste roda sem .env.
 *
 * Dois ritmos (aprovados pelo Gustavo em 2026-10-07):
 *  - URGENTE (coleta falhou, conexão quebrada, WhatsApp caiu, erro do painel):
 *    sai quando o urgente mais antigo da fila completa a JANELA (minutos). A
 *    janela existe para juntar a rajada — um ciclo que falha em 3 clientes vira
 *    1 mensagem, não 3.
 *  - RESUMO (saldo baixo, pixel, comentários, anúncio reprovado…): sai nos
 *    horários fixos (09:00 e 16:00 de São Paulo), com tudo o que entrou antes.
 *
 * Quando um lote sai, ele leva TODA a fila pendente, urgente e resumo juntos:
 * mandar o urgente agora e o resumo daqui a horas seriam duas mensagens onde
 * cabe uma.
 */

const ZONE = 'America/Sao_Paulo';

export type Slot = { hour: number; minute: number };

/** `"09:00,16:00"` → slots ordenados. Entrada inválida é ignorada (e devolvida). */
export function parseSlots(raw: string): { slots: Slot[]; invalid: string[] } {
  const slots: Slot[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(part);
    const hour = m ? Number(m[1]) : NaN;
    const minute = m ? Number(m[2]) : NaN;
    if (!m || hour > 23 || minute > 59) {
      invalid.push(part);
      continue;
    }
    slots.push({ hour, minute });
  }
  slots.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
  return { slots, invalid };
}

/**
 * Último horário de resumo ≤ `now`, em São Paulo (o container roda em UTC).
 * Sem slot hoje ainda → o último de ontem. Sem slot nenhum → null.
 */
export function lastSlotAt(now: Date, slots: Slot[]): Date | null {
  if (slots.length === 0) return null;
  const local = DateTime.fromJSDate(now, { zone: ZONE });
  for (let back = 0; back <= 1; back++) {
    const day = local.minus({ days: back }).startOf('day');
    for (const slot of [...slots].reverse()) {
      const at = day.set({ hour: slot.hour, minute: slot.minute });
      if (at.toMillis() <= now.getTime()) return at.toJSDate();
    }
  }
  return null;
}

export type FlushInput = {
  now: Date;
  /** created_at do urgente pendente mais antigo (null = nenhum). */
  oldestUrgentAt: Date | null;
  /** created_at do pendente mais antigo, qualquer urgência (null = fila vazia). */
  oldestPendingAt: Date | null;
  slots: Slot[];
  urgentWindowMs: number;
};

export type FlushDecision = { flush: false } | { flush: true; reason: 'urgent' | 'digest'; slotAt: Date | null };

export function planFlush(p: FlushInput): FlushDecision {
  if (!p.oldestPendingAt) return { flush: false };
  const slotAt = lastSlotAt(p.now, p.slots);
  // Algo entrou ANTES do último horário e não saiu: é o resumo daquele horário.
  // Também cobre o resumo perdido por reinício (sai no próximo tick).
  if (slotAt && p.oldestPendingAt.getTime() < slotAt.getTime()) {
    return { flush: true, reason: 'digest', slotAt };
  }
  if (p.oldestUrgentAt && p.now.getTime() - p.oldestUrgentAt.getTime() >= p.urgentWindowMs) {
    return { flush: true, reason: 'urgent', slotAt: null };
  }
  return { flush: false };
}

export type QueuedNotice = {
  titulo: string;
  detalhe: string | null;
  urgency: 'urgent' | 'digest';
  createdAt: Date;
};

/** Teto de cada item dentro do resumo — um aviso longo não pode engolir os outros. */
const ITEM_MAX = 220;
const SEP = ' | ';
const CENTRAL = 'painel.beeads.com.br/alertas';

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function hhmm(d: Date): string {
  return DateTime.fromJSDate(d, { zone: ZONE }).toFormat('HH:mm');
}

/**
 * Lote → `{titulo, detalhe}` do template `aviso_operacional_v1` (o que já está
 * aprovado na Meta — zero espera por template novo). O template não aceita
 * quebra de linha em parâmetro, então os itens vão numerados numa linha só.
 *
 * - Um item só, urgente: sai como ele veio (é o aviso de sempre, sem moldura).
 * - Repetidos (mesmo título + detalhe) viram um item com "(Nx)".
 * - Urgentes primeiro, depois por ordem de chegada.
 * - Estourou o teto: corta no último item inteiro e fecha com "+N avisos".
 */
export function formatBatch(
  items: QueuedNotice[],
  ctx: { reason: 'urgent' | 'digest'; slotAt: Date | null },
): { titulo: string; detalhe: string } {
  const groups = new Map<string, { item: QueuedNotice; count: number }>();
  for (const it of items) {
    const key = `${oneLine(it.titulo)}\u0000${oneLine(it.detalhe ?? '')}`;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { item: it, count: 1 });
  }
  const ordered = [...groups.values()].sort((a, b) => {
    if (a.item.urgency !== b.item.urgency) return a.item.urgency === 'urgent' ? -1 : 1;
    return a.item.createdAt.getTime() - b.item.createdAt.getTime();
  });

  const only = items.length === 1 ? items[0] : undefined;
  if (only && ctx.reason === 'urgent') {
    const it = only;
    return { titulo: oneLine(it.titulo), detalhe: oneLine(it.detalhe ?? '') };
  }

  const total = items.length;
  const urgentes = items.filter((i) => i.urgency === 'urgent').length;
  const head =
    ctx.reason === 'digest' && ctx.slotAt
      ? `Resumo das ${hhmm(ctx.slotAt)}`
      : urgentes > 0
        ? 'Avisos urgentes'
        : 'Avisos';
  const conta = `${total} ${total === 1 ? 'aviso' : 'avisos'}`;
  const titulo = urgentes > 0 && ctx.reason === 'digest' ? `${head} · ${conta} (${urgentes} urgente${urgentes === 1 ? '' : 's'})` : `${head} · ${conta}`;

  const parts: string[] = [];
  let used = 0;
  for (const [i, { item, count }] of ordered.entries()) {
    const mark = item.urgency === 'urgent' ? '⚠ ' : '';
    const times = count > 1 ? ` (${count}x)` : '';
    const det = item.detalhe ? `: ${oneLine(item.detalhe)}` : '';
    const text = clip(`${i + 1}) ${mark}${oneLine(item.titulo)}${times}${det}`, ITEM_MAX);
    const restantes = ordered.slice(i + 1).reduce((n, g) => n + g.count, 0) + count;
    const tail = `${SEP}+${restantes} ${restantes === 1 ? 'aviso' : 'avisos'} em ${CENTRAL}`;
    const add = (parts.length ? SEP.length : 0) + text.length;
    // Reserva espaço para a cauda se ainda houver item depois deste.
    const reserve = i < ordered.length - 1 ? tail.length : 0;
    if (used + add + reserve > OPS_DIGEST_DETALHE_MAX) {
      parts.push(`+${restantes} ${restantes === 1 ? 'aviso' : 'avisos'} em ${CENTRAL}`);
      break;
    }
    parts.push(text);
    used += add;
  }
  return { titulo, detalhe: parts.join(SEP) };
}

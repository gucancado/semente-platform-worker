/**
 * Regras do agrupamento de avisos ao operador: quando o lote sai e como vira
 * UMA mensagem. Horários sempre de São Paulo (UTC-3, sem horário de verão).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBatch, lastSlotAt, parseSlots, planFlush, type QueuedNotice } from '../../src/ops-notify/digest.js';
import { OPS_DIGEST_DETALHE_MAX } from '../../src/webhook-cloud/templates.js';

const SLOTS = parseSlots('09:00,16:00').slots;
/** `hh:mm` de São Paulo em 2026-10-07 → Date (UTC = SP + 3h). */
const sp = (hhmm: string, day = '2026-10-07') => new Date(`${day}T${hhmm}:00-03:00`);
const MIN = 60_000;

test('parseSlots: aceita HH:mm, ordena e devolve o inválido', () => {
  const r = parseSlots('16:00, 9:00 ,25:00,xx');
  assert.deepEqual(r.slots, [{ hour: 9, minute: 0 }, { hour: 16, minute: 0 }]);
  assert.deepEqual(r.invalid, ['25:00', 'xx']);
});

test('lastSlotAt: horário de São Paulo, cai pro de ontem antes das 09:00', () => {
  assert.equal(lastSlotAt(sp('08:59'), SLOTS)?.toISOString(), sp('16:00', '2026-10-06').toISOString());
  assert.equal(lastSlotAt(sp('09:00'), SLOTS)?.toISOString(), sp('09:00').toISOString());
  assert.equal(lastSlotAt(sp('15:59'), SLOTS)?.toISOString(), sp('09:00').toISOString());
  assert.equal(lastSlotAt(sp('23:00'), SLOTS)?.toISOString(), sp('16:00').toISOString());
  assert.equal(lastSlotAt(sp('10:00'), []), null);
});

test('planFlush: fila vazia não sai', () => {
  assert.deepEqual(
    planFlush({ now: sp('09:00'), oldestUrgentAt: null, oldestPendingAt: null, slots: SLOTS, urgentWindowMs: 10 * MIN }),
    { flush: false },
  );
});

test('planFlush: resumo espera o horário e sai nele com o que entrou antes', () => {
  const base = { oldestUrgentAt: null, slots: SLOTS, urgentWindowMs: 10 * MIN };
  // Alerta das 07:22 da madrugada: não sai até as 09:00.
  assert.equal(planFlush({ ...base, now: sp('08:59'), oldestPendingAt: sp('07:22') }).flush, false);
  const d = planFlush({ ...base, now: sp('09:00'), oldestPendingAt: sp('07:22') });
  assert.equal(d.flush && d.reason, 'digest');
  // Entrou 09:01: espera as 16:00.
  assert.equal(planFlush({ ...base, now: sp('15:59'), oldestPendingAt: sp('09:01') }).flush, false);
  assert.equal(planFlush({ ...base, now: sp('16:00'), oldestPendingAt: sp('09:01') }).flush, true);
});

test('planFlush: resumo perdido por reinício sai no próximo tick', () => {
  const d = planFlush({ now: sp('11:30'), oldestUrgentAt: null, oldestPendingAt: sp('06:00'), slots: SLOTS, urgentWindowMs: 10 * MIN });
  assert.equal(d.flush && d.reason, 'digest');
});

test('planFlush: urgente espera a janela pra juntar a rajada', () => {
  const base = { slots: SLOTS, urgentWindowMs: 10 * MIN };
  assert.equal(planFlush({ ...base, now: sp('10:09'), oldestUrgentAt: sp('10:00'), oldestPendingAt: sp('10:00') }).flush, false);
  const d = planFlush({ ...base, now: sp('10:10'), oldestUrgentAt: sp('10:00'), oldestPendingAt: sp('09:30') });
  assert.equal(d.flush && d.reason, 'urgent');
});

const item = (titulo: string, over: Partial<QueuedNotice> = {}): QueuedNotice => ({
  titulo,
  detalhe: null,
  urgency: 'digest',
  createdAt: sp('07:00'),
  ...over,
});

test('formatBatch: urgente sozinho sai como veio, sem moldura', () => {
  const r = formatBatch([item('Coleta falhou', { urgency: 'urgent', detalhe: 'Meta · Hoenka' })], { reason: 'urgent', slotAt: null });
  assert.deepEqual(r, { titulo: 'Coleta falhou', detalhe: 'Meta · Hoenka' });
});

test('formatBatch: resumo numera, junta repetidos e põe urgente primeiro', () => {
  const r = formatBatch(
    [
      item('Saldo baixo', { detalhe: 'Hoenka', createdAt: sp('07:22') }),
      item('Pixel caiu', { detalhe: 'Vem Curtir BH', createdAt: sp('08:00') }),
      item('Saldo baixo', { detalhe: 'Hoenka', createdAt: sp('08:30') }),
      item('Erro no painel', { urgency: 'urgent', createdAt: sp('08:40') }),
    ],
    { reason: 'digest', slotAt: sp('09:00') },
  );
  assert.equal(r.titulo, 'Resumo das 09:00 · 4 avisos (1 urgente)');
  assert.equal(r.detalhe, '1) ⚠ Erro no painel | 2) Saldo baixo (2x): Hoenka | 3) Pixel caiu: Vem Curtir BH');
  assert.ok(!/\n/.test(r.detalhe + r.titulo), 'parâmetro de template não aceita quebra de linha');
});

test('formatBatch: estourou o teto → corta no item inteiro e aponta a Central', () => {
  const muitos = Array.from({ length: 40 }, (_, i) =>
    item(`Anúncio reprovado ${i}`, { detalhe: 'x'.repeat(120), createdAt: new Date(sp('07:00').getTime() + i * MIN) }),
  );
  const r = formatBatch(muitos, { reason: 'digest', slotAt: sp('16:00') });
  assert.ok(r.detalhe.length <= OPS_DIGEST_DETALHE_MAX, `detalhe com ${r.detalhe.length}`);
  assert.match(r.detalhe, /\| \+\d+ avisos em painel\.beeads\.com\.br\/alertas$/);
  const listados = (r.detalhe.match(/\| \d+\) |^\d+\) /g) ?? []).length;
  const resto = Number(/\+(\d+) avisos/.exec(r.detalhe)![1]);
  assert.equal(listados + resto, 40, 'nenhum aviso some da conta');
});

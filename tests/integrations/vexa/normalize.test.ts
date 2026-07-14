import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { vexaMeetingToEpisodeInput, dedupSegments, parseVexaTimestamp } from '../../../src/integrations/vexa/normalize.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => JSON.parse(readFileSync(join(here, '../../fixtures/vexa', name), 'utf8'));

test('parseVexaTimestamp trata ISO sem tz como UTC', () => {
  const d = parseVexaTimestamp('2026-07-13T14:00:00.000000');
  assert.equal(d!.toISOString(), '2026-07-13T14:00:00.000Z');
  assert.equal(parseVexaTimestamp(null), null);
});

test('dedupSegments mescla o primeiro segment duplicado (mesmo speaker+text, <1s)', () => {
  const m = fx('edge-cases.json');
  const out = dedupSegments(m.segments);
  // 5 segments → 4 (a dupla Ana "Bom dia" vira 1, com start=1000.00 e end=1003.50)
  assert.equal(out.length, 4);
  assert.equal(out[0].start, 1000.0);
  assert.equal(out[0].end, 1003.5);
  assert.equal(out[0].text, 'Bom dia a todos.');
});

test('vexaMeetingToEpisodeInput: casos-limite (turns, 2083 ignorado, Speaker genérico)', () => {
  const m = fx('edge-cases.json');
  const ep = vexaMeetingToEpisodeInput(m, 'vexa/99.json');
  assert.equal(ep.fonte, 'reuniao');
  assert.equal(ep.external_source, 'vexa');
  assert.equal(ep.external_id, '99');
  assert.equal(ep.raw_r2_key, 'vexa/99.json');
  assert.equal(ep.audio_r2_key, null);
  // Turns: [Ana: "Bom dia a todos. Vamos comecar."] [Bruno: "Perfeito."] [Speaker: "Concordo."]
  assert.equal(ep.turns.length, 3);
  assert.equal(ep.turns[0].speaker_name, 'Ana');
  assert.equal(ep.turns[0].text, 'Bom dia a todos. Vamos comecar.');
  assert.equal(ep.turns[0].turn_index, 0);
  // Tempos relativos ao primeiro start (1000.0) — NUNCA o absolute_start_time de 2083.
  assert.equal(ep.turns[0].started_at_ms, 0);
  assert.equal(ep.turns[0].ended_at_ms, 6000); // 1006.0 - 1000.0 = 6s
  assert.equal(ep.turns[2].speaker_name, 'Speaker'); // label genérico mantido
  // occurred_at = start_time do meeting (UTC)
  assert.equal(ep.occurred_at.toISOString(), '2026-07-13T14:00:00.000Z');
  assert.equal(ep.duration_seconds, 300); // 14:05 - 14:00
  // participants: speakers únicos, email null, "Speaker" incluído
  const names = (ep.participants ?? []).map((p) => p.name).sort();
  assert.deepEqual(names, ['Ana', 'Bruno', 'Speaker']);
  assert.equal((ep.participants ?? [])[0].email, null);
  // metadata
  assert.equal((ep.metadata as any).meet_code, 'xyz-abcd-efg');
  assert.equal((ep.metadata as any).vexa_meeting_id, 99);
  assert.equal((ep.metadata as any).speaker_counts.Ana, 2);
});

test('fixture real: normaliza sem estourar, produz turns e participantes', () => {
  const m = fx('real-01.json');
  const ep = vexaMeetingToEpisodeInput(m, `vexa/${m.id}.json`);
  assert.ok(ep.turns.length > 0);
  assert.ok((ep.participants ?? []).length >= 5); // 6 speakers na real (spec)
  // nenhum turn com tempo absurdo (bug 2083 = ~3.5e12 ms desde epoch)
  for (const t of ep.turns) {
    assert.ok((t.started_at_ms ?? 0) >= 0);
    assert.ok((t.started_at_ms ?? 0) < 1000 * 60 * 60 * 24); // < 24h de reunião
  }
});

test('fixture sintética: agrupa o monólogo de um speaker só', () => {
  const m = fx('synthetic-01.json');
  const ep = vexaMeetingToEpisodeInput(m, `vexa/${m.id}.json`);
  assert.equal((ep.participants ?? []).length, 1); // só "Gustavo Cançado"
  assert.equal(ep.turns.length, 1); // todos os segments do mesmo speaker → 1 turn
});

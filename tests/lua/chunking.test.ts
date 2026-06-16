import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkTurns, estimateTokens } from '../../src/lua/chunking.js';

// Nota: este teste NAO toca o banco. O --env-file so satisfaz o import de config.
// O shape de retorno espelha `ChunkInput` (src/lua/db.ts) sem os campos de embedding,
// portanto camelCase: chunkIndex/turnStart/turnEnd/charStart/charEnd/text/tokenCount.

test('estimateTokens: heuristica deterministica chars/4 (ceil)', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2); // ceil(5/4)
  // Determinismo: mesma entrada => mesma saida.
  assert.equal(estimateTokens('palavra'), estimateTokens('palavra'));
});

test('agrupa turnos consecutivos ate ~450 tokens, corta em fronteira de turno', () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({
    turn_index: i,
    speaker: `P${i % 2}`,
    text: 'palavra '.repeat(50),
  }));
  const chunks = chunkTurns(turns, { targetTokens: 450, maxTurnTokens: 700 });

  assert.ok(chunks.length > 1, 'deve quebrar em mais de um chunk');
  // Garantia dura: nenhum chunk passa de maxTurnTokens.
  assert.ok(chunks.every((c) => c.tokenCount <= 700));
  // Todo chunk tem prefixo "Falante:".
  assert.ok(chunks.every((c) => c.text.includes(':')));
  // Cobertura completa dos turnos: 0..9 sem buracos.
  assert.equal(chunks[0]!.turnStart, 0);
  assert.equal(chunks.at(-1)!.turnEnd, 9);
  // chunkIndex sequencial 0-based.
  chunks.forEach((c, i) => assert.equal(c.chunkIndex, i));
  // Corte em fronteira de turno => char_start/char_end nulos.
  assert.ok(chunks.every((c) => c.charStart === null && c.charEnd === null));
  // Turnos contiguos sem buraco entre chunks.
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(chunks[i]!.turnStart, chunks[i - 1]!.turnEnd + 1);
  }
});

test('monologo > 700 tokens fatia intra-turno com char_start/char_end nao-nulos', () => {
  const turns = [{ turn_index: 0, speaker: 'X', text: 'frase. '.repeat(400) }];
  const chunks = chunkTurns(turns, { targetTokens: 450, maxTurnTokens: 700 });

  assert.ok(chunks.length > 1, 'monologo deve gerar varios pedacos');
  assert.ok(chunks.every((c) => c.charStart !== null && c.charEnd !== null));
  // Cada pedaco e do mesmo turno: turnStart == turnEnd == turn_index.
  assert.ok(chunks.every((c) => c.turnStart === 0 && c.turnEnd === 0));
  // Garantia dura mesmo no monologo.
  assert.ok(chunks.every((c) => c.tokenCount <= 700));
  // Prefixo "Falante:" presente em todo pedaco.
  assert.ok(chunks.every((c) => c.text.includes('X:')));
  // chunkIndex sequencial.
  chunks.forEach((c, i) => assert.equal(c.chunkIndex, i));
  // Offsets cobrem o texto do turno em ordem, sem sobreposicao e sem buraco.
  const source = turns[0]!.text;
  let prevEnd = 0;
  for (const c of chunks) {
    assert.ok(c.charStart! >= prevEnd, 'pedacos em ordem, sem sobreposicao');
    assert.ok(c.charEnd! <= source.length);
    assert.ok(c.charEnd! > c.charStart!);
    prevEnd = c.charEnd!;
  }
  assert.equal(prevEnd, source.length, 'offsets cobrem o texto inteiro');
});

test('entrada vazia => array vazio', () => {
  assert.deepEqual(chunkTurns([], { targetTokens: 450, maxTurnTokens: 700 }), []);
});

test('turno unico curto => um unico chunk', () => {
  const turns = [{ turn_index: 0, speaker: 'A', text: 'oi tudo bem' }];
  const chunks = chunkTurns(turns, { targetTokens: 450, maxTurnTokens: 700 });
  assert.equal(chunks.length, 1);
  const c = chunks[0]!;
  assert.equal(c.chunkIndex, 0);
  assert.equal(c.turnStart, 0);
  assert.equal(c.turnEnd, 0);
  assert.equal(c.charStart, null);
  assert.equal(c.charEnd, null);
  assert.equal(c.text, 'A: oi tudo bem');
  assert.ok(c.tokenCount > 0);
});

test('opts default: targetTokens=450, maxTurnTokens=700', () => {
  // Sem opts, um turno gigante (>700 tok por construcao) deve virar monologo (>1 chunk).
  const turns = [{ turn_index: 0, speaker: 'Y', text: 'a. '.repeat(2000) }];
  const chunks = chunkTurns(turns);
  assert.ok(chunks.length > 1, 'default maxTurnTokens=700 dispara split do monologo');
  assert.ok(chunks.every((c) => c.charStart !== null));
});

test('corte na fronteira: 2 turnos cabem, o 3o estoura e abre novo chunk', () => {
  // Cada turno renderizado ("P: " + texto) estima ~50 tokens; o alvo (target=110)
  // comporta 2 turnos (100 + 1 do "\n" separador) e o 3o estoura => corte na fronteira.
  const target = 110;
  const max = 700;
  const text = 'x'.repeat(197); // "P: " (3) + 197 = 200 chars => 50 tokens
  const turns = [
    { turn_index: 0, speaker: 'P', text },
    { turn_index: 1, speaker: 'P', text },
    { turn_index: 2, speaker: 'P', text },
  ];
  assert.equal(estimateTokens('P: ' + text), 50); // sanity do dimensionamento
  const chunks = chunkTurns(turns, { targetTokens: target, maxTurnTokens: max });

  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0]!.turnStart, 0);
  assert.equal(chunks[0]!.turnEnd, 1, 'os dois primeiros turnos cabem no alvo');
  assert.equal(chunks.at(-1)!.turnEnd, 2, 'o 3o turno vai pro proximo chunk');
  assert.ok(chunks.every((c) => c.tokenCount <= max));
  assert.ok(chunks.every((c) => c.charStart === null && c.charEnd === null));
});

test('corte na fronteira: turno isolado ja no alvo fecha sozinho', () => {
  // Cada turno sozinho (~50 tok) cabe; mas com target baixo (40) cada turno
  // ja excede => cada um vira seu proprio chunk (corte sempre em fronteira).
  const text = 'x'.repeat(197); // render = 50 tokens > target
  const turns = [
    { turn_index: 0, speaker: 'P', text },
    { turn_index: 1, speaker: 'P', text },
  ];
  const chunks = chunkTurns(turns, { targetTokens: 40, maxTurnTokens: 700 });
  assert.equal(chunks.length, 2, 'cada turno isolado ja passa do alvo => 1 chunk cada');
  assert.equal(chunks[0]!.turnStart, 0);
  assert.equal(chunks[0]!.turnEnd, 0);
  assert.equal(chunks[1]!.turnEnd, 1);
});

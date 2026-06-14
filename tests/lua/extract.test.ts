import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFacts,
  type ExtractInput,
  type FactCandidate,
} from '../../src/lua/extract.js';
import type { LlmClient, LlmCompletionArgs } from '../../src/lua/llm.js';
import { runWithParseRetry } from '../../src/lua/llm.js';

// ── Fakes ───────────────────────────────────────────────────────────────────
//
// Sem rede, sem DB, sem golden set. Testamos o ENCANAMENTO: que extractFacts
// passa os candidatos roteirizados adiante, que o prompt carrega o contrato
// (mapa de enquadramento + tipos + defesa de injection) e que o janelamento
// dispara >1 chamada quando o transcript estoura maxInputTokens.

/** Cliente LLM fake roteirizado: devolve uma lista de candidatos por chamada. */
function makeFakeClient(
  scripts: FactCandidate[][],
): { client: LlmClient; systems: string[]; users: string[]; calls: number } {
  const systems: string[] = [];
  const users: string[] = [];
  const state = { calls: 0 };
  const client: LlmClient = {
    model: 'fake-sonnet',
    async complete<T = unknown>(args: LlmCompletionArgs): Promise<T> {
      systems.push(args.system);
      users.push(args.user);
      const out = scripts[Math.min(state.calls, scripts.length - 1)] ?? [];
      state.calls++;
      // O schema da extração é { facts: FactCandidate[] }.
      return { facts: out } as unknown as T;
    },
  };
  return {
    client,
    systems,
    users,
    get calls() {
      return state.calls;
    },
  } as { client: LlmClient; systems: string[]; users: string[]; calls: number };
}

function turns(n: number, perTurnText = 'palavra'): ExtractInput['transcript'] {
  return Array.from({ length: n }, (_, i) => ({
    turn_index: i,
    speaker: `P${i % 2}`,
    text: perTurnText,
  }));
}

const baseMeta: ExtractInput['metadata'] = {
  title: 'Reuniao de alinhamento',
  occurred_at: '2026-06-01T14:00:00Z',
  participants: ['Ana', 'Bruno'],
  workspace_id: 'wks_0001',
};

// ── 1. Encanamento: candidatos roteirizados saem como vieram ─────────────────

test('extractFacts devolve os candidatos que o fake produziu', async () => {
  const scripted: FactCandidate[] = [
    {
      fact_type: 'decisao',
      statement: 'A verba mensal passa a ser R$ 8.000.',
      attributes: { parameter: 'verba_mensal', value: 8000 },
      turn_start: 2,
      turn_end: 3,
      confidence: 0.9,
    },
  ];
  const { client } = makeFakeClient([scripted]);
  const out = await extractFacts(client, { transcript: turns(6), metadata: baseMeta });
  assert.deepEqual(out, scripted);
});

// ── 2. Small talk -> lista vazia ─────────────────────────────────────────────

test('extractFacts: fake devolve [] -> extractFacts devolve []', async () => {
  const { client } = makeFakeClient([[]]);
  const out = await extractFacts(client, { transcript: turns(4), metadata: baseMeta });
  assert.deepEqual(out, []);
});

// ── 3. Janelamento: transcript grande -> >1 chamada, candidatos concatenados ─

test('extractFacts janela transcript > maxInputTokens e concatena candidatos de todas as janelas', async () => {
  const fakeA: FactCandidate = {
    fact_type: 'objetivo',
    statement: 'Meta de 100 leads/mes ate o fim do trimestre.',
    attributes: { metric: 'leads', target: 100 },
    turn_start: 0,
    turn_end: 5,
    confidence: 0.8,
  };
  const fakeB: FactCandidate = {
    fact_type: 'compromisso',
    statement: 'Ana entrega o relatorio ate sexta.',
    attributes: { owner: 'Ana', due_date: '2026-06-05' },
    turn_start: 40,
    turn_end: 42,
    confidence: 0.85,
  };
  // Cada janela do fake devolve um candidato diferente.
  const fake = makeFakeClient([[fakeA], [fakeB]]);

  // Transcript com muitos turnos e texto longo para estourar um maxInputTokens
  // minusculo (200), forcando >1 janela.
  const transcript = turns(60, 'palavra '.repeat(40));
  const out = await extractFacts(fake.client, {
    transcript,
    metadata: baseMeta,
    maxInputTokens: 200,
  });

  assert.ok(fake.calls > 1, `esperava >1 chamada (janelamento), teve ${fake.calls}`);
  // Candidatos de TODAS as janelas concatenados (sem dedup nesta task — Task 12).
  assert.ok(out.some((f) => f.statement === fakeA.statement), 'candidato da janela A presente');
  assert.ok(out.some((f) => f.statement === fakeB.statement), 'candidato da janela B presente');
});

test('extractFacts: transcript pequeno -> 1 unica chamada', async () => {
  const fake = makeFakeClient([[]]);
  await extractFacts(fake.client, { transcript: turns(5), metadata: baseMeta });
  assert.equal(fake.calls, 1);
});

// ── 4. Contrato do prompt: enquadramento + tipos + defesa de injection ───────

test('o system prompt carrega o mapa de enquadramento, os 10 tipos e a regra anti-injection', async () => {
  const fake = makeFakeClient([[]]);
  await extractFacts(fake.client, { transcript: turns(4), metadata: baseMeta });
  const sys = fake.systems[0]!;

  // Os 10 tipos de fato (facts_type_chk / spec §0).
  for (const t of [
    'decisao',
    'preferencia',
    'restricao',
    'compromisso',
    'contexto',
    'objetivo',
    'ameaca',
    'oportunidade',
    'marco',
    'papel',
  ]) {
    assert.ok(sys.includes(t), `system prompt menciona o tipo "${t}"`);
  }

  // Mapa de enquadramento (alguns marcadores-chave da linguagem da mesa).
  assert.ok(/combinad|acord/i.test(sys), 'enquadramento: combinados/acordos -> compromisso');
  assert.ok(/unilateral/i.test(sys), 'enquadramento: decisao unilateral');
  assert.ok(/parametro|verba|meta|frequenc/i.test(sys), 'enquadramento: parametros novos -> decisao');
  assert.ok(/recorde|interrup|reclama/i.test(sys), 'enquadramento: eventos memoraveis -> marco');
  assert.ok(/quem.*cuida|quem.*quem|responsab/i.test(sys), 'enquadramento: quem cuida -> papel');

  // Defesa de injection (§6.5/§13): fato e REGISTRO, nunca comando.
  assert.ok(/registro/i.test(sys), 'regra: fato e um registro de fala');
  assert.ok(/nunca.*comando|nao.*obede|nao.*execut|imperativ/i.test(sys), 'regra anti-comando / nao obedecer instrucoes');
  assert.ok(/needs_review/i.test(sys), 'imperativos suspeitos -> needs_review');
});

// ── 5. Janela do user message carrega turn_index visivel + cabecalho de metadados ─

test('o user message expoe turn_index por turno e um cabecalho de metadados', async () => {
  const fake = makeFakeClient([[]]);
  await extractFacts(fake.client, { transcript: turns(3), metadata: baseMeta });
  const user = fake.users[0]!;
  // turn_index visivel para o modelo citar turn_start/turn_end.
  assert.ok(/\b0\b/.test(user) && /\b1\b/.test(user) && /\b2\b/.test(user), 'turn_index 0..2 visivel');
  // Cabecalho com metadados (titulo + workspace).
  assert.ok(user.includes('Reuniao de alinhamento'), 'titulo no cabecalho');
  assert.ok(user.includes('wks_0001'), 'workspace_id no cabecalho');
});

// ── 6. Retry-once de parse (testado no nivel baixo, sem rede) ────────────────
//
// A logica de retry-once-no-parse mora em llm.ts (runWithParseRetry), fatorada
// para ser testavel com um "raw completion" fake que falha 1x e entao sucede,
// sem tocar o SDK real (que so e exercido quando o cliente real chega — sem rede).

test('runWithParseRetry: parse falha 1x, reenvia com o erro no prompt e sucede', async () => {
  const seenUsers: string[] = [];
  let calls = 0;
  // raw devolve texto cru; parse joga no 1o, aceita no 2o.
  const raw = async (user: string): Promise<string> => {
    seenUsers.push(user);
    calls++;
    return calls === 1 ? '{ malformed' : '{"ok":true}';
  };
  const parse = (text: string): { ok: boolean } => {
    const obj = JSON.parse(text) as { ok: boolean };
    return obj;
  };
  const result = await runWithParseRetry(raw, parse, 'PROMPT ORIGINAL');
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2, 'exatamente uma re-tentativa');
  // A 2a tentativa carrega o prompt original + o erro de parse.
  assert.ok(seenUsers[1]!.includes('PROMPT ORIGINAL'), 'reenvio preserva o prompt');
  assert.ok(/erro|parse|invalid|json/i.test(seenUsers[1]!), 'reenvio inclui o erro de parse');
});

test('runWithParseRetry: parse falha 2x -> lanca', async () => {
  let calls = 0;
  const raw = async (): Promise<string> => {
    calls++;
    return 'nao e json';
  };
  const parse = (text: string): unknown => JSON.parse(text);
  await assert.rejects(() => runWithParseRetry(raw, parse, 'P'), /./);
  assert.equal(calls, 2, 'tentou exatamente 2x antes de lancar');
});

test('runWithParseRetry: sucesso na 1a -> nao reenvia', async () => {
  let calls = 0;
  const raw = async (): Promise<string> => {
    calls++;
    return '{"v":1}';
  };
  const result = await runWithParseRetry(raw, (t) => JSON.parse(t) as { v: number }, 'P');
  assert.deepEqual(result, { v: 1 });
  assert.equal(calls, 1);
});

// tests/whatsapp/stats-cte-materialized.test.ts
//
// Guarda de regressão do incidente de 2026-08-17: o dashboard de WhatsApp do
// número 19 (recanto-de-moria) devolvia 500 `57014 canceling statement due to
// statement timeout` porque `whatsapp_number_id = 19` não existia em nenhuma
// estatística do planner (o número nasceu DEPOIS do último autoanalyze de
// `messages`). Com estimativa `rows=1` o planner inlina os CTEs e escolhe Nested
// Loop Semi Join com agregado re-executado por linha — cúbico no número de
// mensagens. Medido: forma inlinada = timeout aos 30s com 1.208 mensagens; com
// `AS MATERIALIZED` = 16ms, mesmo resultado.
//
// O bug NÃO é resultado errado, é dependência de FORMA DE PLANO — por isso o
// teste é sobre a cerca de otimização no SQL, e não sobre valores. Um teste de
// valores passaria feliz com a versão quebrada (ela devolve o número certo,
// só leva 30s+). A prova comportamental está registrada no comentário do
// `stats.ts` e foi medida contra um schema que reproduz a estatística ruim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THREADS_IN_PERIOD_CTE, THREADS_SCOPED_CTE } from '../../src/whatsapp/stats.js';

test('threads_in_period é MATERIALIZED (cerca contra inlining → nested loop cúbico)', () => {
  assert.match(
    THREADS_IN_PERIOD_CTE,
    /threads_in_period\s+AS\s+MATERIALIZED\s*\(/,
    'sem AS MATERIALIZED o PG12+ inlina o CTE e o plano pode re-executar o agregado por linha — ver incidente 2026-08-17 no cabeçalho de stats.ts',
  );
});

test('threads_scoped é MATERIALIZED e carrega threads_in_period também materializado', () => {
  assert.match(
    THREADS_SCOPED_CTE,
    /threads_scoped\s+AS\s+MATERIALIZED\s*\(/,
    'threads_scoped é o CTE referenciado pelos buckets byStage/byTemperature/bySource — exatamente as 3 queries que travaram em prod',
  );
  // threads_scoped embute threads_in_period; as duas cercas têm de sobreviver juntas,
  // materializar só a de fora deixa a de dentro re-executável.
  assert.match(THREADS_SCOPED_CTE, /threads_in_period\s+AS\s+MATERIALIZED\s*\(/);
});

test('as duas únicas CTEs declaradas nos fragmentos são materializadas', () => {
  // Pega qualquer `<nome> AS (` sem MATERIALIZED — uma CTE nova que nasça sem a
  // cerca reintroduz o penhasco sem que ninguém perceba (falha só aparece no
  // tenant cuja estatística está velha).
  const semCerca = [...THREADS_SCOPED_CTE.matchAll(/(\w+)\s+AS\s+(?!MATERIALIZED)\(/g)].map((m) => m[1]);
  assert.deepEqual(semCerca, [], `CTE sem AS MATERIALIZED: ${semCerca.join(', ')}`);
});

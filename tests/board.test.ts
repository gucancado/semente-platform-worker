/**
 * tests/board.test.ts — testes PUROS (sem DATABASE_URL) da projeção do board.
 *
 * Cobre (Task C1.1):
 *  - Paridade da projeção TS↔SQL: `boardColumnSqlMirror` (transcrição do CASE
 *    board_column) === kernel `boardColumn` para TODOS os estados possíveis.
 *  - Cursor encode/decode (round-trip + rejeição de entradas inválidas).
 *  - Validação de params: `isBoardColumn` + limites.
 *
 * O CASE SQL REAL é provado por tests/whatsapp/board.db.test.ts (fixtures nas 5
 * colunas). Aqui provamos que a lógica transcrita não divergiu do kernel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardColumn, type OppStatus } from '../src/whatsapp/opportunity-core.js';
import {
  BOARD_COLUMNS,
  DEFAULT_LIMIT_PER_COLUMN,
  MAX_LIMIT_PER_COLUMN,
  boardColumnSqlMirror,
  decodeBoardCursor,
  encodeBoardCursor,
  isBoardColumn,
} from '../src/whatsapp/board.js';

// ── Paridade TS↔SQL: mirror === kernel para todos os estados ──────────────────

const LEADS: (boolean | null)[] = [null, true, false];
const STATUSES: OppStatus[] = ['em_andamento', 'ganho', 'perdido'];
const QUALS: (boolean | null)[] = [null, true, false];
const LOSS: (string | null)[] = [null, 'nao_lead', 'sem_orcamento'];

test('paridade: boardColumnSqlMirror === boardColumn para os 81 estados', () => {
  for (const isLead of LEADS) {
    for (const status of STATUSES) {
      for (const isQualified of QUALS) {
        for (const lossReason of LOSS) {
          const kernel = boardColumn(isLead, { status, isQualified, lossReason });
          const mirror = boardColumnSqlMirror(isLead, status, isQualified, lossReason);
          assert.equal(
            mirror, kernel,
            `divergência em isLead=${isLead} status=${status} isQ=${isQualified} loss=${lossReason}: mirror=${mirror} kernel=${kernel}`,
          );
        }
      }
    }
  }
});

test('paridade: casos de coluna representativos (documentação do mapeamento §5)', () => {
  assert.equal(boardColumnSqlMirror(null, 'em_andamento', null, null), 'novas_conversas');
  assert.equal(boardColumnSqlMirror(true, 'em_andamento', null, null), 'interessados');
  assert.equal(boardColumnSqlMirror(true, 'em_andamento', true, null), 'negociacoes');
  assert.equal(boardColumnSqlMirror(true, 'ganho', true, null), 'ganhos');
  assert.equal(boardColumnSqlMirror(true, 'perdido', true, 'sem_orcamento'), 'perdas');
  // Exclusões do board:
  assert.equal(boardColumnSqlMirror(true, 'perdido', null, 'nao_lead'), null, 'perda nao_lead fora do board');
  assert.equal(boardColumnSqlMirror(false, 'em_andamento', null, null), null, 'not_lead fora do board');
  assert.equal(boardColumnSqlMirror(true, 'em_andamento', false, null), null, 'em_andamento+desqualificado inalcançável');
  // perda sem motivo ainda conta (loss_reason NULL é DISTINCT FROM 'nao_lead'):
  assert.equal(boardColumnSqlMirror(true, 'perdido', true, null), 'perdas');
});

// ── Cursor encode/decode ──────────────────────────────────────────────────────

test('cursor: round-trip com lastMessageAt não-nulo', () => {
  const iso = '2026-07-15T12:34:56.789Z';
  const decoded = decodeBoardCursor(encodeBoardCursor(iso, 42));
  assert.deepEqual(decoded, { lastMessageAt: iso, oppId: 42 });
});

test('cursor: round-trip com lastMessageAt null (cauda NULLS LAST)', () => {
  const decoded = decodeBoardCursor(encodeBoardCursor(null, 7));
  assert.deepEqual(decoded, { lastMessageAt: null, oppId: 7 });
});

test('cursor: entradas inválidas → null', () => {
  assert.equal(decodeBoardCursor('não-base64!!'), null);
  assert.equal(decodeBoardCursor(Buffer.from('{}', 'utf8').toString('base64url')), null, 'não-array');
  assert.equal(decodeBoardCursor(Buffer.from('[1]', 'utf8').toString('base64url')), null, 'tamanho errado');
  assert.equal(decodeBoardCursor(Buffer.from('["2026-07-15T00:00:00Z",0]', 'utf8').toString('base64url')), null, 'oppId=0');
  assert.equal(decodeBoardCursor(Buffer.from('["2026-07-15T00:00:00Z",-1]', 'utf8').toString('base64url')), null, 'oppId negativo');
  assert.equal(decodeBoardCursor(Buffer.from('["not-a-date",5]', 'utf8').toString('base64url')), null, 'data inválida');
  assert.equal(decodeBoardCursor(Buffer.from('[123,5]', 'utf8').toString('base64url')), null, 'lastMessageAt numérico');
});

// ── Validação de params ────────────────────────────────────────────────────────

test('isBoardColumn: aceita só as 5 chaves canônicas', () => {
  for (const c of BOARD_COLUMNS) assert.equal(isBoardColumn(c), true);
  assert.equal(BOARD_COLUMNS.length, 5);
  assert.deepEqual([...BOARD_COLUMNS], ['novas_conversas', 'interessados', 'negociacoes', 'ganhos', 'perdas']);
  for (const bad of ['', 'novas', 'ganho', 'perdidos', undefined, null, 42]) {
    assert.equal(isBoardColumn(bad as unknown), false, `rejeita ${String(bad)}`);
  }
});

test('limites de limit_per_column expostos como constantes', () => {
  assert.equal(DEFAULT_LIMIT_PER_COLUMN, 30);
  assert.equal(MAX_LIMIT_PER_COLUMN, 100);
});

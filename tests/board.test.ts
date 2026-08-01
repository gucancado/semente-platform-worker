/**
 * tests/board.test.ts — testes PUROS (sem DATABASE_URL) da projeção do board.
 *
 * Cobre (Task C1.1 → atualizado p/ board 4 colunas, sem 'perdas'):
 *  - Paridade da projeção TS↔SQL: `boardColumnSqlMirror` (transcrição do CASE
 *    board_column) === kernel `boardColumn` para TODOS os estados possíveis.
 *  - Cursor encode/decode (round-trip + rejeição de entradas inválidas).
 *  - Validação de params: `isBoardColumn` + limites.
 *
 * O CASE SQL REAL é provado por tests/whatsapp/board.db.test.ts (fixtures nas 4
 * colunas + status filter). Aqui provamos que a lógica transcrita não divergiu do
 * kernel — agora perdido cai na COLUNA DE POSIÇÃO (deriva de isLead/isQualified),
 * não mais numa coluna 'perdas'.
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

test('paridade: casos de coluna representativos (documentação do mapeamento §1)', () => {
  // em_andamento cai na posição por isLead/isQualified.
  assert.equal(boardColumnSqlMirror(null, 'em_andamento', null, null), 'novas_conversas');
  assert.equal(boardColumnSqlMirror(true, 'em_andamento', null, null), 'interessados');
  assert.equal(boardColumnSqlMirror(true, 'em_andamento', true, null), 'negociacoes');
  // ganho é sempre 'ganhos' (nos 2 modos do toggle).
  assert.equal(boardColumnSqlMirror(true, 'ganho', true, null), 'ganhos');
  // Perdido agora deriva a MESMA coluna de posição (não mais 'perdas'):
  assert.equal(boardColumnSqlMirror(true, 'perdido', true, 'sem_orcamento'), 'negociacoes', 'perdido+qualificado → negociacoes');
  assert.equal(boardColumnSqlMirror(true, 'perdido', false, 'sem_orcamento'), 'interessados', 'perdido+desqualificado → interessados');
  assert.equal(boardColumnSqlMirror(null, 'perdido', null, 'sem_orcamento'), 'novas_conversas', 'perdido+isLead null → novas_conversas');
  assert.equal(boardColumnSqlMirror(true, 'perdido', null, 'sem_orcamento'), 'interessados', 'perdido+isLead true+isQ null → interessados');
  // Exclusões do board:
  assert.equal(boardColumnSqlMirror(true, 'perdido', null, 'nao_lead'), null, 'perda nao_lead (cascata) fora do board');
  assert.equal(boardColumnSqlMirror(false, 'em_andamento', null, null), null, 'not_lead fora do board');
  assert.equal(boardColumnSqlMirror(false, 'ganho', true, null), null, 'ganho de not_lead escondido');
  // Estado impossível (em_andamento+desqualificado, invariante §4.4): a projeção
  // agora o dobra em 'interessados' (mirror e kernel concordam — a paridade cobre).
  assert.equal(boardColumnSqlMirror(true, 'em_andamento', false, null), 'interessados', 'em_andamento+desqualificado (impossível) → interessados');
});

test('kernel boardColumn: perdido fica na coluna de posição (não mais em perdas)', () => {
  const perdido = (isLead: boolean | null, isQualified: boolean | null, lossReason: string | null) =>
    boardColumn(isLead, { status: 'perdido', isQualified, lossReason });
  assert.equal(perdido(true, true, 'sem_orcamento'), 'negociacoes', 'perdido+isQualified=true → negociacoes');
  assert.equal(perdido(true, false, 'sem_orcamento'), 'interessados', 'perdido+isQualified=false → interessados');
  assert.equal(perdido(null, null, 'sem_orcamento'), 'novas_conversas', 'perdido+isLead=null → novas_conversas');
  assert.equal(perdido(true, null, 'sem_orcamento'), 'interessados', 'perdido+isLead=true+isQualified=null → interessados');
  assert.equal(perdido(true, null, 'nao_lead'), null, 'perdido+nao_lead (cascata) → oculto');
  assert.equal(perdido(false, null, 'sem_orcamento'), null, 'not_lead → oculto mesmo perdido');
  assert.equal(boardColumn(true, { status: 'ganho', isQualified: true, lossReason: null }), 'ganhos', 'ganho → ganhos');
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

test('isBoardColumn: aceita só as 4 chaves canônicas (perdas removida)', () => {
  for (const c of BOARD_COLUMNS) assert.equal(isBoardColumn(c), true);
  assert.equal(BOARD_COLUMNS.length, 4);
  assert.deepEqual([...BOARD_COLUMNS], ['novas_conversas', 'interessados', 'negociacoes', 'ganhos']);
  for (const bad of ['', 'novas', 'ganho', 'perdas', 'perdidos', undefined, null, 42]) {
    assert.equal(isBoardColumn(bad as unknown), false, `rejeita ${String(bad)}`);
  }
});

test('limites de limit_per_column expostos como constantes', () => {
  assert.equal(DEFAULT_LIMIT_PER_COLUMN, 30);
  assert.equal(MAX_LIMIT_PER_COLUMN, 100);
});

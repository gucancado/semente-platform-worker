import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOppPatchV3,
  qualificationLabel,
  boardColumn,
  OppInvariantError,
  type OppStateV3,
} from '../src/whatsapp/opportunity-core.js';

const openOpportunity: OppStateV3 = {
  status: 'em_andamento',
  isQualified: null,
  closedAt: null,
  title: null,
  lossReason: null,
};

test('qualificationLabel mapeia null/true/false', () => {
  assert.equal(qualificationLabel(null), 'indefinido');
  assert.equal(qualificationLabel(true), 'qualificado');
  assert.equal(qualificationLabel(false), 'desqualificado');
});

test('ganho autoqualifica, cascateia lead e gera eventos status+qualification', () => {
  const result = applyOppPatchV3(openOpportunity, { status: 'ganho' });

  assert.deepEqual(result, {
    next: {
      status: 'ganho',
      isQualified: true,
      closedAt: null,
      title: null,
      lossReason: null,
    },
    events: [
      { field: 'status', oldValue: 'em_andamento', newValue: 'ganho' },
      { field: 'qualification', oldValue: 'indefinido', newValue: 'qualificado' },
    ],
    closedAtAction: 'set_now',
    threadLeadAction: 'set_true',
  });
});

test('desqualificar aberta sem status vira perdido e cascateia lead', () => {
  const result = applyOppPatchV3(openOpportunity, { isQualified: false });

  assert.deepEqual(result, {
    next: {
      status: 'perdido',
      isQualified: false,
      closedAt: null,
      title: null,
      lossReason: null,
    },
    events: [
      { field: 'status', oldValue: 'em_andamento', newValue: 'perdido' },
      { field: 'qualification', oldValue: 'indefinido', newValue: 'desqualificado' },
    ],
    closedAtAction: 'set_now',
    threadLeadAction: 'set_true',
  });
});

test('desqualificar com status contraditorio lanca invalid_value', () => {
  assert.throws(
    () => applyOppPatchV3(openOpportunity, { isQualified: false, status: 'em_andamento' }),
    (error) =>
      error instanceof OppInvariantError && error.code === 'invalid_value',
  );
});

test('desqualificar oportunidade ganha lanca desqualificar_ganho', () => {
  const current: OppStateV3 = {
    status: 'ganho',
    isQualified: true,
    closedAt: '2026-07-24T12:00:00.000Z',
    title: null,
    lossReason: null,
  };

  assert.throws(
    () => applyOppPatchV3(current, { isQualified: false }),
    (error) =>
      error instanceof OppInvariantError && error.code === 'desqualificar_ganho',
  );
});

test('reabrir perdida desqualificada limpa isQualified e lossReason', () => {
  const current: OppStateV3 = {
    status: 'perdido',
    isQualified: false,
    closedAt: '2026-07-24T12:00:00.000Z',
    title: null,
    lossReason: 'nao_lead',
  };

  const result = applyOppPatchV3(current, { status: 'em_andamento' });

  assert.deepEqual(result, {
    next: {
      status: 'em_andamento',
      isQualified: null,
      closedAt: '2026-07-24T12:00:00.000Z',
      title: null,
      lossReason: null,
    },
    events: [
      { field: 'status', oldValue: 'perdido', newValue: 'em_andamento' },
      { field: 'qualification', oldValue: 'desqualificado', newValue: 'indefinido' },
      { field: 'loss_reason', oldValue: 'nao_lead', newValue: null },
    ],
    closedAtAction: 'clear',
    threadLeadAction: 'keep',
  });
});

test('lossReason em oportunidade em_andamento lanca invalid_value', () => {
  assert.throws(
    () => applyOppPatchV3(openOpportunity, { lossReason: 'sem_orcamento' }),
    (error) =>
      error instanceof OppInvariantError && error.code === 'invalid_value',
  );
});

test('perdido para ganho limpa lossReason', () => {
  const current: OppStateV3 = {
    status: 'perdido',
    isQualified: true,
    closedAt: '2026-07-24T12:00:00.000Z',
    title: null,
    lossReason: 'sem_orcamento',
  };

  const result = applyOppPatchV3(current, { status: 'ganho' });

  assert.equal(result.next.status, 'ganho');
  assert.equal(result.next.isQualified, true);
  assert.equal(result.next.lossReason, null);
  assert.deepEqual(result.events, [
    { field: 'status', oldValue: 'perdido', newValue: 'ganho' },
    { field: 'loss_reason', oldValue: 'sem_orcamento', newValue: null },
  ]);
  assert.equal(result.closedAtAction, 'set_now');
  assert.equal(result.threadLeadAction, 'set_true');
});

test('alterar lossReason numa perdida gera evento loss_reason sem mexer no status', () => {
  const current: OppStateV3 = {
    status: 'perdido',
    isQualified: true,
    closedAt: '2026-07-24T12:00:00.000Z',
    title: null,
    lossReason: null,
  };

  const result = applyOppPatchV3(current, { lossReason: 'sem_orcamento' });

  assert.equal(result.next.status, 'perdido');
  assert.equal(result.next.lossReason, 'sem_orcamento');
  assert.deepEqual(result.events, [
    { field: 'loss_reason', oldValue: null, newValue: 'sem_orcamento' },
  ]);
  assert.equal(result.closedAtAction, 'keep');
  assert.equal(result.threadLeadAction, 'keep');
});

test('isQualified null numa qualificada nao cascateia lead', () => {
  const current: OppStateV3 = {
    status: 'em_andamento',
    isQualified: true,
    closedAt: null,
    title: null,
    lossReason: null,
  };

  const result = applyOppPatchV3(current, { isQualified: null });

  assert.equal(result.threadLeadAction, 'keep');
  assert.deepEqual(result.events, [
    { field: 'qualification', oldValue: 'qualificado', newValue: 'indefinido' },
  ]);
  assert.equal(result.next.isQualified, null);
  assert.equal(result.closedAtAction, 'keep');
});

test('no-op nao gera eventos e mantem closed_at', () => {
  const result = applyOppPatchV3(openOpportunity, { status: 'em_andamento' });

  assert.deepEqual(result, {
    next: openOpportunity,
    events: [],
    closedAtAction: 'keep',
    threadLeadAction: 'keep',
  });
});

test('boardColumn projeta as cinco colunas e os casos fora do board', () => {
  assert.equal(
    boardColumn(null, { status: 'em_andamento', isQualified: null, lossReason: null }),
    'novas_conversas',
  );
  assert.equal(
    boardColumn(true, { status: 'em_andamento', isQualified: null, lossReason: null }),
    'interessados',
  );
  assert.equal(
    boardColumn(true, { status: 'em_andamento', isQualified: true, lossReason: null }),
    'negociacoes',
  );
  assert.equal(
    boardColumn(true, { status: 'ganho', isQualified: true, lossReason: null }),
    'ganhos',
  );
  assert.equal(
    boardColumn(true, { status: 'perdido', isQualified: true, lossReason: 'sem_orcamento' }),
    'perdas',
  );
  assert.equal(
    boardColumn(false, { status: 'em_andamento', isQualified: null, lossReason: null }),
    null,
  );
  assert.equal(
    boardColumn(true, { status: 'perdido', isQualified: false, lossReason: 'nao_lead' }),
    null,
  );
});

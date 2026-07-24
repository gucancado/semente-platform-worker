import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOppPatch,
  migrationRowFor,
  normalizeTagName,
  OppInvariantError,
  type OppState,
} from '../../src/whatsapp/opportunity-core.js';

const openOpportunity: OppState = {
  status: 'em_andamento',
  qualification: 'indefinido',
  closedAt: null,
  title: null,
};

test('marcar como ganho autoqualifica e gera dois eventos', () => {
  const result = applyOppPatch(openOpportunity, { status: 'ganho' });

  assert.deepEqual(result, {
    next: {
      status: 'ganho',
      qualification: 'qualificado',
      closedAt: null,
      title: null,
    },
    events: [
      { field: 'status', oldValue: 'em_andamento', newValue: 'ganho' },
      { field: 'qualification', oldValue: 'indefinido', newValue: 'qualificado' },
    ],
    closedAtAction: 'set_now',
  });
});

test('patch com o mesmo status não gera evento e mantém closed_at', () => {
  const result = applyOppPatch(openOpportunity, { status: 'em_andamento' });

  assert.deepEqual(result, {
    next: openOpportunity,
    events: [],
    closedAtAction: 'keep',
  });
});

test('reabrir oportunidade limpa closed_at', () => {
  const current: OppState = {
    status: 'ganho',
    qualification: 'qualificado',
    closedAt: '2026-07-24T12:00:00.000Z',
    title: null,
  };

  const result = applyOppPatch(current, { status: 'em_andamento' });

  assert.equal(result.closedAtAction, 'clear');
  assert.equal(result.next.closedAt, current.closedAt);
  assert.deepEqual(result.events, [
    { field: 'status', oldValue: 'ganho', newValue: 'em_andamento' },
  ]);
});

test('trocar ganho por perdido redefine closed_at', () => {
  const current: OppState = {
    status: 'ganho',
    qualification: 'qualificado',
    closedAt: '2026-07-24T12:00:00.000Z',
    title: null,
  };

  const result = applyOppPatch(current, { status: 'perdido' });

  assert.equal(result.closedAtAction, 'set_now');
  assert.deepEqual(result.events, [
    { field: 'status', oldValue: 'ganho', newValue: 'perdido' },
  ]);
});

test('desqualificar uma oportunidade ganha lança erro de invariante', () => {
  const current: OppState = {
    status: 'ganho',
    qualification: 'qualificado',
    closedAt: '2026-07-24T12:00:00.000Z',
    title: null,
  };

  assert.throws(
    () => applyOppPatch(current, { qualification: 'desqualificado' }),
    (error) =>
      error instanceof OppInvariantError &&
      error.code === 'desqualificar_ganho',
  );

  assert.throws(
    () =>
      applyOppPatch(openOpportunity, {
        status: 'ganho',
        qualification: 'desqualificado',
      }),
    (error) =>
      error instanceof OppInvariantError &&
      error.code === 'desqualificar_ganho',
  );
});

test('mudar o título gera evento title', () => {
  const result = applyOppPatch(openOpportunity, { title: 'Nova oportunidade' });

  assert.deepEqual(result.events, [
    { field: 'title', oldValue: null, newValue: 'Nova oportunidade' },
  ]);
  assert.equal(result.next.title, 'Nova oportunidade');
  assert.equal(result.closedAtAction, 'keep');
});

test('migrationRowFor mapeia cliente', () => {
  assert.deepEqual(migrationRowFor('cliente'), {
    status: 'ganho',
    qualification: 'qualificado',
    closed: true,
  });
});

test('migrationRowFor mapeia qualificado', () => {
  assert.deepEqual(migrationRowFor('qualificado'), {
    status: 'em_andamento',
    qualification: 'qualificado',
    closed: false,
  });
});

test('migrationRowFor mapeia perdido', () => {
  assert.deepEqual(migrationRowFor('perdido'), {
    status: 'perdido',
    qualification: 'qualificado',
    closed: true,
  });
});

test('migrationRowFor ignora desqualificado', () => {
  assert.equal(migrationRowFor('desqualificado'), null);
});

test('migrationRowFor ignora stage desconhecido', () => {
  assert.equal(migrationRowFor('interessado'), null);
});

test('normalizeTagName remove bordas e colapsa whitespace', () => {
  assert.equal(normalizeTagName('  Cardio  BH '), 'Cardio BH');
});

test('normalizeTagName converte whitespace vazio em null', () => {
  assert.equal(normalizeTagName('  '), null);
});

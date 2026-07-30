// tests/whatsapp/ai-judgment-prompt.test.ts  (PURO)
//
// Prova o prompt pt-BR (papel, perguntas condicionais, guidances/catálogos/travas
// presentes quando existem) e o validador estrito do output (sticky-force-null,
// domínio de loss_reason/tags/not_lead_reason, coerência, JSON malformado → ok:false).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JudgmentContext } from '../../src/whatsapp/ai-judgment-context.js';
import type { StickyFlags } from '../../src/whatsapp/ai-sticky.js';
import { buildJudgmentPrompt, parseJudgmentDecision } from '../../src/whatsapp/ai-judgment-prompt.js';

const NO_STICKY: StickyFlags = {
  isLead: false,
  isQualified: false,
  status: false,
  lossReason: false,
  tagsRemovedByHuman: [],
};

function ctx(over: Partial<JudgmentContext> = {}): JudgmentContext {
  return {
    numberId: 1,
    identifier: 'c',
    workspaceId: 'ws',
    watermark: null,
    lastMessageAt: '2026-07-30T10:00:00.000Z',
    messages: [{ direction: 'inbound', text: 'oi, quero saber o preço', createdAt: '2026-07-30T10:00:00.000Z' }],
    triage: { isLead: null, leadSource: null, notes: null },
    openOpp: null,
    lastClosedOpp: null,
    settings: { newOppAfterDays: 30, aiLeadGuidance: null, aiQualifiedGuidance: null },
    lossReasons: [],
    notLeadReasons: [],
    tags: [],
    sticky: { ...NO_STICKY },
    ...over,
  };
}

const openOpp = {
  id: 200,
  title: 'Plano X',
  status: 'em_andamento' as const,
  isQualified: null,
  lossReason: null,
  tags: [],
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-29T00:00:00.000Z',
  closedAt: null,
};

// ── Prompt ──────────────────────────────────────────────────────────────────

test('prompt: papel observacional + pede só JSON, mensagens renderizadas', () => {
  const { system, user } = buildJudgmentPrompt(ctx());
  assert.match(system, /analista de CRM observacional/i);
  assert.match(system, /SOMENTE com um único objeto JSON/i);
  assert.match(user, /\[cliente\] oi, quero saber o preço/);
});

test('prompt: guidances e catálogos aparecem quando presentes', () => {
  const { user } = buildJudgmentPrompt(
    ctx({
      openOpp,
      settings: {
        newOppAfterDays: 30,
        aiLeadGuidance: 'lead = pediu orçamento de telhado',
        aiQualifiedGuidance: 'qualificado = tem obra em 30 dias',
      },
      lossReasons: [{ code: 'preco', label: 'Preço', description: 'achou caro' }],
      tags: [{ id: 10, name: 'Telhado', description: 'demanda de cobertura' }],
      notLeadReasons: ['Spam', 'Fornecedor'],
    }),
  );
  assert.match(user, /lead = pediu orçamento de telhado/);
  assert.match(user, /qualificado = tem obra em 30 dias/);
  assert.match(user, /preco: Preço — achou caro/);
  assert.match(user, /10: Telhado — demanda de cobertura/);
  assert.match(user, /"Spam", "Fornecedor"/);
});

test('prompt: guidance vazio → critério genérico, sem quebrar', () => {
  const { user } = buildJudgmentPrompt(ctx());
  // triagem indefinida e não travada → pergunta de triagem com critério genérico
  assert.match(user, /É um lead\?/);
  assert.match(user, /demonstra interesse real/i);
});

test('prompt: dimensões travadas por sticky são anunciadas; pergunta some', () => {
  const { user } = buildJudgmentPrompt(
    ctx({
      openOpp,
      triage: { isLead: true, leadSource: null, notes: null },
      sticky: { ...NO_STICKY, isQualified: true, status: true },
    }),
  );
  assert.match(user, /TRAVADAS \(mantenha null\)/);
  assert.match(user, /qualificação/);
  // qualify travado → não pede qualify
  assert.doesNotMatch(user, /está qualificada\?/);
});

test('prompt: sem opp aberta mas com fechada → pergunta closed_action', () => {
  const { user } = buildJudgmentPrompt(
    ctx({
      lastClosedOpp: { ...openOpp, id: 100, status: 'perdido', closedAt: '2026-07-05T00:00:00.000Z' },
    }),
  );
  assert.match(user, /"closed_action"/);
  assert.match(user, /reabrir/);
});

// ── Validador ─────────────────────────────────────────────────────────────────

test('validador: JSON malformado → ok:false', () => {
  const r = parseJudgmentDecision('não sou json {', ctx());
  assert.equal(r.ok, false);
});

test('validador: extrai JSON de cercas markdown', () => {
  const raw = '```json\n{"triage":"lead","not_lead_reason":null,"open_opp":null,"closed_action":null,"tags":[],"rationale":"ok"}\n```';
  const r = parseJudgmentDecision(raw, ctx());
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.decision.triage === 'lead');
});

test('validador: sticky força triage e qualify a null', () => {
  const raw = JSON.stringify({
    triage: 'lead',
    not_lead_reason: null,
    open_opp: { qualify: true, status: null, loss_reason: null },
    closed_action: null,
    tags: [],
    rationale: 'x',
  });
  const r = parseJudgmentDecision(
    raw,
    ctx({ openOpp, sticky: { ...NO_STICKY, isLead: true, isQualified: true } }),
  );
  assert.ok(r.ok);
  assert.equal(r.decision.triage, null); // is_lead travado
  assert.equal(r.decision.openOpp?.qualify, null); // qualify travado
});

test('validador: loss_reason fora do catálogo e nao_lead → null', () => {
  const base = { triage: null, not_lead_reason: null, closed_action: null, tags: [], rationale: '' };
  const c = ctx({ openOpp, lossReasons: [{ code: 'preco', label: 'Preço', description: null }] });

  const r1 = parseJudgmentDecision(
    JSON.stringify({ ...base, open_opp: { qualify: null, status: 'perdido', loss_reason: 'inexistente' } }),
    c,
  );
  assert.ok(r1.ok && r1.decision.openOpp?.lossReason === null);

  const r2 = parseJudgmentDecision(
    JSON.stringify({ ...base, open_opp: { qualify: null, status: 'perdido', loss_reason: 'nao_lead' } }),
    c,
  );
  assert.ok(r2.ok && r2.decision.openOpp?.lossReason === null);

  const r3 = parseJudgmentDecision(
    JSON.stringify({ ...base, open_opp: { qualify: null, status: 'perdido', loss_reason: 'preco' } }),
    c,
  );
  assert.ok(r3.ok && r3.decision.openOpp?.lossReason === 'preco');
});

test('validador: loss_reason incoerente (status não-perdido) é descartado', () => {
  const c = ctx({ openOpp, lossReasons: [{ code: 'preco', label: 'Preço', description: null }] });
  const r = parseJudgmentDecision(
    JSON.stringify({
      triage: null,
      not_lead_reason: null,
      open_opp: { qualify: null, status: null, loss_reason: 'preco' },
      closed_action: null,
      tags: [],
      rationale: '',
    }),
    c,
  );
  assert.ok(r.ok && r.decision.openOpp?.lossReason === null);
});

test('validador: open_opp descartado sem opp aberta; closed_action só com opp fechada', () => {
  // sem opp nenhuma
  const r1 = parseJudgmentDecision(
    JSON.stringify({
      triage: null,
      not_lead_reason: null,
      open_opp: { qualify: true, status: null, loss_reason: null },
      closed_action: 'reabrir',
      tags: [],
      rationale: '',
    }),
    ctx(),
  );
  assert.ok(r1.ok);
  assert.equal(r1.decision.openOpp, null);
  assert.equal(r1.decision.closedAction, null);

  // com opp aberta → closed_action não se aplica
  const r2 = parseJudgmentDecision(
    JSON.stringify({
      triage: null,
      not_lead_reason: null,
      open_opp: null,
      closed_action: 'criar_nova',
      tags: [],
      rationale: '',
    }),
    ctx({ openOpp }),
  );
  assert.ok(r2.ok && r2.decision.closedAction === null);
});

test('validador: reabrir travado por status sticky vira null; criar_nova passa', () => {
  const closed = { ...openOpp, id: 100, status: 'perdido' as const, closedAt: '2026-07-05T00:00:00.000Z' };
  const mk = (action: string) =>
    JSON.stringify({ triage: null, not_lead_reason: null, open_opp: null, closed_action: action, tags: [], rationale: '' });

  const r1 = parseJudgmentDecision(mk('reabrir'), ctx({ lastClosedOpp: closed, sticky: { ...NO_STICKY, status: true } }));
  assert.ok(r1.ok && r1.decision.closedAction === null);

  const r2 = parseJudgmentDecision(mk('criar_nova'), ctx({ lastClosedOpp: closed, sticky: { ...NO_STICKY, status: true } }));
  assert.ok(r2.ok && r2.decision.closedAction === 'criar_nova');
});

test('validador: tags filtradas ao catálogo, dedupe; coerção de string', () => {
  const c = ctx({ openOpp, tags: [{ id: 10, name: 'A', description: null }, { id: 11, name: 'B', description: null }] });
  const r = parseJudgmentDecision(
    JSON.stringify({
      triage: null,
      not_lead_reason: null,
      open_opp: null,
      closed_action: null,
      tags: [10, 10, 99, '11', 'lixo'],
      rationale: '',
    }),
    c,
  );
  assert.ok(r.ok);
  assert.deepEqual(r.decision.tags, [10, 11]);
});

test('validador: not_lead_reason só sobrevive com triage=not_lead e no catálogo', () => {
  const c = ctx({ notLeadReasons: ['Spam', 'Fornecedor'] });

  const r1 = parseJudgmentDecision(
    JSON.stringify({ triage: 'not_lead', not_lead_reason: 'spam', open_opp: null, closed_action: null, tags: [], rationale: '' }),
    c,
  );
  assert.ok(r1.ok && r1.decision.notLeadReason === 'Spam'); // normaliza pro label do catálogo

  const r2 = parseJudgmentDecision(
    JSON.stringify({ triage: 'lead', not_lead_reason: 'Spam', open_opp: null, closed_action: null, tags: [], rationale: '' }),
    c,
  );
  assert.ok(r2.ok && r2.decision.notLeadReason === null); // triage != not_lead → limpa

  const r3 = parseJudgmentDecision(
    JSON.stringify({ triage: 'not_lead', not_lead_reason: 'qualquer', open_opp: null, closed_action: null, tags: [], rationale: '' }),
    c,
  );
  assert.ok(r3.ok && r3.decision.notLeadReason === null); // fora do catálogo → null
});

test('validador: campos ausentes viram defaults null/[]/""', () => {
  const r = parseJudgmentDecision('{}', ctx());
  assert.ok(r.ok);
  assert.deepEqual(r.decision, {
    triage: null,
    notLeadReason: null,
    openOpp: null,
    closedAction: null,
    tags: [],
    rationale: '',
  });
});

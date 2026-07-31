// tests/whatsapp/ai-pattern-prompt.test.ts  (PURO)
//
// Prova o prompt pt-BR do analista de PADRÕES nível 2 (papel das etiquetas, padrões
// recorrentes ≥3, humanOwned não-editável, anti-injeção nos rationais, só JSON) e o
// validador estrito (caps, edit só de ids do contexto não-humanOwned, retro ⊆ ids,
// colisão de nome vira edição, código reservado barrado, insightSummary obrigatório).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PatternContext } from '../../src/whatsapp/ai-pattern-context.js';
import { buildPatternPrompt, parsePatternDecision } from '../../src/whatsapp/ai-pattern-prompt.js';

const NOW = '2026-07-28T03:00:00.000Z';

function ctx(over: Partial<PatternContext> = {}): PatternContext {
  return {
    workspaceId: 'ws',
    periodStart: '2026-07-21',
    periodEnd: '2026-07-27',
    judgments: [],
    tags: [],
    lossReasons: [],
    aggregates: { byOpportunityTag: {}, byLossReason: {}, byOpportunityStatus: {} },
    guidances: { lead: null, qualified: null },
    triageCounts: { judged: 0, toLead: 0, toNotLead: 0 },
    opportunityIds: [],
    lossBackfillCandidates: [],
    ...over,
  };
}

// ── Prompt ──────────────────────────────────────────────────────────────────

test('prompt: papel de analista de padrões + só JSON + período/data injetados', () => {
  const { system, user } = buildPatternPrompt(ctx(), NOW);
  assert.match(system, /analista de PADR[ÕO]ES/i);
  assert.match(system, /SOMENTE com um único objeto JSON/i);
  assert.match(system, /O QU[ÊE]|POR QU[ÊE]/); // papel das etiquetas
  assert.match(system, /DEMANDA REPRIMIDA/i);
  assert.match(system, /pelo menos 3|≥ ?3|3 conversas/i); // recorrência
  assert.match(user, /2026-07-21.*2026-07-27/);
  assert.match(user, /2026-07-28T03:00:00\.000Z/);
});

test('prompt: rationais entre delimitadores + aviso de dados-não-comandos', () => {
  const { system, user } = buildPatternPrompt(
    ctx({
      judgments: [
        { identifier: 'a', rationale: 'cliente quer plano odontológico', applied: ['triage:lead'], decidedAt: NOW },
      ],
    }),
    NOW,
  );
  assert.match(system, /‹rationais›|<rationais>/);
  assert.match(system, /DADOS|não.*instru|NUNCA/i);
  assert.match(user, /<rationais>/);
  assert.match(user, /<\/rationais>/);
  assert.match(user, /cliente quer plano odontológico/);
});

test('prompt: humanOwned aparece como não-editável; catálogos e agregados renderizados', () => {
  const { user } = buildPatternPrompt(
    ctx({
      tags: [
        { id: 10, name: 'Bairro X', description: 'zona sul', humanOwned: true },
        { id: 11, name: 'Plano', description: null, humanOwned: false },
      ],
      lossReasons: [
        { code: 'lead_nao_respondeu', label: 'Lead não respondeu', description: null, active: true, system: true, humanOwned: false },
        { id: 5, code: 'preco', label: 'Preço', description: 'achou caro', active: true, system: false, humanOwned: false },
      ],
      aggregates: { byOpportunityStatus: { ganho: 3, perdido: 8 }, byLossReason: { preco: 5 }, byOpportunityTag: { 'Bairro X': 4 } },
      guidances: { lead: 'pediu orçamento', qualified: null },
      triageCounts: { judged: 12, toLead: 7, toNotLead: 3 },
      opportunityIds: [41, 55, 60],
    }),
    NOW,
  );
  assert.match(user, /10: Bairro X/);
  assert.match(user, /não editável/i); // marca do humanOwned
  assert.match(user, /preco/);
  assert.match(user, /sistema/i); // motivo de sistema marcado
  assert.match(user, /ganho.*3|3.*ganho/);
  assert.match(user, /pediu orçamento/);
  assert.match(user, /12/); // judged
  assert.match(user, /41, 55, 60|41,55,60/); // ids citáveis
});

// ── Validador ─────────────────────────────────────────────────────────────────

const base = {
  new_tags: [],
  edit_tags: [],
  new_loss_reasons: [],
  edit_loss_reasons: [],
  guidance_suggestions: [],
  insight_summary: 'resumo da semana',
};
const mk = (over: Record<string, unknown>) => JSON.stringify({ ...base, ...over });

test('validador: JSON malformado → ok:false', () => {
  const r = parsePatternDecision('não é json {', ctx());
  assert.equal(r.ok, false);
});

test('validador: insightSummary ausente/vazio → ok:false; cap 2000', () => {
  const r1 = parsePatternDecision(mk({ insight_summary: '   ' }), ctx());
  assert.equal(r1.ok, false);
  const r2 = parsePatternDecision(mk({ insight_summary: 'x'.repeat(3000) }), ctx());
  assert.ok(r2.ok && r2.decision.insightSummary.length === 2000);
});

test('validador: extrai JSON de cercas markdown', () => {
  const raw = '```json\n' + mk({ insight_summary: 'ok' }) + '\n```';
  const r = parsePatternDecision(raw, ctx());
  assert.ok(r.ok && r.decision.insightSummary === 'ok');
});

test('validador: caps newTags≤5, newLossReasons≤3, guidance≤2', () => {
  const r = parsePatternDecision(
    mk({
      new_tags: Array.from({ length: 8 }, (_, i) => ({ name: `T${i}`, description: 'd', retro_opportunity_ids: [] })),
      new_loss_reasons: Array.from({ length: 6 }, (_, i) => ({ label: `Motivo ${i}`, description: 'd' })),
      guidance_suggestions: [
        { kind: 'guidance_lead', suggested: 'A', reason: 'x' },
        { kind: 'guidance_qualified', suggested: 'B', reason: 'y' },
        { kind: 'guidance_lead', suggested: 'C', reason: 'z' },
      ],
    }),
    ctx(),
  );
  assert.ok(r.ok);
  assert.equal(r.decision.newTags.length, 5);
  assert.equal(r.decision.newLossReasons.length, 3);
  assert.equal(r.decision.guidanceSuggestions.length, 2);
});

test('validador: cap de EDIÇÃO editTags≤5 (simétrico à criação, anti-drift) — trunca com warn', () => {
  // 8 tags editáveis no contexto; 8 edições pedidas → só 5 sobrevivem.
  const c = ctx({
    tags: Array.from({ length: 8 }, (_, i) => ({ id: 10 + i, name: `T${i}`, description: null, humanOwned: false })),
  });
  const warns: unknown[][] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a); };
  let r: ReturnType<typeof parsePatternDecision>;
  try {
    r = parsePatternDecision(
      mk({ edit_tags: Array.from({ length: 8 }, (_, i) => ({ id: 10 + i, description: `d${i}` })) }),
      c,
    );
  } finally { console.warn = orig; }
  assert.ok(r.ok);
  assert.equal(r.decision.editTags.length, 5, 'editTags truncado no cap 5');
  assert.ok(warns.some((w) => /editTags acima do limite/.test(String(w[0]))), 'loga warn no truncamento');
});

test('validador: cap de EDIÇÃO editLossReasons≤3 (simétrico à criação, anti-drift) — trunca com warn', () => {
  const c = ctx({
    lossReasons: Array.from({ length: 6 }, (_, i) => ({
      id: 5 + i, code: `c${i}`, label: `L${i}`, description: null, active: true, system: false, humanOwned: false,
    })),
  });
  const warns: unknown[][] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a); };
  let r: ReturnType<typeof parsePatternDecision>;
  try {
    r = parsePatternDecision(
      mk({ edit_loss_reasons: Array.from({ length: 6 }, (_, i) => ({ id: 5 + i, description: `d${i}` })) }),
      c,
    );
  } finally { console.warn = orig; }
  assert.ok(r.ok);
  assert.equal(r.decision.editLossReasons.length, 3, 'editLossReasons truncado no cap 3');
  assert.ok(warns.some((w) => /editLossReasons acima do limite/.test(String(w[0]))), 'loga warn no truncamento');
});

test('validador: editTags só de ids do contexto e não-humanOwned', () => {
  const c = ctx({
    tags: [
      { id: 10, name: 'A', description: null, humanOwned: false },
      { id: 11, name: 'B', description: null, humanOwned: true },
    ],
  });
  const r = parsePatternDecision(
    mk({
      edit_tags: [
        { id: 10, description: 'nova desc' }, // ok
        { id: 11, description: 'tenta' }, // humanOwned → dropado
        { id: 99, description: 'inexistente' }, // fora do contexto → dropado
      ],
    }),
    c,
  );
  assert.ok(r.ok);
  assert.deepEqual(r.decision.editTags, [{ id: 10, description: 'nova desc' }]);
});

test('validador: newTag que colide (case-insensitive) vira editTag se não-humanOwned; senão descarta', () => {
  const c = ctx({
    tags: [
      { id: 10, name: 'Plano saúde', description: null, humanOwned: false },
      { id: 20, name: 'Bairro X', description: null, humanOwned: true },
    ],
  });
  const r = parsePatternDecision(
    mk({
      new_tags: [
        { name: 'PLANO SAÚDE', description: 'critério novo', retro_opportunity_ids: [] }, // colide com 10 (editável) → edit
        { name: 'bairro x', description: 'nao pode', retro_opportunity_ids: [] }, // colide com 20 (humanOwned) → descarta
        { name: 'Telhado', description: 'nova de fato', retro_opportunity_ids: [] }, // genuinamente nova
      ],
    }),
    c,
  );
  assert.ok(r.ok);
  assert.deepEqual(r.decision.newTags, [{ name: 'Telhado', description: 'nova de fato', retroOpportunityIds: [] }]);
  assert.deepEqual(r.decision.editTags, [{ id: 10, description: 'critério novo' }]);
});

test('validador: retroOpportunityIds filtrados ao whitelist do contexto', () => {
  const c = ctx({ opportunityIds: [41, 55, 60] });
  const r = parsePatternDecision(
    mk({ new_tags: [{ name: 'Nova', description: 'd', retro_opportunity_ids: [41, 99, 55, 41, 'x'] }] }),
    c,
  );
  assert.ok(r.ok);
  assert.deepEqual(r.decision.newTags[0]!.retroOpportunityIds, [41, 55]); // 99/'x' fora; dedupe
});

test('validador: newLossReason com código reservado/sistema é barrado', () => {
  const r = parsePatternDecision(
    mk({
      new_loss_reasons: [
        { label: 'Não lead', description: 'x' }, // slug 'nao_lead' → RESERVED → dropado
        { label: 'Lead não respondeu', description: 'y' }, // slug de sistema → dropado
        { label: 'Sem orçamento', description: 'ok' }, // válido
      ],
    }),
    ctx(),
  );
  assert.ok(r.ok);
  assert.deepEqual(r.decision.newLossReasons, [{ label: 'Sem orçamento', description: 'ok' }]);
});

test('validador: editLossReason só de ids custom do contexto não-humanOwned; sistema (sem id) nunca casa', () => {
  const c = ctx({
    lossReasons: [
      { code: 'lead_nao_respondeu', label: 'Lead não respondeu', description: null, active: true, system: true, humanOwned: false },
      { id: 5, code: 'preco', label: 'Preço', description: null, active: true, system: false, humanOwned: false },
      { id: 6, code: 'humano', label: 'Humano', description: null, active: true, system: false, humanOwned: true },
    ],
  });
  const r = parsePatternDecision(
    mk({
      edit_loss_reasons: [
        { id: 5, description: 'melhor critério' }, // ok
        { id: 6, description: 'nao pode' }, // humanOwned → dropado
        { id: 999, description: 'inexistente' }, // fora → dropado
      ],
    }),
    c,
  );
  assert.ok(r.ok);
  assert.deepEqual(r.decision.editLossReasons, [{ id: 5, description: 'melhor critério' }]);
});

test('validador: newLossReason que colide com custom humanOwned protege sticky (descarta)', () => {
  const c = ctx({
    lossReasons: [
      { id: 6, code: 'preco', label: 'Preço', description: 'humano', active: true, system: false, humanOwned: true },
      { id: 7, code: 'sem_orcamento', label: 'Sem orçamento', description: null, active: true, system: false, humanOwned: false },
    ],
  });
  const r = parsePatternDecision(
    mk({
      new_loss_reasons: [
        { label: 'Preço', description: 'reescreve humano' }, // colide com humanOwned → descarta
        { label: 'Sem orçamento', description: 'nova desc' }, // colide com não-humanOwned → vira edit
      ],
    }),
    c,
  );
  assert.ok(r.ok);
  assert.deepEqual(r.decision.newLossReasons, []);
  assert.deepEqual(r.decision.editLossReasons, [{ id: 7, description: 'nova desc' }]);
});

test('validador: guidance kind inválido dropado; dedupe por kind; texto vazio dropado', () => {
  const r = parsePatternDecision(
    mk({
      guidance_suggestions: [
        { kind: 'guidance_lead', suggested: 'texto A', reason: 'r1' },
        { kind: 'guidance_lead', suggested: 'texto B', reason: 'r2' }, // dup kind → dropado
        { kind: 'invalido', suggested: 'x', reason: 'y' }, // kind inválido → dropado
        { kind: 'guidance_qualified', suggested: '   ', reason: 'z' }, // vazio → dropado
      ],
    }),
    ctx(),
  );
  assert.ok(r.ok);
  assert.deepEqual(r.decision.guidanceSuggestions, [{ kind: 'guidance_lead', suggested: 'texto A', reason: 'r1' }]);
});

test('validador: campos ausentes viram listas vazias (com insight presente)', () => {
  const r = parsePatternDecision(JSON.stringify({ insight_summary: 'só o resumo' }), ctx());
  assert.ok(r.ok);
  assert.deepEqual(r.decision, {
    newTags: [],
    editTags: [],
    newLossReasons: [],
    editLossReasons: [],
    guidanceSuggestions: [],
    backfillLossReasons: [],
    insightSummary: 'só o resumo',
  });
});

// ── backfill de loss_reason (spec §8) ─────────────────────────────────────────

test('prompt: seção de backfill só aparece quando há candidatas', () => {
  const semCand = buildPatternPrompt(ctx(), NOW).user;
  assert.doesNotMatch(semCand, /OPORTUNIDADES PERDIDAS SEM MOTIVO/);
  const comCand = buildPatternPrompt(
    ctx({ lossBackfillCandidates: [{ opportunityId: 71, rationale: 'lead sumiu após orçamento' }] }),
    NOW,
  ).user;
  assert.match(comCand, /OPORTUNIDADES PERDIDAS SEM MOTIVO/);
  assert.match(comCand, /opp 71/);
  assert.match(comCand, /lead sumiu após orçamento/);
});

test('validador: backfill só de opp ∈ candidatas e code ∈ catálogo ativo (nunca nao_lead); dedupe + cap', () => {
  const c = ctx({
    lossBackfillCandidates: [
      { opportunityId: 71, rationale: 'x' }, { opportunityId: 72, rationale: null }, { opportunityId: 73, rationale: 'y' },
    ],
    lossReasons: [
      { id: 5, code: 'preco', label: 'Preço', description: null, active: true, system: false, humanOwned: false },
      { id: 6, code: 'inativo', label: 'Inativo', description: null, active: false, system: false, humanOwned: false },
      { code: 'lead_nao_respondeu', label: 'Lead não respondeu', description: null, active: true, system: true, humanOwned: false },
    ],
  });
  const r = parsePatternDecision(
    mk({
      backfill_loss_reasons: [
        { opportunity_id: 71, code: 'PRECO' },          // ok (case-insensitive) → preco
        { opportunity_id: 71, code: 'lead_nao_respondeu' }, // dup opp → dropado
        { opportunity_id: 72, code: 'inativo' },         // code inativo → dropado
        { opportunity_id: 99, code: 'preco' },           // opp fora das candidatas → dropado
        { opportunity_id: 73, code: 'nao_lead' },        // cascata → dropado
      ],
    }),
    c,
  );
  assert.ok(r.ok);
  assert.deepEqual(r.decision.backfillLossReasons, [{ opportunityId: 71, code: 'preco' }]);
});

test('validador: backfill respeita cap 10', () => {
  const cands = Array.from({ length: 15 }, (_, i) => ({ opportunityId: 100 + i, rationale: 'r' }));
  const c = ctx({
    lossBackfillCandidates: cands,
    lossReasons: [{ id: 5, code: 'preco', label: 'Preço', description: null, active: true, system: false, humanOwned: false }],
  });
  const r = parsePatternDecision(
    mk({ backfill_loss_reasons: cands.map((x) => ({ opportunity_id: x.opportunityId, code: 'preco' })) }),
    c,
  );
  assert.ok(r.ok);
  assert.equal(r.decision.backfillLossReasons.length, 10);
});

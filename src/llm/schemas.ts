/**
 * src/llm/schemas.ts
 *
 * JSON Schemas das saídas de cada tarefa, para structured outputs da Anthropic.
 * Espelham o "Formato exato" escrito em cada prompt. São só a PRIMEIRA defesa:
 * o validador de cada tarefa (parseJudgmentDecision, parsePatternDecision,
 * parseDigest) continua aplicando catálogo, sticky, caps e limites — e é ele
 * que manda. Mudou o formato no prompt? Mude aqui também.
 */

const str = { type: 'string' } as const;
const nullable = (s: Record<string, unknown>) => ({ anyOf: [s, { type: 'null' }] });

/** IA do CRM nível 1 — ver SYSTEM_PROMPT em src/whatsapp/ai-judgment-prompt.ts. */
export const JUDGMENT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    triage: nullable({ type: 'string', enum: ['lead', 'not_lead'] }),
    not_lead_reason: nullable(str),
    open_opp: nullable({
      type: 'object',
      properties: {
        qualify: nullable({ type: 'boolean' }),
        status: nullable({ type: 'string', enum: ['ganho', 'perdido'] }),
        loss_reason: nullable(str),
      },
      required: ['qualify', 'status', 'loss_reason'],
    }),
    closed_action: nullable({ type: 'string', enum: ['nada', 'reabrir', 'criar_nova'] }),
    tags: { type: 'array', items: { type: 'integer' } },
    rationale: str,
  },
  required: ['triage', 'not_lead_reason', 'open_opp', 'closed_action', 'tags', 'rationale'],
};

/** IA do CRM nível 2 — ver SYSTEM_PROMPT em src/whatsapp/ai-pattern-prompt.ts. */
export const PATTERN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tag_suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: str, description: str, reason: str },
        required: ['name', 'description', 'reason'],
      },
    },
    new_loss_reasons: {
      type: 'array',
      items: { type: 'object', properties: { label: str, description: str }, required: ['label', 'description'] },
    },
    edit_loss_reasons: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'integer' }, description: str }, required: ['id', 'description'] },
    },
    guidance_suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['guidance_lead', 'guidance_qualified'] },
          suggested: str,
          reason: str,
        },
        required: ['kind', 'suggested', 'reason'],
      },
    },
    backfill_loss_reasons: {
      type: 'array',
      items: {
        type: 'object',
        properties: { opportunity_id: { type: 'integer' }, code: str },
        required: ['opportunity_id', 'code'],
      },
    },
    insight_summary: str,
  },
  required: [
    'tag_suggestions', 'new_loss_reasons', 'edit_loss_reasons',
    'guidance_suggestions', 'backfill_loss_reasons', 'insight_summary',
  ],
};

/** Digest de reunião — ver SYSTEM em src/meetings-summary/prompt.ts. */
export const DIGEST_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    resumo: str,
    pontos: { type: 'array', items: str },
    decisoes: { type: 'array', items: str },
    acoes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { o_que: str, responsavel: nullable(str), prazo: nullable(str) },
        required: ['o_que', 'responsavel', 'prazo'],
      },
    },
    pendencias: { type: 'array', items: str },
  },
  required: ['resumo', 'pontos', 'decisoes', 'acoes', 'pendencias'],
};

/**
 * src/llm/tasks.ts
 *
 * Constrói o provider de cada tarefa de texto a partir da config (env). Ponto
 * ÚNICO usado pelo boot (index.ts) e pelos CLIs, para que os dois nunca
 * escolham provedores diferentes para a mesma tarefa.
 */
import { config, crmPatternLlmChoice } from '../config.js';
import { TextJudgmentLlm, JUDGMENT_MAX_TOKENS, PATTERN_MAX_TOKENS } from '../whatsapp/ai-llm.js';
import { TextSummaryLlm } from '../meetings-summary/provider.js';
import { createTextLlm } from './factory.js';
import { JUDGMENT_SCHEMA, PATTERN_SCHEMA } from './schemas.js';

type Cfg = typeof config;

export function buildJudgmentLlm(cfg: Cfg = config): TextJudgmentLlm {
  const llm = createTextLlm('crm-ai-judgment', cfg.CRM_AI_PROVIDER, cfg.CRM_AI_MODEL, cfg);
  return new TextJudgmentLlm(llm, {
    schema: JUDGMENT_SCHEMA, maxTokens: JUDGMENT_MAX_TOKENS, effort: cfg.CRM_AI_EFFORT ?? 'low', thinking: cfg.CRM_AI_THINKING,
  });
}

export function buildPatternLlm(cfg: Cfg = config): TextJudgmentLlm {
  const { provider, model } = crmPatternLlmChoice(cfg);
  const llm = createTextLlm('crm-ai-pattern', provider, model, cfg);
  return new TextJudgmentLlm(llm, { schema: PATTERN_SCHEMA, maxTokens: PATTERN_MAX_TOKENS, effort: cfg.CRM_AI_EFFORT ?? 'low' });
}

export function buildSummaryLlm(cfg: Cfg = config): TextSummaryLlm {
  const llm = createTextLlm('meeting-summary', cfg.MEETING_SUMMARY_PROVIDER, cfg.MEETING_SUMMARY_MODEL, cfg);
  return new TextSummaryLlm(llm, { effort: cfg.MEETING_SUMMARY_EFFORT });
}

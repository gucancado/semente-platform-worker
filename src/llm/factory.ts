/**
 * src/llm/factory.ts
 *
 * Seleção de provedor POR TAREFA, por env, sem deploy:
 *   CRM_AI_PROVIDER / CRM_AI_MODEL                       — IA do CRM nível 1
 *   CRM_AI_PATTERN_PROVIDER / CRM_AI_PATTERN_MODEL       — IA do CRM nível 2
 *   MEETING_SUMMARY_PROVIDER / MEETING_SUMMARY_MODEL     — digest de reunião
 *   LUA_PROVIDER / LUA_{EXTRACTION,JUDGE,RECAP}_MODEL    — Lua
 * Trocar = mudar a env no Coolify + restart. Sem fallback automático entre
 * provedores: uma conta fora do ar vira erro `systemic` na fila, que espera.
 *
 * Modelo incompatível com o provedor (ex.: provider=anthropic com model=gpt-…)
 * falha no BOOT, não na primeira chamada da madrugada.
 */
import { AnthropicTextLlm } from './anthropic.js';
import { OpenAITextLlm } from './openai.js';
import type { LlmProviderName, TextLlm } from './types.js';

export type LlmKeys = { OPENAI_API_KEY?: string; ANTHROPIC_API_KEY?: string };

export function assertModelMatchesProvider(task: string, provider: LlmProviderName, model: string): void {
  const isClaude = model.startsWith('claude-');
  if (provider === 'anthropic' && !isClaude) {
    throw new Error(`${task}: provider=anthropic com modelo '${model}' (esperado claude-*)`);
  }
  if (provider === 'openai' && isClaude) {
    throw new Error(`${task}: provider=openai com modelo '${model}' (modelo Claude)`);
  }
}

export function createTextLlm(task: string, provider: LlmProviderName, model: string, keys: LlmKeys): TextLlm {
  assertModelMatchesProvider(task, provider, model);
  if (provider === 'anthropic') {
    if (!keys.ANTHROPIC_API_KEY) throw new Error(`${task}: provider=anthropic exige ANTHROPIC_API_KEY`);
    return new AnthropicTextLlm({ apiKey: keys.ANTHROPIC_API_KEY, model });
  }
  if (!keys.OPENAI_API_KEY) throw new Error(`${task}: provider=openai exige OPENAI_API_KEY`);
  return new OpenAITextLlm({ apiKey: keys.OPENAI_API_KEY, model });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APIError as AnthropicAPIError, APIConnectionError as AnthropicConnErr } from '@anthropic-ai/sdk';
import { APIError as OpenAIAPIError, APIConnectionError as OpenAIConnErr } from 'openai';

import { AnthropicTextLlm, toStructuredSchema } from '../../src/llm/anthropic.js';
import { OpenAITextLlm } from '../../src/llm/openai.js';
import { classifyLlmError } from '../../src/llm/errors.js';
import { llmCost } from '../../src/llm/pricing.js';
import { createTextLlm } from '../../src/llm/factory.js';
import { JUDGMENT_SCHEMA, DIGEST_SCHEMA, PATTERN_SCHEMA } from '../../src/llm/schemas.js';
import { TextJudgmentLlm, judgmentCost } from '../../src/whatsapp/ai-llm.js';
import { TextSummaryLlm, summaryCost } from '../../src/meetings-summary/provider.js';
import { classifySummaryError } from '../../src/meetings-summary/error-class.js';

// ── fakes ──
function fakeAnthropic(response: Record<string, unknown>) {
  const calls: any[] = [];
  const client = {
    messages: {
      create: async (body: any, opts: any) => {
        calls.push({ body, opts });
        return response;
      },
    },
  };
  return { client: client as any, calls };
}

function fakeOpenAI(response: Record<string, unknown>) {
  const calls: any[] = [];
  const client = {
    chat: { completions: { create: async (body: any, opts: any) => { calls.push({ body, opts }); return response; } } },
  };
  return { client: client as any, calls };
}

const anthropicOk = {
  content: [{ type: 'text', text: '{"a":1}' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 },
};

test('anthropic: structured output via output_config.format, sem prefill/tool/temperature', async () => {
  const { client, calls } = fakeAnthropic(anthropicOk);
  const llm = new AnthropicTextLlm({ apiKey: 'x', model: 'claude-haiku-5-5', client });
  const r = await llm.complete({
    system: 'sys', messages: [{ role: 'user', content: 'u' }],
    json: { schema: JUDGMENT_SCHEMA }, maxTokens: 500, effort: 'low', timeoutMs: 1234,
  });
  const b = calls[0].body;
  assert.equal(b.model, 'claude-haiku-5-5');
  assert.equal(b.max_tokens, 500);
  assert.equal(b.output_config.effort, 'low');
  assert.equal(b.output_config.format.type, 'json_schema');
  assert.equal(b.output_config.format.schema.additionalProperties, false);
  assert.equal(b.temperature, undefined);
  assert.equal(b.tools, undefined);
  assert.equal(b.tool_choice, undefined);
  assert.equal(b.thinking, undefined);
  assert.equal(b.messages.at(-1).role, 'user', 'nunca termina em assistant (prefill)');
  assert.deepEqual(calls[0].opts, { timeout: 1234 });
  assert.equal(r.text, '{"a":1}');
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.finishReason, 'stop');
  // input = fresco + cache lido + cache gravado
  assert.deepEqual(r.usage, { input: 1150, output: 20, cachedInput: 1000, cacheWrite: 50 });
});

test('anthropic: stop_reason max_tokens → length; refusal → refusal', async () => {
  for (const [stop, want] of [['max_tokens', 'length'], ['refusal', 'refusal']] as const) {
    const { client } = fakeAnthropic({ ...anthropicOk, stop_reason: stop });
    const llm = new AnthropicTextLlm({ apiKey: 'x', model: 'claude-haiku-5-5', client });
    const r = await llm.complete({ system: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 10 });
    assert.equal(r.finishReason, want);
  }
});

test('toStructuredSchema: additionalProperties:false em todo objeto, restrições não suportadas removidas', () => {
  const s = toStructuredSchema({
    type: 'object',
    properties: {
      n: { type: 'integer', minimum: 0, maximum: 9 },
      s: { type: 'string', minLength: 1, maxLength: 5 },
      a: { type: 'array', minItems: 3, maxItems: 5, items: { type: 'object', properties: { x: { type: 'string' } } } },
      o: { anyOf: [{ type: 'object', properties: {} }, { type: 'null' }] },
    },
  }) as any;
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.properties.n, { type: 'integer' });
  assert.deepEqual(s.properties.s, { type: 'string' });
  assert.equal(s.properties.a.minItems, undefined);
  assert.equal(s.properties.a.maxItems, undefined);
  assert.equal(s.properties.a.items.additionalProperties, false);
  assert.equal(s.properties.o.anyOf[0].additionalProperties, false);
  // nome de propriedade que coincide com uma palavra-chave removida sobrevive
  const p = toStructuredSchema({ type: 'object', properties: { maximum: { type: 'string' } } }) as any;
  assert.deepEqual(p.properties.maximum, { type: 'string' });
});

test('schemas das tarefas: todo objeto aninhado sai com additionalProperties:false', () => {
  const walk = (n: any): void => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'object') assert.equal(n.additionalProperties, false);
    for (const v of Object.values(n)) walk(v);
  };
  for (const sc of [JUDGMENT_SCHEMA, PATTERN_SCHEMA, DIGEST_SCHEMA]) walk(toStructuredSchema(sc));
});

test('openai: json_object + temperature 0 em modelo comum; reasoning_effort none em gpt-5*', async () => {
  const resp = {
    choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } },
  };
  const a = fakeOpenAI(resp);
  const mini = new OpenAITextLlm({ apiKey: 'x', model: 'gpt-4o-mini', client: a.client });
  const r = await mini.complete({ system: 'responda em JSON', messages: [{ role: 'user', content: 'u' }], json: { schema: {} }, maxTokens: 50 });
  assert.equal(a.calls[0].body.temperature, 0);
  assert.equal(a.calls[0].body.reasoning_effort, undefined);
  assert.deepEqual(a.calls[0].body.response_format, { type: 'json_object' });
  assert.deepEqual(r.usage, { input: 100, output: 10, cachedInput: 40, cacheWrite: 0 });
  assert.equal(r.provider, 'openai');

  const b = fakeOpenAI(resp);
  const g5 = new OpenAITextLlm({ apiKey: 'x', model: 'gpt-5.4-mini', client: b.client });
  await g5.complete({ system: 'sem a palavra', messages: [{ role: 'user', content: 'u' }], json: { schema: {} }, maxTokens: 50 });
  assert.equal(b.calls[0].body.temperature, undefined);
  assert.equal(b.calls[0].body.reasoning_effort, 'none');
  assert.match(b.calls[0].body.messages[0].content, /JSON/, 'json_object exige "json" na conversa');
});

test('erros: crédito esgotado nos DOIS provedores é systemic; 400 de conteúdo é item', () => {
  const h = new Headers();
  const billing402 = AnthropicAPIError.generate(402, { type: 'error', error: { type: 'billing_error', message: 'pay' } }, undefined, h);
  const credit400 = AnthropicAPIError.generate(
    400,
    { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } },
    undefined, h,
  );
  const overloaded = AnthropicAPIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }, undefined, h);
  const bad400 = AnthropicAPIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 500000 tokens' } }, undefined, h);
  const auth = AnthropicAPIError.generate(401, { type: 'error', error: { type: 'authentication_error', message: 'x' } }, undefined, h);
  assert.equal(classifyLlmError(billing402), 'systemic');
  assert.equal(classifyLlmError(credit400), 'systemic');
  assert.equal(classifyLlmError(overloaded), 'systemic');
  assert.equal(classifyLlmError(auth), 'systemic');
  assert.equal(classifyLlmError(bad400), 'item');
  assert.equal(classifyLlmError(new AnthropicConnErr({ message: 'dns' })), 'systemic');

  const quota = OpenAIAPIError.generate(429, { error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'quota' } }, undefined, h);
  const ctx400 = OpenAIAPIError.generate(400, { error: { message: 'maximum context length is 500000 tokens' } }, undefined, h);
  assert.equal(classifyLlmError(quota), 'systemic');
  assert.equal(classifyLlmError(ctx400), 'item');
  assert.equal(classifyLlmError(new OpenAIConnErr({ message: 'dns' })), 'systemic');

  assert.equal(classifyLlmError(new Error('qualquer')), 'item');
  assert.equal(classifySummaryError(billing402), 'systemic', 'digest usa a mesma regra');
});

test('preço: Haiku 5.5 e Sonnet 5.5 pela tabela da skill; cache lido/gravado separados', () => {
  // Haiku 5.5: 0,10 in / 0,50 out por 1M
  assert.ok(Math.abs(llmCost('claude-haiku-5-5', { input: 100_000, output: 0, cachedInput: 0, cacheWrite: 0 }) - 0.01) < 1e-9);
  assert.ok(Math.abs(llmCost('claude-haiku-5-5', { input: 0, output: 1_000_000, cachedInput: 0, cacheWrite: 0 }) - 0.5) < 1e-9);
  // Sonnet 5.5: 1M de entrada toda lida do cache = 0,10
  assert.ok(Math.abs(llmCost('claude-sonnet-5-5', { input: 1_000_000, output: 0, cachedInput: 1_000_000, cacheWrite: 0 }) - 0.1) < 1e-9);
  // Haiku 5.5 acima de 100K de entrada: a chamada inteira na faixa longa (0,50/2,50)
  assert.ok(Math.abs(llmCost('claude-haiku-5-5', { input: 200_000, output: 0, cachedInput: 0, cacheWrite: 0 }) - 0.1) < 1e-9);
  assert.ok(Math.abs(llmCost('claude-haiku-5-5', { input: 200_000, output: 1_000_000, cachedInput: 0, cacheWrite: 0 }) - 2.6) < 1e-9);
  // OpenAI sem preço de cache conhecido: cacheado cobrado cheio (superestima)
  assert.ok(Math.abs(llmCost('gpt-4o-mini', { input: 1_000_000, output: 0, cachedInput: 500_000, cacheWrite: 0 }) - 0.15) < 1e-9);
  // desconhecido → fallback caro, nunca 0
  assert.ok(llmCost('modelo-x', { input: 1000, output: 1000, cachedInput: 0, cacheWrite: 0 }) > 0);
  assert.equal(judgmentCost('gpt-4o-mini', { inputTokens: 1_000_000, outputTokens: 0 }), 0.15);
  assert.ok(summaryCost('claude-haiku-5-5', { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0 }) > 0);
});

test('factory: modelo incompatível com o provedor falha no boot; chave ausente falha', () => {
  assert.throws(() => createTextLlm('t', 'anthropic', 'gpt-4o-mini', { ANTHROPIC_API_KEY: 'k' }), /claude-\*/);
  assert.throws(() => createTextLlm('t', 'openai', 'claude-haiku-5-5', { OPENAI_API_KEY: 'k' }), /Claude/);
  assert.throws(() => createTextLlm('t', 'anthropic', 'claude-haiku-5-5', {}), /ANTHROPIC_API_KEY/);
  assert.equal(createTextLlm('t', 'anthropic', 'claude-haiku-5-5', { ANTHROPIC_API_KEY: 'k' }).provider, 'anthropic');
  assert.equal(createTextLlm('t', 'openai', 'gpt-4o-mini', { OPENAI_API_KEY: 'k' }).provider, 'openai');
});

test('TextJudgmentLlm / TextSummaryLlm: repassam schema, provider e uso', async () => {
  const { client, calls } = fakeAnthropic(anthropicOk);
  const base = new AnthropicTextLlm({ apiKey: 'x', model: 'claude-haiku-5-5', client });
  const j = new TextJudgmentLlm(base, { schema: JUDGMENT_SCHEMA, maxTokens: 4000, effort: 'low' });
  const jr = await j.judge('s', 'u');
  assert.equal(j.provider, 'anthropic');
  assert.equal(calls[0].body.output_config.format.schema.properties.triage.anyOf[0].enum[0], 'lead');
  assert.equal(jr.usage.inputTokens, 1150);
  assert.equal(jr.usage.cachedInputTokens, 1000);

  const s = new TextSummaryLlm(base, { effort: 'low' });
  const sr = await s.summarize('s', 'u');
  assert.equal(sr.finishReason, 'stop');
  assert.ok(calls[1].body.output_config.format.schema.properties.pontos);
});

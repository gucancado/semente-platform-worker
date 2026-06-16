import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../src/config.js';
import {
  getExtractionClient,
  getJudgeClient,
  getRecapClient,
} from '../../src/lua/llm-provider.js';

// O comportamento depende de a chave Anthropic estar provisionada no env do
// teste. Sem rede em nenhum dos ramos: ou o stub que lanca, ou o cliente real
// (cuja construcao NAO faz chamada de rede). Ramificamos pela presenca da chave
// para que o teste seja robusto seja qual for o c:/tmp/lua-test.env.
const hasKey = !!config.ANTHROPIC_API_KEY;

test('getExtractionClient: stub que lanca sem chave / modelo configurado com chave', async () => {
  const c = getExtractionClient();
  if (hasKey) {
    assert.equal(c.model, config.LUA_EXTRACTION_MODEL);
    assert.equal(c.model, 'claude-sonnet-4-6');
  } else {
    assert.equal(c.model, 'unconfigured');
    await assert.rejects(
      () => c.complete({ system: 's', user: 'u', schema: {} }),
      /ANTHROPIC_API_KEY ausente/,
    );
  }
});

test('os tres accessors usam os tres modelos configurados (ou todos unconfigured)', () => {
  const ext = getExtractionClient();
  const judge = getJudgeClient();
  const recap = getRecapClient();

  if (hasKey) {
    assert.equal(ext.model, config.LUA_EXTRACTION_MODEL);
    assert.equal(judge.model, config.LUA_JUDGE_MODEL);
    assert.equal(recap.model, config.LUA_RECAP_MODEL);
  } else {
    assert.equal(ext.model, 'unconfigured');
    assert.equal(judge.model, 'unconfigured');
    assert.equal(recap.model, 'unconfigured');
  }
});

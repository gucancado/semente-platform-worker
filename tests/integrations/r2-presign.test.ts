import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stubs de env obrigatórias pro config.ts carregar sem Postgres/serviços reais.
process.env.DATABASE_URL = 'postgres://x:x@localhost:5432/x';
process.env.BLOQUIM_API_URL = 'https://bloquim.example.com';
process.env.AGENT_TOKENS_JSON = JSON.stringify({ bot: { worker_token: 'changeme00000000', fallback_workspace_id: 'wks_test' } });
process.env.EVOLUTION_WEBHOOK_SECRET = 'test-secret-32chars-xxxxxxxxxx';
process.env.OWNER_ADMIN_TOKEN = 'test-owner-admin-token-32chars-xxxxxx';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-google-client-id';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-google-client-secret';
process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://example.com/callback';
process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = 'dGVzdC1lbmNyeXB0aW9uLWtleS0zMmNoYXJzLXh4eHh4eA==';
process.env.GOOGLE_OAUTH_STATE_SECRET = 'dGVzdC1zdGF0ZS1zZWNyZXQtNDBjaGFycy14eHh4eHh4eHh4';

// Configura R2 ANTES de importar o módulo (config.ts lê env no load).
process.env.R2_ENDPOINT = 'https://acc.r2.cloudflarestorage.com';
process.env.R2_ACCESS_KEY_ID = 'test-key-id';
process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
process.env.R2_BUCKET_EPISODES = 'semente-episodios-prod';

const { presignGet } = await import('../../src/integrations/r2.js');

test('presignGet devolve URL assinada contendo bucket e key', async () => {
  const url = await presignGet('fireflies/abc.json', 120);
  assert.match(url, /semente-episodios-prod/);
  assert.match(url, /fireflies%2Fabc\.json|fireflies\/abc\.json/);
  assert.match(url, /X-Amz-Signature=/);
  assert.match(url, /X-Amz-Expires=120/);
});

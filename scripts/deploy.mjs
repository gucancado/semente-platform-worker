// scripts/deploy.mjs
// Deploy manual do worker via Coolify API. Substitui o antigo .github/workflows/deploy.yml
// (auto-deploy no push) — aposentado porque (a) o token Coolify rotaciona mensalmente e
// quebrava o workflow silenciosamente, e (b) o app tem migrations gated cuja ordem
// (Bloquim->worker->MCP + smoke + rollback) não pode ser furada por deploy automático.
//
// Uso:
//   COOLIFY_TOKEN=<bearer> node scripts/deploy.mjs            # dispara e acompanha
//   COOLIFY_TOKEN=<bearer> node scripts/deploy.mjs --dry-run  # só mostra o que faria
//   COOLIFY_TOKEN=<bearer> node scripts/deploy.mjs --no-wait  # dispara e sai
//
// Envs (com defaults sãos; só o token é obrigatório):
//   COOLIFY_TOKEN     (obrigatório) Bearer token do Coolify — rotaciona ~mensal, NUNCA commitar
//   COOLIFY_API       default http://5.78.199.192:8000/api/v1
//   COOLIFY_APP_UUID  default qlp2n4fi3jlklisftet1y7cz (semente-platform-worker)

const API = process.env.COOLIFY_API ?? 'http://5.78.199.192:8000/api/v1';
const UUID = process.env.COOLIFY_APP_UUID ?? 'qlp2n4fi3jlklisftet1y7cz';
const TOKEN = process.env.COOLIFY_TOKEN;
const dryRun = process.argv.includes('--dry-run');
const noWait = process.argv.includes('--no-wait');

if (!TOKEN && !dryRun) {
  console.error('FALTA env COOLIFY_TOKEN (Bearer do Coolify). Veja seção Coolify no CLAUDE.md global.');
  process.exit(2);
}

const deployUrl = `${API}/deploy?uuid=${UUID}`;
const auth = { Authorization: `Bearer ${TOKEN}` };

if (dryRun) {
  console.log('[dry-run] POST', deployUrl);
  console.log('[dry-run] Authorization: Bearer', TOKEN ? '<token-presente>' : '<SEM TOKEN>');
  console.log('[dry-run] depois faria polling em', `${API}/deployments/<deployment_uuid>`, 'até finished/failed');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('→ disparando deploy:', deployUrl);
  const res = await fetch(deployUrl, { method: 'POST', headers: auth });
  const body = await res.text();
  if (!res.ok) {
    console.error(`FAIL: deploy retornou HTTP ${res.status}: ${body}`);
    process.exit(1);
  }
  let json;
  try { json = JSON.parse(body); } catch { json = null; }
  const dep = json?.deployments?.[0] ?? json;
  const deploymentUuid = dep?.deployment_uuid ?? dep?.uuid;
  console.log('✓ deploy aceito.', dep?.message ?? body);

  if (noWait || !deploymentUuid) {
    if (!deploymentUuid) console.log('(sem deployment_uuid na resposta — não dá pra acompanhar; cheque o painel)');
    console.log('Monitore o /health:', 'https://agentes-worker.beeads.com.br/health');
    return;
  }

  console.log('→ acompanhando deployment', deploymentUuid);
  const deadline = Date.now() + 10 * 60 * 1000; // 10 min
  let last = '';
  while (Date.now() < deadline) {
    await sleep(5000);
    const r = await fetch(`${API}/deployments/${deploymentUuid}`, { headers: auth });
    if (!r.ok) { console.log(`  (status HTTP ${r.status}, tentando de novo)`); continue; }
    const d = await r.json().catch(() => null);
    const status = d?.status ?? d?.deployment_status ?? 'unknown';
    if (status !== last) { console.log('  status:', status); last = status; }
    if (status === 'finished' || status === 'success') { console.log('✓ deploy FINISHED'); return; }
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      console.error('✗ deploy', status);
      process.exit(1);
    }
  }
  console.error('✗ timeout (10min) aguardando o deploy — cheque o painel do Coolify');
  process.exit(1);
}

main().catch((e) => { console.error('erro:', e?.message ?? e); process.exit(1); });

/**
 * Emite link de reconexão para uma instância de SISTEMA (sem workspace) e
 * imprime a URL pública. Caminho para instâncias sem tela no painel — hoje,
 * `saturno`. O telefone é OBRIGATÓRIO: é a trava que impede o link deslogado
 * de parear um aparelho alheio (spec §2.2) — sem ela, quem tivesse o link
 * trocaria a identidade de um número mantendo todo o histórico pendurado nele.
 *
 *   pnpm whatsapp:reconnect-link -- --instance=saturno --label="Saturno" --expected-phone=+553195950748
 *
 * Emitir um link novo EXPIRA o anterior do mesmo alvo (createReconnectLink).
 */
import { pool } from '../db.js';
import { createReconnectLink, generateLinkToken } from '../whatsapp/provision-links.js';
import { normalizePhone } from '../whatsapp/numbers.js';

const LINK_MAX_CLICKS = 10;
const LINK_TTL_DAYS = 7;
const INSTANCE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function main() {
  const instance = arg('instance');
  const expectedPhone = normalizePhone(arg('expected-phone'));
  if (!instance || !INSTANCE_NAME_RE.test(instance) || !expectedPhone) {
    console.error('uso: pnpm whatsapp:reconnect-link -- --instance=<nome> --expected-phone=+55... [--label="..."]');
    process.exit(2);
  }
  const base = (process.env.PANEL_PUBLIC_URL ?? 'https://painel.beeads.com.br').replace(/\/+$/, '');
  const token = generateLinkToken();
  const row = await createReconnectLink(pool, {
    token, targetInstance: instance, targetLabel: arg('label'), expectedPhone,
    workspaceId: null, createdBy: 'cli', maxClicks: LINK_MAX_CLICKS, ttlDays: LINK_TTL_DAYS,
  });
  console.log(`instância : ${instance}`);
  console.log(`telefone  : ${expectedPhone}`);
  console.log(`expira em : ${row.expiresAt}`);
  console.log(`URL       : ${base}/reconectar-whatsapp/${token}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });

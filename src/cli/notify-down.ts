/**
 * Dispara o aviso de queda para UMA instância, fora da cadência do daemon — é o
 * smoke do fluxo inteiro: link travado no telefone → Cloud API → celular.
 *
 *   pnpm whatsapp:notify-down -- --instance=saturno [--dry-run]
 *   (no container: node dist/cli/notify-down.js --instance=saturno)
 *
 * Alvo: instância de SYSTEM_INSTANCE_WATCH_JSON, ou número de whatsapp_numbers
 * pela instância. NÃO consome a cadência do episódio (não mexe em
 * down_notify_count): um envio manual não pode adiar o aviso automático.
 * `--dry-run` avalia a saúde (grava o episódio, como o vigia faria) e mostra o
 * texto, sem emitir link nem enviar.
 */
import { pool } from '../db.js';
import { config } from '../config.js';
import { getNumberByInstance } from '../whatsapp/numbers.js';
import { ensureReconnectLink } from '../whatsapp/provision-links.js';
import { buildDownNotifyText, reconnectUrl } from '../whatsapp/down-notify.js';
import { buildDownNotifyDeps, buildSystemProbe } from '../whatsapp/down-notify-start.js';
import { assessSystemTargets } from '../whatsapp/down-notify-service.js';

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

const log = {
  info: (...a: unknown[]) => console.log(...a),
  warn: (...a: unknown[]) => console.warn(...a),
  error: (...a: unknown[]) => console.error(...a),
};

async function resolveTarget(instance: string) {
  const sys = config.SYSTEM_INSTANCE_WATCH_JSON.find((t) => t.instance === instance);
  if (sys) {
    // Mesma avaliação do vigia: grava o episódio com o início observado, sem avisar.
    const [a] = await assessSystemTargets(
      { pool, log, staleMs: config.SYSTEM_INSTANCE_STORE_STALE_MS, probe: buildSystemProbe(pool) },
      [sys],
    );
    if (a) console.log(`estado    : ${a.state} (${a.verdict.down ? `fora — ${a.verdict.reason}` : 'saudável'})`);
    return { phone: sys.expectedPhone, label: sys.label, workspaceId: null, downSince: a?.row.downSince ?? new Date() };
  }
  const n = await getNumberByInstance(pool, instance);
  if (!n?.phone) return null;
  const { rows } = await pool.query(`SELECT disconnected_since FROM whatsapp_numbers WHERE id = $1`, [n.id]);
  return { phone: n.phone, label: n.label, workspaceId: n.workspaceId, downSince: (rows[0]?.disconnected_since as Date | null) ?? new Date() };
}

async function main() {
  const instance = arg('instance');
  const dryRun = process.argv.includes('--dry-run');
  if (!instance) {
    console.error('uso: pnpm whatsapp:notify-down -- --instance=<nome> [--dry-run]');
    process.exit(2);
  }

  const target = await resolveTarget(instance);
  if (!target) {
    console.error(`instância ${instance} não está em SYSTEM_INSTANCE_WATCH_JSON nem é número com telefone conhecido`);
    process.exit(1);
  }
  const built = buildDownNotifyDeps(pool, log);
  if ('error' in built) {
    console.error(`aviso indisponível: ${built.error}`);
    process.exit(1);
  }

  console.log(`instância : ${instance}`);
  console.log(`telefone  : ${target.phone}${target.label ? ` (${target.label})` : ''}`);
  console.log(`desde     : ${target.downSince.toISOString()}`);
  console.log(`remetente : Cloud phone_number_id ${built.phoneNumberId}`);
  console.log(`template  : ${config.CONNECTION_NOTIFY_TEMPLATE_NAME ?? '(nenhum — só texto livre, janela de 24h)'}`);

  if (dryRun) {
    console.log('--- texto (dry-run, sem link emitido) ---');
    console.log(buildDownNotifyText({ ...target, link: reconnectUrl(config.PANEL_PUBLIC_URL, '<token>') }));
    await pool.end();
    return;
  }

  const link = await ensureReconnectLink(pool, {
    instance,
    expectedPhone: target.phone,
    label: target.label,
    workspaceId: target.workspaceId,
    createdBy: 'cli:notify-down',
    maxClicks: built.deps.link.maxClicks,
    ttlDays: built.deps.link.ttlDays,
  });
  const url = reconnectUrl(config.PANEL_PUBLIC_URL, link.row.token);
  console.log(`link      : ${url} (${link.reused ? 'reusado' : 'novo'}, expira ${link.row.expiresAt})`);

  const r = await built.deps.send({
    phone: target.phone, label: target.label, downSince: target.downSince, token: link.row.token, link: url,
  });
  console.log(`resultado : ${JSON.stringify(r)}`);
  await pool.end();
  process.exit(r.ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

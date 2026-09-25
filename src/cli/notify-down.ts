/**
 * Dispara o aviso de queda para UMA instância, fora da cadência do daemon — é o
 * smoke do fluxo inteiro: link travado no telefone → Cloud API → celular.
 *
 *   pnpm whatsapp:notify-down -- --instance=saturno [--dry-run] [--to=+55...]
 *   (no container: node dist/cli/notify-down.js --instance=saturno)
 *
 * Alvo: instância de SYSTEM_INSTANCE_WATCH_JSON, ou número de whatsapp_numbers
 * pela instância. NÃO consome a cadência do episódio (não mexe em
 * down_notify_count): um envio manual não pode adiar o aviso automático.
 * `--to` troca SÓ quem recebe (teste): nome, telefone exibido, "desde" e o link
 * travado no telefone continuam sendo os do alvo, que NÃO recebe nada.
 * `--dry-run` avalia a saúde (grava o episódio, como o vigia faria) e mostra o
 * texto, sem emitir link nem enviar.
 *
 * A CÓPIA ao operador sai junto (quando OPS_NOTIFY_TO está configurado), pelo
 * mesmo caminho do vigia: sem isto o smoke não exercitaria o único pedaço do
 * aviso que ninguém consegue verificar sem esperar uma queda de verdade.
 */
import { pool } from '../db.js';
import { config } from '../config.js';
import { getNumberByInstance, normalizePhone } from '../whatsapp/numbers.js';
import { ensureReconnectLink } from '../whatsapp/provision-links.js';
import { reconnectUrl } from '../whatsapp/down-notify.js';
import { renderConnectionDownText } from '../webhook-cloud/templates.js';
import { opsCopyFor, sameWhatsappNumber } from '../whatsapp/down-notify-ops-copy.js';
import { makeOpsCopySender } from '../whatsapp/down-notify-sender.js';
import { buildDownNotifyDeps, buildSystemProbe, buildSystemWatchOpts } from '../whatsapp/down-notify-start.js';
import { assessSystemTargets } from '../whatsapp/down-notify-service.js';
import { resolveWorkspaceNames } from '../bloquim/workspace-names.js';

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
      { pool, log, probe: buildSystemProbe(pool), ...buildSystemWatchOpts(log) },
      [sys],
    );
    // Fora sem `downSince` = SUSPEITA: o episódio só abre no segundo tick consecutivo fora.
    // Episódio aberto primeiro: o da sonda fica aberto com a Evolution dizendo `open`.
    const verdict = a?.row.downSince
      ? `fora — ${a.verdict.reason ?? 'episódio aberto pela sonda'}`
      : !a?.verdict.down
        ? 'saudável'
      : a.storeStale
        ? 'store atrasado — só gatilho de sonda, não abre episódio'
        : `suspeita — ${a.verdict.reason} (só vira episódio se outra observação confirmar; esta rodada conta como uma)`;
    if (a) console.log(`estado    : ${a.state} (${verdict})`);
    return { phone: sys.expectedPhone, name: sys.label, workspaceId: null, downSince: a?.row.downSince ?? new Date() };
  }
  const n = await getNumberByInstance(pool, instance);
  if (!n?.phone) return null;
  const { rows } = await pool.query(`SELECT disconnected_since FROM whatsapp_numbers WHERE id = $1`, [n.id]);
  const names = await resolveWorkspaceNames([n.workspaceId]);
  return { phone: n.phone, name: names.get(n.workspaceId) ?? n.label, workspaceId: n.workspaceId, downSince: (rows[0]?.disconnected_since as Date | null) ?? new Date() };
}

async function main() {
  const instance = arg('instance');
  const dryRun = process.argv.includes('--dry-run');
  if (!instance) {
    console.error('uso: pnpm whatsapp:notify-down -- --instance=<nome> [--dry-run] [--to=+55...]');
    process.exit(2);
  }
  const toArg = arg('to');
  const to = normalizePhone(toArg);
  if (toArg && !to) {
    console.error(`--to inválido: ${toArg}`);
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
  console.log(`telefone  : ${target.phone}${target.name ? ` (${target.name})` : ''}`);
  console.log(`desde     : ${target.downSince.toISOString()}`);
  console.log(`remetente : Cloud phone_number_id ${built.phoneNumberId}`);
  console.log(`template  : ${config.CONNECTION_NOTIFY_TEMPLATE_NAME ?? '(nenhum — só texto livre, janela de 24h)'}`);
  console.log(`destino   : ${to ? `${to} (TESTE — o alvo NÃO recebe)` : target.phone}`);

  const copia = opsCopyFor({
    name: target.name,
    phone: target.phone,
    downSince: target.downSince,
    // O CLI não consome a cadência do episódio, então não há contagem real a
    // exibir: 1 é o que o primeiro aviso mostraria.
    notifyNumber: 1,
    maxNotifies: built.deps.cadence.maxNotifies,
  });
  const copiaPara =
    config.OPS_NOTIFY_TO && !sameWhatsappNumber(config.OPS_NOTIFY_TO, target.phone)
      ? config.OPS_NOTIFY_TO
      : null;
  console.log(
    `cópia     : ${copiaPara ?? (config.OPS_NOTIFY_TO ? 'dispensada (o alvo já é o operador)' : 'off (sem OPS_NOTIFY_TO)')}`,
  );

  if (dryRun) {
    console.log('--- texto (dry-run, sem link emitido) ---');
    console.log(renderConnectionDownText({ ...target, token: '<token>' }));
    console.log('--- cópia ao operador (dry-run) ---');
    console.log(`${copia.titulo}\n${copia.detalhe}`);
    await pool.end();
    return;
  }

  const link = await ensureReconnectLink(pool, {
    instance,
    expectedPhone: target.phone,
    label: target.name,
    workspaceId: target.workspaceId,
    createdBy: 'cli:notify-down',
    maxClicks: built.deps.link.maxClicks,
    ttlDays: built.deps.link.ttlDays,
  });
  const url = reconnectUrl(config.PANEL_PUBLIC_URL, link.row.token);
  console.log(`link      : ${url} (${link.reused ? 'reusado' : 'novo'}, expira ${link.row.expiresAt})`);

  const r = await built.deps.send({
    phone: target.phone, to, name: target.name, downSince: target.downSince, token: link.row.token, link: url,
  });
  console.log(`resultado : ${JSON.stringify(r)}`);

  // Igual ao vigia: a cópia sai DEPOIS e só quando o principal saiu, em
  // try/catch próprio, e NÃO entra no código de saída — falha dela não pode
  // fazer um smoke bem-sucedido parecer quebrado.
  if (r.ok && copiaPara) {
    try {
      const c = await makeOpsCopySender({ phoneNumberId: built.phoneNumberId, to: copiaPara })(
        copia.titulo,
        copia.detalhe,
      );
      console.log(`cópia     : ${JSON.stringify(c)}`);
    } catch (err) {
      console.log(`cópia     : falhou — ${(err as Error).message}`);
    }
  }

  await pool.end();
  process.exit(r.ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

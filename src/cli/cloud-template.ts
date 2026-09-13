/**
 * Submete ou consulta o template do aviso de queda na WABA do número Cloud.
 *
 *   pnpm whatsapp:cloud-template -- --waba=1495675302037643 create
 *   pnpm whatsapp:cloud-template -- --waba=1495675302037643 status
 *   (no container: node dist/cli/cloud-template.js --waba=... status)
 *
 * O corpo submetido é CONNECTION_DOWN_TEMPLATE — o mesmo módulo que monta os
 * parâmetros do envio, para o que se aprova e o que se envia não divergirem.
 */
import { config } from '../config.js';
import { CONNECTION_DOWN_TEMPLATE, CONNECTION_DOWN_TEMPLATE_NAME } from '../webhook-cloud/templates.js';

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function graph(method: 'GET' | 'POST', path: string, body?: unknown) {
  const r = await fetch(`https://graph.facebook.com/${config.WHATSAPP_CLOUD_GRAPH_VERSION}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.WHATSAPP_CLOUD_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as unknown };
}

async function main() {
  const waba = arg('waba');
  const cmd = process.argv.find((a) => a === 'create' || a === 'status');
  if (!waba || !/^\d+$/.test(waba) || !cmd) {
    console.error('uso: pnpm whatsapp:cloud-template -- --waba=<id> create|status');
    process.exit(2);
  }
  if (!config.WHATSAPP_CLOUD_ACCESS_TOKEN) {
    console.error('WHATSAPP_CLOUD_ACCESS_TOKEN ausente');
    process.exit(1);
  }

  const r =
    cmd === 'create'
      ? await graph('POST', `${waba}/message_templates`, CONNECTION_DOWN_TEMPLATE)
      : await graph(
          'GET',
          `${waba}/message_templates?name=${CONNECTION_DOWN_TEMPLATE_NAME}&fields=name,status,category,language,rejected_reason`,
        );
  console.log(`${cmd} → HTTP ${r.status}`);
  console.log(JSON.stringify(r.body, null, 2));
  process.exit(r.status < 400 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

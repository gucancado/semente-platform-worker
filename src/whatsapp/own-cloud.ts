import { sameWhatsappNumber } from './down-notify-ops-copy.js';
import { isOwnDownNotice } from './down-notify.js';

/**
 * Mensagem mandada pelo NOSSO número Cloud (aviso de queda, cópia, sonda) a uma
 * instância Evolution. Nunca é conversa de lead: não entra em webhook_logs,
 * messages, gatilho nem IA, e não conta como tráfego do store.
 *
 * Módulo PURO — sem config, pool ou rede.
 *
 * ⚠️ O texto do template é lido por `ownCloudText`, NUNCA por
 * `extractMessageText`: estender aquele faria webhook e backfill ingerirem
 * todo template (inclusive de terceiros) como conversa.
 */

/** templateId dos nossos templates aprovados: aviso_operacional_v1, conexao_whatsapp_caiu_v2. */
export const OWN_TEMPLATE_IDS: readonly string[] = ['1896879847947648', '1620869592995276'];

/** "Teste de conexão do WhatsApp <nome> (...)" + "Código XXXX." — corpo da sonda. */
const PROBE_RE = /Teste de conexão do WhatsApp[\s\S]*?Código ([A-Z2-9]{4})\./;

export function parseOwnPhones(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.replace(/\D+/g, ''))
    .filter((s) => s.length > 0);
}

function unwrap(m: any): any {
  return m?.ephemeralMessage?.message ?? m?.viewOnceMessage?.message ?? m?.viewOnceMessageV2?.message ?? m;
}

export function ownCloudText(message: unknown): string | null {
  const m = unwrap(message as any);
  if (!m || typeof m !== 'object') return null;
  const hydrated = m.templateMessage?.hydratedTemplate ?? m.templateMessage?.hydratedFourRowTemplate;
  if (typeof hydrated?.hydratedContentText === 'string') return hydrated.hydratedContentText;
  if (typeof m.conversation === 'string') return m.conversation;
  if (typeof m.extendedTextMessage?.text === 'string') return m.extendedTextMessage.text;
  return null;
}

function templateIdOf(message: unknown): string | null {
  const m = unwrap(message as any);
  const id = m?.templateMessage?.templateId
    ?? m?.templateMessage?.hydratedTemplate?.templateId
    ?? m?.templateMessage?.hydratedFourRowTemplate?.templateId;
  return typeof id === 'string' ? id : null;
}

export function extractProbeCode(text: string | null): string | null {
  if (!text) return null;
  return PROBE_RE.exec(text)?.[1] ?? null;
}

function jidDigits(jid: unknown): string | null {
  if (typeof jid !== 'string' || !jid.endsWith('@s.whatsapp.net')) return null;
  return (jid.split('@')[0] ?? '').split(':')[0] ?? null;
}

/**
 * Registro cru da Evolution (`{key, message}`, do webhook `data` ou do store).
 * Só DM recebida conta — grupo e `fromMe` nunca.
 *
 * ⚠️ O aviso de queda (`isOwnDownNotice`) entra como regra própria, além das
 * três da `remoteJidAlt`/`templateId`/marcador da sonda: o Baileys pode
 * entregar o aviso (ou a cópia dele) como `conversation`/`extendedTextMessage`
 * puro numa DM em LID sem `remoteJidAlt` — aí nem o telefone nem o templateId
 * aparecem, e só o CONTEÚDO (link ou frase fixa) prova a origem.
 */
export function isFromOwnCloudRecord(record: unknown, ownPhones: string[]): boolean {
  const r = record as { key?: { remoteJid?: unknown; remoteJidAlt?: unknown; fromMe?: unknown }; message?: unknown } | null;
  const jid = r?.key?.remoteJid;
  if (typeof jid !== 'string' || jid.endsWith('@g.us')) return false;
  if (r?.key?.fromMe === true) return false;
  const sender = jidDigits(r?.key?.remoteJidAlt) ?? jidDigits(jid);
  if (sender && ownPhones.some((p) => sameWhatsappNumber(p, sender))) return true;
  const tid = templateIdOf(r?.message);
  if (tid && OWN_TEMPLATE_IDS.includes(tid)) return true;
  if (isOwnDownNotice(record)) return true;
  return extractProbeCode(ownCloudText(r?.message)) != null;
}

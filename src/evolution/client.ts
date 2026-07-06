export type EvolutionDeps = { baseUrl: string; apiKey: string; fetch?: typeof fetch };

async function call(deps: EvolutionDeps, method: string, path: string, body?: unknown): Promise<any> {
  const f = deps.fetch ?? fetch;
  const res = await f(`${deps.baseUrl}${path}`, {
    method,
    headers: { 'apikey': deps.apiKey, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  } as any);
  if (!res.ok) throw new Error(`Evolution ${method} ${path} → ${res.status}`);
  return res.json();
}

// Eventos que o worker precisa por instância. CONNECTION_UPDATE/QRCODE p/ status,
// MESSAGES_UPSERT p/ ingestão. Sem isso o número novo não atualiza status nem recebe msgs.
const INSTANCE_WEBHOOK_EVENTS = ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'];

export async function createEvolutionInstance(deps: EvolutionDeps, instance: string, webhook?: { url: string; secret: string }) {
  await call(deps, 'POST', '/instance/create', { instanceName: instance, qrcode: true, integration: 'WHATSAPP-BAILEYS' });
  // O webhook GLOBAL da Evolution NÃO envia X-Evolution-Secret → o /webhook do worker
  // rejeitaria (401). Por isso registramos um webhook POR-INSTÂNCIA com o secret + eventos.
  if (webhook) await setInstanceWebhook(deps, instance, webhook);
}

/**
 * Garante a instância de forma idempotente. Se o create falhar mas a instância
 * já existir (connectionState responde), segue. Sempre (re)registra o webhook
 * por-instância; se o webhook falhar após o create, faz rollback (delete).
 */
export async function ensureEvolutionInstance(deps: EvolutionDeps, instance: string, webhook: { url: string; secret: string }) {
  let created = false;
  try {
    await call(deps, 'POST', '/instance/create', { instanceName: instance, qrcode: true, integration: 'WHATSAPP-BAILEYS' });
    created = true;
  } catch (e) {
    // pode já existir — confirma via connectionState; se não existir mesmo, propaga.
    try { await getConnectionState(deps, instance); } catch { throw e; }
  }
  try {
    await setInstanceWebhook(deps, instance, webhook);
  } catch (e) {
    if (created) { try { await deleteInstance(deps, instance); } catch { /* idempotente */ } }
    throw e;
  }
}

export async function setInstanceWebhook(deps: EvolutionDeps, instance: string, p: { url: string; secret: string }) {
  await call(deps, 'POST', `/webhook/set/${instance}`, {
    webhook: {
      enabled: true,
      url: p.url,
      headers: { 'Content-Type': 'application/json', 'X-Evolution-Secret': p.secret },
      byEvents: false,
      base64: false,
      events: INSTANCE_WEBHOOK_EVENTS,
    },
  });
}
export async function getQrCode(deps: EvolutionDeps, instance: string): Promise<{ base64: string; pairingCode?: string }> {
  const r = await call(deps, 'GET', `/instance/connect/${instance}`);
  return { base64: r.base64 ?? r.qrcode?.base64 ?? '', pairingCode: r.pairingCode ?? r.code };
}
export async function getConnectionState(deps: EvolutionDeps, instance: string): Promise<'open'|'connecting'|'close'> {
  const r = await call(deps, 'GET', `/instance/connectionState/${instance}`);
  return (r.instance?.state ?? r.state ?? 'close') as 'open'|'connecting'|'close';
}
export async function logoutInstance(deps: EvolutionDeps, instance: string) { await call(deps, 'DELETE', `/instance/logout/${instance}`); }
export async function deleteInstance(deps: EvolutionDeps, instance: string) { await call(deps, 'DELETE', `/instance/delete/${instance}`); }
export async function sendText(deps: EvolutionDeps, instance: string, to: string, text: string): Promise<{ sendId: string }> {
  const r = await call(deps, 'POST', `/message/sendText/${instance}`, { number: to, text });
  return { sendId: r.key?.id ?? r.id ?? '' };
}

/**
 * Resolve o LID de privacidade do WhatsApp p/ o número real, quando disponível.
 * Mensagens @lid trazem o número em `*Alt` (remoteJidAlt/participantAlt). Sem alt,
 * mantém o jid original. Para @g.us e @s.whatsapp.net, retorna o próprio jid.
 */
export function canonicalJid(jid: string | null | undefined, jidAlt: string | null | undefined): string {
  if (jid && jid.endsWith('@lid') && jidAlt && jidAlt.endsWith('@s.whatsapp.net')) return jidAlt;
  return jid ?? '';
}

/** Normaliza jid de grupo da Evolution ('<id>@g.us') p/ o formato do identifier ('+<id>'). */
export function normalizeGroupJid(raw: string): string {
  const idPart = raw.split('@')[0] ?? '';
  return idPart.startsWith('+') ? idPart : `+${idPart}`;
}

/** Uma página de mensagens da instância (Evolution v2 paginado, desc por messageTimestamp). */
export async function fetchMessages(
  deps: EvolutionDeps,
  instance: string,
  page: number,
  offset = 100
): Promise<{ records: any[]; total: number; pages: number }> {
  const r = await call(deps, 'POST', `/chat/findMessages/${instance}`, { where: {}, page, offset });
  const m = r?.messages ?? {};
  return { records: Array.isArray(m.records) ? m.records : [], total: m.total ?? 0, pages: m.pages ?? 0 };
}

/**
 * Baixa + descriptografa a mídia de uma mensagem sob demanda (webhook usa
 * base64:false → bytes não vêm no payload). `rawMessage` = objeto `data` do
 * webhook (tem `key`+`message`). Pode responder base64 vazio se a mídia ainda
 * não foi descriptografada — o caller (service) trata vazio como retryable.
 */
export async function getBase64FromMediaMessage(
  deps: EvolutionDeps, instance: string, rawMessage: unknown
): Promise<{ base64: string; mimetype: string | null }> {
  const r = await call(deps, 'POST', `/chat/getBase64FromMediaMessage/${instance}`, { message: rawMessage });
  return { base64: typeof r?.base64 === 'string' ? r.base64 : '', mimetype: r?.mimetype ?? null };
}

/**
 * Lista os grupos da instância. Shape do retorno da Evolution varia por versão —
 * cobrimos array direto e {groups:[...]}; cada item tem id ('<id>@g.us') + subject.
 */
export async function fetchAllGroups(
  deps: EvolutionDeps,
  instance: string
): Promise<Array<{ jid: string; subject: string | null }>> {
  const r = await call(deps, 'GET', `/group/fetchAllGroups/${instance}?getParticipants=false`);
  const arr: any[] = Array.isArray(r) ? r : Array.isArray(r?.groups) ? r.groups : [];
  return arr
    .filter((g) => typeof g?.id === 'string')
    .map((g) => ({ jid: normalizeGroupJid(g.id), subject: g.subject ?? g.subjectName ?? null }));
}

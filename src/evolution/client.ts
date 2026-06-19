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

export async function createEvolutionInstance(deps: EvolutionDeps, instance: string) {
  // integration: qrcode true; webhook é global (não setar por instância) — spec §1.4
  await call(deps, 'POST', '/instance/create', { instanceName: instance, qrcode: true, integration: 'WHATSAPP-BAILEYS' });
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

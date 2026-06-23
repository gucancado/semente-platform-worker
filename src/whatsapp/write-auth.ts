// src/whatsapp/write-auth.ts

/** Capability do agente (1º fator). Pura. */
export function agentCanWrite(cfg: { can_write_whatsapp_meta?: boolean }): boolean {
  return cfg?.can_write_whatsapp_meta === true;
}

export type WriteGateResult = { ok: true } | { ok: false; error: string; reason: string };

/**
 * Duplo gate de escrita no MCP: (1) capability do agente; (2) acting_user é
 * admin/owner do workspace (via resolveByWhatsapp + hasWorkspaceRole).
 * Fail-closed: sem INTERNAL_API_SECRET, resolveByWhatsapp → null → recusa.
 *
 * Os imports de identity são lazy para manter agentCanWrite testável sem env vars.
 */
export async function requireWhatsappWrite(
  cfg: { can_write_whatsapp_meta?: boolean },
  actingUser: string | undefined,
  workspaceId: string,
): Promise<WriteGateResult> {
  if (!agentCanWrite(cfg)) return { ok: false, error: 'forbidden', reason: 'agente sem capability de escrita' };
  if (!actingUser) return { ok: false, error: 'forbidden', reason: 'acting_user obrigatório' };
  const { resolveByWhatsapp, hasWorkspaceRole } = await import('../commands/identity.js');
  const user = await resolveByWhatsapp(actingUser);
  if (!hasWorkspaceRole(user, workspaceId, 'admin')) {
    return { ok: false, error: 'forbidden', reason: 'acting_user não é admin do workspace' };
  }
  return { ok: true };
}

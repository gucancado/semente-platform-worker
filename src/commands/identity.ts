import { config } from '../config.js';

/**
 * Resolução de identidade WhatsApp → usuário Bloquim, via endpoint interno do
 * bloquim-api (`GET /api/internal/resolve-by-whatsapp`), gated por
 * `INTERNAL_API_SECRET`. Usado pelo dispatcher de comandos pra personalizar
 * respostas e (próxima fase) autorizar comandos por permissão de workspace.
 *
 * Graceful: retorna null se não configurado, indisponível, ou número não
 * encontrado. Quem chama deve degradar (saudação genérica, recusar comandos
 * de workspace).
 */
export type ResolvedWorkspace = { id: string; name: string; role: string };
export type ResolvedUser = {
  userId: string;
  name: string;
  email: string;
  whatsapp: string | null;
  workspaces: ResolvedWorkspace[];
};

export async function resolveByWhatsapp(phone: string): Promise<ResolvedUser | null> {
  const secret = config.INTERNAL_API_SECRET;
  if (!secret) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8) return null;

  // O endpoint interno fica em /api/internal — independente do path de
  // BLOQUIM_API_URL (que pode ser /api/v1). Deriva o origin.
  let origin: string;
  try {
    origin = new URL(config.BLOQUIM_API_URL).origin;
  } catch {
    return null;
  }

  try {
    const r = await fetch(`${origin}/api/internal/resolve-by-whatsapp?phone=${encodeURIComponent(digits)}`, {
      headers: { 'X-Internal-Secret': secret },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    return (await r.json()) as ResolvedUser;
  } catch {
    return null;
  }
}

/**
 * O usuário tem role >= mínima exigida no workspace alvo?
 * Hierarquia simples: admin > editor > viewer. Aceita variações de nome.
 */
const ROLE_RANK: Record<string, number> = { admin: 3, owner: 3, editor: 2, member: 1, viewer: 1 };

export function hasWorkspaceRole(
  user: ResolvedUser | null,
  workspaceId: string,
  minRole: 'admin' | 'editor' | 'viewer',
): boolean {
  if (!user) return false;
  const ws = user.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return false;
  const need = ROLE_RANK[minRole] ?? 99;
  const have = ROLE_RANK[(ws.role || '').toLowerCase()] ?? 0;
  return have >= need;
}

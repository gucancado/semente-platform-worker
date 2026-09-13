import { config } from '../config.js';

/**
 * Nomes de workspace pelo Bloquim (`GET /api/internal/workspaces`, gated por
 * INTERNAL_API_SECRET). O worker só guarda `workspace_id`; o nome canônico mora
 * no Bloquim — é o mesmo que o painel exibe.
 *
 * Graceful por contrato: qualquer falha devolve mapa vazio e quem chama cai no
 * rótulo. Nomear o cliente é conforto, nunca motivo para um aviso não sair.
 */
export type WorkspaceNamesDeps = {
  fetch?: typeof fetch;
  /** Sobrescreve INTERNAL_API_SECRET (testes). String vazia = sem segredo. */
  secret?: string;
  /** Sobrescreve a origem derivada de BLOQUIM_API_URL (testes). */
  bloquimOrigin?: string;
};

export async function resolveWorkspaceNames(
  ids: string[],
  deps: WorkspaceNamesDeps = {},
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const wanted = [...new Set(ids.filter(Boolean))];
  if (wanted.length === 0) return names;

  const secret = deps.secret ?? config.INTERNAL_API_SECRET;
  if (!secret) return names;

  let origin = deps.bloquimOrigin;
  if (!origin) {
    try {
      // A rota interna fica em /api/internal, independente do path de BLOQUIM_API_URL.
      origin = new URL(config.BLOQUIM_API_URL).origin;
    } catch {
      return names;
    }
  }

  try {
    const r = await (deps.fetch ?? fetch)(
      `${origin}/api/internal/workspaces?ids=${wanted.map(encodeURIComponent).join(',')}`,
      { headers: { 'X-Internal-Secret': secret }, signal: AbortSignal.timeout(8000) },
    );
    if (!r.ok) return names;
    const body = (await r.json()) as { workspaces?: Array<{ id?: unknown; name?: unknown }> };
    for (const w of body.workspaces ?? []) {
      if (typeof w.id === 'string' && typeof w.name === 'string' && w.name.trim()) names.set(w.id, w.name.trim());
    }
  } catch {
    // Bloquim fora ou resposta ilegível: o chamador usa o rótulo.
  }
  return names;
}

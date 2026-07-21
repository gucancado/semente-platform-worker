export const DEFAULT_FREEMAIL = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'yahoo.com.br', 'icloud.com', 'me.com', 'uol.com.br', 'bol.com.br', 'terra.com.br',
];

export type DomainRule = { workspace_id: string; project_slug: string | null };
export type AttributionResult = {
  workspace_id: string | null; project_slug: string | null;
  method: 'domain' | 'internal' | 'title' | 'none'; unresolved_domains: string[];
};

function domainOf(email: string | undefined | null): string | null {
  const at = (email ?? '').lastIndexOf('@');
  return at > 0 ? email!.slice(at + 1).toLowerCase().trim() : null;
}

/**
 * Resolução de workspace por participantes (spec §9). Ordem: domain → internal → none.
 * ('calendar' só existe no pipeline Recall; 'manual' é endpoint admin.)
 * - Conhecidos (em rules) concordando → domain; divergentes → none.
 * - Desconhecidos NÃO vetam (vão pra unresolved_domains — alimenta curadoria).
 * - Freemail não conta como domínio, mas o participante segue sendo externo.
 * - Todos internos → internal (se internalWorkspaceId configurado).
 */
export function resolveAttribution(
  participants: Array<{ name?: string; email?: string | null }>,
  rules: Map<string, DomainRule>,
  opts: { internalDomains: string[]; freemailDomains: string[]; internalWorkspaceId?: string }
): AttributionResult {
  const internal = new Set(opts.internalDomains.map((d) => d.toLowerCase()));
  const freemail = new Set(opts.freemailDomains.map((d) => d.toLowerCase()));

  const externalDomains = new Set<string>();
  let hasExternalParticipant = false;
  let hasAnyEmail = false;
  for (const part of participants) {
    const d = domainOf(part.email);
    if (!d) continue;
    hasAnyEmail = true;
    if (internal.has(d)) continue;
    hasExternalParticipant = true;
    if (!freemail.has(d)) externalDomains.add(d);
  }

  const known = new Map<string, DomainRule>();
  const unresolved: string[] = [];
  for (const d of externalDomains) {
    const rule = rules.get(d);
    if (rule) known.set(d, rule); else unresolved.push(d);
  }

  if (known.size > 0) {
    const workspaces = new Set([...known.values()].map((r) => r.workspace_id));
    if (workspaces.size === 1) {
      const rule = [...known.values()][0]!;
      return { workspace_id: rule.workspace_id, project_slug: rule.project_slug, method: 'domain', unresolved_domains: unresolved.sort() };
    }
    return { workspace_id: null, project_slug: null, method: 'none', unresolved_domains: unresolved.sort() };
  }
  if (hasAnyEmail && !hasExternalParticipant && opts.internalWorkspaceId) {
    return { workspace_id: opts.internalWorkspaceId, project_slug: null, method: 'internal', unresolved_domains: [] };
  }
  return { workspace_id: null, project_slug: null, method: 'none', unresolved_domains: unresolved.sort() };
}

/** Carrega todas as regras (tabela pequena — cache em memória por execução do importador). */
export async function loadDomainRules(): Promise<Map<string, DomainRule>> {
  const { pool } = await import('../db.js');
  const { rows } = await pool.query<{ domain: string; workspace_id: string; project_slug: string | null }>(
    `SELECT domain, workspace_id, project_slug FROM workspace_domains`
  );
  return new Map(rows.map((r) => [r.domain.toLowerCase(), { workspace_id: r.workspace_id, project_slug: r.project_slug }]));
}

export async function upsertDomainRule(args: { domain: string; workspace_id: string; project_slug?: string | null; notes?: string | null }): Promise<void> {
  const { pool } = await import('../db.js');
  const { rows } = await pool.query<{ workspace_id: string }>(
    `INSERT INTO workspace_domains (domain, workspace_id, project_slug, notes) VALUES ($1,$2,$3,$4)
     ON CONFLICT (domain) DO UPDATE SET
       project_slug = COALESCE(EXCLUDED.project_slug, workspace_domains.project_slug),
       notes = COALESCE(EXCLUDED.notes, workspace_domains.notes)
     WHERE workspace_domains.workspace_id = EXCLUDED.workspace_id
     RETURNING workspace_id`,
    [args.domain.toLowerCase(), args.workspace_id, args.project_slug ?? null, args.notes ?? null]
  );
  if (!rows[0]) {
    throw new Error(`workspace_domains: '${args.domain}' já mapeado pra outro workspace — ambiguidade de domínio exige resolução manual`);
  }
}

// ── Fallback por título (spec: reunião sem e-mail de cliente mas com nome no título) ──

export type TitleRule = { pattern: string; workspace_id: string; project_slug: string | null };

/** Upsert de regra de título (espelha upsertDomainRule). Pattern normalizado lowercase. */
export async function upsertTitleRule(args: { pattern: string; workspace_id: string; project_slug?: string | null; notes?: string | null }): Promise<void> {
  const { pool } = await import('../db.js');
  await pool.query(
    `INSERT INTO workspace_title_rules (pattern, workspace_id, project_slug, notes)
     VALUES (lower($1), $2, $3, $4)
     ON CONFLICT (pattern) DO UPDATE SET workspace_id = $2, project_slug = $3, notes = $4`,
    [args.pattern.trim(), args.workspace_id, args.project_slug ?? null, args.notes ?? null]
  );
}

/** Carrega regras de título (tabela pequena — cache em memória por execução). */
export async function loadTitleRules(): Promise<TitleRule[]> {
  const { pool } = await import('../db.js');
  const { rows } = await pool.query<TitleRule>(
    `SELECT pattern, workspace_id, project_slug FROM workspace_title_rules`
  );
  return rows.map((r) => ({ ...r, pattern: r.pattern.toLowerCase() }));
}

/**
 * Resolve workspace pelo TÍTULO quando o domínio não resolveu (método 'none').
 * Casa cada `pattern` como substring do título (lowercased). Se os patterns que
 * casam apontam pra UM workspace → 'title'; se divergem (2+ workspaces) → 'none'
 * (ambíguo, não chuta); nenhum casa → 'none'. Determinístico: independe da ordem.
 */
export function resolveByTitle(title: string | null | undefined, rules: TitleRule[]): AttributionResult {
  const t = (title ?? '').toLowerCase();
  if (!t) return { workspace_id: null, project_slug: null, method: 'none', unresolved_domains: [] };
  const matched = rules.filter((r) => r.pattern && t.includes(r.pattern));
  if (matched.length === 0) return { workspace_id: null, project_slug: null, method: 'none', unresolved_domains: [] };
  const workspaces = new Set(matched.map((r) => r.workspace_id));
  if (workspaces.size > 1) return { workspace_id: null, project_slug: null, method: 'none', unresolved_domains: [] };
  // Empate de patterns no mesmo workspace: escolhe o pattern mais específico (mais longo).
  const best = matched.sort((a, b) => b.pattern.length - a.pattern.length)[0]!;
  return { workspace_id: best.workspace_id, project_slug: best.project_slug, method: 'title', unresolved_domains: [] };
}

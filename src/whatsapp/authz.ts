/**
 * Worker-side actor authz client with short cache.
 *
 * Calls the Bloquim internal endpoint `POST /api/internal/authz/workspace-role`
 * (Task 1) to resolve a user's role in a workspace. Exposes:
 *
 *   resolveActorRole      — cached (TTL 45s), for read gates
 *   resolveActorRoleFresh — no cache, for write/admin actions (spec §5.1)
 *   assertActorMember     — throws AuthzError if role == null (cached path)
 *   assertActorAdmin      — throws AuthzError if role !== 'admin' (fresh path)
 *
 * Fail-closed in all error conditions (missing secret, non-OK HTTP, timeout).
 *
 * NOTE on lazy config: config.ts runs Zod parse at module-load time and throws
 * if required env vars are absent. To allow this module to be imported in tests
 * without a full env, config is accessed LAZILY — only inside function bodies
 * after a deps-override check. Tests supply `secret` and `bloquimOrigin` via
 * AuthzDeps and config is never actually evaluated. This follows the worker's
 * established pattern (see CLAUDE.md "Bug-traps: JWT_SECRET env var is required").
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ActorRole = 'admin' | 'editor' | 'executor' | null;

/**
 * Injectable dependencies for testability. Mirrors the pattern in
 * src/evolution/client.ts (injectable fetch) and
 * src/goals/email/gmail-client.ts (injectable clock via now()).
 */
export interface AuthzDeps {
  /** Overrides global fetch — useful in tests to mock network calls. */
  fetch?: typeof fetch;
  /** Overrides Date.now() — useful in tests to control TTL expiry. */
  now?: () => number;
  /**
   * Overrides config.INTERNAL_API_SECRET — provided in tests to avoid
   * importing config (which requires a full process.env at parse time).
   */
  secret?: string;
  /**
   * Overrides the derived Bloquim origin — provided in tests so no URL
   * parsing of config.BLOQUIM_API_URL is needed.
   */
  bloquimOrigin?: string;
}

// ── Lazy config accessor ──────────────────────────────────────────────────────
// Imported lazily to avoid Zod throwing at module-load time in test environments.

function getSecret(deps: AuthzDeps): string | undefined {
  if (deps.secret !== undefined) return deps.secret || undefined;
  // Only reach config when NOT in test (test always supplies deps.secret).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { config } = require('../config.js') as typeof import('../config.js');
  return config.INTERNAL_API_SECRET;
}

function getBloquimOrigin(deps: AuthzDeps): string | null {
  if (deps.bloquimOrigin !== undefined) return deps.bloquimOrigin;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { config } = require('../config.js') as typeof import('../config.js');
    return new URL(config.BLOQUIM_API_URL).origin;
  } catch {
    return null;
  }
}

// ── Custom error ──────────────────────────────────────────────────────────────

export class AuthzError extends Error {
  constructor(
    message: string,
    public readonly code: 'FORBIDDEN' | 'UNAUTHORIZED' | 'MISCONFIGURED' = 'FORBIDDEN',
  ) {
    super(message);
    this.name = 'AuthzError';
  }
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 45_000;

interface CacheEntry {
  value: ActorRole;
  expiresAt: number;
}

const roleCache = new Map<string, CacheEntry>();

function cacheKey(userId: string, workspaceId: string): string {
  return `${userId}::${workspaceId}`;
}

// ── Internal fetch helper ─────────────────────────────────────────────────────

async function fetchRole(
  userId: string,
  workspaceId: string,
  deps: AuthzDeps,
): Promise<ActorRole> {
  const secret = getSecret(deps);

  // Fail-closed: no secret → deny without fetching.
  if (!secret) return null;

  const origin = getBloquimOrigin(deps);
  if (!origin) return null;

  const f = deps.fetch ?? fetch;

  try {
    const url = `${origin}/api/internal/authz/workspace-role`;
    const res = await f(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': secret,
      },
      body: JSON.stringify({ userId, workspaceId }),
      signal: AbortSignal.timeout(5000),
    } as RequestInit);

    // Fail-closed: non-OK HTTP → deny.
    if (!res.ok) return null;

    const data = (await res.json()) as { role?: ActorRole };
    return data.role ?? null;
  } catch {
    // Network error or timeout → fail-closed.
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve the actor's role in a workspace, with a 45s in-process cache.
 * Use for read-path gates (member check). On any failure → returns null.
 */
export async function resolveActorRole(
  userId: string,
  workspaceId: string,
  deps: AuthzDeps = {},
): Promise<ActorRole> {
  const now = deps.now ?? Date.now;
  const key = cacheKey(userId, workspaceId);
  const cached = roleCache.get(key);
  if (cached && now() < cached.expiresAt) {
    return cached.value;
  }

  const value = await fetchRole(userId, workspaceId, deps);
  roleCache.set(key, { value, expiresAt: now() + CACHE_TTL_MS });
  return value;
}

/**
 * Resolve the actor's role without reading or writing the cache.
 * Use for write/admin gates where stale data is unacceptable (spec §5.1).
 */
export async function resolveActorRoleFresh(
  userId: string,
  workspaceId: string,
  deps: AuthzDeps = {},
): Promise<ActorRole> {
  // Intentionally bypass and do not populate the shared cache.
  return fetchRole(userId, workspaceId, deps);
}

/**
 * Assert the actor is a member (any non-null role) of the workspace.
 * Uses the cached path — suitable for read operations.
 * Throws AuthzError on deny or misconfiguration.
 */
export async function assertActorMember(
  userId: string,
  workspaceId: string,
  deps: AuthzDeps = {},
): Promise<void> {
  const secret = getSecret(deps);
  if (!secret) {
    throw new AuthzError(
      'Authz not configured (INTERNAL_API_SECRET missing)',
      'MISCONFIGURED',
    );
  }

  const role = await resolveActorRole(userId, workspaceId, deps);
  if (role === null) {
    throw new AuthzError(
      `User ${userId} is not a member of workspace ${workspaceId}`,
      'FORBIDDEN',
    );
  }
}

/**
 * Assert the actor has admin role in the workspace.
 * Uses the FRESH (uncached) path — admin checks must never be served from
 * a stale cache (spec §5.1).
 * Throws AuthzError on deny, non-admin role, or misconfiguration.
 */
export async function assertActorAdmin(
  userId: string,
  workspaceId: string,
  deps: AuthzDeps = {},
): Promise<void> {
  const secret = getSecret(deps);
  if (!secret) {
    throw new AuthzError(
      'Authz not configured (INTERNAL_API_SECRET missing)',
      'MISCONFIGURED',
    );
  }

  const role = await resolveActorRoleFresh(userId, workspaceId, deps);
  if (role !== 'admin') {
    throw new AuthzError(
      `User ${userId} does not have admin role in workspace ${workspaceId} (got: ${role})`,
      'FORBIDDEN',
    );
  }
}

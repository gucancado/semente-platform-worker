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
 * Fail-closed in all error conditions (missing secret, malformed Bloquim URL,
 * non-OK HTTP, network error, timeout).
 *
 * NOTE on ESM-safe config: the worker runs native ESM (`"type":"module"`,
 * `node dist/index.js`), so `require` is undefined at runtime — using it here
 * would crash the FIRST real authz call (no deps). We therefore read config
 * straight from `process.env` (NOT importing `../config.js`, which would re-run
 * `EnvSchema.parse` at import and break the no-DB local unit tests). Defaults
 * are overridable via AuthzDeps so the client stays fully unit-testable without
 * a populated env. This mirrors the worker bug-trap "JWT_SECRET env var is
 * required" (lazy env access) in CLAUDE.md.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ActorRole = 'admin' | 'editor' | 'executor' | null;

/**
 * Result of a single role fetch. We distinguish a DEFINITIVE answer (the Bloquim
 * endpoint replied 200 — including a real `role: null` = confirmed non-member)
 * from a TRANSIENT failure (missing config, non-OK HTTP, network error, timeout).
 * Only definitive answers may be cached; transient failures must NOT poison the
 * cache, or a brief Bloquim blip would lock a legitimate user out for the full
 * TTL.
 */
interface RoleResult {
  role: ActorRole;
  /** True only when Bloquim returned an authoritative 200 answer. */
  definitive: boolean;
}

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
   * Overrides the default secret (process.env.INTERNAL_API_SECRET) — provided
   * in tests to avoid depending on a populated env.
   */
  secret?: string;
  /**
   * Overrides the derived Bloquim origin (from process.env.BLOQUIM_API_URL) —
   * provided in tests so no URL parsing of env is needed.
   */
  bloquimOrigin?: string;
}

// ── Config accessors (ESM-safe, process.env directly) ─────────────────────────

function getSecret(deps: AuthzDeps): string | undefined {
  if (deps.secret !== undefined) return deps.secret || undefined;
  return process.env.INTERNAL_API_SECRET || undefined;
}

/**
 * Memoized default Bloquim origin, derived once from process.env.BLOQUIM_API_URL.
 * `undefined` = not yet computed; `null` = computed and failed (missing/malformed)
 * → fail-closed without re-parsing on every call.
 */
let memoizedOrigin: string | null | undefined;

function getBloquimOrigin(deps: AuthzDeps): string | null {
  if (deps.bloquimOrigin !== undefined) return deps.bloquimOrigin;
  if (memoizedOrigin !== undefined) return memoizedOrigin;
  try {
    memoizedOrigin = new URL(process.env.BLOQUIM_API_URL ?? '').origin;
  } catch {
    // Missing or malformed BLOQUIM_API_URL → fail-closed (deny), don't crash.
    memoizedOrigin = null;
  }
  return memoizedOrigin;
}

/** Test-only: reset the memoized origin so env changes take effect mid-suite. */
export function __resetOriginMemoForTests(): void {
  memoizedOrigin = undefined;
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
/** Cap cache size to avoid unbounded growth (mirror Bloquim permissionsCache). */
const MAX_ENTRIES = 5000;

interface CacheEntry {
  value: ActorRole;
  expiresAt: number;
}

const roleCache = new Map<string, CacheEntry>();

function cacheKey(userId: string, workspaceId: string): string {
  return `${userId}::${workspaceId}`;
}

function cacheSet(key: string, value: ActorRole, expiresAt: number): void {
  // Refresh insertion order so the cap evicts genuinely-oldest entries.
  if (roleCache.has(key)) roleCache.delete(key);
  roleCache.set(key, { value, expiresAt });
  while (roleCache.size > MAX_ENTRIES) {
    const oldest = roleCache.keys().next().value;
    if (oldest === undefined) break;
    roleCache.delete(oldest);
  }
}

// ── Internal fetch helper ─────────────────────────────────────────────────────

/**
 * Fetch the role from Bloquim. Returns a RoleResult so the caller can decide
 * whether the answer is cacheable. Fail-closed (role:null) on every failure,
 * but only `definitive: true` results should be written to the cache.
 */
async function fetchRole(
  userId: string,
  workspaceId: string,
  deps: AuthzDeps,
): Promise<RoleResult> {
  const secret = getSecret(deps);
  // Misconfiguration is treated as a non-definitive deny (do not cache).
  if (!secret) return { role: null, definitive: false };

  const origin = getBloquimOrigin(deps);
  if (!origin) return { role: null, definitive: false };

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

    // Non-OK HTTP → transient deny, do NOT cache (Bloquim blip must not lock out).
    if (!res.ok) return { role: null, definitive: false };

    const data = (await res.json()) as { role?: ActorRole };
    // 200 OK is authoritative — including role:null (confirmed non-member).
    return { role: data.role ?? null, definitive: true };
  } catch {
    // Network error or timeout → transient deny, do NOT cache.
    return { role: null, definitive: false };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve the actor's role in a workspace, with a 45s in-process cache.
 * Use for read-path gates (member check). On any failure → returns null.
 * Only DEFINITIVE answers (Bloquim 200) are cached; transient failures retry
 * on the next call.
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

  const result = await fetchRole(userId, workspaceId, deps);
  // Never cache transient failures — only a confirmed answer from Bloquim.
  if (result.definitive) {
    cacheSet(key, result.role, now() + CACHE_TTL_MS);
  }
  return result.role;
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
  const result = await fetchRole(userId, workspaceId, deps);
  return result.role;
}

/**
 * Assert the actor is a member (any non-null role) of the workspace.
 * Uses the cached path — suitable for read operations.
 * Throws AuthzError on deny (FORBIDDEN) or misconfiguration (MISCONFIGURED).
 */
export async function assertActorMember(
  userId: string,
  workspaceId: string,
  deps: AuthzDeps = {},
): Promise<void> {
  // Single source of truth for MISCONFIGURED: the secret check lives here so the
  // unset-secret case surfaces distinctly from a denied role (HTTP 500 vs 403 in
  // the route). fetchRole also fail-closes on a missing secret, so behaviour is
  // identical regardless of path.
  if (!getSecret(deps)) {
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
 * Throws AuthzError on deny / non-admin (FORBIDDEN) or misconfiguration
 * (MISCONFIGURED).
 */
export async function assertActorAdmin(
  userId: string,
  workspaceId: string,
  deps: AuthzDeps = {},
): Promise<void> {
  if (!getSecret(deps)) {
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

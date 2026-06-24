/**
 * route-authz.ts — Shared authz gate for /whatsapp/* route handlers.
 *
 * Abstracts the boilerplate of:
 *   1. Missing actor → 400
 *   2. assertActorMember / assertActorAdmin → 403 or 500 on AuthzError
 *
 * Injectable via RouteAuthzDeps so route tests can exercise the gate
 * without a real network/DB.
 */

import { assertActorMember, assertActorAdmin, AuthzError, type AuthzDeps } from './authz.js';

// ── Injectable deps (for testing) ─────────────────────────────────────────────

export interface RouteAuthz {
  assertMember(userId: string, workspaceId: string, deps?: AuthzDeps): Promise<void>;
  assertAdmin(userId: string, workspaceId: string, deps?: AuthzDeps): Promise<void>;
}

/** Default implementation — uses the real authz functions from authz.ts. */
export const defaultRouteAuthz: RouteAuthz = {
  assertMember: assertActorMember,
  assertAdmin: assertActorAdmin,
};

// ── Gate helpers ───────────────────────────────────────────────────────────────

/**
 * Check actor is present; returns 400 if not.
 * Returns `false` (and sends reply) when actor is missing; otherwise returns `true`.
 */
export function checkActorPresent(req: any, reply: any): boolean {
  if (!req.actingUser) {
    reply.code(400).send({ error: 'x-acting-user required' });
    return false;
  }
  return true;
}

/**
 * Map an AuthzError to the appropriate HTTP response.
 *
 * UNAUTHORIZED  → 401 { error: 'unauthorized' }
 * MISCONFIGURED → 500 { error: 'authz_misconfigured' }
 * FORBIDDEN     → 403 { error: 'forbidden' }
 * Non-AuthzError → rethrow (becomes Fastify 500).
 *
 * Returns `true` when the error was handled (reply already sent). When the error
 * is not an AuthzError it rethrows (never returns), so the return type is `true`:
 * callers can treat a normal return as "handled".
 */
export function handleAuthzError(err: unknown, reply: any): true {
  if (err instanceof AuthzError) {
    switch (err.code) {
      case 'UNAUTHORIZED':
        reply.code(401).send({ error: 'unauthorized' });
        return true;
      case 'MISCONFIGURED':
        reply.code(500).send({ error: 'authz_misconfigured' });
        return true;
      case 'FORBIDDEN':
        reply.code(403).send({ error: 'forbidden' });
        return true;
    }
  }
  throw err;
}

/**
 * Run a membership gate for a read route handler.
 * Returns `true` if the gate PASSED (handler may proceed).
 * Returns `false` if the gate DENIED (reply already sent — handler must return).
 */
export async function gateMember(
  req: any,
  reply: any,
  workspaceId: string,
  authz: RouteAuthz,
): Promise<boolean> {
  if (!checkActorPresent(req, reply)) return false;
  try {
    await authz.assertMember(req.actingUser, workspaceId);
    return true;
  } catch (err) {
    // handleAuthzError sends the reply when it handles an AuthzError, or rethrows
    // (→ Fastify 500) otherwise. A normal return means "gate denied" → false.
    handleAuthzError(err, reply);
    return false;
  }
}

/**
 * Run an admin gate for a write route handler.
 * Returns `true` if the gate PASSED (handler may proceed).
 * Returns `false` if the gate DENIED (reply already sent — handler must return).
 */
export async function gateAdmin(
  req: any,
  reply: any,
  workspaceId: string,
  authz: RouteAuthz,
): Promise<boolean> {
  if (!checkActorPresent(req, reply)) return false;
  try {
    await authz.assertAdmin(req.actingUser, workspaceId);
    return true;
  } catch (err) {
    // handleAuthzError sends the reply when it handles an AuthzError, or rethrows
    // (→ Fastify 500) otherwise. A normal return means "gate denied" → false.
    handleAuthzError(err, reply);
    return false;
  }
}

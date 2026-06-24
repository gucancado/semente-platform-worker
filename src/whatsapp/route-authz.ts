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
 * MISCONFIGURED → 500 { error: 'authz_misconfigured' }
 * FORBIDDEN     → 403 { error: 'forbidden' }
 * Other error   → rethrow (becomes Fastify 500).
 *
 * @returns true if the error was handled (gate denied); false if it was rethrown.
 */
export function handleAuthzError(err: unknown, reply: any): boolean {
  if (err instanceof AuthzError) {
    if (err.code === 'MISCONFIGURED') {
      reply.code(500).send({ error: 'authz_misconfigured' });
      return true;
    }
    // FORBIDDEN (or any other AuthzError code)
    reply.code(403).send({ error: 'forbidden' });
    return true;
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
    handleAuthzError(err, reply);
    return false;
  }
}

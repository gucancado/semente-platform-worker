import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { requirePanelToken } from '../whatsapp/provision-routes.js';
import {
  resolveAttribution, resolveByTitle, loadDomainRules, loadTitleRules,
  upsertTitleRule, DEFAULT_FREEMAIL,
} from './attribution.js';

/**
 * Contrato attribution_v1: o Bloquim (sync da agenda) resolve o workspace de um
 * evento ANTES da reunião existir, com as MESMAS regras do import (domain >
 * title > internal > none). Regras continuam únicas, aqui no worker.
 */
export function registerAttributionRoutes(
  app: FastifyInstance,
  deps: { panelToken: string; internalWorkspaceId?: string }
): void {
  const auth = requirePanelToken(deps.panelToken);

  app.post('/attribution/resolve', { preHandler: auth }, async (req: any, reply) => {
    const title: string | null = req.body?.title ?? null;
    const attendees: Array<{ email?: string | null; name?: string }> = Array.isArray(req.body?.attendees) ? req.body.attendees : [];
    const rules = await loadDomainRules();
    const titleRules = await loadTitleRules();
    const freemail = [...DEFAULT_FREEMAIL, ...config.FREEMAIL_DOMAINS_EXTRA];
    let attr = resolveAttribution(attendees, rules, {
      internalDomains: config.INTERNAL_DOMAINS,
      freemailDomains: freemail,
      internalWorkspaceId: deps.internalWorkspaceId ?? config.INTERNAL_WORKSPACE_ID,
    });
    if (attr.method !== 'domain') {
      const byTitle = resolveByTitle(title, titleRules);
      if (byTitle.workspace_id) attr = { ...byTitle, unresolved_domains: attr.unresolved_domains };
    }
    return reply.send({
      schema: 'attribution_v1',
      workspace_id: attr.workspace_id, project_slug: attr.project_slug,
      method: attr.method, unresolved_domains: attr.unresolved_domains,
    });
  });

  app.post('/attribution/title-rules', { preHandler: auth }, async (req: any, reply) => {
    const pattern: string = String(req.body?.pattern ?? '').trim();
    const workspaceId: string | undefined = req.body?.workspace_id;
    if (pattern.length < 3 || !workspaceId) return reply.code(400).send({ error: 'invalid_rule' });
    await upsertTitleRule({ pattern, workspace_id: workspaceId, project_slug: req.body?.project_slug ?? null, notes: req.body?.notes ?? null });
    return reply.code(201).send({ ok: true, pattern: pattern.toLowerCase() });
  });
}

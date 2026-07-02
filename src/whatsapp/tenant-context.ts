import type { WhatsappNumber } from './numbers.js';

export type TenantContext = {
  workspaceId: string;
  number: { id: number; label: string | null; phone: string | null } | null;
};

export function tenantContext(input: WhatsappNumber): TenantContext;
export function tenantContext(input: { workspaceId: string }): TenantContext;
export function tenantContext(input: WhatsappNumber | { workspaceId: string }): TenantContext {
  if ('id' in input) {
    return { workspaceId: input.workspaceId, number: { id: input.id, label: input.label, phone: input.phone } };
  }
  return { workspaceId: input.workspaceId, number: null };
}

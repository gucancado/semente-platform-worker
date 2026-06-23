// src/whatsapp/group-gate.ts
export type Kind = 'dm' | 'group' | 'all';

/** Quando grupos não estão expostos, força a listagem a só DMs. */
export function coerceKind(requested: Kind | undefined, exposeGroups: boolean): Kind {
  if (!exposeGroups) return 'dm';
  return requested ?? 'all';
}

/** Acesso a uma thread específica: grupo só passa com flag on; DM sempre. */
export function groupAccessAllowed(isGroup: boolean, exposeGroups: boolean): boolean {
  return !isGroup || exposeGroups;
}

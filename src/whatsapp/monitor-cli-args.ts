// Parsing puro dos argumentos das CLIs de monitor de grupos (sem I/O).
export type GroupMonitorArgs =
  | { cmd: 'list' }
  | { cmd: 'set'; slot: 'A' | 'B'; instance: string; phone: string | null; keepDms: boolean; dryRun: boolean }
  | { error: string };
export type MonitorCopyArgs = { since: string; until: string | null; dryRun: boolean } | { error: string };

function flag(argv: string[], name: string): string | undefined {
  const p = `--${name}=`;
  const a = argv.find((x) => x.startsWith(p));
  return a === undefined ? undefined : a.slice(p.length);
}

export function parseGroupMonitorArgs(argv: string[]): GroupMonitorArgs {
  const cmd = argv[0];
  if (cmd === 'list') return { cmd: 'list' };
  if (cmd !== 'set') return { error: 'uso: list | set --slot=A|B --instance=<nome> [--phone=+55...] [--keep-dms] [--dry-run]' };
  const slot = (flag(argv, 'slot') ?? '').toUpperCase();
  if (slot !== 'A' && slot !== 'B') return { error: '--slot deve ser A ou B' };
  const instance = flag(argv, 'instance');
  if (!instance) return { error: '--instance é obrigatório' };
  const phone = flag(argv, 'phone') ?? null;
  if (phone !== null && !/^\+\d{10,15}$/.test(phone)) return { error: '--phone deve casar ^\+\d{10,15}$ (ex.: +5531999999999)' };
  return { cmd: 'set', slot, instance, phone, keepDms: argv.includes('--keep-dms'), dryRun: argv.includes('--dry-run') };
}

function iso(v: string): string | null {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function parseMonitorCopyArgs(argv: string[]): MonitorCopyArgs {
  const s = flag(argv, 'since');
  if (!s) return { error: '--since é obrigatório (ISO, ex.: 2026-10-13T00:00:00Z)' };
  const since = iso(s);
  if (!since) return { error: `--since inválido: ${s}` };
  const u = flag(argv, 'until');
  let until: string | null = null;
  if (u !== undefined) {
    until = iso(u);
    if (!until) return { error: `--until inválido: ${u}` };
  }
  return { since, until, dryRun: argv.includes('--dry-run') };
}

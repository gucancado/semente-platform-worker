/**
 * Sistema de comandos `!` — padrão do ecossistema de agentes (saturno, mercurio,
 * futuros). Comandos em pt-BR. Dispatch DETERMINÍSTICO (sem LLM) → custo zero,
 * confiável. Resposta sempre via número B (Cloud API).
 *
 * Parse: trim → tira '!' → remove acento → 1º token = comando → resto = args.
 */

export type CommandScope = 'public' | 'workspace' | 'owner';

export type ParsedCommand = { name: string; args: string[]; raw: string };

export function parseCommand(text: string | null | undefined): ParsedCommand | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('!')) return null;
  const body = trimmed.slice(1).trim();
  if (!body) return null;
  // remove acentos pra casar "!ajuda" / "!ajúda" etc.
  const norm = body.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const parts = norm.split(/\s+/);
  const name = (parts[0] ?? '').toLowerCase();
  if (!name) return null;
  return { name, args: parts.slice(1), raw: trimmed };
}

export type CommandContext = {
  agent: string;
  from: string; // E.164 do remetente
  displayName?: string | null; // pushName do WhatsApp ou nome resolvido no Bloquim
};

export type CommandHandler = (ctx: CommandContext) => Promise<string> | string;

export type CommandDef = {
  names: string[]; // primeiro = canônico; demais = aliases
  scope: CommandScope;
  describe: string;
  handler: CommandHandler;
};

const COMMANDS: CommandDef[] = [
  {
    names: ['oi', 'status'],
    scope: 'public',
    describe: '!oi — status do agente',
    handler: (ctx) => {
      const primeiro = ctx.displayName ? ctx.displayName.trim().split(/\s+/)[0] : '';
      const saud = primeiro ? `Olá, ${primeiro}!` : 'Olá!';
      return `${saud} Sou um agente automatizado da BeeAds (operado por humanos). Estou ativo, tudo certo.`;
    },
  },
  {
    names: ['ajuda', 'comandos', 'help'],
    scope: 'public',
    describe: '!ajuda — lista os comandos disponíveis',
    handler: () => {
      const linhas = COMMANDS.filter((c) => c.scope === 'public').map((c) => `• ${c.describe}`);
      return ['Comandos disponíveis:', ...linhas].join('\n');
    },
  },
];

export function findCommand(name: string): CommandDef | null {
  return COMMANDS.find((c) => c.names.includes(name)) ?? null;
}

/**
 * Resolve e executa um comando. Retorna o texto de resposta (sempre algo, mesmo
 * em erro/desconhecido — o caller envia via B). Gate de permissão p/ escopos
 * workspace/owner entra na próxima fase (precisa de identidade resolvida).
 */
export async function dispatchCommand(
  parsed: ParsedCommand,
  ctx: CommandContext,
): Promise<string> {
  const cmd = findCommand(parsed.name);
  if (!cmd) {
    return `Comando "!${parsed.name}" não reconhecido. Envie !ajuda para ver os comandos.`;
  }
  if (cmd.scope !== 'public') {
    // Placeholder até a fase de identidade+permissão. Por ora, recusa não-público.
    return 'Esse comando ainda não está disponível.';
  }
  return await cmd.handler(ctx);
}

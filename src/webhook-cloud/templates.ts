import { DEFAULT_PANEL_PUBLIC_URL, fmtBrtShort, reconnectUrl } from '../whatsapp/down-notify.js';

/**
 * Template do aviso de queda (WhatsApp Cloud API).
 *
 * Existe porque texto livre só é entregue dentro da janela de 24h — e ninguém
 * conversa com o número Cloud do saturno, então a janela está sempre fechada
 * quando um número cai.
 *
 * O link vai NO CORPO, sem botão: botão de URL não sobrevive ao encaminhamento,
 * e a pessoa precisa abrir o link em OUTRA tela para escanear o QR com o mesmo
 * celular que recebeu o aviso.
 *
 * ⚠️ Esta constante é o que foi SUBMETIDO à aprovação da Meta. Mudar texto ou
 * variáveis exige submeter um template NOVO (nome novo): editar só aqui faz o
 * envio divergir do aprovado e ser recusado. A v1 (`conexao_whatsapp_caiu`, com
 * botão) segue aprovada na WABA, mas não é mais enviada.
 */
export const CONNECTION_DOWN_TEMPLATE_NAME = 'conexao_whatsapp_caiu_v2';

/** Base do link, congelada no texto aprovado. O token é a variável {{3}}. */
export const RECONNECT_URL_BASE = reconnectUrl(DEFAULT_PANEL_PUBLIC_URL, '');

type TemplateComponent = { type: 'BODY'; text: string; example: { body_text: string[][] } };

// A Meta recusa corpo que termina em variável — por isso a linha fixa depois do link.
const BODY_TEXT =
  'O WhatsApp {{1}} está desconectado da BeeAds desde {{2}}.\n\n' +
  'Para reconectar, abra o link abaixo em outra tela e escaneie o QR com este celular em ' +
  '*Configurações > Dispositivos conectados*\n\n' +
  `${RECONNECT_URL_BASE}{{3}}\n\n` +
  'Mensagem automática da BeeAds.';

export const CONNECTION_DOWN_TEMPLATE: {
  name: string;
  language: string;
  category: 'UTILITY';
  components: TemplateComponent[];
} = {
  name: CONNECTION_DOWN_TEMPLATE_NAME,
  language: 'pt_BR',
  category: 'UTILITY',
  components: [
    {
      type: 'BODY',
      text: BODY_TEXT,
      example: { body_text: [['Pousada Recanto de Moriá (+5524999422282)', '09/09 às 15:32', 'exemploToken123']] },
    },
  ],
};

/** A Meta recusa parâmetro de corpo com quebra de linha, tab ou espaços repetidos. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** `name`: nome do workspace — ou, sem workspace, o rótulo da instância. */
type DownMessageInput = { name: string | null; phone: string; downSince: Date; token: string };

export function connectionDownTemplateParams(p: DownMessageInput): { bodyParams: string[] } {
  const who = p.name ? `${oneLine(p.name)} (${p.phone})` : p.phone;
  return { bodyParams: [who, fmtBrtShort(p.downSince), p.token] };
}

/**
 * O mesmo corpo com as variáveis preenchidas: é o texto livre de fallback e o
 * que o CLI mostra no dry-run. Uma fonte só — o que se encaminha é o aprovado.
 */
export function renderConnectionDownText(p: DownMessageInput): string {
  const { bodyParams } = connectionDownTemplateParams(p);
  return BODY_TEXT.replace(/\{\{(\d+)\}\}/g, (_, n: string) => bodyParams[Number(n) - 1] ?? '');
}

// ── Aviso OPERACIONAL do painel (beeads-central-de-dados) ────────────────────

/**
 * Template do aviso de operação do painel (WhatsApp Cloud API).
 *
 * Existe porque o canal antigo saía pela Evolution, da instância do PRÓPRIO
 * destinatário — e ficou 35 dias mudo quando aquela instância caiu (todo envio
 * dava 400). Instância Evolution é leitura; quem envia é sempre o número Cloud,
 * que não tem sessão para cair. O remetente é o MESMO do aviso de queda.
 *
 * ⚠️ Esta constante é o que foi SUBMETIDO à aprovação da Meta (id
 * 1896879847947648, em PENDING). Mudar texto ou variáveis exige submeter um
 * template NOVO (nome novo): editar só aqui faz o envio divergir do aprovado e
 * ser recusado — mesma regra do CONNECTION_DOWN_TEMPLATE acima.
 */
export const OPS_ALERT_TEMPLATE_NAME = 'aviso_operacional_v1';

// Duas variáveis, nesta ordem: {{1}} título curto, {{2}} detalhe de uma linha.
// A Meta recusa corpo que termina em variável — daí a linha fixa no fim.
const OPS_ALERT_BODY_TEXT =
  'Aviso do painel BeeAds: {{1}}\n' +
  'Detalhe: {{2}}\n' +
  'Mensagem automática da BeeAds.';

export const OPS_ALERT_TEMPLATE: {
  name: string;
  language: string;
  category: 'UTILITY';
  components: TemplateComponent[];
} = {
  name: OPS_ALERT_TEMPLATE_NAME,
  language: 'pt_BR',
  category: 'UTILITY',
  components: [
    {
      type: 'BODY',
      text: OPS_ALERT_BODY_TEXT,
      example: { body_text: [['3 erros novos no painel', 'TypeError em /[slug]/whatsapp — 12x']] },
    },
  ],
};

/**
 * Teto por parâmetro. A Meta aceita até 1024 chars num parâmetro de corpo; 600
 * é folga deliberada para as duas variáveis juntas caberem numa mensagem que
 * ainda se lê no celular. Trunca com reticência em vez de deixar a Meta recusar.
 */
export const OPS_ALERT_PARAM_MAX = 600;

/** Parâmetro VAZIO é recusado pela Meta — o travessão preserva o envio. */
const EMPTY_PARAM = '—';

function opsParam(s: string | null | undefined): string {
  const flat = oneLine(s ?? '');
  if (!flat) return EMPTY_PARAM;
  return flat.length > OPS_ALERT_PARAM_MAX ? `${flat.slice(0, OPS_ALERT_PARAM_MAX - 1)}…` : flat;
}

export type OpsAlertInput = { titulo: string; detalhe?: string | null };

export function opsAlertTemplateParams(p: OpsAlertInput): { bodyParams: string[] } {
  return { bodyParams: [opsParam(p.titulo), opsParam(p.detalhe)] };
}

/**
 * O mesmo corpo com as variáveis preenchidas: é o texto livre de fallback
 * enquanto a Meta não aprova o template. Uma fonte só.
 */
export function renderOpsAlertText(p: OpsAlertInput): string {
  const { bodyParams } = opsAlertTemplateParams(p);
  return OPS_ALERT_BODY_TEXT.replace(/\{\{(\d+)\}\}/g, (_, n: string) => bodyParams[Number(n) - 1] ?? '');
}

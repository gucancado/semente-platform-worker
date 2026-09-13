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

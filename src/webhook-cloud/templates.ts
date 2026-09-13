import { DEFAULT_PANEL_PUBLIC_URL, fmtBrtShort, reconnectUrl } from '../whatsapp/down-notify.js';

/**
 * Template do aviso de queda (WhatsApp Cloud API).
 *
 * Existe porque texto livre só é entregue dentro da janela de 24h — e ninguém
 * conversa com o número Cloud do saturno, então a janela está sempre fechada
 * quando um número cai.
 *
 * ⚠️ Esta constante é o que foi SUBMETIDO à aprovação da Meta. Mudar texto,
 * variáveis ou a base do botão exige submeter um template NOVO (nome novo):
 * editar só aqui faz o envio divergir do aprovado e ser recusado.
 */
export const CONNECTION_DOWN_TEMPLATE_NAME = 'conexao_whatsapp_caiu';

/** Base do botão de URL, congelada na aprovação. O token é o sufixo dinâmico. */
export const RECONNECT_URL_BASE = reconnectUrl(DEFAULT_PANEL_PUBLIC_URL, '');

type TemplateComponent =
  | { type: 'BODY'; text: string; example: { body_text: string[][] } }
  | { type: 'BUTTONS'; buttons: Array<{ type: 'URL'; text: string; url: string; example: string[] }> };

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
      text:
        'O WhatsApp {{1}} está desconectado da BeeAds desde {{2}}. ' +
        'Para reconectar, toque no botão abaixo e escaneie o QR code com este celular.',
      example: { body_text: [['Monitor de grupos (+553195950748)', '09/09 às 18:10']] },
    },
    {
      type: 'BUTTONS',
      buttons: [
        {
          type: 'URL',
          text: 'Reconectar',
          url: `${RECONNECT_URL_BASE}{{1}}`,
          example: [`${RECONNECT_URL_BASE}exemploToken123`],
        },
      ],
    },
  ],
};

/** A Meta recusa parâmetro de corpo com quebra de linha, tab ou espaços repetidos. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function connectionDownTemplateParams(p: {
  label: string | null;
  phone: string;
  downSince: Date;
  token: string;
}): { bodyParams: string[]; urlButtonParam: string } {
  const who = p.label ? `${oneLine(p.label)} (${p.phone})` : p.phone;
  return { bodyParams: [who, fmtBrtShort(p.downSince)], urlButtonParam: p.token };
}

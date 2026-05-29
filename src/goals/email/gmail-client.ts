/**
 * ÚNICO arquivo no worker que importa googleapis.gmail.
 * Wraps Gmail API: sendEmail (texto/HTML), listInbox (metadata), getOwnEmail.
 */

import { google, type gmail_v1 } from 'googleapis';
import { getAuthedOAuth2Client } from '../../integrations/google/client-factory.js';
import type { GoogleOAuthConnection } from '../../integrations/google/types.js';

export type SendEmailRequest = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
};

export type InboxMessage = {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  internalDate: string;
};

async function gmailClient(conn: GoogleOAuthConnection): Promise<gmail_v1.Gmail> {
  const auth = await getAuthedOAuth2Client(conn);
  return google.gmail({ version: 'v1', auth });
}

/**
 * Compõe e envia email. text e/ou html devem ser fornecidos. Encoding: UTF-8.
 * Retorna messageId do Gmail.
 */
export async function sendEmail(
  conn: GoogleOAuthConnection,
  req: SendEmailRequest
): Promise<{ messageId: string }> {
  if (!req.text && !req.html) {
    throw new Error('sendEmail: pelo menos um de text/html é obrigatório');
  }
  const fromEmail = conn.google_email;
  const headers: string[] = [
    `From: ${fromEmail}`,
    `To: ${req.to}`,
    `Subject: =?UTF-8?B?${Buffer.from(req.subject, 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
  ];
  if (req.replyTo) headers.push(`Reply-To: ${req.replyTo}`);

  let body: string;
  if (req.html && req.text) {
    // multipart/alternative
    const boundary = `bdy${Date.now().toString(36)}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body =
      `\r\n--${boundary}\r\n` +
      `Content-Type: text/plain; charset="UTF-8"\r\n\r\n${req.text}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/html; charset="UTF-8"\r\n\r\n${req.html}\r\n` +
      `--${boundary}--`;
  } else if (req.html) {
    headers.push('Content-Type: text/html; charset="UTF-8"');
    body = `\r\n${req.html}`;
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    body = `\r\n${req.text}`;
  }

  const raw = Buffer.from(headers.join('\r\n') + body, 'utf8').toString('base64url');

  const gmail = await gmailClient(conn);
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  return { messageId: res.data.id ?? '' };
}

/**
 * Lista últimas mensagens da inbox (label INBOX). Default 20 mensagens.
 * Retorna apenas metadata (não download de body completo).
 */
export async function listInbox(
  conn: GoogleOAuthConnection,
  opts: { maxResults?: number; query?: string } = {}
): Promise<InboxMessage[]> {
  const gmail = await gmailClient(conn);
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    labelIds: ['INBOX'],
    maxResults: opts.maxResults ?? 20,
    q: opts.query,
  });
  const ids = (listRes.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  if (ids.length === 0) return [];

  const results: InboxMessage[] = [];
  // batch via individual gets (Gmail batch endpoint é complicado; aceita o N+1 pra MVP)
  for (const id of ids) {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject'],
    });
    const headers = msg.data.payload?.headers ?? [];
    const from = headers.find((h) => h.name === 'From')?.value ?? '';
    const subject = headers.find((h) => h.name === 'Subject')?.value ?? '';
    results.push({
      id: msg.data.id ?? id,
      threadId: msg.data.threadId ?? '',
      from,
      subject,
      snippet: msg.data.snippet ?? '',
      internalDate: msg.data.internalDate ?? '0',
    });
  }
  return results;
}

const ownEmailCache = new Map<number, { email: string; cachedAt: number }>();
const OWN_EMAIL_TTL_MS = 60_000;

export async function getOwnEmail(conn: GoogleOAuthConnection): Promise<string> {
  const cached = ownEmailCache.get(conn.id);
  if (cached && Date.now() - cached.cachedAt < OWN_EMAIL_TTL_MS) {
    return cached.email;
  }
  const gmail = await gmailClient(conn);
  const res = await gmail.users.getProfile({ userId: 'me' });
  const email = res.data.emailAddress ?? conn.google_email;
  ownEmailCache.set(conn.id, { email, cachedAt: Date.now() });
  return email;
}

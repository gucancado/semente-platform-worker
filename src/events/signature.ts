import { createHmac, timingSafeEqual } from 'node:crypto';

// String canônica assinada: event_id + "." + timestamp + "." + body.
// Assinar só o body permitiria troca de headers entre contextos (spec §4, achado Codex #5).
export function canonicalString(eventId: string, timestamp: string, body: string): string {
  return `${eventId}.${timestamp}.${body}`;
}

export function signEvent(secret: string, eventId: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(canonicalString(eventId, timestamp, body)).digest('hex');
}

export function verifyEventSignature(
  secrets: string[],
  signature: string,
  eventId: string,
  timestamp: string,
  body: string,
  nowMs: number = Date.now(),
  toleranceMs: number = 5 * 60_000
): boolean {
  const ts = Date.parse(timestamp);
  if (Number.isNaN(ts) || Math.abs(nowMs - ts) > toleranceMs) return false;
  const sigBuf = Buffer.from(signature, 'hex');
  for (const secret of secrets) {
    const expected = Buffer.from(signEvent(secret, eventId, timestamp, body), 'hex');
    if (sigBuf.length === expected.length && timingSafeEqual(sigBuf, expected)) return true;
  }
  return false;
}

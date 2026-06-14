import type { FirefliesTranscript } from './normalize.js';

const QUERY = `
query Transcripts($limit: Int, $skip: Int, $fromDate: DateTime, $toDate: DateTime) {
  transcripts(limit: $limit, skip: $skip, fromDate: $fromDate, toDate: $toDate) {
    id title date duration host_email organizer_email participants audio_url
    meeting_attendees { displayName email name phoneNumber location }
    sentences { index speaker_name text raw_text start_time end_time }
  }
}`;

const PING_QUERY = `query { user { name email num_transcripts } }`;

/** Erro transitório → vale re-tentar. */
function isTransient(err: unknown): boolean {
  if (err instanceof Error) {
    // AbortSignal.timeout() rejeita com TimeoutError; abort manual com AbortError.
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  }
  return false;
}

export class FirefliesClient {
  private apiKey: string;

  constructor(
    apiKey: string,
    private fetchFn: typeof fetch = fetch,
    private baseUrl = 'https://api.fireflies.ai/graphql',
    private maxRetries = 3,
    private sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((res) => setTimeout(res, ms))
  ) {
    if (!apiKey || !apiKey.trim()) throw new Error('FIREFLIES_API_KEY ausente ou vazia');
    this.apiKey = apiKey.trim();
  }

  private headers() {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` };
  }

  async page(opts: { limit?: number; skip?: number; fromDate?: string; toDate?: string }): Promise<FirefliesTranscript[]> {
    const body = JSON.stringify({
      query: QUERY,
      variables: { limit: Math.min(opts.limit ?? 50, 50), skip: opts.skip ?? 0, fromDate: opts.fromDate, toDate: opts.toDate },
    });

    let lastError = '';
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      let r: Response;
      try {
        r = await this.fetchFn(this.baseUrl, {
          method: 'POST',
          headers: this.headers(),
          body,
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        // Falha de rede / timeout: re-tenta se transitória, senão estoura.
        if (isTransient(err)) {
          lastError = (err as Error).name;
          if (attempt < this.maxRetries) { await this.sleepFn(1000 * 2 ** (attempt - 1)); continue; }
          break;
        }
        throw err;
      }

      if (!r.ok) {
        const text = (await r.text()).slice(0, 300);
        // 429 (rate limit) e 5xx (erro de servidor) são transitórios; 4xx não-429 falha imediato.
        const transient = r.status === 429 || r.status >= 500;
        if (transient && attempt < this.maxRetries) {
          lastError = `HTTP ${r.status} — ${text}`;
          await this.sleepFn(1000 * 2 ** (attempt - 1));
          continue;
        }
        if (transient) { lastError = `HTTP ${r.status} — ${text}`; break; }
        throw new Error(`fireflies: HTTP ${r.status} — ${text}`);
      }

      const json = (await r.json()) as { data?: { transcripts: FirefliesTranscript[] }; errors?: Array<{ message: string }> };
      if (json.errors?.length) throw new Error(`fireflies: ${json.errors.map((e) => e.message).join('; ')}`);
      return json.data?.transcripts ?? [];
    }

    throw new Error(`fireflies: falha após ${this.maxRetries} tentativas — ${lastError}`);
  }

  /** Itera todas as páginas (rate limit desconhecido — pausa defensiva de 1s entre páginas). */
  async *iterateAll(opts: { fromDate?: string; toDate?: string; pageDelayMs?: number } = {}): AsyncGenerator<FirefliesTranscript> {
    let skip = 0;
    for (;;) {
      const page = await this.page({ limit: 50, skip, fromDate: opts.fromDate, toDate: opts.toDate });
      for (const t of page) yield t;
      if (page.length < 50) return;
      skip += 50;
      await new Promise((res) => setTimeout(res, opts.pageDelayMs ?? 1000));
    }
  }

  /** Diagnóstico: confere a chave/conta. Não estoura — retorna status + corpo cru. */
  async ping(): Promise<{ status: number; body: string }> {
    try {
      const r = await this.fetchFn(this.baseUrl, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ query: PING_QUERY }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = await r.text();
      return { status: r.status, body };
    } catch (err) {
      return { status: 0, body: (err as Error).message };
    }
  }
}

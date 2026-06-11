import type { FirefliesTranscript } from './normalize.js';

const QUERY = `
query Transcripts($limit: Int, $skip: Int, $fromDate: DateTime, $toDate: DateTime) {
  transcripts(limit: $limit, skip: $skip, fromDate: $fromDate, toDate: $toDate) {
    id title date duration host_email organizer_email participants audio_url
    meeting_attendees { displayName email name phoneNumber location }
    sentences { index speaker_name text raw_text start_time end_time }
  }
}`;

export class FirefliesClient {
  constructor(
    private apiKey: string,
    private fetchFn: typeof fetch = fetch,
    private baseUrl = 'https://api.fireflies.ai/graphql'
  ) {}

  async page(opts: { limit?: number; skip?: number; fromDate?: string; toDate?: string }): Promise<FirefliesTranscript[]> {
    const r = await this.fetchFn(this.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ query: QUERY, variables: { limit: Math.min(opts.limit ?? 50, 50), skip: opts.skip ?? 0, fromDate: opts.fromDate, toDate: opts.toDate } }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`fireflies: HTTP ${r.status} — ${(await r.text()).slice(0, 300)}`);
    const json = (await r.json()) as { data?: { transcripts: FirefliesTranscript[] }; errors?: Array<{ message: string }> };
    if (json.errors?.length) throw new Error(`fireflies: ${json.errors.map((e) => e.message).join('; ')}`);
    return json.data?.transcripts ?? [];
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
}

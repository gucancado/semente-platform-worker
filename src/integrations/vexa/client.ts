export type VexaSegment = {
  start: number;              // epoch SEGUNDOS (float)
  end: number;                // epoch SEGUNDOS (float)
  text: string;
  language: string | null;
  speaker: string | null;     // display name; ~2% vem como "Speaker" genérico
  completed?: boolean;
  segment_id?: string;
  absolute_start_time?: string; // BUG upstream (ano 2083) — ignorar
  absolute_end_time?: string;
};

export type VexaMeeting = {
  id: number;                 // id do meeting no Vexa
  platform: string;           // 'google_meet'
  native_meeting_id: string;  // código do meet (xxx-xxxx-xxx)
  constructed_meeting_url?: string;
  status: string;             // 'joining'|'awaiting_admission'|'active'|'completed'|'failed'|...
  start_time: string | null;  // ISO sem sufixo de tz (ex.: "2026-07-10T21:58:25.557234")
  end_time: string | null;
  data?: unknown;
  segments: VexaSegment[];
};

const PLATFORM = 'google_meet';

/** Client HTTP do Vexa Lite. `fetchFn` injetável para testes. Erros não-2xx estouram com status+corpo. */
export class VexaClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string, private fetchFn: typeof fetch = fetch) {
    if (!baseUrl || !baseUrl.trim()) throw new Error('VEXA_API_URL ausente ou vazia');
    if (!apiKey || !apiKey.trim()) throw new Error('VEXA_API_KEY ausente ou vazia');
    this.baseUrl = baseUrl.trim().replace(/\/+$/, '');
    this.apiKey = apiKey.trim();
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey };
  }

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    const r = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) {
      const text = (await r.text().catch(() => '')).slice(0, 300);
      throw new Error(`vexa: HTTP ${r.status} — ${text}`);
    }
    // DELETE pode não retornar JSON; tolera corpo vazio.
    const raw = await r.text().catch(() => '');
    return raw ? JSON.parse(raw) : {};
  }

  async sendBot(meetCode: string, botName: string, language: string): Promise<VexaMeeting> {
    return this.req('POST', '/bots', {
      platform: PLATFORM,
      native_meeting_id: meetCode,
      bot_name: botName,
      language,
    });
  }

  async stopBot(meetCode: string): Promise<void> {
    await this.req('DELETE', `/bots/${PLATFORM}/${meetCode}`);
  }

  async getTranscript(meetCode: string): Promise<VexaMeeting> {
    return this.req('GET', `/transcripts/${PLATFORM}/${meetCode}`);
  }

  async getBotStatus(): Promise<unknown> {
    return this.req('GET', '/bots/status');
  }
}

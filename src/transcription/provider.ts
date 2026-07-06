import OpenAI, { toFile } from 'openai';

export interface TranscriptionResult { text: string; model: string; costUsd: number; }
export interface TranscriptionProvider {
  transcribe(audio: Buffer, opts: { mime: string | null; durationS: number | null; language?: string }): Promise<TranscriptionResult>;
}

// US$/min — confirmar no pricing vigente. Duração vem do envelope (seconds), não da API.
export const RATE_USD_PER_MIN: Record<string, number> = {
  'gpt-4o-mini-transcribe': 0.003,
  'gpt-4o-transcribe': 0.006,
  'whisper-1': 0.006,
};

export function costFor(model: string, durationS: number | null): number {
  if (!durationS || durationS <= 0) return 0;
  const rate = RATE_USD_PER_MIN[model] ?? 0.006;
  return (durationS / 60) * rate;
}

export class OpenAITranscriptionProvider implements TranscriptionProvider {
  private client: OpenAI;
  private model: string;
  constructor(opts: { apiKey: string; model: string; client?: OpenAI }) {
    this.client = opts.client ?? new OpenAI({ apiKey: opts.apiKey });
    this.model = opts.model;
  }
  async transcribe(audio: Buffer, opts: { mime: string | null; durationS: number | null; language?: string }): Promise<TranscriptionResult> {
    const file = await toFile(audio, 'audio.ogg', { type: opts.mime ?? 'audio/ogg' });
    const r: any = await this.client.audio.transcriptions.create({
      file, model: this.model, language: opts.language ?? 'pt',
    });
    return { text: typeof r?.text === 'string' ? r.text : '', model: this.model, costUsd: costFor(this.model, opts.durationS) };
  }
}

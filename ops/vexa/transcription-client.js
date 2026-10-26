import { log } from './log.js';
import { isLowConfidenceSegment } from './confidence.js';
// [PATCH BeeAds] Montado sobre /app/core/meetings/modules/whisper/dist/transcription-client.js
// (imagem vexaai/vexa-lite@sha256:216652b4…). Fonte: semente-platform-worker/ops/vexa/.
const ALWAYS_JUNK = /amara\.org|opusdei\.pt|legendas? pela comunidade/i;
/** A typed STT failure. `source` lets a consumer attribute it; `retryable` drives backoff. */
export class TranscriptionError extends Error {
    kind;
    status;
    detail;
    retryable;
    source = 'stt';
    constructor(kind, status, detail, retryable) {
        super(`stt ${kind}${status ? ` (HTTP ${status})` : ''}${detail ? `: ${detail}` : ''}`);
        this.kind = kind;
        this.status = status;
        this.detail = detail;
        this.retryable = retryable;
        this.name = 'TranscriptionError';
    }
}
/** Map an HTTP status to a typed fault (the anti-corruption translation, P5). */
function classifyHttp(status, detail) {
    if (status === 402)
        return new TranscriptionError('payment_required', status, detail, false);
    if (status === 401 || status === 403)
        return new TranscriptionError('unauthorized', status, detail, false);
    if (status === 429)
        return new TranscriptionError('rate_limited', status, detail, true);
    if (status >= 500)
        return new TranscriptionError('unavailable', status, detail, true);
    if (status >= 400)
        return new TranscriptionError('bad_request', status, detail, false);
    return new TranscriptionError('unknown', status, detail, false);
}
/**
 * HTTP client for the transcription-service.
 * Converts Float32Array audio to WAV, sends as multipart form,
 * and returns transcription results.
 */
export class TranscriptionClient {
    serviceUrl;
    apiToken;
    maxRetries;
    retryDelayMs;
    sampleRate;
    maxSpeechDurationSec;
    minSilenceDurationMs;
    constructor(config) {
        // Ensure serviceUrl ends with the transcriptions endpoint
        this.serviceUrl = config.serviceUrl.replace(/\/+$/, '');
        if (!this.serviceUrl.endsWith('/v1/audio/transcriptions')) {
            this.serviceUrl += '/v1/audio/transcriptions';
        }
        this.apiToken = config.apiToken;
        this.maxRetries = config.maxRetries ?? 3;
        this.retryDelayMs = config.retryDelayMs ?? 1000;
        this.sampleRate = config.sampleRate ?? 16000;
        this.maxSpeechDurationSec = config.maxSpeechDurationSec;
        this.minSilenceDurationMs = config.minSilenceDurationMs;
    }
    /**
     * Transcribe a Float32Array audio buffer.
     * Converts to WAV, POSTs to transcription-service, returns parsed result.
     * Retries on transient failures (503, network errors).
     */
    async transcribe(audioData, language, prompt) {
        const wavBuffer = this.float32ToWav(audioData);
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                const result = await this.sendRequest(wavBuffer, language, prompt);
                return result;
            }
            catch (err) {
                // Normalize anything non-HTTP (abort/network) into a typed fault too, so the
                // thrown value is ALWAYS a TranscriptionError the consumer can attribute (P18).
                const fault = err instanceof TranscriptionError
                    ? err
                    : new TranscriptionError(err?.name === 'AbortError' ? 'timeout' : 'unavailable', undefined, err?.message, true);
                const isLastAttempt = attempt === this.maxRetries;
                if (fault.retryable && !isLastAttempt) {
                    const delay = this.retryDelayMs * Math.pow(2, attempt);
                    log(`[TranscriptionClient] ${fault.kind} (attempt ${attempt + 1}/${this.maxRetries + 1}): ${fault.message}. Retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
                // Non-retryable (402/401/4xx) or retries exhausted → surface the typed fault.
                log(`[TranscriptionClient] transcription failed after ${attempt + 1} attempt(s): ${fault.message}`);
                throw fault;
            }
        }
        // Should never reach here, but TypeScript needs it
        throw new Error('Transcription failed: exhausted retries');
    }
    /**
     * Send the WAV buffer to the transcription-service as multipart form data.
     */
    async sendRequest(wavBuffer, language, prompt) {
        // Build multipart form data manually (no external dependency needed)
        const boundary = `----FormBoundary${Date.now().toString(36)}`;
        const parts = [];
        // File part
        parts.push(Buffer.from(`--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
            `Content-Type: audio/wav\r\n\r\n`));
        parts.push(wavBuffer);
        parts.push(Buffer.from('\r\n'));
        // Model part (required by OpenAI-compatible API)
        parts.push(Buffer.from(`--${boundary}\r\n` +
            `Content-Disposition: form-data; name="model"\r\n\r\n` +
            `whisper-1\r\n`));
        // Response format part
        parts.push(Buffer.from(`--${boundary}\r\n` +
            `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
            `verbose_json\r\n`));
        // Language part (if specified)
        if (language) {
            parts.push(Buffer.from(`--${boundary}\r\n` +
                `Content-Disposition: form-data; name="language"\r\n\r\n` +
                `${language}\r\n`));
        }
        // [PATCH BeeAds] Pede SEGMENT junto com word. Só com `word` a OpenAI não devolve
        // `segments` (nem no_speech_prob/avg_logprob), e o filtro de confiança abaixo
        // nunca rodava: toda frase que o Whisper inventa em silêncio passava.
        for (const granularity of ['segment', 'word']) {
            parts.push(Buffer.from(`--${boundary}\r\n` +
                `Content-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\n` +
                `${granularity}\r\n`));
        }
        // Max speech segment duration (controls how often Whisper splits segments)
        if (this.maxSpeechDurationSec !== undefined) {
            parts.push(Buffer.from(`--${boundary}\r\n` +
                `Content-Disposition: form-data; name="max_speech_duration_s"\r\n\r\n` +
                `${this.maxSpeechDurationSec}\r\n`));
        }
        // Min silence duration for VAD segment splitting (lower = more splits at natural pauses)
        if (this.minSilenceDurationMs !== undefined) {
            parts.push(Buffer.from(`--${boundary}\r\n` +
                `Content-Disposition: form-data; name="min_silence_duration_ms"\r\n\r\n` +
                `${this.minSilenceDurationMs}\r\n`));
        }
        // Prompt: previous confirmed text as context for streaming continuity
        if (prompt) {
            parts.push(Buffer.from(`--${boundary}\r\n` +
                `Content-Disposition: form-data; name="prompt"\r\n\r\n` +
                `${prompt}\r\n`));
        }
        // End boundary
        parts.push(Buffer.from(`--${boundary}--\r\n`));
        const body = Buffer.concat(parts);
        const headers = {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
        };
        if (this.apiToken) {
            headers['Authorization'] = `Bearer ${this.apiToken}`;
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        try {
            const response = await fetch(this.serviceUrl, {
                method: 'POST',
                headers,
                body,
                signal: controller.signal,
            });
            if (!response.ok) {
                const errorText = await response.text().catch(() => 'Unable to read error response');
                throw classifyHttp(response.status, errorText); // typed fault (P5/P18), not a bare Error
            }
            const data = await response.json();
            const allSegments = (data.segments || []).map((s) => ({
                start: s.start || 0,
                end: s.end || 0,
                text: s.text || '',
                avg_logprob: s.avg_logprob,
                no_speech_prob: s.no_speech_prob,
                compression_ratio: s.compression_ratio,
                words: s.words,
            }));
            // Drop low-confidence (hallucinated / faint-bleed) segments at the source and
            // rebuild the text from what survives, so phantoms never reach the pipeline.
            // If the model returned no segments we can't score, so keep its text as-is.
            // [PATCH BeeAds] + créditos de legenda que o Whisper inventa (nunca são fala).
            const segments = allSegments.filter((s) => !isLowConfidenceSegment(s) && !ALWAYS_JUNK.test(s.text || ''));
            const text = allSegments.length
                ? segments.map((s) => (s.text || '').trim()).filter(Boolean).join(' ')
                : (data.text || '');
            if (allSegments.length && segments.length < allSegments.length) {
                log(`[STT] dropped ${allSegments.length - segments.length}/${allSegments.length} low-confidence segment(s)`);
            }
            return {
                text,
                language: data.language || language || 'unknown',
                language_probability: data.language_probability ?? 0,
                duration: data.duration || 0,
                segments,
            };
        }
        finally {
            clearTimeout(timeoutId);
        }
    }
    /**
     * Convert Float32Array audio samples to a WAV file buffer.
     * Output: 16-bit PCM, mono, at this.sampleRate (default 16kHz).
     */
    float32ToWav(samples) {
        const numChannels = 1;
        const bitsPerSample = 16;
        const bytesPerSample = bitsPerSample / 8;
        const dataSize = samples.length * bytesPerSample;
        const headerSize = 44;
        const buffer = Buffer.alloc(headerSize + dataSize);
        // RIFF header
        buffer.write('RIFF', 0);
        buffer.writeUInt32LE(36 + dataSize, 4);
        buffer.write('WAVE', 8);
        // fmt sub-chunk
        buffer.write('fmt ', 12);
        buffer.writeUInt32LE(16, 16); // Sub-chunk size
        buffer.writeUInt16LE(1, 20); // PCM format
        buffer.writeUInt16LE(numChannels, 22); // Mono
        buffer.writeUInt32LE(this.sampleRate, 24); // Sample rate
        buffer.writeUInt32LE(this.sampleRate * numChannels * bytesPerSample, 28); // Byte rate
        buffer.writeUInt16LE(numChannels * bytesPerSample, 32); // Block align
        buffer.writeUInt16LE(bitsPerSample, 34); // Bits per sample
        // data sub-chunk
        buffer.write('data', 36);
        buffer.writeUInt32LE(dataSize, 40);
        // Convert Float32 [-1, 1] to Int16
        let offset = headerSize;
        for (let i = 0; i < samples.length; i++) {
            let sample = samples[i];
            // Clamp to [-1, 1]
            sample = Math.max(-1, Math.min(1, sample));
            // Convert to 16-bit integer
            const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            buffer.writeInt16LE(Math.round(int16), offset);
            offset += 2;
        }
        return buffer;
    }
}
//# sourceMappingURL=transcription-client.js.map
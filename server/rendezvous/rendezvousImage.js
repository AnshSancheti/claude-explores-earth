const IMAGE_API_ROOT = 'https://api.openai.com/v1';

function parseIntOr(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanPrompt(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2400);
}

function mimeForBuffer(buffer) {
  if (buffer?.[0] === 0x89 && buffer?.[1] === 0x50) return 'image/png';
  if (buffer?.[0] === 0xff && buffer?.[1] === 0xd8) return 'image/jpeg';
  return 'image/jpeg';
}

export function scaffoldDrawingPrompt(drawingPrompt) {
  const authored = cleanPrompt(drawingPrompt);
  if (!authored) throw new Error('A sender-authored drawing prompt is required');
  return `Create a handmade observational sketch on one plain, slightly warm sheet of paper. Follow the sender's visual instructions faithfully, including any symbolism or abstraction they choose. The result must look drawn by hand, with varied pencil, charcoal, crayon, or ink marks and recognizable forms rather than a route diagram or a set of bare geometric lines.

Hard constraint: the image must contain no readable words, letters, numbers, captions, labels, signatures, logos, street signs, or watermarks. If the request mentions written signage, represent it only as illegible abstract marks.

Sender's drawing instructions:
${authored}`;
}

export class RendezvousImageService {
  constructor({ fetchImpl = globalThis.fetch, logger = console } = {}) {
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.apiKey = process.env.OPENAI_API_KEY;
    this.model = process.env.RENDEZVOUS_IMAGE_MODEL || 'gpt-image-2';
    this.quality = process.env.RENDEZVOUS_IMAGE_QUALITY || 'low';
    this.size = process.env.RENDEZVOUS_IMAGE_SIZE || '1152x768';
    this.outputFormat = process.env.RENDEZVOUS_IMAGE_FORMAT || 'webp';
    this.timeoutMs = parseIntOr(process.env.RENDEZVOUS_IMAGE_TIMEOUT_MS, 150000);
    this.maxAttempts = Math.max(1, parseIntOr(process.env.RENDEZVOUS_IMAGE_ATTEMPTS, 2));
  }

  async generate({ drawingPrompt, referenceImages = [] }) {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is required for rendezvous drawings');
    const prompt = scaffoldDrawingPrompt(drawingPrompt);
    const images = Array.isArray(referenceImages) ? referenceImages.filter(Buffer.isBuffer).slice(0, 4) : [];
    let lastError = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.#request({ prompt, referenceImages: images });
      } catch (error) {
        lastError = error;
        this.logger.warn?.(`Rendezvous image attempt ${attempt}/${this.maxAttempts} failed: ${error.message}`);
        if (!error.retryable || attempt >= this.maxAttempts) break;
      }
    }
    throw lastError || new Error('Rendezvous image generation failed');
  }

  async #request({ prompt, referenceImages }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const hasReferences = referenceImages.length > 0;
      let body;
      let headers = { Authorization: `Bearer ${this.apiKey}` };
      let endpoint;
      if (hasReferences) {
        endpoint = `${IMAGE_API_ROOT}/images/edits`;
        body = new FormData();
        body.append('model', this.model);
        body.append('prompt', prompt);
        body.append('size', this.size);
        body.append('quality', this.quality);
        body.append('output_format', this.outputFormat);
        body.append('background', 'opaque');
        body.append('n', '1');
        referenceImages.forEach((buffer, index) => {
          const mime = mimeForBuffer(buffer);
          body.append('image[]', new Blob([buffer], { type: mime }), `view-${index}.${mime === 'image/png' ? 'png' : 'jpg'}`);
        });
      } else {
        endpoint = `${IMAGE_API_ROOT}/images/generations`;
        headers = { ...headers, 'Content-Type': 'application/json' };
        body = JSON.stringify({
          model: this.model,
          prompt,
          size: this.size,
          quality: this.quality,
          output_format: this.outputFormat,
          background: 'opaque',
          n: 1
        });
      }

      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload?.error?.message || `Image API returned ${response.status}`);
        error.status = response.status;
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      const encoded = payload?.data?.[0]?.b64_json;
      if (!encoded) throw new Error('Image API returned no raster data');
      return {
        buffer: Buffer.from(encoded, 'base64'),
        mimeType: `image/${this.outputFormat}`,
        model: this.model,
        requestId: response.headers.get('x-request-id') || null
      };
    } catch (error) {
      if (error?.name === 'AbortError') {
        const timeoutError = new Error(`Rendezvous image generation timed out after ${this.timeoutMs}ms`);
        timeoutError.retryable = true;
        throw timeoutError;
      }
      if (error?.retryable === undefined && error instanceof TypeError) error.retryable = true;
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

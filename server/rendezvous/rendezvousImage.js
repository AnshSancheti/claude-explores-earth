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

function cleanFeatures(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => cleanPrompt(value).slice(0, 180))
    .filter(Boolean))]
    .slice(0, 5);
}

export function scaffoldDrawingPrompt(drawingPrompt, groundedFeatures = []) {
  const authored = cleanPrompt(drawingPrompt);
  if (!authored) throw new Error('A sender-authored drawing prompt is required');
  const features = cleanFeatures(groundedFeatures);
  if (features.length < 2) throw new Error('At least two grounded visible features are required');
  return `Create a clear handmade observational sketch on one plain, slightly warm sheet of paper. Draw the stable visible features listed below and preserve their relationship to one another. Follow the sender's chosen composition and symbolism, but keep those observed features visually dominant. The message should help one friend recognize evidence from another friend's surroundings, not become a literal camera reproduction, a generic streetscape, a route-arrow diagram, or purely decorative abstraction.

The result should feel like one friend sketched what mattered for another: selective, grounded, and interpretable, with varied pencil, charcoal, crayon, or ink marks. Use natural sketching such as contour, texture, perspective, shading, and relative scale. Symbols may appear as secondary marks, but do not let arrows, paths, or abstract geometry replace the observed scene.

Hard constraint: the image must contain no readable words, letters, numbers, captions, labels, signatures, logos, street signs, or watermarks. If the request mentions written signage, represent it only as illegible abstract marks.

Visible features verified by the sender at the current branch:
${features.map(feature => `- ${feature}`).join('\n')}

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

  async generate({ drawingPrompt, groundedFeatures = [] }) {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is required for rendezvous drawings');
    const prompt = scaffoldDrawingPrompt(drawingPrompt, groundedFeatures);
    let lastError = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.#request({ prompt });
      } catch (error) {
        lastError = error;
        this.logger.warn?.(`Rendezvous image attempt ${attempt}/${this.maxAttempts} failed: ${error.message}`);
        if (!error.retryable || attempt >= this.maxAttempts) break;
      }
    }
    throw lastError || new Error('Rendezvous image generation failed');
  }

  async #request({ prompt }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const endpoint = `${IMAGE_API_ROOT}/images/generations`;
      const headers = {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      };
      const body = JSON.stringify({
        model: this.model,
        prompt,
        size: this.size,
        quality: this.quality,
        output_format: this.outputFormat,
        background: 'opaque',
        n: 1
      });

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

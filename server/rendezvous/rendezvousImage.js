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

export function scaffoldDrawingPrompt(
  drawingPrompt,
  groundedFeatures = [],
  { hasReferenceImage = false } = {}
) {
  const authored = cleanPrompt(drawingPrompt);
  if (!authored) throw new Error('A sender-authored drawing prompt is required');
  const features = cleanFeatures(groundedFeatures);
  return `Create one clear handmade drawing on a plain, slightly warm sheet of paper. This is a private wordless message passed between two friends trying to find each other. Follow the sender's composition and communicative choices faithfully.

The result should feel intentionally drawn by a person using pencil, charcoal, crayon, or ink, with coherent composition and legible visual relationships. It may be observational, symbolic, diagrammatic, map-like, figurative, or abstract when the sender asks. Arrows, paths, motion, repeated motifs, uncertainty, and spatial relationships are allowed. Do not turn it into a literal Street View reproduction unless the sender explicitly makes that choice.

Hard constraint: the image must contain no readable words, letters, numbers, captions, labels, signatures, logos, street signs, or watermarks. If the request mentions written signage, represent it only as illegible abstract marks.

Visual anchors available to the sender:
${features.length > 0 ? features.map(feature => `- ${feature}`).join('\n') : '- None specified; follow the authored visual message.'}

${hasReferenceImage
    ? `A private source photograph is attached only to ground the visual anchors above. Use its real shapes, counts, materials, proportions, and spatial relationships when depicting those anchors. Do not copy the photograph as a scene, reproduce camera artifacts or interface overlays, or add details merely because they appear in the photograph. Transform the sender's chosen evidence into the authored handmade message, and do not replace a real object's geometry with a generic decorative version.`
    : ''}

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
  }

  async generate({ drawingPrompt, groundedFeatures = [], referenceImage = null }) {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is required for rendezvous drawings');
    const usableReference = Buffer.isBuffer(referenceImage?.buffer) &&
      referenceImage.buffer.length > 0
      ? referenceImage
      : null;
    const prompt = scaffoldDrawingPrompt(drawingPrompt, groundedFeatures, {
      hasReferenceImage: Boolean(usableReference)
    });
    return this.#request({ prompt, referenceImage: usableReference });
  }

  async #request({ prompt, referenceImage = null }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const endpoint = referenceImage
        ? `${IMAGE_API_ROOT}/images/edits`
        : `${IMAGE_API_ROOT}/images/generations`;
      const headers = { Authorization: `Bearer ${this.apiKey}` };
      let body;
      if (referenceImage) {
        body = new FormData();
        body.append('model', this.model);
        body.append('prompt', prompt);
        body.append('size', this.size);
        body.append('quality', this.quality);
        body.append('output_format', this.outputFormat);
        body.append('background', 'opaque');
        body.append('n', '1');
        body.append(
          'image[]',
          new Blob([referenceImage.buffer], {
            type: referenceImage.mimeType || 'image/jpeg'
          }),
          'branch-reference.jpg'
        );
      } else {
        headers['Content-Type'] = 'application/json';
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

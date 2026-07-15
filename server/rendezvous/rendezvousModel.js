import OpenAI from 'openai';

function parseIntOr(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJsonContent(rawContent) {
  const text = typeof rawContent === 'string' ? rawContent.trim() : '';
  if (!text) throw new Error('Rendezvous model returned blank content');
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1].trim());
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(text.slice(first, last + 1));
    throw new Error(`Invalid rendezvous model JSON: ${text.slice(0, 240)}`);
  }
}

function normalizeHeading(value) {
  if (value === null || value === undefined || value === '') return null;
  const heading = Number(value);
  return Number.isFinite(heading) ? ((heading % 360) + 360) % 360 : null;
}

function headingDelta(a, b) {
  const first = normalizeHeading(a);
  const second = normalizeHeading(b);
  if (first === null || second === null) return Infinity;
  const delta = Math.abs(first - second);
  return Math.min(delta, 360 - delta);
}

function compassDirection(heading) {
  const directions = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  return directions[Math.round((normalizeHeading(heading) || 0) / 45) % directions.length];
}

function cleanString(value, maxLength) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

export function sanitizeRendezvousDecision(raw, options) {
  const optionCount = Array.isArray(options) ? options.length : 0;
  let selectedIndex = Number.isInteger(Number(raw?.selectedIndex)) ? Number(raw.selectedIndex) : 0;
  selectedIndex = Math.min(Math.max(selectedIndex, 0), Math.max(0, optionCount - 1));
  const intendedHeading = normalizeHeading(raw?.intendedHeading);
  if (intendedHeading !== null && optionCount > 1) {
    const selectedDelta = headingDelta(options[selectedIndex]?.heading, intendedHeading);
    const matches = options
      .map((option, index) => ({ index, delta: headingDelta(option?.heading, intendedHeading) }))
      .filter(item => item.delta <= 12)
      .sort((a, b) => a.delta - b.delta || a.index - b.index);
    if (selectedDelta > 12 && matches.length === 1) selectedIndex = matches[0].index;
  }
  const referenceViewIndices = Array.isArray(raw?.referenceViewIndices)
    ? [...new Set(raw.referenceViewIndices.map(Number).filter(index => Number.isInteger(index) && index >= 0 && index < optionCount))].slice(0, 4)
    : [];
  return {
    selectedIndex,
    intendedHeading,
    reasoning: cleanString(raw?.reasoning, 700) || 'I choose the most promising unfamiliar public route.',
    drawingPrompt: cleanString(raw?.drawingPrompt, 2400),
    referenceViewIndices
  };
}

function fallbackDecision(options, visitedPanos, cause) {
  const unvisitedIndex = options.findIndex(option => !visitedPanos.includes(option.panoId));
  return {
    selectedIndex: unvisitedIndex >= 0 ? unvisitedIndex : 0,
    intendedHeading: null,
    reasoning: 'I choose the least familiar public way forward and keep searching.',
    drawingPrompt: '',
    referenceViewIndices: [],
    fallbackCause: cause
  };
}

export class RendezvousModelService {
  constructor({ client = null, logger = console } = {}) {
    this.logger = logger;
    this.model = process.env.RENDEZVOUS_MODEL || 'gpt-5-nano';
    this.maxTokens = parseIntOr(process.env.RENDEZVOUS_MODEL_MAX_TOKENS, 2400);
    this.maxRetryTokens = Math.max(this.maxTokens, parseIntOr(process.env.RENDEZVOUS_MODEL_MAX_RETRY_TOKENS, 4800));
    this.reasoningEffort = process.env.RENDEZVOUS_MODEL_REASONING_EFFORT || 'low';
    this.maxAttempts = Math.max(1, parseIntOr(process.env.RENDEZVOUS_MODEL_ATTEMPTS, 2));
    this.client = client;
  }

  #client() {
    if (!this.client) {
      this.client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        timeout: parseIntOr(process.env.OPENAI_TIMEOUT_MS, 45000),
        maxRetries: parseIntOr(process.env.OPENAI_MAX_RETRIES, 1)
      });
    }
    return this.client;
  }

  async decide({ agent, partnerName, options, screenshots, scratchpadBuffer, scratchpadMimeType = 'image/webp' }) {
    if (!Array.isArray(options) || options.length < 2) {
      throw new Error('Rendezvous model is only called at a genuine route branch');
    }
    const optionLines = options.map((option, index) => {
      const visited = agent.visitedPanos?.includes(option.panoId) ? 'walked before' : 'unfamiliar';
      const label = option.label ? `; visible Street View route label: ${cleanString(option.label, 160)}` : '';
      const heading = Math.round(Number(option.heading) || 0);
      return `Option ${index}: heading ${heading} degrees (${compassDirection(heading)}); ${visited}${label}`;
    }).join('\n');
    const privateMemory = (agent.recentNotes || [])
      .filter(note => !/model (?:is|was) unavailable/i.test(note))
      .slice(-5)
      .map(note => `- ${cleanString(note, 300)}`)
      .join('\n') || '- No prior field notes.';

    const systemPrompt = `You are ${agent.name}, one of two friends lost on different Manhattan street corners. Your sole goal is to physically find ${partnerName}.

You can see your own Street View routes and one physical sheet last sent by your friend. That sheet image is the only information that crosses between you. You never receive ${partnerName}'s coordinates, path, distance, neighborhood, reasoning, prompt, transcript, or hidden state. Infer what you can from the image itself.

You are now at a real branching point. Choose one visible public route. Avoid indoor shops, private interiors, dead ends, and immediate loops. Google headings are compass bearings clockwise from north.

Because you currently hold the sheet, you must also decide what picture to send to ${partnerName}. Author a free-form prompt for an image model. You control what the picture communicates: it may be observational, symbolic, spatial, literal, abstract, or use a visual convention that you develop together. The experiment is meant to reveal your own communication strategy, so do not merely fill a template. You may ask the image model to draw from any subset of the route images by listing their option indices as referenceViewIndices.

The resulting picture must contain no readable text, letters, numbers, labels, captions, signatures, logos, or watermarks. Express everything visually. Do not put those prohibitions into drawingPrompt; simply describe the picture you want.

Return only JSON:
{
  "selectedIndex": <0-${options.length - 1}>,
  "intendedHeading": <the numeric heading you intend, or null>,
  "reasoning": "one concise first-person field note",
  "drawingPrompt": "your complete instructions to the image model",
  "referenceViewIndices": [<zero or more option indices>]
}`;

    const userContent = [
      {
        type: 'text',
        text: `Image 1 is the physical sheet exactly as you received it. The remaining images are your current route options 0 through ${options.length - 1}.\n\n${optionLines}\n\nYour private memory, unavailable to ${partnerName}:\n${privateMemory}`
      },
      {
        type: 'image_url',
        image_url: { url: `data:${scratchpadMimeType};base64,${scratchpadBuffer.toString('base64')}`, detail: 'high' }
      },
      ...screenshots.map(buffer => ({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${buffer.toString('base64')}`, detail: 'low' }
      }))
    ];

    let lastError = null;
    let tokenBudget = this.maxTokens;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.#client().chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
          ],
          response_format: { type: 'json_object' },
          reasoning_effort: this.reasoningEffort,
          max_completion_tokens: tokenBudget
        });
        const content = response?.choices?.[0]?.message?.content;
        const parsed = parseJsonContent(content);
        const decision = sanitizeRendezvousDecision(parsed, options);
        if (!decision.drawingPrompt) throw new Error('Rendezvous model omitted its drawing prompt');
        return decision;
      } catch (error) {
        lastError = error;
        this.logger.warn?.(`Rendezvous model attempt ${attempt}/${this.maxAttempts} failed: ${error.message}`);
        if (/blank content|drawing prompt/i.test(error.message)) {
          tokenBudget = Math.min(this.maxRetryTokens, Math.max(tokenBudget * 2, 3200));
        }
      }
    }

    const status = lastError?.status ?? lastError?.response?.status;
    return fallbackDecision(
      options,
      agent.visitedPanos || [],
      status ? `api_error_${status}` : 'model_error'
    );
  }
}

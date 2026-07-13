import OpenAI from 'openai';
import { SCRATCHPAD_MAX_OPS_PER_TURN } from './scratchpad.js';

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

function fallbackDecision(options, visitedPanos, cause, { canEditPad = false, forcePass = false } = {}) {
  const unvisitedIndex = options.findIndex(option => !visitedPanos.includes(option.panoId));
  const selectedIndex = unvisitedIndex >= 0 ? unvisitedIndex : 0;
  return {
    selectedIndex,
    reasoning: 'I take the least familiar public way forward and keep the search moving.',
    padOperations: [],
    passPad: canEditPad && forcePass,
    fallbackCause: cause
  };
}

function sanitizeDecision(raw, optionCount, { canEditPad, forcePass }) {
  const parsedIndex = parseInt(raw?.selectedIndex, 10);
  const selectedIndex = Number.isFinite(parsedIndex) && parsedIndex >= 0 && parsedIndex < optionCount
    ? parsedIndex
    : 0;
  const reasoning = typeof raw?.reasoning === 'string' && raw.reasoning.trim()
    ? raw.reasoning.trim().slice(0, 420)
    : 'I am testing the most legible public route and keeping my bearings.';

  return {
    selectedIndex,
    reasoning,
    padOperations: canEditPad && Array.isArray(raw?.padOperations)
      ? raw.padOperations.slice(0, SCRATCHPAD_MAX_OPS_PER_TURN)
      : [],
    passPad: canEditPad && (forcePass || raw?.passPad === true),
    fallbackCause: null
  };
}

export class RendezvousModelService {
  constructor({ client = null, logger = console } = {}) {
    this.logger = logger;
    this.model = process.env.RENDEZVOUS_MODEL || 'gpt-5-nano';
    this.maxTokens = parseIntOr(process.env.RENDEZVOUS_MODEL_MAX_TOKENS, 2400);
    this.maxRetryTokens = Math.max(
      this.maxTokens,
      parseIntOr(process.env.RENDEZVOUS_MODEL_MAX_RETRY_TOKENS, 4800)
    );
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

  async decide({
    agent,
    partnerName,
    options,
    screenshots,
    scratchpadBuffer,
    canEditPad,
    padStatus,
    forcePass = false
  }) {
    if (!Array.isArray(options) || options.length === 0) {
      throw new Error('Rendezvous model requires at least one movement option');
    }

    const optionLines = options.map((option, index) => {
      const visited = agent.visitedPanos?.includes(option.panoId) ? 'walked before' : 'unfamiliar';
      const label = option.label ? `; Street View label: ${option.label}` : '';
      return `Option ${index}: heading ${Math.round(Number(option.heading) || 0)} degrees; ${visited}${label}`;
    }).join('\n');
    const privateMemory = (agent.recentNotes || [])
      .filter(note => !/model (?:is|was) unavailable/i.test(note))
      .slice(-5)
      .map(note => `- ${note}`)
      .join('\n') || '- No prior field notes.';
    const padInstruction = canEditPad
      ? `You have the physical scratchpad. You may add up to ${SCRATCHPAD_MAX_OPS_PER_TURN} drawing operations. ${forcePass ? `You have held it long enough and must pass it to ${partnerName} this turn.` : `Set passPad=true when the marks are useful enough to send to ${partnerName}.`}`
      : `You do not have the physical scratchpad right now (${padStatus}). You may remember the last version you saw, but padOperations must be empty and passPad must be false.`;

    const systemPrompt = `You are ${agent.name}, one of two friends lost on different Manhattan street corners. Your only goal is to physically find ${partnerName}. You can walk through Google Street View and sometimes hold one shared paper scratchpad.

This is a real cooperative search, not a riddle-writing exercise. The scratchpad is the only information that ever crosses between you. You are never given ${partnerName}'s coordinates, path, distance, neighborhood, plans, or hidden state. Do not invent access to them. Street names and landmarks you can genuinely read or recognize are fair to write down.

Choose one visible public route. Avoid indoor shops, private interiors, dead ends, and immediate loops. Use your own observations, your private memory, and the last scratchpad you personally saw.

Treat this as a practical search between friends. When you can read your street or intersection, put that concrete clue on the sheet. Interpret your friend's marks as actionable geography: move toward a location they identify, or clearly mark where you are headed so they can intercept you. A concrete place your friend marked outranks generic exploration and your own older plan. Do not merely repeat a strategy such as "unfamiliar route." Prefer a stable street name, intersection, landmark, or directional sketch that helps the two of you converge.

Google headings are compass bearings measured clockwise: 0° is north, 90° east, 180° south, and 270° west. Never describe a bearing with the wrong compass direction. Before choosing, identify the newest useful place your friend marked, infer its direction from your own visible street using Manhattan geography, then choose the route whose numeric bearing best matches that direction. Only prioritize novelty when the sheet contains no actionable friend location.

${padInstruction}

Drawing operation grammar uses normalized 0-1 canvas coordinates:
- {"type":"text","text":"BROADWAY?","at":{"x":0.12,"y":0.18},"size":30,"rotation":-3}
- {"type":"arrow","from":{"x":0.2,"y":0.5},"to":{"x":0.7,"y":0.5},"width":4}
- {"type":"line","from":...,"to":...,"width":4}
- {"type":"circle","center":{"x":0.5,"y":0.5},"radiusX":0.12,"radiusY":0.08,"width":4}
- {"type":"stroke","points":[{"x":0.1,"y":0.2},{"x":0.2,"y":0.3}],"width":4}
- {"type":"erase","from":...,"to":...,"width":28}

The sheet is finite. Prefer a small, expressive update over filling it with prose. You may cross out, annotate, or reinterpret older marks.

Return only JSON:
{
  "selectedIndex": <0-${options.length - 1}>,
  "reasoning": "one concise first-person field note grounded in what is visible and what the pad suggests",
  "padOperations": [],
  "passPad": false
}`;

    const userContent = [
      {
        type: 'text',
        text: `These are the routes visible from your current panorama. Image 1 is the last scratchpad version you personally saw; the remaining images correspond to options 0 through ${options.length - 1} in order.\n\n${optionLines}\n\nYour private field memory:\n${privateMemory}\n\nScratchpad status: ${padStatus}`
      },
      {
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${scratchpadBuffer.toString('base64')}`,
          detail: 'low'
        }
      },
      ...screenshots.map(buffer => ({
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${buffer.toString('base64')}`,
          detail: 'low'
        }
      }))
    ];

    let lastError = null;
    let attemptMaxTokens = this.maxTokens;
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
          max_completion_tokens: attemptMaxTokens
        });
        const choice = response?.choices?.[0];
        const content = choice?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
          const completionTokens = response?.usage?.completion_tokens;
          const detail = [
            choice?.finish_reason ? `finish=${choice.finish_reason}` : null,
            Number.isFinite(completionTokens) ? `completion_tokens=${completionTokens}` : null,
            `budget=${attemptMaxTokens}`
          ].filter(Boolean).join(', ');
          throw new Error(`Rendezvous model returned blank content (${detail})`);
        }
        const raw = parseJsonContent(content);
        return sanitizeDecision(raw, options.length, { canEditPad, forcePass });
      } catch (error) {
        lastError = error;
        this.logger.warn?.(`Rendezvous model attempt ${attempt}/${this.maxAttempts} failed: ${error.message}`);
        if (/blank content/i.test(error?.message || '')) {
          attemptMaxTokens = Math.min(this.maxRetryTokens, Math.max(attemptMaxTokens * 2, 3200));
        }
      }
    }

    const status = lastError?.status ?? lastError?.response?.status;
    return fallbackDecision(
      options,
      agent.visitedPanos || [],
      status ? `api_error_${status}` : 'model_error',
      { canEditPad, forcePass }
    );
  }
}

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

const NAMED_ROUTE_PATTERN = /\b(?:[A-Z][A-Za-z'-]*|[EWNS]|\d+(?:st|nd|rd|th)?)(?:\s+(?:[A-Z0-9][A-Za-z0-9'-]*)){0,3}\s+(?:St(?:reet)?|Ave(?:nue)?|Rd|Road|Blvd|Boulevard|Pl|Place|Park|Plaza|Square)\b/;
const NAMED_GEOGRAPHY_PATTERN = /\b(?:Manhattan|Brooklyn|Bronx|Queens|Staten Island|New York|NYC|Yonkers)\b/i;
const SHARED_DIRECTION_PATTERN = /\b(?:north|south|east|west|northeast|northwest|southeast|southwest|northbound|southbound|eastbound|westbound)\b/i;

export function containsUnsupportedSheetGeography(value) {
  const text = String(value || '');
  return NAMED_ROUTE_PATTERN.test(text) || NAMED_GEOGRAPHY_PATTERN.test(text) || SHARED_DIRECTION_PATTERN.test(text);
}

function cleanStringList(values, { limit = 5, maxLength = 180 } = {}) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => cleanString(value, maxLength))
    .filter(Boolean))]
    .slice(0, limit);
}

function cleanBeliefUpdate(raw) {
  const numericConfidence = Number(raw?.confidence);
  return {
    key: cleanString(raw?.key, 80),
    description: cleanString(raw?.description, 500),
    confidence: Number.isFinite(numericConfidence) ? Math.min(1, Math.max(0, numericConfidence)) : 0,
    basisSequences: [...new Set((Array.isArray(raw?.basisSequences) ? raw.basisSequences : [])
      .map(value => Math.floor(Number(value)))
      .filter(value => Number.isFinite(value) && value > 0))]
      .slice(-8)
  };
}

export function sanitizeRendezvousDecision(raw, options, { allowWait = true } = {}) {
  const optionCount = Array.isArray(options) ? options.length : 0;
  const requestedAction = cleanString(raw?.action, 20).toLowerCase();
  const allowedActions = allowWait ? ['move', 'retrace', 'wait'] : ['move', 'retrace'];
  const action = allowedActions.includes(requestedAction) ? requestedAction : 'move';
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
  const numericSheetConfidence = Number(raw?.sheetConfidence);
  return {
    action,
    selectedIndex,
    intendedHeading,
    waitTurns: action === 'wait' ? Math.min(6, Math.max(1, Math.floor(Number(raw?.waitTurns) || 1))) : 0,
    reasoning: cleanString(raw?.reasoning, 700) || 'I choose the most promising unfamiliar public route.',
    observation: cleanString(raw?.observation, 700),
    observedFeatures: cleanStringList(raw?.observedFeatures),
    sheetInterpretation: cleanString(raw?.sheetInterpretation, 700),
    sheetConfidence: Number.isFinite(numericSheetConfidence)
      ? Math.min(1, Math.max(0, numericSheetConfidence))
      : 0.35,
    drawingIntent: cleanString(raw?.drawingIntent, 700),
    drawingPrompt: cleanString(raw?.drawingPrompt, 2400),
    memoryUpdate: {
      currentPlan: cleanString(raw?.memoryUpdate?.currentPlan, 500),
      conventionUpdate: cleanBeliefUpdate(raw?.memoryUpdate?.conventionUpdate),
      partnerHypothesis: cleanBeliefUpdate(raw?.memoryUpdate?.partnerHypothesis)
    }
  };
}

function fallbackDecision(options, visitedPanos, cause) {
  const unvisitedIndex = options.findIndex(option => !visitedPanos.includes(option.panoId));
  return {
    action: 'move',
    selectedIndex: unvisitedIndex >= 0 ? unvisitedIndex : 0,
    intendedHeading: null,
    waitTurns: 0,
    reasoning: 'I choose the least familiar public way forward and keep searching.',
    observation: '',
    observedFeatures: [],
    sheetInterpretation: '',
    sheetConfidence: 0,
    drawingIntent: '',
    drawingPrompt: '',
    memoryUpdate: {},
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

  async decide({
    agent,
    partnerName,
    options,
    screenshots,
    scratchpadBuffer,
    scratchpadMimeType = 'image/webp',
    sheetMessage = null,
    visualHistory = [],
    privateMemory = null,
    movementSinceDecision = null,
    allowWait = true,
    consecutiveWaitDecisions = 0
  }) {
    if (!Array.isArray(options) || options.length < 2) {
      throw new Error('Rendezvous model is only called at a genuine route branch');
    }
    const optionLines = options.map((option, index) => {
      const visited = option.visited || agent.visitedPanos?.includes(option.panoId) ? 'walked before; available for retracing' : 'unfamiliar';
      const label = option.label ? `; visible Street View route label: ${cleanString(option.label, 160)}` : '';
      const heading = Math.round(Number(option.heading) || 0);
      return `Option ${index}: heading ${heading} degrees (${compassDirection(heading)}); ${visited}${label}`;
    }).join('\n');
    const recentFieldNotes = (agent.recentNotes || [])
      .filter(note => !/model (?:is|was) unavailable/i.test(note))
      .slice(-5)
      .map(note => `- ${cleanString(note, 300)}`)
      .join('\n') || '- No prior field notes.';

    const actionGuidance = allowWait
      ? `- move: continue through a promising unfamiliar public route;
- retrace: deliberately choose an option marked walked before when returning toward a remembered place supports the joint plan;
- wait: remain here for 1 to 6 of your own turns when anchoring your position is more useful than continued motion.`
      : `- move: continue through a promising unfamiliar public route;
- retrace: deliberately choose an option marked walked before when returning toward a remembered place supports the joint plan.

You have already chosen to remain at this same branch ${Math.max(1, Math.floor(Number(consecutiveWaitDecisions) || 0))} consecutive times without gaining a new local observation. Your friend may also be waiting. Remaining here again is not available at this decision; choose move or retrace and communicate that choice visually.`;
    const actionSchema = allowWait ? '"move" | "retrace" | "wait"' : '"move" | "retrace"';

    const systemPrompt = `You are ${agent.name}, one of two friends trying to meet after becoming separated on unfamiliar streets. You both began in Manhattan, but the world is open and either of you may have traveled far beyond your starting area. ${partnerName} is not a passive target: your friend is also moving, interpreting your drawings, and actively trying to meet you. You are building a shared strategy together.

You can see your own Street View routes and one physical sheet last sent by your friend. That sheet image is the only information that crosses between you. You never receive ${partnerName}'s coordinates, path, distance, neighborhood, reasoning, prompt, transcript, or hidden state. Infer what you can from the image itself.

You have no global map or privileged geographic knowledge. Your private memory below is an evidence ledger built only from streets you walked and sheets you previously saw. Every belief has provenance and limited confidence. Fresh visible evidence outranks an old plan. A repeated guess is not confirmation; revise or abandon it when observations disagree.

You are now at a real branching point. Choose a cooperative action:
${actionGuidance}
Avoid indoor shops, private interiors, dead ends, and accidental immediate loops. Google headings are compass bearings clockwise from north.

Because you currently hold the sheet, decide what visual message to send to ${partnerName}. The drawing is evidence about the world around its sender, not a command that maps onto the recipient's private route options. Base it on at least two stable features visible in the current route images, including at least one discriminative feature when one is available, and preserve their spatial relationship. Examples include unusual facade geometry, a distinctive awning arrangement, scaffolding structure, road geometry, trees relative to buildings, towers, stairs, traffic lights, sculpture, or uncommon street furniture. Symbols may support the observation, but they must not dominate it. Do not encode private option numbers, an imagined compass agreement, or a place name. Reuse a visual convention only when the evidence ledger shows actual prior sheet sequences supporting it.

Street names and geographic labels visible in your route-option images are private local navigation evidence for you alone. The no-text sheet cannot transmit them. Never put a named street, avenue, park, square, neighborhood, borough, city, compass heading, or option label into observedFeatures, drawingIntent, drawingPrompt, sheetInterpretation, conventionUpdate, or partnerHypothesis. You may mention a visible local label only in your private observation, reasoning, or currentPlan.

The resulting picture must contain no readable text, letters, numbers, labels, captions, signatures, logos, or watermarks. Express everything visually. Do not put those prohibitions into drawingPrompt; simply describe the picture you want.

Interpret the received sheet explicitly and state your confidence. Describe only sender-side visual evidence actually present in the drawing. Any street label in your current route images belongs to your surroundings, not the sender's. Similar generic features such as trees, parked cars, or scaffolding are weak evidence; do not infer that you share a block or route unless multiple unusual features and their arrangement recur across reciprocal sheets. Update only the current plan and at most one sourced visual convention and partner hypothesis. basisSequences must list real prior sent or received sheet sequence numbers from your evidence ledger. Unsupported beliefs will remain low confidence. drawingIntent is your private record of what the outgoing picture is meant to communicate; only drawingPrompt and the grounded visible features are sent to the image renderer.

Return only JSON:
{
  "action": ${actionSchema},
  "selectedIndex": <0-${options.length - 1}>,
  "intendedHeading": <the numeric heading you intend, or null>,
  "waitTurns": <1-6 when action is wait, otherwise 0>,
  "reasoning": "one concise first-person field note",
  "observation": "a grounded description of what you currently notice and want to remember",
  "observedFeatures": ["stable visible feature one", "stable visible feature two"],
  "sheetInterpretation": "what you think the current drawing from your friend means, including uncertainty",
  "sheetConfidence": <0.0-1.0>,
  "memoryUpdate": {
    "currentPlan": "your current cooperative next strategy, revised by fresh evidence",
    "conventionUpdate": {"key": "short-stable-key", "description": "a visual convention hypothesis", "confidence": <0.0-1.0>, "basisSequences": [<real sequence numbers>]},
    "partnerHypothesis": {"key": "short-stable-key", "description": "a hypothesis about your friend's situation", "confidence": <0.0-1.0>, "basisSequences": [<real sequence numbers>]}
  },
  "drawingIntent": "what you want your friend to learn from the next drawing",
  "drawingPrompt": "complete instructions for an observational sketch that visually encodes that intent without text"
}`;

    const history = (Array.isArray(visualHistory) ? visualHistory : []).slice(-4);
    const historyLines = history.length > 0
      ? history.map((item, index) =>
          `History image ${index + 1}: sheet sequence ${item.sequence}; ${item.direction === 'sent' ? 'you sent it' : 'you received it'}.`
        ).join('\n')
      : 'No earlier sheet images are available.';

    const userContent = [
      {
        type: 'text',
        text: `Image 1 is the physical sheet exactly as you received it. Next come ${history.length} earlier sheet images in chronological order, followed by your current route images for options 0 through ${options.length - 1}.

Visual history:
${historyLines}

Current sheet metadata: ${sheetMessage ? `sequence ${sheetMessage.sequence}, sent by ${sheetMessage.from}` : 'blank first sheet'}

${optionLines}

Your persistent private memory, unavailable to ${partnerName}:
${JSON.stringify(privateMemory || {}, null, 2)}

Your own movement since your last successful branch decision:
${JSON.stringify(movementSinceDecision || {}, null, 2)}

Recent private field notes:
${recentFieldNotes}`
      },
      {
        type: 'image_url',
        image_url: { url: `data:${scratchpadMimeType};base64,${scratchpadBuffer.toString('base64')}`, detail: 'high' }
      },
      ...history.map(item => ({
        type: 'image_url',
        image_url: { url: `data:${item.mimeType || 'image/webp'};base64,${item.buffer.toString('base64')}`, detail: 'low' }
      })),
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
        if (!allowWait && cleanString(parsed?.action, 20).toLowerCase() === 'wait') {
          throw new Error('Rendezvous model chose waiting after local patience expired');
        }
        const decision = sanitizeRendezvousDecision(parsed, options, { allowWait });
        if (!decision.drawingPrompt) throw new Error('Rendezvous model omitted its drawing prompt');
        if (!decision.drawingIntent) throw new Error('Rendezvous model omitted its private drawing intent');
        if (decision.observedFeatures.length < 2) throw new Error('Rendezvous model omitted two grounded visible features');
        if (!decision.memoryUpdate.currentPlan) {
          throw new Error('Rendezvous model omitted its private memory revision');
        }
        const unsupportedGeography = [
          ...decision.observedFeatures,
          decision.sheetInterpretation,
          decision.drawingIntent,
          decision.drawingPrompt,
          decision.memoryUpdate.conventionUpdate.description,
          decision.memoryUpdate.partnerHypothesis.description
        ].find(containsUnsupportedSheetGeography);
        if (unsupportedGeography) {
          throw new Error(`Rendezvous model put unsupported named geography into the visual channel: ${unsupportedGeography.slice(0, 120)}`);
        }
        return decision;
      } catch (error) {
        lastError = error;
        this.logger.warn?.(`Rendezvous model attempt ${attempt}/${this.maxAttempts} failed: ${error.message}`);
        if (/blank content|drawing prompt|drawing intent|memory revision|named geography|json/i.test(error.message)) {
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

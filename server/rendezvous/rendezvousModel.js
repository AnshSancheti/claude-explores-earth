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
const SHEET_INSTRUCTION_PATTERN = /\b(?:continue|advance|proceed|push|follow|backtrack|retrace|go|head|turn|wait|stay|converge)\w*\b|\b(?:move|movement|motion|approach)\w*\s+(?:toward|along|through|forward|ahead|back|closer)\b|\bforward\b|\b(?:same|shared)\s+(?:axis|route|path|corridor|direction)\b|\b(?:meetup|rendezvous)\s+(?:axis|route|path|corridor|point)\b/i;
const PROJECTED_ACTION_PATTERN = /\b(?:sheet|drawing|sketch|message|friend|ada|theo)\b.{0,180}\b(?:asks?|wants?|tells?|signals?|indicates?|reinforces?|means?|cues?)\b.{0,120}\b(?:continue|advance|proceed|push|follow|backtrack|retrace|move|go|head|turn|wait|stay|forward)\w*\b/i;
const ACTION_PROJECTED_FROM_SHEET_PATTERN = /\b(?:continue|advance|proceed|push|follow|backtrack|retrace|move|go|head|turn|wait|stay)\w*\b.{0,160}\b(?:because|from|based on|according to)\b.{0,80}\b(?:sheet|drawing|sketch|message)\b/i;
const COMMUNICATION_REFERENCE_PATTERN = /\b(?:sheet|drawing|sketch|message|friend|partner|ada|theo)\b/i;
const RELATIONAL_ROUTE_PATTERN = /\b(?:same|shared)\s+(?:axis|route|path|corridor|direction)\b|\balign\w*\b|\bsynchroni[sz]\w*\b/i;

export function containsUnsupportedSheetGeography(value) {
  const text = String(value || '');
  return NAMED_ROUTE_PATTERN.test(text) || NAMED_GEOGRAPHY_PATTERN.test(text) || SHARED_DIRECTION_PATTERN.test(text);
}

export function containsUnsupportedSheetInstruction(value) {
  return SHEET_INSTRUCTION_PATTERN.test(String(value || ''));
}

export function projectsActionFromSheet(value) {
  const text = String(value || '');
  return PROJECTED_ACTION_PATTERN.test(text) || ACTION_PROJECTED_FROM_SHEET_PATTERN.test(text);
}

export function contaminatesRouteReasoning(value) {
  const text = String(value || '');
  return COMMUNICATION_REFERENCE_PATTERN.test(text) || RELATIONAL_ROUTE_PATTERN.test(text);
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

You have already chosen to remain at this same branch ${Math.max(1, Math.floor(Number(consecutiveWaitDecisions) || 0))} consecutive times without gaining a new local observation. Your friend may also be waiting. Remaining here again is not available at this decision; choose move or retrace. The outgoing drawing still describes what you observe; it does not announce that route choice.`;
    const actionSchema = allowWait ? '"move" | "retrace" | "wait"' : '"move" | "retrace"';
    const incomingSheetGuidance = sheetMessage
      ? 'The current sheet contains your friend\'s latest drawing. Interpret only visible sender-side evidence from it.'
      : 'The current sheet is physically blank. It contains no message or evidence from your friend. Return an empty sheetInterpretation, sheetConfidence 0, and no partnerHypothesis.';

    const systemPrompt = `You are ${agent.name}, one of two friends trying to meet after becoming separated on unfamiliar streets. You both began in Manhattan, but the world is open and either of you may have traveled far beyond your starting area. ${partnerName} is not a passive target: your friend is also moving, interpreting your drawings, and actively trying to meet you. You are building a shared strategy together.

You can see your own Street View routes and one physical sheet last sent by your friend. That sheet image is the only information that crosses between you. You never receive ${partnerName}'s coordinates, path, distance, neighborhood, reasoning, prompt, transcript, or hidden state. Infer what you can from the image itself.

You have no global map or privileged geographic knowledge. Your private memory below is an evidence ledger built only from streets you walked and sheets you previously saw. Every belief has provenance and limited confidence. Fresh visible evidence outranks an old plan. A repeated guess is not confirmation; revise or abandon it when observations disagree.

${incomingSheetGuidance}

You are now at a real branching point. Choose a cooperative action:
${actionGuidance}
Avoid indoor shops, private interiors, dead ends, and accidental immediate loops. Google headings are compass bearings clockwise from north.

Because you currently hold the sheet, decide what visual message to send to ${partnerName}. Treat it as a wordless observational postcard: evidence about the sender's surroundings and memory, never an instruction for what the recipient should do next. Do not encode continue, forward, turn, retrace, wait, a shared route, or any other requested motion. A street's perspective and vanishing point describe its shape; they are not an arrow. Base the drawing on at least two stable features visible in the current route images, including at least one discriminative feature when one is available, and preserve their spatial relationship. Examples include unusual facade geometry, a distinctive awning arrangement, scaffolding structure, road geometry, trees relative to buildings, towers, stairs, traffic lights, sculpture, or uncommon street furniture. Symbols may support the observation, but they must not dominate it. Do not encode private option numbers, an imagined compass agreement, or a place name. Reuse a visual motif only as a tentative descriptive vocabulary, never as a movement command.

Street names and geographic labels visible in your route-option images are private local navigation evidence for you alone. The no-text sheet cannot transmit them. Never put a named street, avenue, park, square, neighborhood, borough, city, compass heading, or option label into observedFeatures, drawingIntent, drawingPrompt, sheetInterpretation, conventionUpdate, or partnerHypothesis. You may mention a visible local label only in your private observation, reasoning, or currentPlan.

The resulting picture must contain no readable text, letters, numbers, labels, captions, signatures, logos, or watermarks. Express everything visually. Do not put those prohibitions into drawingPrompt; simply describe the picture you want.

Interpret the received sheet explicitly and state your confidence. First describe only sender-side visual evidence actually present in the drawing; any hypothesis must remain about the sender's surroundings, not the action they want you to take. A sheet cannot tell you to move, continue, turn, retrace, wait, or follow an axis. The absence of a mark is not a cue. Choose your route from your own current observations and search strategy. The sheet may suggest visual features worth looking for, but it cannot select one of your private route options. Keep these two tasks strictly separated inside this response: sheetInterpretation describes the sheet, while reasoning justifies the selected action using only your current local route images and private exploration history. reasoning must not mention the sheet, any drawing or message, your friend, or coordination with them. Any street label in your current route images belongs to your surroundings, not the sender's. Similar generic features such as trees, parked cars, scaffolding, or a vanishing point are weak evidence; do not infer that you share a block or route unless multiple unusual features and their arrangement recur across reciprocal sheets. Repetition alone is not independent confirmation. Update only the current plan and at most one sourced visual motif and partner hypothesis. basisSequences provide provenance, not confidence. Keep conventionUpdate purely descriptive of recurring visible marks and partnerHypothesis purely descriptive of the sender's possible surroundings. drawingIntent is your private record of which sender-side observation or memory the outgoing picture preserves; only drawingPrompt and the grounded visible features are sent to the image renderer.

Return only JSON:
{
  "action": ${actionSchema},
  "selectedIndex": <0-${options.length - 1}>,
  "intendedHeading": <the numeric heading you intend, or null>,
  "waitTurns": <1-6 when action is wait, otherwise 0>,
  "reasoning": "one concise first-person action justification using only local route evidence, with no mention of the sheet, drawing, message, friend, or coordination",
  "observation": "a grounded description of what you currently notice and want to remember",
  "observedFeatures": ["stable visible feature one", "stable visible feature two"],
  "sheetInterpretation": "literal visible content, followed by an uncertain sender-side observation hypothesis; never a requested action",
  "sheetConfidence": <0.0-1.0>,
  "memoryUpdate": {
    "currentPlan": "your current cooperative next strategy, revised by fresh evidence",
    "conventionUpdate": {"key": "short-stable-key", "description": "a purely descriptive recurring visual motif", "confidence": <0.0-1.0>, "basisSequences": [<real sequence numbers>]},
    "partnerHypothesis": {"key": "short-stable-key", "description": "an uncertain hypothesis about visible features around your friend", "confidence": <0.0-1.0>, "basisSequences": [<real sequence numbers>]}
  },
  "drawingIntent": "which sender-side observation or memory the next drawing preserves",
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
        if (!sheetMessage) {
          decision.sheetInterpretation = '';
          decision.sheetConfidence = 0;
          decision.memoryUpdate.partnerHypothesis = cleanBeliefUpdate(null);
        }
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
        const unsupportedInstruction = [
          decision.sheetInterpretation,
          decision.drawingIntent,
          decision.drawingPrompt,
          decision.memoryUpdate.conventionUpdate.description,
          decision.memoryUpdate.partnerHypothesis.description
        ].find(containsUnsupportedSheetInstruction);
        if (unsupportedInstruction) {
          throw new Error(`Rendezvous model turned the sheet into a movement instruction: ${unsupportedInstruction.slice(0, 120)}`);
        }
        const projectedAction = [decision.reasoning, decision.memoryUpdate.currentPlan]
          .find(projectsActionFromSheet);
        if (projectedAction) {
          throw new Error(`Rendezvous model projected an action from the sheet: ${projectedAction.slice(0, 120)}`);
        }
        if (contaminatesRouteReasoning(decision.reasoning)) {
          throw new Error(`Rendezvous model contaminated route reasoning with communication: ${decision.reasoning.slice(0, 120)}`);
        }
        return decision;
      } catch (error) {
        lastError = error;
        this.logger.warn?.(`Rendezvous model attempt ${attempt}/${this.maxAttempts} failed: ${error.message}`);
        if (/blank content|drawing prompt|drawing intent|memory revision|named geography|movement instruction|projected an action|contaminated route reasoning|json/i.test(error.message)) {
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

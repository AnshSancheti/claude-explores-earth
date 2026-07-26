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

function cleanStringList(values, { limit = 5, maxLength = 180 } = {}) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => cleanString(value, maxLength))
    .filter(Boolean))]
    .slice(0, limit);
}

function cleanBeliefUpdate(raw) {
  const numericConfidence = Number(raw?.confidence);
  const key = cleanString(raw?.key, 80);
  const evidenceStatus = ['new_corroboration', 'repetition_only', 'weakened', 'unclear']
    .includes(raw?.evidenceStatus)
    ? raw.evidenceStatus
    : (key ? 'unclear' : '');
  return {
    key,
    description: cleanString(raw?.description, 500),
    confidence: Number.isFinite(numericConfidence) ? Math.min(1, Math.max(0, numericConfidence)) : 0,
    basisSequences: [...new Set((Array.isArray(raw?.basisSequences) ? raw.basisSequences : [])
      .map(value => Math.floor(Number(value)))
      .filter(value => Number.isFinite(value) && value > 0))]
      .slice(-8),
    evidenceStatus
  };
}

function sanitizeEvidenceDelta(raw) {
  return {
    newEvidence: cleanStringList(raw?.newEvidence, { limit: 6, maxLength: 220 }),
    repeatedEvidence: cleanStringList(raw?.repeatedEvidence, { limit: 5, maxLength: 220 }),
    contradictions: cleanStringList(raw?.contradictions, { limit: 5, maxLength: 220 }),
    unresolvedQuestions: cleanStringList(raw?.unresolvedQuestions, { limit: 5, maxLength: 220 }),
    informationWorthSending: cleanStringList(raw?.informationWorthSending, { limit: 5, maxLength: 220 }),
    planAssessment: ['supporting', 'weakening', 'inconclusive'].includes(raw?.planAssessment)
      ? raw.planAssessment
      : 'inconclusive'
  };
}

const OUTBOUND_CONTRIBUTION_KINDS = Object.freeze([
  'local_observation',
  'own_action',
  'question',
  'correction',
  'acknowledgement',
  'deliberate_repetition'
]);

function isConcreteLocalEvidence(description) {
  const value = cleanString(description, 220);
  if (!value || value.toLowerCase() === 'context') return false;
  return !/\b(?:arrow|implied|suggests?|cue|motif|route|waypoint|shared|prior|sheet|partner|destination|coordinate|map|grid|star|intersection context)\b/i
    .test(value);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeOutboundPlaceNames(description, routeLabels = [], maxLength = 2400) {
  let value = cleanString(description, maxLength)
    .replace(
      /\b[A-Z][A-Za-z0-9'.-]*(?:\s+[A-Z][A-Za-z0-9'.-]*)?\s*\/\s*[A-Z][A-Za-z0-9'.-]*(?:\s+[A-Z][A-Za-z0-9'.-]*)?(?:\s+(?:intersection|anchor|corner))?\b/g,
      'local street corner'
    )
    .replace(
      /\b(?:[A-Z][A-Za-z0-9'.-]*\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Place|Pl|Parkway|Pkwy|Highway|Hwy)\b/g,
      'local street'
    );
  const labels = routeLabels.flatMap(label => {
    const full = cleanString(label, 120);
    const base = full.replace(
      /\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Place|Pl|Parkway|Pkwy|Highway|Hwy)\.?$/i,
      ''
    );
    return [full, base.length >= 4 ? base : ''];
  });
  [...new Set(labels.filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .forEach(label => {
      value = value.replace(
        new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(label)}(?![A-Za-z0-9])`, 'gi'),
        'local street'
      );
    });
  return value
    .replace(/^(?:at|in|near|the|with)\s+/i, '')
    .replace(/\blocal street(?:\s+local street)+\b/gi, 'local street')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isCueDependentSearchPlan(...descriptions) {
  const text = descriptions.map(value => cleanString(value, 1200)).join(' ');
  const positiveText = text.replace(
    /\b(?:do not|don't|never|not|without)\b[^.!;]{0,120}/gi,
    ' '
  );
  const partnerCuePattern = /\b(?:authorization|cue|permission|signal from (?:ada|theo|my friend|the friend|my partner|the partner)|(?:ada|theo|my friend|the friend|my partner|the partner)(?:'s|’s)? (?:authorization|cue|permission|signal)|(?:ada|theo|my friend|the friend|my partner|the partner) (?:to )?(?:authoriz\w*|cu\w*|instruct\w*|signal\w*))\b/i;
  if (!partnerCuePattern.test(positiveText)) return false;
  if (/\b(?:await|hold|pause|remain|stay|wait)\w*\b/i.test(positiveText)) return true;
  return /\b(?:advance|move|proceed|resume)\w*\b[^.!;]{0,120}\b(?:after|once|until|when)\b/i
    .test(positiveText);
}

function describeChosenAction(routeDecision, options) {
  if (routeDecision.action === 'wait') return 'I chose to wait at this branch.';
  const selectedOption = Array.isArray(options) ? options[routeDecision.selectedIndex] : null;
  const direction = Number.isFinite(Number(selectedOption?.heading))
    ? compassDirection(selectedOption.heading)
    : '';
  if (routeDecision.action === 'retrace') {
    return `I chose to retrace${direction ? ` ${direction}` : ''} along a public route I had already walked.`;
  }
  return `I chose to move${direction ? ` ${direction}` : ''} along the selected public route.`;
}

function buildContributionEvidence({ routeDecision, perception, privateMemory, options }) {
  const catalog = [];
  const routeLabels = (Array.isArray(options) ? options : []).map(option => option?.label);
  const add = (prefix, values) => {
    cleanStringList(values, { limit: 6, maxLength: 220 })
      .map(description => sanitizeOutboundPlaceNames(description, routeLabels, 220))
      .filter(Boolean)
      .forEach((description, index) => {
      catalog.push({ id: `${prefix}:${index}`, description });
    });
  };
  add('local', routeDecision.observedFeatures
    .filter(isConcreteLocalEvidence));
  add('action', [describeChosenAction(routeDecision, options)]);
  add('received', perception.literalContents);
  add('question', perception.evidenceDelta.unresolvedQuestions);
  add('contradiction', perception.evidenceDelta.contradictions);
  add('prior_sent', (privateMemory?.sentMessages || []).slice(-2).map(message =>
    message.informationDelta || message.intent
  ));
  return catalog;
}

function validContributionEvidencePrefix(kind, evidenceId) {
  const prefix = String(evidenceId || '').split(':')[0];
  if (kind === 'local_observation') return prefix === 'local';
  if (kind === 'own_action') return prefix === 'action';
  if (kind === 'question') return prefix === 'question';
  if (kind === 'correction') return prefix === 'contradiction';
  if (kind === 'acknowledgement') return prefix === 'received';
  if (kind === 'deliberate_repetition') return prefix === 'prior_sent' || prefix === 'received';
  return false;
}

function contributionKindForEvidenceId(evidenceId) {
  const prefix = String(evidenceId || '').split(':')[0];
  if (prefix === 'local') return 'local_observation';
  if (prefix === 'action') return 'own_action';
  if (prefix === 'question') return 'question';
  if (prefix === 'contradiction') return 'correction';
  if (prefix === 'received') return 'acknowledgement';
  if (prefix === 'prior_sent') return 'deliberate_repetition';
  return null;
}

function authoritativeContributionSummary(kind, description) {
  const evidence = cleanString(description, 300);
  if (kind === 'local_observation') return `New local observation: ${evidence}`;
  if (kind === 'own_action') return `My current chosen action: ${evidence}`;
  if (kind === 'question') return `Question I am sending: ${evidence}`;
  if (kind === 'correction') return `Correction I am sending: ${evidence}`;
  if (kind === 'acknowledgement') {
    return `Acknowledging received visual evidence without claiming it as my own: ${evidence}`;
  }
  if (kind === 'deliberate_repetition') {
    return `Deliberately repeating existing visual evidence without treating it as new: ${evidence}`;
  }
  return evidence;
}

function usesMultiPanelTemplate(...descriptions) {
  return /\b(?:left|middle|right|three)[ -]?panel\b|\btriptych\b|\bpanel\s*[123]\b/i
    .test(descriptions.map(value => cleanString(value, 2400)).join(' '));
}

function assertsUncitedSharedDestination(...descriptions) {
  const destinationClaim = /\b(?:shared|joint|mutual|anticipated|agreed|known)\s+(?:destination|target|waypoint|district|meeting place)\b|\b(?:destination|target|waypoint)\s+(?:for|shared by)\s+(?:both|us|the friends)\b/i;
  const uncertainty = /\b(?:uncertain|possibly|possible|hypothesis|hypothetical|question|whether|maybe|might|could|perhaps|test|verify|clarify)\b/i;
  return descriptions
    .flatMap(value => cleanString(value, 2400).split(/[.!?;]+/))
    .some(statement => destinationClaim.test(statement) && !uncertainty.test(statement));
}

export function reconcileRendezvousMessageAction(requestedAction, ...descriptions) {
  if (requestedAction === 'transition' || requestedAction === 'unclear') return requestedAction;
  const text = descriptions.map(value => cleanString(value, 2400)).join(' ');
  const positiveText = text.replace(
    /\b(?:avoid|exclude|no|omit|remove|without)\b[^.!;]{0,160}/gi,
    ' '
  );
  const movementCues = positiveText.match(/\b(?:arrow|diagonal|journey|move|movement|path|progression|route|toward|travel)\b/gi) || [];
  const stillnessCues = text.match(/\b(?:anchor|hold|pause|remain|stationary|still|stillness|wait|waiting)\b/gi) || [];
  if (requestedAction === 'stillness' && movementCues.length >= 2) return 'transition';
  if (requestedAction === 'movement' && stillnessCues.length >= 2) return 'transition';
  return requestedAction;
}

function sanitizeSheetPerception(raw) {
  const sheetInterpretation = cleanString(raw?.sheetInterpretation, 700);
  const numericConfidence = Number(raw?.sheetConfidence);
  const frameOfReference = ['sender', 'recipient', 'shared', 'unclear'].includes(raw?.frameOfReference)
    ? raw.frameOfReference
    : 'unclear';
  const informationNovelty = ['new', 'mixed', 'repeated', 'unclear'].includes(raw?.informationNovelty)
    ? raw.informationNovelty
    : 'unclear';
  return {
    sheetInterpretation,
    sheetConfidence: sheetInterpretation && Number.isFinite(numericConfidence)
      ? Math.min(0.8, Math.max(0, numericConfidence))
      : (sheetInterpretation ? 0.25 : 0),
    literalContents: cleanStringList(raw?.literalContents, { limit: 6, maxLength: 220 }),
    possiblePlaces: cleanStringList(raw?.possiblePlaces, { limit: 4, maxLength: 220 }),
    possibleIntentions: cleanStringList(raw?.possibleIntentions, { limit: 4, maxLength: 220 }),
    frameOfReference,
    requestedResponse: cleanString(raw?.requestedResponse, 400),
    informationNovelty,
    evidenceDelta: sanitizeEvidenceDelta(raw?.evidenceDelta),
    conventionUpdate: cleanBeliefUpdate(raw?.conventionUpdate || raw?.memoryUpdate?.conventionUpdate),
    partnerHypothesis: cleanBeliefUpdate(raw?.partnerHypothesis || raw?.memoryUpdate?.partnerHypothesis)
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
  return {
    action: 'wait',
    selectedIndex: Math.max(0, options.findIndex(option => !visitedPanos.includes(option.panoId))),
    intendedHeading: null,
    waitTurns: 1,
    reasoning: 'I hold this choice until I can form and send a deliberate message.',
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
    let perception = sanitizeSheetPerception(null);
    const rememberedSheet = sheetMessage
      ? (privateMemory?.receivedSheets || []).find(entry => entry.sequence === sheetMessage.sequence)
      : null;

    if (rememberedSheet) {
      const rememberedReconciliation = (privateMemory?.reconciliations || [])
        .find(entry => entry.sheetSequence === sheetMessage.sequence);
      perception = sanitizeSheetPerception({
        sheetInterpretation: rememberedSheet.interpretation,
        sheetConfidence: rememberedSheet.confidence,
        literalContents: rememberedSheet.literalContents,
        possiblePlaces: rememberedSheet.possiblePlaces,
        possibleIntentions: rememberedSheet.possibleIntentions,
        frameOfReference: rememberedSheet.frameOfReference,
        requestedResponse: rememberedSheet.requestedResponse,
        informationNovelty: rememberedSheet.informationNovelty,
        evidenceDelta: rememberedReconciliation
      });
    } else if (sheetMessage) {
      const perceptionPrompt = `You are ${agent.name}, privately inspecting the newest wordless drawing passed to you by ${partnerName}. The drawing is your only direct communication channel. It may depict observations, memories, uncertainty, a plan, a request, intended movement, or an invented visual convention.

You are deliberately seeing this image before your prior ledger or earlier drawings. Describe only what this image visibly contains, then infer what place, surroundings, intention, or coordination idea it might represent. You may use your own real-world knowledge to privately name possible landmarks, streets, neighborhoods, directions, or places. These names stay in your private memory; they are not text written on the sheet. Keep alternatives when the image is ambiguous and never treat generic city imagery as certainty.

Privately determine the drawing's frame of reference. A direction, path, or moving figure may describe the sender's own movement, propose shared movement, request a response, or address you. Unless the image or an established convention distinguishes those roles, do not assume a depicted route is an instruction for you to follow in your own local frame.

Do not invent access to ${partnerName}'s coordinates, route options, hidden reasoning, or actual destination.

Return only JSON:
{
  "literalContents": ["visible element and relationship"],
  "possiblePlaces": ["private place hypothesis with uncertainty"],
  "possibleIntentions": ["private interpretation of what the sender may intend or ask"],
  "frameOfReference": "sender" | "recipient" | "shared" | "unclear",
  "requestedResponse": "what response the image appears to ask from you, or empty when none is visually supported",
  "sheetInterpretation": "your concise best reading, including uncertainty",
  "sheetConfidence": <0.0-0.8>
}`;
      const perceptionContent = [
        {
          type: 'text',
          text: `This is sheet sequence ${sheetMessage.sequence}, sent by ${sheetMessage.from}. Inspect this image on its own. No earlier drawing or private ledger is included in this first-look pass.`
        },
        {
          type: 'image_url',
          image_url: { url: `data:${scratchpadMimeType};base64,${scratchpadBuffer.toString('base64')}`, detail: 'high' }
        }
      ];
      let perceptionTokens = Math.min(this.maxTokens, 1800);
      for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
        try {
          const response = await this.#client().chat.completions.create({
            model: this.model,
            messages: [
              { role: 'system', content: perceptionPrompt },
              { role: 'user', content: perceptionContent }
            ],
            response_format: { type: 'json_object' },
            reasoning_effort: this.reasoningEffort,
            max_completion_tokens: perceptionTokens
          });
          perception = sanitizeSheetPerception(parseJsonContent(response?.choices?.[0]?.message?.content));
          if (!perception.sheetInterpretation || perception.literalContents.length === 0) {
            throw new Error('Rendezvous sheet perception omitted its grounded reading');
          }
          break;
        } catch (error) {
          this.logger.warn?.(`Rendezvous sheet perception attempt ${attempt}/${this.maxAttempts} failed: ${error.message}`);
          perceptionTokens = Math.min(this.maxRetryTokens, Math.max(perceptionTokens * 2, 2600));
          if (attempt >= this.maxAttempts) {
            this.logger.warn?.(`Rendezvous sheet perception unavailable; preserving the sheet for a later retry: ${error.message}`);
            return {
              ...fallbackDecision(options, agent.visitedPanos || [], 'sheet_perception_error'),
              sheetPerception: perception,
              reconciliation: perception.evidenceDelta
            };
          }
        }
      }
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
- wait: remain here for 1 to 6 of your own turns when current local evidence makes anchoring your position more useful than continued motion. Neither friend leads or grants the other permission to move, so waiting for your friend to cue, authorize, or instruct you is not a valid reason to wait.`
      : `- move: continue through a promising unfamiliar public route;
- retrace: deliberately choose an option marked walked before when returning toward a remembered place supports the joint plan.

You have already chosen to remain at this same branch ${Math.max(1, Math.floor(Number(consecutiveWaitDecisions) || 0))} consecutive times without gaining a new local observation. Your friend may also be waiting. Remaining here again is not available at this decision; choose move or retrace.`;
    const actionSchema = allowWait ? '"move" | "retrace" | "wait"' : '"move" | "retrace"';
    const incomingSheetGuidance = perception.sheetInterpretation
      ? `Your private reading of the newest sheet is: ${JSON.stringify(perception)}

Only use a depicted route as a direct instruction for your own movement when the image or an established convention supports a recipient or shared frame. Sender-framed or unclear movement is evidence about your friend's behavior, not automatically a command to reproduce it locally.`
      : 'The sheet is blank or has not yet carried a usable message.';
    const currentVisibleEvidence = perception.literalContents.map((description, index) => ({
      id: `visible:${index}`,
      description
    }));

    const systemPrompt = `You are ${agent.name}, one of two friends actively trying to find each other after becoming separated on unfamiliar streets. You both began in Manhattan, but the world is open. The only information you exchange is a wordless drawing passed back and forth.

You can use your own real-world knowledge when interpreting what you personally see or what a drawing might depict. You never receive ${partnerName}'s coordinates, path, route options, hidden reasoning, or actual destination. Treat every place and intention inferred from a drawing as a hypothesis whose confidence must follow the evidence.

You are at a genuine branch. Reconcile your current surroundings, private memory, and the newest drawing, then choose:
${actionGuidance}
Avoid indoor shops, private interiors, dead ends, and accidental immediate loops. Google headings are compass bearings clockwise from north.

This call chooses your action, reconciles the clean first-look reading with history, and revises your private plan. You and your friend are peers searching independently; a drawing supplies evidence, questions, and hypotheses, never permission that must arrive before you can act. Remove any leader/follower or "await their cue" premise inherited from memory when revising your plan. The newest sheet's literal contents are the highest-priority evidence for your friend's current visible action. History may explain a recurring motif, but it cannot turn a currently still drawing into evidence that the sender is presently moving. "New evidence" means information directly visible in the newest first-look reading that is absent from earlier sheets; recurring imagery and history-only beliefs belong under repeated evidence even when freshly rendered. Do not turn repetition into confirmation or assume a sender-framed route is an instruction for you.

For every convention or partner hypothesis update, classify its evidence. "new_corroboration" requires an independently informative cue that supports the proposed meaning, not merely another appearance of the same symbol or your own motif echoed back to you. Use "repetition_only" when a motif recurs without new support for its meaning, "weakened" when new evidence conflicts with it or meaningful movement fails a concrete prediction, and "unclear" when the relationship cannot be assessed. A convention can remain useful visual vocabulary while the hypothesis about what it means weakens. Revise your current plan accordingly: an uncorroborated symbol may be tested as a hypothesis, but not treated as a known shared physical destination.

A separate call will let you decide what to draw. Explain your actual thinking in first person, including how the drawing affected you when relevant. Do not claim certainty that the evidence does not support.

Return only JSON:
{
  "action": ${actionSchema},
  "selectedIndex": <0-${options.length - 1}>,
  "intendedHeading": <the numeric heading you intend, or null>,
  "waitTurns": <1-6 when action is wait, otherwise 0>,
  "reasoning": "one concise first-person account of why this action best supports finding your friend",
  "observation": "a grounded description of what you currently notice and want to remember",
  "observedFeatures": ["literal concrete physical feature visible in a current local route-option image; never a navigation arrow or interface overlay, abstract route, sheet motif, inferred destination, shared cue, or remembered feature"],
  "sheetReconciliation": {
    "currentSenderAction": "movement" | "stillness" | "transition" | "unclear",
    "currentSenderActionBasis": "specific literal cue in the newest sheet, or why it remains unclear",
    "informationNovelty": "new" | "mixed" | "repeated" | "unclear",
    "newEvidenceIds": ["zero or more exact IDs from the newest-sheet visible evidence catalog"],
    "repeatedEvidence": [],
    "contradictions": [],
    "unresolvedQuestions": [],
    "informationWorthSending": [],
    "planAssessment": "supporting" | "weakening" | "inconclusive",
    "conventionUpdate": {"key": "short-stable-key", "description": "possible meaning of a recurring visual convention", "confidence": <0.0-0.7>, "basisSequences": [<real sequence numbers>], "evidenceStatus": "new_corroboration" | "repetition_only" | "weakened" | "unclear"},
    "partnerHypothesis": {"key": "short-stable-key", "description": "current hypothesis about the sender's place or intention", "confidence": <0.0-0.75>, "basisSequences": [<real sequence numbers>], "evidenceStatus": "new_corroboration" | "repetition_only" | "weakened" | "unclear"}
  },
  "memoryUpdate": {
    "currentPlan": "your current search strategy, revised by fresh local evidence"
  }
}`;

    const actionMemory = {
      ...(privateMemory || {}),
      currentPlan: privateMemory?.currentPlan
    };
    const userContent = [
      {
        type: 'text',
        text: `The following images are your current local route options 0 through ${options.length - 1}. They do not show your friend's surroundings.

${incomingSheetGuidance}

${optionLines}

Your descriptive private evidence ledger, unavailable to ${partnerName}:
${JSON.stringify(actionMemory, null, 2)}

Your own movement since your last successful branch decision:
${JSON.stringify(movementSinceDecision || {}, null, 2)}

Newest-sheet visible evidence catalog:
${JSON.stringify(currentVisibleEvidence, null, 2)}

Recent private field notes:
${recentFieldNotes}`
      },
      ...screenshots.map(buffer => ({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${buffer.toString('base64')}`, detail: 'low' }
      }))
    ];

    let lastError = null;
    let routeDecision = null;
    let routeReconciliation = {
      informationNovelty: perception.informationNovelty,
      evidenceDelta: perception.evidenceDelta,
      conventionUpdate: perception.conventionUpdate,
      partnerHypothesis: perception.partnerHypothesis
    };
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
        if (isCueDependentSearchPlan(
          parsed?.action === 'wait' ? parsed?.reasoning : '',
          parsed?.memoryUpdate?.currentPlan
        )) {
          throw new Error('Rendezvous model made independent movement contingent on a partner cue');
        }
        routeDecision = sanitizeRendezvousDecision(parsed, options, { allowWait });
        if (
          routeDecision.action !== 'wait' &&
          routeDecision.intendedHeading !== null &&
          headingDelta(
            options[routeDecision.selectedIndex]?.heading,
            routeDecision.intendedHeading
          ) > 45
        ) {
          throw new Error('Rendezvous selected route contradicts its intended heading');
        }
        if (!routeDecision.observation || routeDecision.observedFeatures.length === 0) {
          throw new Error('Rendezvous route decision omitted its current observation');
        }
        if (!routeDecision.memoryUpdate.currentPlan) {
          throw new Error('Rendezvous model omitted its private memory revision');
        }
        if (sheetMessage) {
          const rawReconciliation = parsed?.sheetReconciliation;
          const currentSenderAction = ['movement', 'stillness', 'transition', 'unclear']
            .includes(rawReconciliation?.currentSenderAction)
            ? rawReconciliation.currentSenderAction
            : null;
          const currentSenderActionBasis = cleanString(rawReconciliation?.currentSenderActionBasis, 400);
          const informationNovelty = ['new', 'mixed', 'repeated', 'unclear'].includes(rawReconciliation?.informationNovelty)
            ? rawReconciliation.informationNovelty
            : null;
          if (!informationNovelty || !currentSenderAction || !currentSenderActionBasis) {
            throw new Error('Rendezvous route decision omitted its sheet reconciliation');
          }
          const requestedNewEvidenceIds = cleanStringList(rawReconciliation?.newEvidenceIds, {
            limit: 6,
            maxLength: 80
          });
          const groundedNewEvidence = requestedNewEvidenceIds
            .map(id => currentVisibleEvidence.find(item => item.id === id)?.description)
            .filter(Boolean);
          const evidenceDelta = sanitizeEvidenceDelta(rawReconciliation);
          const conventionUpdate = cleanBeliefUpdate(rawReconciliation?.conventionUpdate);
          const partnerHypothesis = cleanBeliefUpdate(rawReconciliation?.partnerHypothesis);
          const normalizedPlanAssessment = (
            informationNovelty === 'repeated' &&
            groundedNewEvidence.length === 0 &&
            evidenceDelta.planAssessment === 'supporting'
          )
            ? 'inconclusive'
            : evidenceDelta.planAssessment;
          routeReconciliation = {
            currentSenderAction,
            currentSenderActionBasis,
            informationNovelty,
            evidenceDelta: {
              ...evidenceDelta,
              newEvidence: groundedNewEvidence,
              planAssessment: normalizedPlanAssessment
            },
            conventionUpdate,
            partnerHypothesis
          };
        }
        break;
      } catch (error) {
        lastError = error;
        this.logger.warn?.(`Rendezvous model attempt ${attempt}/${this.maxAttempts} failed: ${error.message}`);
        if (/blank content|observation|memory revision|json/i.test(error.message)) {
          tokenBudget = Math.min(this.maxRetryTokens, Math.max(tokenBudget * 2, 3200));
        }
      }
    }
    if (!routeDecision) {
      const status = lastError?.status ?? lastError?.response?.status;
      return {
        ...fallbackDecision(options, agent.visitedPanos || [], status ? `api_error_${status}` : 'route_model_error'),
        sheetInterpretation: perception.sheetInterpretation,
        sheetConfidence: perception.sheetConfidence,
        sheetPerception: perception,
        reconciliation: perception.evidenceDelta
      };
    }
    perception = {
      ...perception,
      currentSenderAction: routeReconciliation.currentSenderAction,
      currentSenderActionBasis: routeReconciliation.currentSenderActionBasis,
      informationNovelty: routeReconciliation.informationNovelty,
      evidenceDelta: routeReconciliation.evidenceDelta,
      conventionUpdate: routeReconciliation.conventionUpdate,
      partnerHypothesis: routeReconciliation.partnerHypothesis
    };

    const contributionEvidence = buildContributionEvidence({
      routeDecision,
      perception,
      privateMemory: actionMemory,
      options
    });
    const drawingSystemPrompt = `You are ${agent.name}. You have reached a real choice while trying to find ${partnerName}, and you currently hold the one physical sheet you pass back and forth.

Decide what wordless drawing would be most useful to send now. You may communicate anything you genuinely believe could help you find each other: what you see, a remembered place, uncertainty, a correction, intended movement, a request, relative spatial relationships, or an invented visual convention. You are not limited to an observational postcard and you may use arrows, diagrams, symbols, maps, perspective, or figurative imagery when you choose.

First identify your outbound contribution: what this reply contributes from your own observation, chosen action, question, correction, acknowledgement, or deliberate repetition. Cite exactly one evidence ID from the supplied catalog. The cited evidence becomes the authoritative information delta; do not restate or enlarge it as a separate claim. Compose each handoff from a conceptually blank page. Make the cited contribution the largest, darkest, or otherwise unmistakable primary subject; prior visual language is optional supporting vocabulary, not a layout template. When the contribution is one simple observation or action, prefer one coherent composition. Use multiple panels only when the cited contribution itself needs a temporal, spatial, or comparative relationship; continuity alone does not justify copying a multi-panel itinerary. A received-sheet or prior-sent motif may be retained as context, acknowledgement, or deliberate repetition, but never relabel it as a new local observation. You will see the current received sheet and up to two earlier passed sheets, explicitly labeled. Compare them as drawings before composing your reply. Do not merely mirror the incoming drawing or redraw your previous message because its motifs are familiar. If your proposed composition visibly resembles a recent sheet, use it only when your continuity reason explains why repetition itself is useful and the cited evidence is visually dominant over that context. Repetition does not make a belief more certain. If you are asking your friend to clarify something, make the uncertainty, choice, or missing relationship visibly legible instead of drawing a confident route. Make the visual roles legible enough that your own movement is not accidentally presented as an instruction to ${partnerName}, unless an instruction is truly what you mean.

A recurring motif may remain part of your visual language without becoming a factual place claim. Unless the cited contribution itself grounds a correction or question about it, do not present an inherited symbol, route, district, target, or waypoint as a known shared destination. You may retain one as a subordinate uncertain hypothesis, deliberately repeat it, transform it, question it, or stop using it. Do not silently promote it into the goal of the search.

Choose the image's dominant action honestly. The strongest visual cue in your drawing prompt must agree with "messageAction". If the message is stillness, movement or future-route cues may be present but must remain visibly subordinate to stopping, waiting, anchoring, or uncertainty. If the message is movement, do not let barriers or static figures dominate it. A transition may visibly contain both.

Do not include readable text, letters, numbers, captions, street labels, signatures, logos, or watermarks in the intended image. Place names may exist in your private reasoning, but do not put street, intersection, neighborhood, or landmark names in the drawing intent, drawing prompt, or visual anchors. Translate a useful named-place hypothesis into visible architecture, landscape, spatial relationships, symbols, or atmosphere. Do not encode exact coordinates or information you do not possess. The image renderer receives only your drawing prompt and the visual anchors you list.

Return only JSON:
{
  "contributionKind": "local_observation" | "own_action" | "question" | "correction" | "acknowledgement" | "deliberate_repetition",
  "contributionEvidenceId": "one exact ID from the available outbound evidence catalog",
  "drawingIntent": "your private account of what you are trying to tell ${partnerName}",
  "continuityReason": "why recurring motifs are worth retaining, or empty when they are not",
  "messageAction": "movement" | "stillness" | "transition" | "unclear",
  "drawingPrompt": "complete visual instructions for one coherent handmade drawing with no readable text",
  "groundedFeatureEvidenceIds": ["zero or more exact IDs from the available outbound evidence catalog that should remain visible as context"]
}`;
    const priorVisualSheets = (Array.isArray(visualHistory) ? visualHistory : []).slice(-2);
    const drawingVisualContext = [];
    if (sheetMessage && Buffer.isBuffer(scratchpadBuffer) && scratchpadBuffer.length > 0) {
      drawingVisualContext.push(
        {
          type: 'text',
          text: `CURRENT RECEIVED SHEET — sequence ${sheetMessage.sequence}, sent by ${sheetMessage.from}. This is communication from your friend, not a local route-option image.`
        },
        {
          type: 'image_url',
          image_url: { url: `data:${scratchpadMimeType};base64,${scratchpadBuffer.toString('base64')}`, detail: 'high' }
        }
      );
    }
    for (const historicalSheet of priorVisualSheets) {
      drawingVisualContext.push(
        {
          type: 'text',
          text: `PRIOR PASSED SHEET — sequence ${historicalSheet.sequence}, ${historicalSheet.direction} by you. Use it only to compare visual vocabulary and repetition.`
        },
        {
          type: 'image_url',
          image_url: {
            url: `data:${historicalSheet.mimeType || 'image/webp'};base64,${historicalSheet.buffer.toString('base64')}`,
            detail: 'low'
          }
        }
      );
    }
    const drawingContent = [
      {
        type: 'text',
        text: `Your private reading and evidence delta:
${JSON.stringify(perception, null, 2)}

Your route decision and near-term intention:
${JSON.stringify({
  action: routeDecision.action,
  intendedHeading: routeDecision.intendedHeading,
  reasoning: routeDecision.reasoning,
  observation: routeDecision.observation,
  observedFeatures: routeDecision.observedFeatures,
  currentPlan: routeDecision.memoryUpdate.currentPlan
}, null, 2)}

Your prior private memory:
${JSON.stringify(actionMemory, null, 2)}

Available outbound evidence catalog:
${JSON.stringify(contributionEvidence, null, 2)}`
      },
      ...drawingVisualContext
    ];
    let drawingPlan = null;
    let drawingRetryFeedback = '';
    tokenBudget = Math.min(this.maxTokens, 1800);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.#client().chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: drawingSystemPrompt },
            {
              role: 'user',
              content: drawingRetryFeedback
                ? [{
                    type: 'text',
                    text: `AUTHORITATIVE PLANNING CORRECTION FROM THE PRIOR ATTEMPT: ${drawingRetryFeedback}`
                  }, ...drawingContent]
                : drawingContent
            }
          ],
          response_format: { type: 'json_object' },
          reasoning_effort: this.reasoningEffort,
          max_completion_tokens: tokenBudget
        });
        const parsed = parseJsonContent(response?.choices?.[0]?.message?.content);
        const requestedContributionKind = OUTBOUND_CONTRIBUTION_KINDS.includes(parsed?.contributionKind)
          ? parsed.contributionKind
          : null;
        const contributionEvidenceId = cleanString(parsed?.contributionEvidenceId, 80);
        const citedEvidence = contributionEvidence.find(item => item.id === contributionEvidenceId);
        const contributionKind = citedEvidence && validContributionEvidencePrefix(
          requestedContributionKind,
          contributionEvidenceId
        )
          ? requestedContributionKind
          : contributionKindForEvidenceId(contributionEvidenceId);
        if (requestedContributionKind && contributionKind !== requestedContributionKind) {
          this.logger.warn?.(
            `Rendezvous drawing planner contribution normalized from ${requestedContributionKind} to ${contributionKind || 'invalid'} for ${contributionEvidenceId || 'missing evidence'}`
          );
        }
        const contributionSummary = authoritativeContributionSummary(
          contributionKind,
          citedEvidence?.description
        );
        const groundedFeatureEvidenceIds = cleanStringList(parsed?.groundedFeatureEvidenceIds, {
          limit: 6,
          maxLength: 80
        });
        const groundedFeatures = [
          citedEvidence?.description,
          ...groundedFeatureEvidenceIds.map(id =>
            contributionEvidence.find(item => item.id === id)?.description
          )
        ].filter(Boolean);
        const routeLabels = (Array.isArray(options) ? options : []).map(option => option?.label);
        const drawingIntent = sanitizeOutboundPlaceNames(parsed?.drawingIntent, routeLabels, 700);
        const drawingPrompt = sanitizeOutboundPlaceNames(parsed?.drawingPrompt, routeLabels, 2400);
        const requestedMessageAction = ['movement', 'stillness', 'transition', 'unclear']
          .includes(parsed?.messageAction)
          ? parsed.messageAction
          : null;
        const candidateDrawingPlan = {
          contributionKind,
          contributionEvidenceId,
          contributionSummary,
          drawingIntent,
          informationDelta: contributionSummary,
          continuityReason: sanitizeOutboundPlaceNames(parsed?.continuityReason, routeLabels, 500),
          messageAction: reconcileRendezvousMessageAction(
            requestedMessageAction,
            drawingIntent,
            drawingPrompt
          ),
          drawingPrompt,
          groundedFeatures: [...new Set(groundedFeatures)].slice(0, 6)
        };
        if (
          !candidateDrawingPlan.contributionKind ||
          !citedEvidence ||
          !validContributionEvidencePrefix(
            candidateDrawingPlan.contributionKind,
            candidateDrawingPlan.contributionEvidenceId
          )
        ) {
          throw new Error('Rendezvous drawing planner cited invalid outbound contribution evidence');
        }
        if (
          !candidateDrawingPlan.contributionSummary ||
          !candidateDrawingPlan.drawingIntent ||
          !candidateDrawingPlan.informationDelta ||
          !candidateDrawingPlan.messageAction ||
          !candidateDrawingPlan.drawingPrompt
        ) {
          throw new Error('Rendezvous drawing planner omitted its intended message, information delta, or dominant action');
        }
        if (
          !['acknowledgement', 'deliberate_repetition'].includes(candidateDrawingPlan.contributionKind) &&
          usesMultiPanelTemplate(...perception.literalContents, perception.sheetInterpretation) &&
          usesMultiPanelTemplate(candidateDrawingPlan.drawingIntent, candidateDrawingPlan.drawingPrompt)
        ) {
          throw new Error('Rendezvous drawing planner echoed the received multi-panel template for a new contribution');
        }
        if (assertsUncitedSharedDestination(
          candidateDrawingPlan.drawingIntent,
          candidateDrawingPlan.drawingPrompt,
          candidateDrawingPlan.continuityReason
        )) {
          throw new Error('Rendezvous drawing planner promoted an uncited motif into a shared destination');
        }
        drawingPlan = candidateDrawingPlan;
        break;
      } catch (error) {
        lastError = error;
        this.logger.warn?.(`Rendezvous drawing plan attempt ${attempt}/${this.maxAttempts} failed: ${error.message}`);
        drawingRetryFeedback = /multi-panel template/i.test(error.message)
          ? 'Start from a blank page and use one coherent composition centered on the cited contribution. You may retain one small recurring symbol, but do not use panels, a triptych, or the received sheet layout.'
          : (/uncited motif/i.test(error.message)
              ? 'Keep the cited contribution primary. Do not describe any inherited symbol, route, target, waypoint, district, or place as a known shared destination. If you retain one, make it subordinate and explicitly uncertain, questioned, tested, transformed, or deliberately repeated.'
              : 'Correct the reported planning error. Cite an exact available evidence ID and make that contribution visually primary without enlarging its claim.');
        tokenBudget = Math.min(this.maxRetryTokens, Math.max(tokenBudget * 2, 2600));
      }
    }
    if (!drawingPlan) {
      const status = lastError?.status ?? lastError?.response?.status;
      return {
        ...fallbackDecision(options, agent.visitedPanos || [], status ? `api_error_${status}` : 'drawing_plan_error'),
        sheetInterpretation: perception.sheetInterpretation,
        sheetConfidence: perception.sheetConfidence,
        sheetPerception: perception,
        reconciliation: perception.evidenceDelta
      };
    }

    return {
      ...routeDecision,
      ...drawingPlan,
      observedFeatures: routeDecision.observedFeatures,
      drawingGroundedFeatures: drawingPlan.groundedFeatures,
      sheetInterpretation: perception.sheetInterpretation,
      sheetConfidence: perception.sheetConfidence,
      sheetPerception: perception,
      reconciliation: perception.evidenceDelta,
      memoryUpdate: {
        ...routeDecision.memoryUpdate,
        conventionUpdate: perception.conventionUpdate,
        partnerHypothesis: perception.partnerHypothesis
      },
      fallbackCause: null
    };
  }

  async reviewDrawing({
    agentName,
    partnerName,
    contributionKind = '',
    contributionEvidenceId = '',
    contributionSummary = '',
    drawingIntent,
    informationDelta = '',
    continuityReason = '',
    messageAction = 'unclear',
    drawingPrompt,
    groundedFeatures = [],
    visualHistory = [],
    imageBuffer,
    imageMimeType = 'image/webp'
  }) {
    if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
      throw new Error('Rendezvous drawing review requires the generated image');
    }
    const decodePrompt = `Inspect this wordless drawing without any knowledge of what its sender intended. Report what a recipient would actually see and most likely infer. Do not reward artistic quality or invent meaning from absent cues.

Return only JSON:
{
  "literalContents": ["visible element and relationship"],
  "likelyMessage": "best context-free interpretation, including uncertainty",
  "dominantAction": "movement" | "stillness" | "transition" | "unclear",
  "movementCues": ["visible cue suggesting movement or direction"],
  "stillnessCues": ["visible cue suggesting waiting, stopping, anchoring, or no movement"],
  "readableText": true | false
}`;
    let blindRead = null;
    let lastError = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.#client().chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: decodePrompt },
            {
              role: 'user',
              content: [{
                type: 'image_url',
                image_url: { url: `data:${imageMimeType};base64,${imageBuffer.toString('base64')}`, detail: 'high' }
              }]
            }
          ],
          response_format: { type: 'json_object' },
          reasoning_effort: this.reasoningEffort,
          max_completion_tokens: 1200
        });
        const parsed = parseJsonContent(response?.choices?.[0]?.message?.content);
        blindRead = {
          literalContents: cleanStringList(parsed?.literalContents, { limit: 8, maxLength: 220 }),
          likelyMessage: cleanString(parsed?.likelyMessage, 700),
          dominantAction: ['movement', 'stillness', 'transition', 'unclear'].includes(parsed?.dominantAction)
            ? parsed.dominantAction
            : 'unclear',
          movementCues: cleanStringList(parsed?.movementCues, { limit: 6, maxLength: 220 }),
          stillnessCues: cleanStringList(parsed?.stillnessCues, { limit: 6, maxLength: 220 }),
          readableText: parsed?.readableText === true
        };
        if (!blindRead.likelyMessage || blindRead.literalContents.length === 0) {
          throw new Error('Rendezvous blind drawing read omitted its grounded interpretation');
        }
        break;
      } catch (error) {
        lastError = error;
        this.logger.warn?.(`Rendezvous blind drawing read attempt ${attempt}/${this.maxAttempts} failed: ${error.message}`);
      }
    }
    if (!blindRead) throw lastError || new Error('Rendezvous blind drawing read failed');
    const normalizedMessageAction = ['movement', 'stillness', 'transition', 'unclear'].includes(messageAction)
      ? messageAction
      : 'unclear';
    const actionConflict = (
      normalizedMessageAction === 'movement' &&
      blindRead.dominantAction === 'stillness'
    ) || (
      normalizedMessageAction === 'stillness' &&
      blindRead.dominantAction === 'movement'
    );
    if (actionConflict) {
      const revisionPrompt = normalizedMessageAction === 'stillness'
        ? 'Remove arrows, directional lines, motion trails, and route cues that imply travel. Make a stopped or waiting figure, a fixed landmark, or another stable anchor the largest and darkest focal element, using a balanced static composition.'
        : 'Make the moving subject and its progression the largest and darkest focal element. Subordinate barriers, stationary figures, and balanced static composition so they cannot read as the main message.';
      return {
        accepted: false,
        assessment: `Blind recipient read the drawing as ${blindRead.dominantAction}, but the intended message is ${normalizedMessageAction}: ${blindRead.likelyMessage}`,
        revisionPrompt,
        blindRead
      };
    }

    const comparisonSheets = (Array.isArray(visualHistory) ? visualHistory : [])
      .filter(item => Buffer.isBuffer(item?.buffer) && item.buffer.length > 0)
      .slice(-2);
    const systemPrompt = `You are ${agentName}, inspecting the actual wordless drawing that will be handed to ${partnerName}. Decide whether it visibly communicates what you intended.

An independent recipient has already decoded the image without seeing your intent. Judge the drawing from that blind reading, not from what you hoped the composition would imply. The outbound contribution is the sender's cited addition to the exchange. Reject a drawing that visually promotes received or remembered context into the sender's new observation, or whose dominant imagery hides the cited contribution. If the information delta is one concrete observation but the blind reading primarily describes an inherited route, destination, or multi-stage itinerary, reject it even when the observation appears somewhere in the image. Every key claim in your intended delta needs a visible cue a neutral observer could point to, and that delta must read as the image's primary message. Compare against the labeled recent sheets when supplied. Reusing a symbol is not itself a near-copy, but repeating substantially the same layout and visual hierarchy without making the current contribution primary is. Absence of motion does not communicate waiting when a prominent arrow communicates movement. Reject readable text, material omissions or distortions of the outbound contribution itself, contradictions, hidden deltas, and generic or accidental repetition. The rendering instructions and recurring motifs are means, not a contract: do not reject an otherwise legible contribution merely because the image omits, changes, or simplifies inherited panels, grids, stars, destinations, or other supporting layout details. Repeated imagery is acceptable when the stated continuity reason makes that repetition intentional and subordinate to the current contribution. Do not demand photorealism.

Return only JSON:
{
  "accepted": true | false,
  "contributionPrimary": true | false,
  "materialContributionConflict": true | false,
  "visualNovelty": "distinct" | "intentional_repetition" | "near_copy" | "unclear",
  "assessment": "concise private assessment",
  "revisionPrompt": "when rejected, concrete visual corrections for the next rendering; otherwise empty"
}`;
    lastError = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.#client().chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `My outbound contribution:
Kind: ${contributionKind || 'legacy'}
Evidence ID: ${contributionEvidenceId || 'legacy'}
What my friend should learn: ${contributionSummary || 'Legacy message: no explicit contribution provenance was recorded.'}

My intended message:
${drawingIntent}

What should be new or deliberately repeated:
${informationDelta || 'Legacy message: no explicit information delta was recorded.'}

Intended dominant action:
${normalizedMessageAction}

Reason for retaining recurring motifs:
${continuityReason || 'None recorded.'}

Independent context-free reading of the rendered image:
${JSON.stringify(blindRead, null, 2)}

My rendering instructions:
${drawingPrompt}

Visual anchors:
${JSON.stringify(groundedFeatures)}`
                },
                ...comparisonSheets.flatMap(item => ([
                  {
                    type: 'text',
                    text: `RECENT SHEET FOR VISUAL COMPARISON — sequence ${item.sequence}, ${item.direction}.`
                  },
                  {
                    type: 'image_url',
                    image_url: {
                      url: `data:${item.mimeType || 'image/webp'};base64,${item.buffer.toString('base64')}`,
                      detail: 'low'
                    }
                  }
                ]))
              ]
            }
          ],
          response_format: { type: 'json_object' },
          reasoning_effort: this.reasoningEffort,
          max_completion_tokens: 1400
        });
        const parsed = parseJsonContent(response?.choices?.[0]?.message?.content);
        const assessment = cleanString(parsed?.assessment, 500);
        const contributionPrimary = parsed?.contributionPrimary !== false;
        const visualNovelty = ['distinct', 'intentional_repetition', 'near_copy', 'unclear']
          .includes(parsed?.visualNovelty)
          ? parsed.visualNovelty
          : 'unclear';
        if (typeof parsed?.accepted !== 'boolean' || !assessment) {
          throw new Error('Rendezvous drawing review omitted its verdict');
        }
        const accidentalNearCopy = comparisonSheets.length > 0
          && visualNovelty === 'near_copy'
          && !['acknowledgement', 'deliberate_repetition'].includes(contributionKind);
        const materialContributionConflict = parsed?.materialContributionConflict === true;
        const layoutOnlyRejection = parsed.accepted === false
          && parsed?.materialContributionConflict === false;
        const accepted = (parsed.accepted || layoutOnlyRejection)
          && contributionPrimary
          && !materialContributionConflict
          && !accidentalNearCopy
          && !blindRead.readableText;
        const forcedRevision = blindRead.readableText
          ? 'Remove every readable word, letter, number, caption, street label, logo, signature, and watermark. Communicate only through visible objects, spatial relationships, symbols, and tone.'
          : (!contributionPrimary
          ? 'Start from a blank composition and make the cited current contribution the largest and darkest primary subject. Reduce inherited route, destination, and multi-panel context to at most one subordinate supporting motif.'
          : (accidentalNearCopy
              ? 'Replace the repeated layout and visual hierarchy. Start from a blank composition centered on the cited current contribution; retain only one small recurring symbol if it is essential for continuity.'
              : ''));
        return {
          accepted,
          assessment: cleanString(
            `Blind read (${blindRead.dominantAction}): ${blindRead.likelyMessage} Sender review (${visualNovelty}, contribution ${contributionPrimary ? 'primary' : 'secondary'}${layoutOnlyRejection ? ', layout-only objection ignored' : ''}): ${assessment}`,
            700
          ),
          revisionPrompt: cleanString(forcedRevision || parsed?.revisionPrompt, 1200),
          blindRead
        };
      } catch (error) {
        lastError = error;
        this.logger.warn?.(`Rendezvous drawing review attempt ${attempt}/${this.maxAttempts} failed: ${error.message}`);
      }
    }
    throw lastError || new Error('Rendezvous drawing review failed');
  }
}

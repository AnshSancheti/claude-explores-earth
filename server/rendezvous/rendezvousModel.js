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

function compassDirection(heading) {
  const directions = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  const normalized = ((Number(heading) || 0) % 360 + 360) % 360;
  return directions[Math.round(normalized / 45) % directions.length];
}

function headingDelta(a, b) {
  const normalizedA = ((Number(a) || 0) % 360 + 360) % 360;
  const normalizedB = ((Number(b) || 0) % 360 + 360) % 360;
  const delta = Math.abs(normalizedA - normalizedB);
  return Math.min(delta, 360 - delta);
}

function normalizeStreetText(value) {
  return String(value || '')
    .replace(/\b(WEST)\b/gi, 'W')
    .replace(/\b(EAST)\b/gi, 'E')
    .replace(/\b(STREET)\b/gi, 'ST')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function corridorFromText(value) {
  const text = normalizeStreetText(value);
  if (!text) return null;
  if (/\b(BROOKLYN|QUEENS|BRONX|STATEN ISLAND|NEW JERSEY|JERSEY CITY|HOBOKEN|OAKLAND|CHICAGO)\b/.test(text)) {
    return null;
  }

  const numbered = text.match(/\b(?:W|E)\s*(\d{1,3})(?:ST|ND|RD|TH)?(?:\s+ST)?\b/) ||
    text.match(/\b(\d{1,3})(?:ST|ND|RD|TH)(?:\s+ST)?\b(?!\s+AVE)/) ||
    text.match(/\b(\d{1,3})\s+ST\b/);
  if (numbered) {
    const number = Number(numbered[1]);
    if (Number.isFinite(number)) {
      return {
        key: `${number} ST`,
        label: `${number}${number === 1 ? 'ST' : number === 2 ? 'ND' : number === 3 ? 'RD' : 'TH'} ST`,
        northRank: number
      };
    }
  }

  const villageRanks = [
    ['CANAL', -6],
    ['SPRING', -5],
    ['PRINCE', -4],
    ['BLEECKER', -2],
    ['CARMINE', -1],
    ['HOUSTON', 0],
    ['GREENWICH VILLAGE', 0],
    ['WASHINGTON SQ', 1],
    ['WASHINGTON SQUARE', 1],
    ['UNION SQ', 14],
    ['UNION SQUARE', 14]
  ];
  const match = villageRanks.find(([name]) => text.includes(name));
  if (match) {
    return {
      key: match[0],
      label: match[0],
      northRank: match[1]
    };
  }

  return null;
}

function hasConnectorRouteComponent(value) {
  const text = normalizeStreetText(value)
    .replace(/\b(AVENUE)\b/g, 'AVE')
    .replace(/\b(PLACE)\b/g, 'PL')
    .replace(/\bAVE\s+OF\s+THE\s+AMERICAS\b/g, '6TH AVE');
  if (!text) return false;

  const components = text
    .split(/\s*(?:\/|&|\bAND\b|\bAT\b|\bCORNER OF\b|\bNEAR\b)\s*/i)
    .map(component => component.trim())
    .filter(Boolean);
  const texts = components.length > 1 ? components : [text];
  return texts.some(component =>
    /\b(?:[1-9]|1[0-2])(?:ST|ND|RD|TH)?\s+AVE\b/.test(component) ||
    /\b(?:AVE|BROADWAY|UNIVERSITY PL|GREENWICH|VARICK|7TH|8TH|9TH|6TH|5TH)\b/.test(component)
  );
}

function newestCorridor(texts = []) {
  for (const text of [...texts].reverse()) {
    const corridor = corridorFromText(text);
    if (corridor) return corridor;
  }
  return null;
}

function placeKeyFromText(value) {
  const text = normalizeStreetText(value)
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(AVENUE)\b/g, 'AVE')
    .replace(/\b(PLACE)\b/g, 'PL')
    .replace(/\s+/g, ' ')
    .trim();
  if (/\bAVE\s+OF\s+THE\s+AMERICAS\b/.test(text)) return '6TH AVE';
  const numberedAvenue = text.match(/\b(?:W|E)?\s*(\d{1,2})(?:ST|ND|RD|TH)?\s+AVE\b/);
  if (numberedAvenue) {
    const number = Number(numberedAvenue[1]);
    if (Number.isFinite(number)) return `${number}${number === 1 ? 'ST' : number === 2 ? 'ND' : number === 3 ? 'RD' : 'TH'} AVE`;
  }
  const numberedStreet = text.match(/\b(?:W|E)\s*(\d{1,3})(?:ST|ND|RD|TH)?(?:\s+ST)?\b/) ||
    text.match(/\b(\d{1,3})(?:ST|ND|RD|TH)(?:\s+ST)?\b/) ||
    text.match(/\b(\d{1,3})\s+ST\b/);
  if (numberedStreet) return `${Number(numberedStreet[1])} ST`;
  const corridor = corridorFromText(value);
  if (corridor) return corridor.key;
  return text || null;
}

function placeKeysFromTexts(texts = []) {
  return new Set(
    texts
      .map(placeKeyFromText)
      .filter(Boolean)
  );
}

function isExplicitLocalObservation(value) {
  const text = normalizeStreetText(value);
  if (!text) return false;
  if (/\b(FRIEND|PARTNER|THEO|ADA|INK|ROUTE COMMAND|AVAILABLE|CONNECTION|CHOOSE|TARGET)\b/.test(text)) {
    return false;
  }
  return /\b(I AM|I'M|I CAN SEE|I SEE|CURRENT|VISIBLE|THIS PANORAMA|THIS VIEW|THIS BLOCK|MY CORNER|MY STREET)\b/.test(text);
}

function optionDirectionScore(option, desiredHeading) {
  const heading = Number(option?.heading);
  if (!Number.isFinite(heading)) return Infinity;
  const delta = headingDelta(heading, desiredHeading);
  const label = normalizeStreetText(option?.label);
  const avenueBonus = /\b(AVE|AVENUE|BROADWAY|UNIVERSITY PL|GREENWICH|VARICK|7TH|8TH|9TH|6TH|5TH)\b/.test(label) ? 8 : 0;
  const publicStreetBonus = /\b(ST|AVE|AVENUE|BROADWAY|PLACE|PL)\b/.test(label) ? 4 : 0;
  return delta - avenueBonus - publicStreetBonus;
}

export function selectConvergencePolicyOption({ agent = {}, options = [], partnerPadText = [], ownPadText = [] } = {}) {
  if (!Array.isArray(options) || options.length === 0) return null;

  const target = newestCorridor(partnerPadText);
  if (!target) return null;

  const optionLocalTexts = options.map(option => option?.label);
  const localObservationTexts = Array.isArray(agent.recentNotes)
    ? agent.recentNotes.filter(isExplicitLocalObservation)
    : [];
  const local = newestCorridor(optionLocalTexts) ||
    newestCorridor([agent.currentRouteLabel]) ||
    newestCorridor(Array.isArray(ownPadText) ? ownPadText : []) ||
    newestCorridor([agent.recentMovement]) ||
    newestCorridor(localObservationTexts);
  if (!local || local.key === target.key) return null;

  const rankDelta = target.northRank - local.northRank;
  if (!Number.isFinite(rankDelta) || Math.abs(rankDelta) < 1) return null;

  const desiredHeading = rankDelta > 0 ? 0 : 180;
  const visitedPanos = new Set(Array.isArray(agent.visitedPanos) ? agent.visitedPanos : []);
  const validCandidates = options
    .map((option, index) => ({
      index,
      visited: visitedPanos.has(option?.panoId),
      labelCorridor: corridorFromText(option?.label),
      score: optionDirectionScore(option, desiredHeading),
      delta: headingDelta(option?.heading, desiredHeading)
    }))
    .filter(item => {
      if (!Number.isFinite(item.score) || item.delta > 75) return false;
      if (
        item.labelCorridor?.key === local.key &&
        target.key !== local.key &&
        !hasConnectorRouteComponent(options[item.index]?.label)
      ) {
        return false;
      }
      return true;
    });
  const unvisitedCandidates = validCandidates.filter(item => !item.visited);
  const scored = (unvisitedCandidates.length > 0 ? unvisitedCandidates : validCandidates)
    .sort((a, b) => a.score - b.score || a.index - b.index);

  if (!scored[0]) return null;
  return {
    selectedIndex: scored[0].index,
    desiredDirection: desiredHeading === 0 ? 'north' : 'south',
    target: target.label,
    local: local.label
  };
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

function operationTextValue(operation) {
  if (!operation || typeof operation !== 'object') return '';
  const type = String(operation.type || '').toLowerCase();
  if (type === 'text') return operation.text || '';
  if (type === 'landmark') return operation.label || operation.text || '';
  return '';
}

function isRenderedReplacementOperation(operation) {
  if (!operation || typeof operation !== 'object') return false;
  return String(operation.type || '').toLowerCase() !== 'replacemine';
}

function filterPartnerEchoPadOperations(padOperations, { agent = {}, options = [], partnerPadText = [] } = {}) {
  if (!Array.isArray(padOperations) || padOperations.length === 0) return [];
  const partnerKeys = placeKeysFromTexts(partnerPadText);
  if (partnerKeys.size === 0) return padOperations;

  const ownKeys = placeKeysFromTexts([
    ...options.map(option => option?.label),
    agent.currentRouteLabel,
    agent.recentMovement
  ]);

  const filtered = padOperations.filter(operation => {
    const key = placeKeyFromText(operationTextValue(operation));
    return !key || !partnerKeys.has(key) || ownKeys.has(key);
  });
  const hasReplaceMine = filtered.some(operation => String(operation?.type || '').toLowerCase() === 'replacemine');
  if (!hasReplaceMine) return filtered;
  if (filtered.some(isRenderedReplacementOperation)) return filtered;
  return filtered.filter(operation => String(operation?.type || '').toLowerCase() !== 'replacemine');
}

function sanitizeDecision(raw, optionCount, { canEditPad, forcePass, agent, options, partnerPadText }) {
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
      ? filterPartnerEchoPadOperations(raw.padOperations.slice(0, SCRATCHPAD_MAX_OPS_PER_TURN), {
          agent,
          options,
          partnerPadText
        })
      : [],
    passPad: canEditPad && (forcePass || raw?.passPad === true),
    fallbackCause: null
  };
}

function hasPlaceText(texts, label) {
  const targetKey = placeKeyFromText(label);
  if (!targetKey) return false;
  return Array.isArray(texts) && texts.some(text => placeKeyFromText(text) === targetKey);
}

function decisionHasPlaceText(decision, label) {
  const targetKey = placeKeyFromText(label);
  if (!targetKey) return false;
  return (decision?.padOperations || [])
    .some(operation => placeKeyFromText(operationTextValue(operation)) === targetKey);
}

function decisionReplacesOwnInk(decision) {
  return (decision?.padOperations || [])
    .some(operation => String(operation?.type || '').toLowerCase() === 'replacemine');
}

function withPolicyLocalInk(decision, policy, { canEditPad = false, ownPadText = [] } = {}) {
  if (!canEditPad || !policy?.local) return decision;
  const existingOwnInkSurvives = !decisionReplacesOwnInk(decision);
  if (
    (existingOwnInkSurvives && hasPlaceText(ownPadText, policy.local)) ||
    decisionHasPlaceText(decision, policy.local)
  ) {
    return decision;
  }
  if ((decision.padOperations || []).length >= SCRATCHPAD_MAX_OPS_PER_TURN) return decision;
  return {
    ...decision,
    padOperations: [
      ...(decision.padOperations || []),
      {
        type: 'text',
        text: policy.local,
        at: { x: 0.12, y: 0.86 },
        size: 20,
        rotation: 0
      }
    ],
    passPad: true
  };
}

function applyConvergencePolicy(decision, policy, { canEditPad = false, ownPadText = [] } = {}) {
  if (!policy || !Number.isFinite(policy.selectedIndex)) return decision;
  if (decision.selectedIndex === policy.selectedIndex) {
    return withPolicyLocalInk(decision, policy, { canEditPad, ownPadText });
  }
  return withPolicyLocalInk({
    ...decision,
    selectedIndex: policy.selectedIndex,
    reasoning: `I treat my friend's ${policy.target} ink as their own observed place, not a route command, so from ${policy.local} I choose the available ${policy.desiredDirection} connection.`
  }, policy, { canEditPad, ownPadText });
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
    partnerPadText = [],
    ownPadText = [],
    forcePass = false
  }) {
    if (!Array.isArray(options) || options.length === 0) {
      throw new Error('Rendezvous model requires at least one movement option');
    }

    const optionLines = options.map((option, index) => {
      const visited = agent.visitedPanos?.includes(option.panoId) ? 'walked before' : 'unfamiliar';
      const label = option.label ? `; Street View label: ${option.label}` : '';
      const heading = Math.round(Number(option.heading) || 0);
      return `Option ${index}: heading ${heading} degrees (${compassDirection(heading)}); ${visited}${label}`;
    }).join('\n');
    const privateMemory = (agent.recentNotes || [])
      .filter(note => !/model (?:is|was) unavailable/i.test(note))
      .slice(-5)
      .map(note => `- ${note}`)
      .join('\n') || '- No prior field notes.';
    const recentMovement = agent.recentMovement
      ? String(agent.recentMovement).slice(0, 160)
      : 'No recent movement yet.';
    const currentRouteLabel = agent.currentRouteLabel
      ? String(agent.currentRouteLabel).slice(0, 120)
      : 'No previous visible route label yet.';
    const padInstruction = canEditPad
      ? `You have the physical scratchpad. You may add up to ${SCRATCHPAD_MAX_OPS_PER_TURN} operations. If your older visible ink is stale, start with {"type":"replaceMine"}; it removes only your visible marks from the current sheet and preserves ${partnerName}'s ink. ${forcePass ? `You have held it long enough and must pass it to ${partnerName} this turn.` : `Set passPad=true when the marks are useful enough to send to ${partnerName}.`}`
      : `You do not have the physical scratchpad right now (${padStatus}). You may remember the last version you saw, but padOperations must be empty and passPad must be false.`;
    const inkInstruction = agent.id === 'theo'
      ? `Your ink is blue. ${partnerName}'s ink is charcoal black.`
      : `Your ink is charcoal black. ${partnerName}'s ink is blue.`;
    const partnerInkTranscript = Array.isArray(partnerPadText) && partnerPadText.length > 0
      ? partnerPadText.slice(-6).map(text => `- ${String(text).slice(0, 80)}`).join('\n')
      : '- No legible text from your friend yet.';
    const ownInkTranscript = Array.isArray(ownPadText) && ownPadText.length > 0
      ? ownPadText.slice(-6).map(text => `- ${String(text).slice(0, 80)}`).join('\n')
      : '- No current legible place text from your own ink.';

    const systemPrompt = `You are ${agent.name}, one of two friends lost on different Manhattan street corners. Your only goal is to physically find ${partnerName}. You can walk through Google Street View and sometimes hold one shared paper scratchpad.

This is a real cooperative search, not a riddle-writing exercise. The scratchpad is the only information that ever crosses between you. You are never given ${partnerName}'s coordinates, path, distance, neighborhood, plans, or hidden state. Do not invent access to them. Street names and landmarks you can genuinely read or recognize are fair to write down.

${inkInstruction} Treat only ${partnerName}'s ink as a clue to their location or movement. Your own older marks are memory, not evidence about where ${partnerName} is. When both colors name places, pursue the place written in ${partnerName}'s color.

Choose one visible public route. Avoid indoor shops, private interiors, dead ends, and immediate loops. Use your own observations, your private memory, and the last scratchpad you personally saw.

Treat this as a practical search between friends sharing one real piece of paper. Make the sheet read like a compact map or symbol composition, not a transcript. Your marks should communicate your own currently observed intersection, street, or landmark, plus your own recent movement into this view. Do not use the sheet to tell ${partnerName} where to go, restate a shared target, copy ${partnerName}'s ink as your own claim, or write route advice. A concrete place your friend marked outranks generic exploration when choosing where you walk, but your new ink should remain self-evidence grounded in your personal Street View observations. Do not merely repeat a strategy such as "unfamiliar route." Prefer a stable street name, intersection, landmark symbol, or recent-movement sketch that helps the two of you infer each other's trails.

Google headings are compass bearings measured clockwise: 0° is north, 90° east, 180° south, and 270° west. Each option includes the computed compass word; trust it. Never describe or select a bearing as though it points in a different direction. Before choosing, identify the newest useful place your friend marked, infer its direction from your own visible street using Manhattan geography, then choose the route whose compass label best matches that direction. Your friend's ink is evidence of their own observed place or movement, never a route command for you to copy. If ${partnerName}'s ink names a different Manhattan corridor, stop generic exploration and take an available connecting avenue or cross-street whose compass direction moves toward that named corridor. Numbered Manhattan streets increase as you go north; W/E 14th St is north of Houston St, and Houston / Carmine / Bleecker / Prince / Greenwich Village corridors are south of 14th St. So from W 14th toward a friend's W Houston mark, choose a southbound connection; from W Houston or Carmine toward a friend's W 14th mark, choose a northbound connection. Walking back one block is valid when it is necessary to pursue your friend's clue. Only prioritize novelty when the sheet contains no actionable friend location.

${padInstruction}

Drawing operation grammar uses normalized 0-1 canvas coordinates:
- {"type":"replaceMine"} removes only your currently visible stale ink before your new marks.
- {"type":"text","text":"BROADWAY","at":{"x":0.12,"y":0.18},"size":30,"rotation":-3}
- {"type":"arrow","from":{"x":0.2,"y":0.5},"to":{"x":0.7,"y":0.5},"width":4}
- {"type":"line","from":...,"to":...,"width":4}
- {"type":"circle","center":{"x":0.5,"y":0.5},"radiusX":0.12,"radiusY":0.08,"width":4}
- {"type":"landmark","center":{"x":0.5,"y":0.5},"symbol":"station","label":"GRAND CENTRAL","width":4}
- {"type":"stroke","points":[{"x":0.1,"y":0.2},{"x":0.2,"y":0.3}],"width":4}

The sheet is finite. Use a few intentional primitives: street/intersection strokes, one landmark symbol, one directional arrow for where you just came from or how you just moved, and at most a couple of very short proper-noun labels that you can personally see. Text is annotation, not the main message. Do not write "go", "follow", "toward", "to", "meet", target names, or instructions. Avoid repeated parallel lines and repeated labels; revise your own stale ink with replaceMine instead of stacking more marks.

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
        text: `These are the routes visible from your current panorama. Image 1 is the last scratchpad version you personally saw; the remaining images correspond to options 0 through ${options.length - 1} in order.\n\n${optionLines}\n\nYour private field memory:\n${privateMemory}\n\nYour recent movement into this view:\n- ${recentMovement}\n\nYour own last selected visible route label:\n- ${currentRouteLabel}\n\nAccessibility readout of current place text visibly written in your own ink:\n${ownInkTranscript}\n\nAccessibility readout of the exact text visibly written in ${partnerName}'s ink:\n${partnerInkTranscript}\n\nScratchpad status: ${padStatus}`
      },
      {
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${scratchpadBuffer.toString('base64')}`,
          detail: 'high'
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
        const decision = sanitizeDecision(raw, options.length, {
          canEditPad,
          forcePass,
          agent,
          options,
          partnerPadText
        });
        const policy = selectConvergencePolicyOption({ agent, options, partnerPadText, ownPadText });
        return applyConvergencePolicy(decision, policy, { canEditPad, ownPadText });
      } catch (error) {
        lastError = error;
        this.logger.warn?.(`Rendezvous model attempt ${attempt}/${this.maxAttempts} failed: ${error.message}`);
        if (/blank content/i.test(error?.message || '')) {
          attemptMaxTokens = Math.min(this.maxRetryTokens, Math.max(attemptMaxTokens * 2, 3200));
        }
      }
    }

    const status = lastError?.status ?? lastError?.response?.status;
    const fallback = fallbackDecision(
      options,
      agent.visitedPanos || [],
      status ? `api_error_${status}` : 'model_error',
      { canEditPad, forcePass }
    );
    const policy = selectConvergencePolicyOption({ agent, options, partnerPadText, ownPadText });
    return applyConvergencePolicy(fallback, policy, { canEditPad, ownPadText });
  }
}

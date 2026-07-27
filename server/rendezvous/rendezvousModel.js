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

function validateCorroborationProvenance(
  beliefUpdate,
  { sheetSequence = null, groundedNewEvidence = [], informationNovelty = 'unclear' } = {}
) {
  if (beliefUpdate?.evidenceStatus !== 'new_corroboration') return beliefUpdate;
  const currentSequence = Math.floor(Number(sheetSequence));
  const citesCurrentSheet = Number.isFinite(currentSequence) &&
    beliefUpdate.basisSequences.includes(currentSequence);
  const hasGroundedNewEvidence = Array.isArray(groundedNewEvidence) &&
    groundedNewEvidence.length > 0;
  if (
    citesCurrentSheet &&
    hasGroundedNewEvidence &&
    informationNovelty !== 'repeated'
  ) {
    return beliefUpdate;
  }
  return {
    ...beliefUpdate,
    evidenceStatus: !hasGroundedNewEvidence || informationNovelty === 'repeated'
      ? 'repetition_only'
      : 'unclear'
  };
}

const OUTBOUND_CONTRIBUTION_KINDS = Object.freeze([
  'local_observation',
  'own_action',
  'response',
  'question',
  'correction',
  'acknowledgement',
  'deliberate_repetition'
]);

const LOW_INFORMATION_URBAN_WORDS = new Set([
  'a', 'an', 'and', 'asphalt', 'at', 'ahead', 'axis', 'building', 'buildings', 'car',
  'black', 'bold', 'bordered', 'both', 'broad', 'busy', 'by', 'cars', 'city', 'corner', 'cross', 'crossing', 'crossings', 'crosswalk',
  'crosswalks', 'curb', 'central', 'distance', 'distant', 'environment', 'far', 'foreground', 'in', 'intersection',
  'expansive', 'flanked', 'intersections', 'lane', 'lanes', 'lengthy', 'lined', 'local', 'long',
  'marked', 'marking', 'markings', 'multiple', 'narrow', 'narrowed', 'narrowing', 'new',
  'observation', 'of', 'on', 'pedestrian', 'pedestrians', 'point', 'recede', 'recedes', 'receding',
  'road', 'roads', 'scene', 'side', 'sides', 'sidewalk', 'sidewalks', 'straight', 'street', 'traffic',
  'streets', 'stripe', 'striped', 'stripes', 'surrounded', 'tall', 'the', 'urban', 'vehicle',
  'vehicles', 'vanishing', 'visible', 'white', 'wide', 'widened', 'widening', 'widthy', 'with',
  'toward', 'towards'
]);

function isLowInformationUrbanObservation(description) {
  const words = cleanString(description, 500).toLowerCase().match(/[a-z]+/g) || [];
  if (words.length === 0) return true;
  const hasGenericStreetAnchor = words.some(word =>
    [
      'axis', 'building', 'buildings', 'city', 'crossing', 'crosswalk', 'curb', 'intersection',
      'lane', 'pedestrian', 'pedestrians', 'road', 'sidewalk', 'street', 'traffic',
      'vehicle', 'vehicles'
    ]
      .includes(word)
  );
  return hasGenericStreetAnchor && words.every(word => LOW_INFORMATION_URBAN_WORDS.has(word));
}

export function isConcreteLocalEvidence(description) {
  const value = cleanString(description, 220);
  if (!value || value.toLowerCase() === 'context') return false;
  if (/\bstreet\s+(?:label|name)\b/i.test(value) || containsNamedStreetReference(value)) {
    return false;
  }
  if (isLowInformationUrbanObservation(value)) return false;
  return !/\b(?:arrow|implied|suggests?|cue|motif|route|waypoint|shared|prior|sheet|partner|destination|coordinate|map|grid|star|intersection context)\b/i
    .test(value);
}

function atomizeLocalEvidenceDescription(description) {
  return cleanString(description, 500)
    .split(/\s*;\s*|(?<=[.!?])\s+(?=[A-Z])/)
    .flatMap(segment => segment.length >= 80
      ? segment.split(/\s+(?:with|and)\s+/i)
      : [segment])
    .map(segment => segment.trim())
    .filter(Boolean);
}

const VISUAL_SIMILARITY_STOPWORDS = new Set([
  'about', 'ahead', 'along', 'also', 'and', 'around', 'away', 'background',
  'been', 'being', 'both', 'city', 'could', 'distance', 'distant', 'down',
  'foreground', 'from', 'into', 'large', 'left', 'might', 'one', 'other',
  'person', 'right', 'scene', 'shows', 'side', 'street', 'the', 'their',
  'there', 'these', 'they', 'this', 'through', 'toward', 'towards', 'urban',
  'viewer', 'visible', 'with', 'would'
]);

function normalizeVisualToken(token) {
  if (/(?:ches|shes|xes|zes|ses)$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && /s$/.test(token) && !/ss$/.test(token)) return token.slice(0, -1);
  return token;
}

function visualDescriptionTokens(value) {
  const description = cleanString(value, 500).toLowerCase();
  const tokens = new Set((description.match(/[a-z][a-z'-]{2,}/g) || [])
    .map(normalizeVisualToken)
    .filter(token => !VISUAL_SIMILARITY_STOPWORDS.has(token)));
  if (
    /\bmidtown(?:-scale)?\b/.test(description) ||
    /\burban canyon\b/.test(description) ||
    /\b(?:tall|high-rise|multi-?story)\b[^.!;]{0,40}\b(?:building|tower)s?\b/.test(description)
  ) {
    tokens.add('dense-highrise-scale');
  }
  return tokens;
}

function visualDescriptionSimilarity(first, second) {
  const a = visualDescriptionTokens(first);
  const b = visualDescriptionTokens(second);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  return shared / Math.min(a.size, b.size);
}

function contributionEvidenceText(value) {
  return cleanString(value, 700)
    .replace(/^(?:New local observation|My current chosen action|Question I am sending|Correction I am sending|Acknowledging received visual evidence without claiming it as my own|Deliberately repeating existing visual evidence without treating it as new):\s*/i, '');
}

const ROUTE_COMMAND_CUES = [
  'arrow',
  'direction',
  'directional',
  'footprint',
  'journey',
  'move',
  'moved',
  'movement',
  'moving',
  'path',
  'perspective',
  'progress',
  'progression',
  'recede',
  'receding',
  'route',
  'run',
  'runner',
  'running',
  'vanishing',
  'walk',
  'walking'
];

function routeCommandCues(value) {
  const positiveText = cleanString(value, 2400).replace(
    /\b(?:avoid|exclude|instead of|no|omit|remove|without)\b[^.!;]{0,140}/gi,
    ' '
  );
  const tokens = visualDescriptionTokens(positiveText);
  return ROUTE_COMMAND_CUES.filter(token =>
    [...tokens].some(candidate => candidate === token || candidate === `${token}s`)
  );
}

function responseWithholdsRouteCertainty(value) {
  return /\b(?:does not|doesn't|cannot|can't|no)\b[^.!;]{0,100}\b(?:cue|destination|direction|endpoint|meeting point|path|rendezvous|route)\b/i
    .test(cleanString(value, 1200));
}

export function responseDrawingContradictsRouteUncertainty(message) {
  if (
    message?.contributionKind !== 'response' ||
    !responseWithholdsRouteCertainty(message?.contributionSummary || message?.informationDelta)
  ) {
    return false;
  }
  const citedRouteCues = routeCommandCues(
    message?.contributionSummary || message?.informationDelta
  );
  return routeCommandCues(
    `${message?.drawingIntent || ''} ${message?.drawingPrompt || ''}`
  ).some(cue => !citedRouteCues.includes(cue));
}

export function responseInventsRouteCoordination(message) {
  if (!['response', 'deliberate_repetition'].includes(message?.contributionKind)) return false;
  const contribution = contributionEvidenceText(
    message?.contributionSummary || message?.informationDelta || ''
  );
  const positiveText = cleanString(
    `${contribution} ${message?.drawingIntent || ''}`,
    1800
  ).replace(
    /\b(?:do not|does not|doesn't|never|not|rather than|without)\b[^.!;]{0,120}/gi,
    ' '
  );
  const affirmativeCoordination =
    /\b(?:align|coordinat|favor|recommend|support|synchroniz)\w*\b[^.!;]{0,120}\b(?:advanc|continu|cross|follow|head|mov|proceed|travel|walk)\w*\b/i;
  const coordinatedRoute =
    /\b(?:coordinat|synchroniz)\w*\b[^.!;]{0,100}\b(?:axis|corridor|crossing|direction|path|route)\b/i;
  return affirmativeCoordination.test(positiveText) || coordinatedRoute.test(positiveText);
}

function questionContrastsStillnessAndMovement(value) {
  const text = cleanString(value, 1200);
  return /\b(?:hold|pause|remain|stay|still|stop|wait)\w*\b/i.test(text) &&
    /\b(?:advance|continue|move|proceed|travel|walk)\w*\b/i.test(text);
}

function responseExplicitlyDirectsRecipient(value) {
  const evidence = contributionEvidenceText(value);
  const movement = '(?:advance|continue|follow|go|head|move|proceed|take|travel|turn|walk)';
  const recipient = '(?:ada|theo|friend|partner|recipient|viewer|you)';
  return new RegExp(`^\\s*(?:please\\s+)?${movement}\\b`, 'i').test(evidence) ||
    new RegExp(`\\b${recipient}\\b[^.!;]{0,100}\\b(?:should\\s+)?${movement}\\w*\\b`, 'i')
      .test(evidence) ||
    new RegExp(`\\b${movement}\\w*\\b[^.!;]{0,100}\\b${recipient}\\b`, 'i')
      .test(evidence);
}

function namedCompassDirections(...values) {
  const text = values.map(value => cleanString(value, 2400)).join(' ').toLowerCase();
  return [...new Set(
    ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']
      .filter(direction => new RegExp(`\\b${direction}\\b`).test(text))
  )];
}

function historicalSheetLiteralContents(privateMemory, currentSequence) {
  return (privateMemory?.receivedSheets || [])
    .filter(sheet => Number(sheet?.sequence) !== Number(currentSequence))
    .slice(-6)
    .flatMap(sheet => cleanStringList(sheet?.literalContents, { limit: 6, maxLength: 220 }));
}

function genericMovementProposition(value) {
  const text = cleanString(value, 1200).toLowerCase();
  return /\b(?:figure|friend|pedestrian|person|runner|someone|walker)\b/.test(text) &&
    /\b(?:advance|depart|follow|head|move|moving|proceed|run|running|travel|walk|walking)\w*\b/.test(text) &&
    /\b(?:arrow|away|corridor|direction|distance|footprints?|forward|path|route|sidewalk|street|trail)\b/.test(text);
}

function routeMeaningQuestion(value) {
  const text = contributionEvidenceText(value);
  return /\bliteral\w*\b/i.test(text) &&
    /\bsymbolic\w*\b/i.test(text) &&
    /\b(?:axis|cue|direction|hint|move|movement|path|route|signal)\w*\b/i.test(text);
}

function dominantSheetDescription(perception) {
  return cleanString(
    perception?.primarySubject ||
      perception?.sheetInterpretation ||
      perception?.literalContents?.[0],
    700
  );
}

function dominantSheetPropositionRepeats(perception, privateMemory, currentSequence) {
  const current = dominantSheetDescription(perception);
  if (!current) return false;
  return (privateMemory?.receivedSheets || [])
    .filter(sheet => Number(sheet?.sequence) !== Number(currentSequence))
    .slice(-6)
    .some(sheet => {
      const previous = cleanString(
        sheet?.primarySubject || sheet?.interpretation || sheet?.literalContents?.[0],
        700
      );
      if (!previous) return false;
      return visualDescriptionSimilarity(current, previous) >= 0.55 ||
        (genericMovementProposition(current) && genericMovementProposition(previous));
    });
}

function splitCurrentSheetEvidence(perception, privateMemory, currentSequence) {
  const historical = historicalSheetLiteralContents(privateMemory, currentSequence);
  const current = cleanStringList(perception?.literalContents, { limit: 6, maxLength: 220 });
  const dominantRepeated = dominantSheetPropositionRepeats(
    perception,
    privateMemory,
    currentSequence
  );
  if (historical.length === 0) {
    return { novel: current, repeated: [], dominantRepeated };
  }
  const split = current.reduce((result, description) => {
    const similarity = Math.max(...historical.map(previous =>
      visualDescriptionSimilarity(description, previous)
    ));
    result[similarity >= 0.55 ? 'repeated' : 'novel'].push(description);
    return result;
  }, { novel: [], repeated: [] });
  return { ...split, dominantRepeated };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const NAMED_STREET_PATTERN =
  /\b(?:[NSEW]\.?\s+)?(?:\d+(?:st|nd|rd|th)?|[A-Z][A-Za-z'.-]*)(?:\s+(?:\d+(?:st|nd|rd|th)?|[A-Z][A-Za-z'.-]*)){0,3}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Place|Pl|Parkway|Pkwy|Highway|Hwy)\b/g;

function containsNamedStreetReference(description) {
  NAMED_STREET_PATTERN.lastIndex = 0;
  return NAMED_STREET_PATTERN.test(cleanString(description, 2400));
}

function sanitizeOutboundPlaceNames(description, routeLabels = [], maxLength = 2400) {
  let value = cleanString(description, maxLength)
    .replace(
      /\b[A-Z][A-Za-z0-9'.-]*(?:\s+[A-Z][A-Za-z0-9'.-]*)?\s*\/\s*[A-Z][A-Za-z0-9'.-]*(?:\s+[A-Z][A-Za-z0-9'.-]*)?(?:\s+(?:intersection|anchor|corner))?\b/g,
      'local street corner'
    )
    .replace(NAMED_STREET_PATTERN, 'local street');
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
  const waitLanguage = /\b(?:await|hold|pause|remain|stay|wait|waiting)\w*\b/i;
  const interpretiveDependency =
    /\b(?:ada|theo|friend|partner|drawing|sheet)\b[^.!;]{0,120}\b(?:clarif|confirm|mean|signal|show)\w*\b/i.test(positiveText) ||
    /\b(?:clarif|confirm|learn|see|understand)\w*\b[^.!;]{0,120}\b(?:ada|theo|friend|partner)\b[^.!;]{0,80}\b(?:intend|mean|signal|want)\w*\b/i.test(positiveText) ||
    /\b(?:scene|situation)\b[^.!;]{0,80}\bclarif\w*\b[^.!;]{0,120}\b(?:ada|theo|friend|partner)\b/i.test(positiveText) ||
    /\b(?:clearer|future|later|next|new)\s+(?:drawing|sheet)\b/i.test(positiveText) ||
    /\b(?:drawing|sheet)\s+from\s+(?:ada|theo|friend|partner)\b[^.!;]{0,100}\bbefore\b/i.test(positiveText);
  if (waitLanguage.test(positiveText) && interpretiveDependency) return true;
  const partnerCuePattern = /\b(?:authorization|cue|permission|signal from (?:ada|theo|my friend|the friend|my partner|the partner)|(?:ada|theo|my friend|the friend|my partner|the partner)(?:'s|’s)? (?:authorization|cue|permission|signal)|(?:ada|theo|my friend|the friend|my partner|the partner) (?:to )?(?:authoriz\w*|cu\w*|instruct\w*|signal\w*))\b/i;
  if (!partnerCuePattern.test(positiveText)) return false;
  if (waitLanguage.test(positiveText)) return true;
  if (
    /\b(?:ada|theo|my friend|the friend|my partner|the partner)(?:'s|’s)?\s+(?:future|later|next)?\s*(?:cue|signal)\b/i
      .test(positiveText)
  ) {
    return true;
  }
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
  const add = (prefix, values, { concreteLocalOnly = false, kind = '' } = {}) => {
    cleanStringList(values, { limit: 6, maxLength: 220 })
      .map(description => sanitizeOutboundPlaceNames(description, routeLabels, 220))
      .filter(description => !concreteLocalOnly || isConcreteLocalEvidence(description))
      .filter(Boolean)
      .forEach((description, index) => {
      catalog.push({ id: `${prefix}:${index}`, kind, description });
    });
  };
  add('local', routeDecision.observedFeatures, {
    concreteLocalOnly: true,
    kind: 'local_observation'
  });
  add('question_local', routeDecision.observedFeatures, {
    concreteLocalOnly: true,
    kind: 'question'
  });
  add('action', [describeChosenAction(routeDecision, options)], { kind: 'own_action' });
  add('received', perception.literalContents, { kind: 'acknowledgement' });
  add('response', perception.evidenceDelta.informationWorthSending, { kind: 'response' });
  add('question', perception.evidenceDelta.unresolvedQuestions, { kind: 'question' });
  add('contradiction', perception.evidenceDelta.contradictions, { kind: 'correction' });
  add('prior_sent', (privateMemory?.sentMessages || []).slice(-6).map(message =>
    message.informationDelta || message.intent
  ), { kind: 'deliberate_repetition' });
  return catalog;
}

function validContributionEvidencePrefix(kind, evidenceId) {
  const prefix = String(evidenceId || '').split(':')[0];
  if (kind === 'local_observation') return prefix === 'local';
  if (kind === 'own_action') return prefix === 'action';
  if (kind === 'response') return prefix === 'response';
  if (kind === 'question') return prefix === 'question' || prefix === 'question_local';
  if (kind === 'correction') return prefix === 'contradiction';
  if (kind === 'acknowledgement') return prefix === 'received';
  if (kind === 'deliberate_repetition') return prefix === 'prior_sent' || prefix === 'received';
  return false;
}

function contributionKindForEvidenceId(evidenceId) {
  const prefix = String(evidenceId || '').split(':')[0];
  if (prefix === 'local') return 'local_observation';
  if (prefix === 'action') return 'own_action';
  if (prefix === 'response') return 'response';
  if (prefix === 'question' || prefix === 'question_local') return 'question';
  if (prefix === 'contradiction') return 'correction';
  if (prefix === 'received') return 'acknowledgement';
  if (prefix === 'prior_sent') return 'deliberate_repetition';
  return null;
}

function authoritativeContributionSummary(kind, description, evidenceId = '') {
  const evidence = cleanString(description, 300);
  if (kind === 'local_observation') return `New local observation: ${evidence}`;
  if (kind === 'own_action') return `My current chosen action: ${evidence}`;
  if (kind === 'response') return `My response to the received drawing: ${evidence}`;
  if (kind === 'question') {
    return String(evidenceId).startsWith('question_local:')
      ? `Question I am sending about this local evidence: ${evidence}`
      : `Question I am sending: ${evidence}`;
  }
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

const BELIEF_TERM_STOPWORDS = new Set([
  'about', 'above', 'across', 'ada', 'after', 'along', 'anchor', 'appears', 'area', 'around', 'arrow',
  'before', 'behind', 'belief', 'below', 'beside', 'between', 'beyond',
  'central', 'choose', 'chosen', 'continue', 'continued', 'continuing', 'convention', 'current', 'decision',
  'destination', 'diagonal', 'directional', 'distant', 'district', 'during', 'each', 'ending', 'endpoint', 'exact',
  'fixed', 'friend', 'from', 'goal', 'grid',
  'guiding', 'hand', 'inland', 'intend', 'intends', 'intention', 'interpretation',
  'inside', 'joint', 'landmark', 'latest', 'local', 'mark', 'marks', 'meaning', 'meeting', 'move', 'moves',
  'movement', 'near', 'newest', 'next', 'only', 'outside', 'partner', 'past', 'path', 'physical',
  'place', 'point', 'possible',
  'progression', 'public', 'recurring', 'reorientation', 'rendezvous', 'right', 'right-hand', 'route',
  'seek', 'seeking', 'selected', 'sender', 'shared', 'should', 'signaling', 'specifying', 'storefront',
  'street', 'symbol', 'target', 'than', 'then', 'theo', 'through', 'toward', 'under', 'until', 'using',
  'visual', 'waypoint', 'when', 'where', 'whether', 'which', 'while', 'with', 'without'
]);

function unsupportedPartnerHypothesisTerms(privateMemory, candidateUpdate = null) {
  const candidateKey = cleanString(candidateUpdate?.key, 80);
  return [...new Set((privateMemory?.partnerHypotheses || [])
    .filter(belief => {
      if (belief?.evidenceStatus === 'new_corroboration') return false;
      return !(
        candidateKey &&
        candidateKey === cleanString(belief?.key, 80) &&
        candidateUpdate?.evidenceStatus === 'new_corroboration'
      );
    })
    .flatMap(belief =>
      `${cleanString(belief?.key, 80)} ${cleanString(belief?.description, 500)}`
        .toLowerCase()
        .match(/[a-z][a-z0-9'-]{3,}/g) || []
    )
    .filter(term => !BELIEF_TERM_STOPWORDS.has(term)))];
}

function unsupportedPartnerHypothesisGoalTerm(
  privateMemory,
  candidateUpdate,
  ...descriptions
) {
  const terms = unsupportedPartnerHypothesisTerms(privateMemory, candidateUpdate);
  if (terms.length === 0) return '';
  const goalLanguage = /\b(?:approach|destination|ending?|goal|head(?:ing)?|progress(?:ion)?|reach|target|toward|towards|waypoint)\b/i;
  const uncertainty = /\b(?:uncertain|unresolved|possibly|possible|hypothesis|hypothetical|question|whether|maybe|may|might|could|perhaps|test|testable|provisional|verify|clarify|investigate|explore)\b/i;
  for (const statement of descriptions
    .flatMap(value => cleanString(value, 2400).split(/[.!?;]+/))) {
    if (!goalLanguage.test(statement) || uncertainty.test(statement)) continue;
    const lower = statement.toLowerCase();
    const matchedTerm = terms.find(term =>
      new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(lower)
    );
    if (matchedTerm) return matchedTerm;
  }
  return '';
}

function unsupportedCurrentSheetAttribution(
  privateMemory,
  routeReconciliation,
  ...descriptions
) {
  const terms = unsupportedPartnerHypothesisTerms(
    privateMemory,
    routeReconciliation?.partnerHypothesis
  );
  if (terms.length === 0) return '';
  const currentEvidence = [
    ...(routeReconciliation?.evidenceDelta?.newEvidence || []),
    ...(routeReconciliation?.evidenceDelta?.repeatedEvidence || [])
  ].map(value => cleanString(value, 500).toLowerCase());
  const statements = descriptions
    .flatMap(value => cleanString(value, 2400).split(/[.!?;]+/))
    .filter(statement =>
      /\b(?:current|latest|newest|new)\s+(?:drawing|evidence|sheet)\b/i.test(statement)
    );
  for (const statement of statements) {
    const lower = statement.toLowerCase();
    const matchedTerm = terms.find(term =>
      new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(lower) &&
      !currentEvidence.some(evidence =>
        new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(evidence)
      )
    );
    if (matchedTerm) return matchedTerm;
  }
  return '';
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

export function reconcileRendezvousContributionAction(
  contributionKind,
  contributionSummary,
  requestedAction,
  ...descriptions
) {
  const evidence = cleanString(contributionSummary, 500);
  if (contributionKind === 'own_action') {
    if (/\bchose to wait\b/i.test(evidence)) return 'stillness';
    if (/\bchose to (?:move|retrace)\b/i.test(evidence)) return 'movement';
  }
  if (
    contributionKind === 'local_observation' &&
    (
      requestedAction === 'transition' ||
      (
        requestedAction === 'movement' &&
        !(
          /\b(?:cyclist|pedestrian|person|runner|someone|vehicle|car|bus|truck|traffic)\b[^.!;]{0,80}\b(?:approach|cross|depart|head|move|ride|run|travel|walk)\w*\b/i
            .test(evidence) ||
          /\b(?:approach|cross|depart|head|move|ride|run|travel|walk)\w*\b[^.!;]{0,80}\b(?:cyclist|pedestrian|person|runner|someone|vehicle|car|bus|truck|traffic)\b/i
            .test(evidence)
        )
      )
    )
  ) {
    return 'unclear';
  }
  return reconcileRendezvousMessageAction(requestedAction, ...descriptions);
}

function sanitizeSheetPerception(raw) {
  const sheetInterpretation = cleanString(raw?.sheetInterpretation, 700);
  const numericConfidence = Number(raw?.sheetConfidence);
  const frameOfReference = ['sender', 'recipient', 'shared', 'unclear'].includes(raw?.frameOfReference)
    ? raw.frameOfReference
    : 'unclear';
  const communicationFunction = [
    'report',
    'request',
    'question',
    'acknowledgement',
    'correction',
    'shared_proposal',
    'unclear'
  ].includes(raw?.communicationFunction)
    ? raw.communicationFunction
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
    primarySubject: cleanString(raw?.primarySubject, 400),
    communicationFunction,
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
  const observedFeatures = cleanStringList(raw?.observedFeatures, { limit: 20 })
    .filter(isConcreteLocalEvidence)
    .slice(0, 5);
  const rawObservation = cleanString(raw?.observation, 700);
  const observation = isConcreteLocalEvidence(rawObservation)
    ? rawObservation
    : observedFeatures.join('; ');
  return {
    action,
    selectedIndex,
    intendedHeading,
    waitTurns: action === 'wait' ? Math.min(6, Math.max(1, Math.floor(Number(raw?.waitTurns) || 1))) : 0,
    reasoning: cleanString(raw?.reasoning, 700) || 'I choose the most promising unfamiliar public route.',
    observation,
    observedFeatures,
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

function copiesSheetRoute(...descriptions) {
  const text = descriptions.map(value => cleanString(value, 1200)).join(' ');
  const positiveText = text.replace(
    /\b(?:do not|don't|never|not|without)\b[^.!?;]{0,120}/gi,
    ' '
  );
  const statements = positiveText
    .split(/[.!?;]+/)
    .map(value => value.trim())
    .filter(Boolean);
  const cue = '(?:arrows?|cues?|depicted|direction|drawings?|footprints?|forward(?:-movement)? frame|indicated|implied|latest sheets?|motifs?|new sheets?|newest sheets?|path|prompts?|route|sheets?|sketch(?:es)?|visuals?|vector)';
  const copyAction = '(?:align(?:s|ed|ing)? with|continue|follow|in line with|mirror|move|preserve|proceed|pursue|reproduce)';
  const crossClausePrompt = /\b(?:drawing|sheet)\b[^.!?]{0,180}\b(?:cue|prompt)\b[^.!?]{0,140}\b(?:advanc|continu|head|keep|move|proceed)\w*\b/i
    .test(positiveText);
  const crossClauseCoordination =
    /\b(?:latest|newest|new)\s+sheet\b[^.!;]{0,160}\b(?:coordinat|synchroniz)\w*\b[^.!]{0,140}[.;][^.!;]{0,120}\b(?:advanc|continu|head|mov|proceed)\w*\b/i
      .test(positiveText);
  const attributedSharedPush =
    /\b(?:arrows?|cues?|drawings?|sheets?|signals?|sketch(?:es)?|visuals?)\b[^.!;]{0,180}\bshared\s+(?:cue|invitation|push|signal)\b[^.!;]{0,60}\b(?:advanc|continu|head|move|press|proceed)\w*\b/i
      .test(positiveText);
  return crossClausePrompt || crossClauseCoordination || attributedSharedPush || statements.some(statement => {
    if (/\b(?:intercept|opposite|counter|cross(?:ing)? path)\b/i.test(statement)) return false;
    return new RegExp(`\\b${copyAction}\\b[^.!;]{0,120}\\b${cue}\\b`, 'i').test(statement) ||
      new RegExp(`\\b${cue}\\b[^.!;]{0,120}\\b(?:reinforce|suggest|tell|direct|ask|imply)\\w*\\b[^.!;]{0,100}\\b(?:continue|follow|move|proceed|advance|head)\\w*\\b`, 'i')
        .test(statement) ||
      /\b(?:latest|newest|new)\s+sheets?\b[^.!;]{0,160}\b(?:align|favor|hint|point|reinforce|support|suggest)\w*\b[^.!;]{0,100}\b(?:advanc|continu|head|move|proceed)\w*\b/i
        .test(statement) ||
      /\b(?:latest|newest|new)\s+evidence\b[^.!;]{0,120}\b(?:favor|indicate|point|reinforce|support|suggest)\w*\b[^.!;]{0,140}\b(?:advanc|continu|follow|head|move|proceed|pursue)\w*\b[^.!;]{0,100}\b(?:axis|corridor|path|route|vanishing point|way)\b/i
        .test(statement) ||
      /\b(?:latest|newest|new)\s+(?:drawings?|sheets?)\b[^.!;]{0,160}\b(?:emphasize|frame|indicate|invite|point|present|reinforce|show|suggest)\w*\b[^.!;]{0,120}\b(?:avenue|axis|continuation|corridor|direction|forward|motion|navigation|path|route|vanishing point|way)\b/i
        .test(statement) ||
      /\b(?:latest|newest|new)\s+sheets?\b[^.!;]{0,160}\b(?:align|correspond|fit|match)\w*\s+with\b[^.!;]{0,100}\b(?:continuation|corridor|direction|forward|path|route|street|stretch|way)\b/i
        .test(statement) ||
      /\b(?:follow|following|use|using|based on)\b[^.!;]{0,40}\b(?:latest|newest|new)\s+(?:drawings?|evidence|sheets?)\b[^.!;]{0,120}\b(?:advanc|continu|head|move|proceed)\w*\b/i
        .test(statement) ||
      /\b(?:align|correspond|fit|match)\w*\s+with\b[^.!;]{0,100}\b(?:drawing|fork|motif|sheet|symbol|visual)\b/i
        .test(statement) ||
      /\b(?:drawing|sheet)s?\b[^.!;]{0,100}\b(?:cue|frame|motif|path|route)s?\b[^.!;]{0,100}\b(?:advanc|continu|head|keep|move|proceed)\w*\b/i
        .test(statement) ||
      /\b(?:arrows?|cues?|drawings?|sheets?|motifs?|visuals?)\b[^.!;]{0,160}\b(?:favor|indicate|reinforce|signal|suggest|support)\w*\b[^.!;]{0,100}\b(?:advanc|continu|head|move|press|proceed)\w*\b/i
        .test(statement) ||
      /\b(?:move|continue|proceed|advance|head)\w*\b[^.!;]{0,80}\b(?:along|with|toward)\b[^.!;]{0,80}\b(?:indicated|implied|depicted|arrow|cue|vector)\b/i
        .test(statement);
  });
}

function sheetMayDirectRecipient(perception, routeReconciliation, sheetMessage) {
  const authoredContributionKind = cleanString(sheetMessage?.contributionKind, 40);
  if (authoredContributionKind !== 'shared_proposal') return false;
  return ['request', 'shared_proposal'].includes(perception?.communicationFunction) &&
    ['recipient', 'shared'].includes(perception?.frameOfReference) &&
    routeReconciliation?.propositionNovelty !== 'repeated' &&
    routeReconciliation?.evidenceDelta?.planAssessment === 'supporting';
}

function locallyGroundRouteLanguage(routeDecision, partnerName) {
  const feature = routeDecision.observedFeatures[0] || routeDecision.observation ||
    'the current public route options';
  const action = routeDecision.action === 'wait'
    ? 'remain at this recognizable branch'
    : routeDecision.action === 'retrace'
      ? 'retrace the selected public route'
      : 'take the selected public route';
  return {
    reasoning: `I choose to ${action} from what I can currently see: ${feature}. The newest drawing remains an unresolved report from ${partnerName}, not route guidance for me.`,
    currentPlan: `Use current local evidence for the chosen search action, while treating the newest drawing as an unresolved report from ${partnerName} rather than route guidance.`
  };
}

function matchingRecentSentPropositions(candidateDrawingPlan, privateMemory) {
  const contributionKind = candidateDrawingPlan?.contributionKind;
  if (
    !['local_observation', 'own_action', 'response', 'question', 'correction']
      .includes(contributionKind)
  ) {
    return [];
  }
  const currentEvidence = contributionEvidenceText(
    candidateDrawingPlan?.informationDelta || candidateDrawingPlan?.contributionSummary
  );
  const currentVisual = cleanString(
    `${candidateDrawingPlan?.drawingIntent || ''} ${candidateDrawingPlan?.drawingPrompt || ''}`,
    3000
  );
  if (!currentEvidence && !currentVisual) return [];
  const recentSentMessages = (privateMemory?.sentMessages || []).slice(-6);
  return recentSentMessages
    .filter(message => message?.contributionKind === contributionKind)
    .filter(message => {
      const previousEvidence = contributionEvidenceText(
        message?.informationDelta || message?.contributionSummary
      );
      const previousVisual = cleanString(
        `${message?.intent || ''} ${message?.contributionSummary || ''}`,
        1800
      );
      const repeatsEvidence = currentEvidence && previousEvidence &&
        visualDescriptionSimilarity(currentEvidence, previousEvidence) >= 0.72;
      const repeatsVisual = currentVisual && previousVisual &&
        visualDescriptionSimilarity(currentVisual, previousVisual) >= 0.6;
      return repeatsEvidence || repeatsVisual ||
        (
          contributionKind === 'question' &&
          routeMeaningQuestion(currentEvidence) &&
          routeMeaningQuestion(previousEvidence)
        ) ||
        (genericMovementProposition(currentVisual) && genericMovementProposition(previousVisual));
    });
}

export function repeatsRecentOutboundProposition(candidateDrawingPlan, privateMemory) {
  const contributionKind = candidateDrawingPlan?.contributionKind;
  if (
    !['local_observation', 'own_action', 'response', 'question', 'correction']
      .includes(contributionKind)
  ) {
    return false;
  }
  const currentEvidence = contributionEvidenceText(
    candidateDrawingPlan?.informationDelta || candidateDrawingPlan?.contributionSummary
  );
  const recentSentMessages = (privateMemory?.sentMessages || []).slice(-6);
  const matchingRecentMessages = matchingRecentSentPropositions(
    candidateDrawingPlan,
    privateMemory
  ).length;
  const recentReceivedObservations = contributionKind === 'local_observation'
    ? (privateMemory?.receivedSheets || []).slice(-6)
      .filter(sheet => ['report', 'shared_proposal', 'unclear'].includes(sheet?.communicationFunction))
    : [];
  const receivedVisualDescription = sheet => cleanString(
    [
      sheet?.primarySubject,
      ...(Array.isArray(sheet?.literalContents) ? sheet.literalContents : []),
      sheet?.interpretation
    ].filter(Boolean).join(' '),
    3000
  );
  const matchingReceivedObservations = recentReceivedObservations
    .filter(sheet => {
      const receivedVisual = receivedVisualDescription(sheet);
      return currentEvidence && receivedVisual &&
        visualDescriptionSimilarity(currentEvidence, receivedVisual) >= 0.72;
    });
  const latestMatchingReceived = matchingReceivedObservations.at(-1);
  const latestRelatedSent = latestMatchingReceived
    ? recentSentMessages
      .filter(message => message?.contributionKind === 'local_observation')
      .filter(message => Number(message?.sequence) < Number(latestMatchingReceived.sequence))
      .findLast(message => {
        const previousEvidence = contributionEvidenceText(
          message?.informationDelta || message?.contributionSummary
        );
        return currentEvidence && previousEvidence &&
          visualDescriptionSimilarity(currentEvidence, previousEvidence) >= 0.3;
      })
    : null;
  const alternatingEchoLoop = Boolean(latestMatchingReceived && latestRelatedSent);

  // A recurring observation, question, or correction may be useful once. After
  // that, the sender must either add information or label the repetition
  // honestly. Received observations count too, so the same postcard cannot
  // evade the limit by alternating authors. Generic action scenes are
  // challenged after the first recurrence.
  return matchingRecentMessages + matchingReceivedObservations.length >=
    (['local_observation'].includes(contributionKind) ? 2 : 1) ||
    alternatingEchoLoop;
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
        primarySubject: rememberedSheet.primarySubject,
        communicationFunction: rememberedSheet.communicationFunction,
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
  "primarySubject": "the largest, darkest, or most compositionally dominant visible subject or relationship",
  "possiblePlaces": ["private place hypothesis with uncertainty"],
  "possibleIntentions": ["private interpretation of what the sender may intend or ask"],
  "communicationFunction": "report" | "request" | "question" | "acknowledgement" | "correction" | "shared_proposal" | "unclear",
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
    const visualEvidenceSplit = splitCurrentSheetEvidence(
      perception,
      privateMemory,
      sheetMessage?.sequence
    );

    const systemPrompt = `You are ${agent.name}, one of two friends actively trying to find each other after becoming separated on unfamiliar streets. You both began in Manhattan, but the world is open. The only information you exchange is a wordless drawing passed back and forth.

You can use your own real-world knowledge when interpreting what you personally see or what a drawing might depict. You never receive ${partnerName}'s coordinates, path, route options, hidden reasoning, or actual destination. Treat every place and intention inferred from a drawing as a hypothesis whose confidence must follow the evidence.

You are at a genuine branch. Reconcile your current surroundings, private memory, and the newest drawing, then choose:
${actionGuidance}
Avoid indoor shops, private interiors, dead ends, and accidental immediate loops. Google headings are compass bearings clockwise from north.

This call chooses your action, reconciles the clean first-look reading with history, and revises your private plan. You and your friend are peers searching independently; a drawing supplies evidence, questions, and hypotheses, never permission that must arrive before you can act. Remove any leader/follower or "await their cue" premise inherited from memory when revising your plan. The newest sheet's literal contents are the highest-priority evidence for your friend's current visible action. History may explain a recurring motif, but it cannot turn a currently still drawing into evidence that the sender is presently moving. "New evidence" means information directly visible in the newest first-look reading that is absent from earlier sheets; recurring imagery and history-only beliefs belong under repeated evidence even when freshly rendered. Do not turn repetition into confirmation or assume a sender-framed route is an instruction for you.

Judge the dominant communicative proposition separately from incidental scenery. A newly rendered van, tree, or storefront can be a new visible detail while the dominant proposition remains the same generic report of a person moving away. Incidental details do not make a repeated movement proposition fresh support for copying its route. You may independently choose the same local heading, but justify that choice from your current route images or from an explicit, non-repeated spatial inference rather than following, aligning with, or reproducing a depicted route.

For every convention or partner hypothesis update, classify its evidence. "new_corroboration" requires an independently informative cue that supports the proposed meaning, not merely another appearance of the same symbol or your own motif echoed back to you. A new-corroboration update must cite the current sheet sequence in basisSequences and identify grounded new evidence from that sheet. Use "repetition_only" when a motif recurs without new support for its meaning, "weakened" when new evidence conflicts with it or meaningful movement fails a concrete prediction, and "unclear" when the relationship cannot be assessed. A convention can remain useful visual vocabulary while the hypothesis about what it means weakens. Revise your current plan accordingly: an uncorroborated symbol may be tested as a hypothesis, but not treated as a known shared physical destination.

If fresh environmental evidence supports only your local movement, it does not corroborate an inherited claim about what a recurring symbol means. When your revised plan mentions a distinctive motif from an uncorroborated partner hypothesis, explicitly frame its meaning as uncertain, questioned, or being tested rather than as the endpoint of movement.

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
    "propositionNovelty": "new" | "repeated" | "unclear",
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
      ...screenshots.flatMap((buffer, index) => ([
        {
          type: 'text',
          text: `LOCAL ROUTE-OPTION IMAGE ${index}. This is your physical surroundings, not the passed sheet. Only these route-option images may ground "observation" and "observedFeatures".`
        },
        {
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${buffer.toString('base64')}`, detail: 'low' }
        }
      ]))
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
    let routeRetryFeedback = '';
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.#client().chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: routeRetryFeedback
                ? [{
                    type: 'text',
                    text: `AUTHORITATIVE ROUTE CORRECTION FROM THE PRIOR ATTEMPT: ${routeRetryFeedback}`
                  }, ...userContent]
                : userContent
            }
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
        const cueDependentSearchPlan = isCueDependentSearchPlan(
          parsed?.reasoning,
          parsed?.memoryUpdate?.currentPlan
        );
        routeDecision = sanitizeRendezvousDecision(parsed, options, { allowWait });
        const validationErrors = [];
        if (cueDependentSearchPlan) {
          validationErrors.push(
            'Rendezvous model made independent movement contingent on a partner cue'
          );
        }
        if (
          routeDecision.action !== 'wait' &&
          routeDecision.intendedHeading !== null &&
          headingDelta(
            options[routeDecision.selectedIndex]?.heading,
            routeDecision.intendedHeading
          ) > 45
        ) {
          validationErrors.push('Rendezvous selected route contradicts its intended heading');
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
          let informationNovelty = ['new', 'mixed', 'repeated', 'unclear'].includes(rawReconciliation?.informationNovelty)
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
            .filter(description => visualEvidenceSplit.novel.includes(description))
            .filter(Boolean);
          if (visualEvidenceSplit.repeated.length > 0) {
            informationNovelty = groundedNewEvidence.length > 0 ? 'mixed' : 'repeated';
          }
          const propositionNovelty = visualEvidenceSplit.dominantRepeated
            ? 'repeated'
            : (['new', 'repeated', 'unclear'].includes(rawReconciliation?.propositionNovelty)
                ? rawReconciliation.propositionNovelty
                : (groundedNewEvidence.length > 0 ? 'new' : 'unclear'));
          const evidenceDelta = sanitizeEvidenceDelta(rawReconciliation);
          const corroborationContext = {
            sheetSequence: sheetMessage.sequence,
            groundedNewEvidence,
            informationNovelty
          };
          const conventionUpdate = validateCorroborationProvenance(
            cleanBeliefUpdate(rawReconciliation?.conventionUpdate),
            corroborationContext
          );
          const partnerHypothesis = validateCorroborationProvenance(
            cleanBeliefUpdate(rawReconciliation?.partnerHypothesis),
            corroborationContext
          );
          const normalizedPlanAssessment = (
            (
              propositionNovelty === 'repeated' ||
              (informationNovelty === 'repeated' && groundedNewEvidence.length === 0)
            ) &&
            evidenceDelta.planAssessment === 'supporting'
          )
            ? 'inconclusive'
            : evidenceDelta.planAssessment;
          routeReconciliation = {
            currentSenderAction,
            currentSenderActionBasis,
            propositionNovelty,
            informationNovelty,
            evidenceDelta: {
              ...evidenceDelta,
              newEvidence: groundedNewEvidence,
              repeatedEvidence: [...new Set([
                ...evidenceDelta.repeatedEvidence,
                ...visualEvidenceSplit.repeated
              ])].slice(0, 5),
              planAssessment: normalizedPlanAssessment
            },
            conventionUpdate,
            partnerHypothesis
          };
        }
        const unsupportedGoalTerm = unsupportedPartnerHypothesisGoalTerm(
          privateMemory,
          routeReconciliation.partnerHypothesis,
          routeDecision.memoryUpdate.currentPlan
        );
        if (unsupportedGoalTerm) {
          validationErrors.push(
            `Rendezvous route plan promoted an unsupported partner hypothesis motif "${unsupportedGoalTerm}" into a movement goal`
          );
        }
        const misattributedSheetTerm = unsupportedCurrentSheetAttribution(
          privateMemory,
          routeReconciliation,
          routeDecision.reasoning,
          routeDecision.memoryUpdate.currentPlan
        );
        if (misattributedSheetTerm) {
          validationErrors.push(
            `Rendezvous route rationale attributed absent motif "${misattributedSheetTerm}" to the current sheet`
          );
        }
        const copiedSheetRoute = sheetMessage &&
          !sheetMayDirectRecipient(perception, routeReconciliation, sheetMessage) &&
          copiesSheetRoute(
          routeDecision.reasoning,
          routeDecision.memoryUpdate.currentPlan
          );
        if (copiedSheetRoute) {
          validationErrors.push(
            'Rendezvous route rationale copied a non-supporting sheet route instead of grounding the action locally'
          );
        }
        if (validationErrors.length > 0) {
          const onlyNonSupportingSheetCausality = validationErrors.every(error =>
            /partner cue|attributed absent motif|copied a non-supporting sheet route/i.test(error)
          );
          if (
            attempt >= this.maxAttempts &&
            validationErrors.length === 1 &&
            unsupportedGoalTerm
          ) {
            routeDecision.memoryUpdate.currentPlan =
              `Continue with the chosen locally justified action while treating the recurring "${unsupportedGoalTerm}" motif as uncertain visual vocabulary, not a known physical destination.`;
            if (routeReconciliation.evidenceDelta.planAssessment === 'supporting') {
              routeReconciliation.evidenceDelta.planAssessment = 'inconclusive';
            }
            this.logger.warn?.(
              `Rendezvous normalized unsupported route motif "${unsupportedGoalTerm}" after ${attempt} attempts`
            );
          } else if (
            attempt >= this.maxAttempts &&
            onlyNonSupportingSheetCausality
          ) {
            const groundedLanguage = locallyGroundRouteLanguage(routeDecision, partnerName);
            routeDecision.reasoning = groundedLanguage.reasoning;
            routeDecision.memoryUpdate.currentPlan = groundedLanguage.currentPlan;
            routeReconciliation.evidenceDelta.planAssessment = 'inconclusive';
            this.logger.warn?.(
              cueDependentSearchPlan
                ? `Rendezvous normalized partner-cue route causality after ${attempt} attempts`
                : misattributedSheetTerm
                ? `Rendezvous normalized absent current-sheet motif "${misattributedSheetTerm}" after ${attempt} attempts`
                : `Rendezvous normalized copied non-supporting sheet route after ${attempt} attempts`
            );
          } else {
            throw new Error(validationErrors.join('; '));
          }
        }
        break;
      } catch (error) {
        routeDecision = null;
        lastError = error;
        this.logger.warn?.(`Rendezvous model attempt ${attempt}/${this.maxAttempts} failed: ${error.message}`);
        routeRetryFeedback = /attributed absent motif/i.test(error.message)
          ? `Do not attribute a remembered motif to the newest sheet unless it appears in the supplied current-sheet evidence. You may keep it as an older uncertain hypothesis, but justify the chosen action from current local route-option evidence. Correct every other validation issue named here too: ${error.message}`
          : /unsupported partner hypothesis/i.test(error.message)
          ? `Your currentPlan promoted a distinctive motif from an unsupported partner hypothesis into the endpoint of movement. You may preserve an action justified by current local evidence, but rewrite the plan so that motif’s physical meaning is explicitly uncertain, questioned, or being tested. Correct every other validation issue named here too: ${error.message}`
          : /partner cue/i.test(error.message)
            ? `Your friend cannot cue, authorize, instruct, or grant permission for your next search action. Remove every dependency on a future signal or clearer sheet. If you choose wait, justify it only by a recognizable feature visible in your current local route-option images; otherwise choose move or retrace now from those local options. Correct every other validation issue named here too: ${error.message}`
          : /copied a non-supporting sheet route/i.test(error.message)
            ? `Your chosen action may remain unchanged, but its causal account cannot follow, align with, or reproduce the newest drawing's route because that proposition is repeated or otherwise non-supporting. Justify the action from current local route-option evidence, or state a genuinely distinct spatial inference. Correct every other validation issue named here too: ${error.message}`
            : `Correct this validation error without inventing new evidence: ${error.message}`;
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
      propositionNovelty: routeReconciliation.propositionNovelty,
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

First identify your outbound contribution: what this reply contributes from your own observation, chosen action, response to the received drawing, question, correction, acknowledgement, or deliberate repetition. Cite exactly one evidence ID from the supplied catalog. The cited evidence becomes the authoritative information delta; do not restate or enlarge it as a separate claim. A response evidence item is your own private synthesis of what is worth saying back; it is not an instruction you must follow. When the received drawing is explicitly a question, answer it, clarify it, correct it, visibly acknowledge that you cannot answer it, or deliberately leave it unresolved. Do not evade it with an unrelated observational postcard when response evidence is available. This requirement preserves a real exchange without prescribing what you should believe or how you should search.

The catalog may expose the same concrete local fact once as "local:*" and once as "question_local:*". Choose "question_local:*" only when you want to author an unresolved visual question grounded in that real local evidence. You decide what relationship, uncertainty, or comparison to ask about in the drawing; the evidence ID only grounds its subject.

Ordinary street substrate by itself is not a useful locating clue. Bare crosswalks, lanes, curbs, asphalt, traffic, sidewalks, or generic city buildings are omitted from the evidence catalog unless the observation also contains a distinctive structure, object, spatial relationship, or atmosphere. You may still use those ordinary elements as supporting context, transform a recurring one into a question or symbol, or deliberately repeat it when repetition itself is what you mean.

Compose each handoff from a conceptually blank page. Make the cited contribution the largest, darkest, or otherwise unmistakable primary subject; prior visual language is optional supporting vocabulary, not a layout template. When the contribution is one simple observation or action, prefer one coherent composition. Use multiple panels only when the cited contribution itself needs a temporal, spatial, or comparative relationship; continuity alone does not justify copying a multi-panel itinerary. A received-sheet or prior-sent motif may be retained as context, acknowledgement, or deliberate repetition, but never relabel it as a new local observation. You will see the current received sheet and up to two earlier passed sheets, explicitly labeled. Compare them as drawings before composing your reply. Do not merely mirror the incoming drawing or redraw your previous message because its motifs are familiar. If your proposed composition visibly resembles a recent sheet, use it only when your continuity reason explains why repetition itself is useful and the cited evidence is visually dominant over that context. Repetition does not make a belief more certain. If you are asking your friend to clarify something, make the uncertainty, choice, or missing relationship visibly legible instead of drawing a confident route. Make the visual roles legible enough that your own movement is not accidentally presented as an instruction to ${partnerName}, unless an instruction is truly what you mean.

A changed compass bearing does not by itself make another generic walking-away street scene a new visual proposition. If you intentionally want to repeat a recent visual proposition, cite a prior_sent evidence ID as deliberate_repetition and explain why the repetition is useful now. Otherwise choose a genuinely different grounded contribution or composition. This requirement does not prescribe what you should say; it keeps your chosen message honest about whether it adds information.

A recurring motif may remain part of your visual language without becoming a factual place claim. Unless the cited contribution itself grounds a correction or question about it, do not present an inherited symbol, route, district, target, or waypoint as a known shared destination. You may retain one as a subordinate uncertain hypothesis, deliberately repeat it, transform it, question it, or stop using it. Do not silently promote it into the goal of the search.

Choose the image's dominant action honestly. The strongest visual cue in your drawing prompt must agree with "messageAction". If the message is stillness, movement or future-route cues may be present but must remain visibly subordinate to stopping, waiting, anchoring, or uncertainty. If the message is movement, do not let barriers or static figures dominate it. A transition may visibly contain both.

Do not include readable text, letters, numbers, captions, street labels, signatures, logos, or watermarks in the intended image. Place names may exist in your private reasoning, but do not put street, intersection, neighborhood, or landmark names in the drawing intent, drawing prompt, or visual anchors. Translate a useful named-place hypothesis into visible architecture, landscape, spatial relationships, symbols, or atmosphere. Do not encode exact coordinates or information you do not possess. The image renderer receives only your drawing prompt and the visual anchors you list.

Return only JSON:
{
  "contributionKind": "local_observation" | "own_action" | "response" | "question" | "correction" | "acknowledgement" | "deliberate_repetition",
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
    let drawingPlanAttemptLimit = this.maxAttempts;
    const drawingPlanFailureKinds = new Set();
    tokenBudget = Math.min(this.maxTokens, 1800);
    for (let attempt = 1; attempt <= drawingPlanAttemptLimit; attempt += 1) {
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
        const evidenceContributionKind = contributionKindForEvidenceId(contributionEvidenceId);
        if (
          citedEvidence &&
          requestedContributionKind &&
          evidenceContributionKind &&
          requestedContributionKind !== evidenceContributionKind
        ) {
          throw new Error(
            `Rendezvous drawing planner labeled its contribution ${requestedContributionKind} but cited ${contributionEvidenceId}, which represents ${evidenceContributionKind}`
          );
        }
        const contributionKind = requestedContributionKind || evidenceContributionKind;
        const contributionSummary = authoritativeContributionSummary(
          contributionKind,
          citedEvidence?.description,
          contributionEvidenceId
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
          messageAction: reconcileRendezvousContributionAction(
            contributionKind,
            contributionSummary,
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
          ['acknowledgement', 'deliberate_repetition'].includes(candidateDrawingPlan.contributionKind) &&
          !candidateDrawingPlan.continuityReason
        ) {
          throw new Error('Rendezvous repeated contribution omitted why repeating it is useful now');
        }
        if (repeatsRecentOutboundProposition(candidateDrawingPlan, actionMemory)) {
          const priorFailuresWereOnlyRepetition =
            drawingPlanFailureKinds.size > 0 &&
            [...drawingPlanFailureKinds].every(error =>
              /repeated outbound proposition/i.test(error)
            );
          const correctionBudgetExhausted =
            attempt === drawingPlanAttemptLimit &&
            (
              drawingPlanAttemptLimit > this.maxAttempts ||
              drawingPlanFailureKinds.size === 0 ||
              priorFailuresWereOnlyRepetition
            );
          const repeatedSentMessage = matchingRecentSentPropositions(
            candidateDrawingPlan,
            actionMemory
          ).at(-1);
          const repeatedEvidenceText = contributionEvidenceText(
            repeatedSentMessage?.informationDelta || repeatedSentMessage?.contributionSummary
          );
          const repeatedEvidence = repeatedSentMessage
            ? contributionEvidence
              .filter(item => item.id.startsWith('prior_sent:'))
              .findLast(item => {
                const evidenceText = contributionEvidenceText(item.description);
                return (
                  visualDescriptionSimilarity(evidenceText, repeatedEvidenceText) >= 0.72 ||
                  (
                    routeMeaningQuestion(evidenceText) &&
                    routeMeaningQuestion(repeatedEvidenceText)
                  )
                );
              })
            : null;
          if (correctionBudgetExhausted && repeatedEvidence) {
            candidateDrawingPlan.contributionKind = 'deliberate_repetition';
            candidateDrawingPlan.contributionEvidenceId = repeatedEvidence.id;
            candidateDrawingPlan.contributionSummary = authoritativeContributionSummary(
              'deliberate_repetition',
              repeatedEvidence.description
            );
            candidateDrawingPlan.informationDelta = candidateDrawingPlan.contributionSummary;
            candidateDrawingPlan.continuityReason ||= (
              'I chose to send this proposition again after recognizing that it already appeared; ' +
              'the recurrence is part of the message rather than new evidence.'
            );
            candidateDrawingPlan.groundedFeatures = [
              repeatedEvidence.description,
              ...candidateDrawingPlan.groundedFeatures
            ].filter((value, index, values) => values.indexOf(value) === index).slice(0, 6);
            this.logger.warn?.(
              'Rendezvous classified a repeatedly chosen drawing proposition as deliberate repetition after exhausting correction attempts'
            );
          } else {
            throw new Error(
              'Rendezvous drawing planner presented a repeated outbound proposition as a fresh contribution'
            );
          }
        }
        const currentSheetNeedsAnswer =
          perception.communicationFunction === 'question' &&
          Boolean(perception.requestedResponse) &&
          contributionEvidence.some(item => item.id.startsWith('response:'));
        if (
          currentSheetNeedsAnswer &&
          !['response', 'question', 'correction', 'acknowledgement', 'deliberate_repetition']
            .includes(candidateDrawingPlan.contributionKind)
        ) {
          throw new Error(
            'Rendezvous drawing planner evaded an explicit received question with an unrelated postcard'
          );
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
        const unsupportedGoalTerm = unsupportedPartnerHypothesisGoalTerm(
          actionMemory,
          routeReconciliation.partnerHypothesis,
          candidateDrawingPlan.drawingIntent,
          candidateDrawingPlan.drawingPrompt,
          candidateDrawingPlan.continuityReason
        );
        if (unsupportedGoalTerm) {
          if (attempt >= this.maxAttempts) {
            const visibleFeatures = candidateDrawingPlan.groundedFeatures.length > 0
              ? candidateDrawingPlan.groundedFeatures.join('; ')
              : candidateDrawingPlan.contributionSummary;
            candidateDrawingPlan.drawingIntent =
              `Send the cited contribution as primary evidence while leaving the inherited "${unsupportedGoalTerm}" motif unresolved rather than depicting it as a destination.`;
            candidateDrawingPlan.continuityReason =
              `The recurring "${unsupportedGoalTerm}" motif is omitted because its physical meaning remains unsupported.`;
            candidateDrawingPlan.drawingPrompt =
              `Create one coherent handmade, wordless drawing that makes this contribution unmistakably primary: ${candidateDrawingPlan.contributionSummary}. Represent it visually without rendering words. Use only these grounded features as context: ${visibleFeatures}. Do not depict the inherited "${unsupportedGoalTerm}" motif as a destination, waypoint, target, or goal. Include no readable text, letters, numbers, labels, logos, or watermarks.`;
            if (candidateDrawingPlan.contributionKind === 'local_observation') {
              candidateDrawingPlan.messageAction = 'unclear';
            }
            this.logger.warn?.(
              `Rendezvous normalized unsupported drawing motif "${unsupportedGoalTerm}" after ${attempt} attempts`
            );
          } else {
            throw new Error(
              `Rendezvous drawing planner promoted an unsupported partner hypothesis motif "${unsupportedGoalTerm}" into a movement goal`
            );
          }
        }
        const unsupportedRouteCues = routeCommandCues(
          `${candidateDrawingPlan.drawingIntent} ${candidateDrawingPlan.drawingPrompt}`
        ).filter(cue => !routeCommandCues(citedEvidence?.description).includes(cue));
        const responseWithholdsRoute =
          responseDrawingContradictsRouteUncertainty(candidateDrawingPlan);
        if (responseWithholdsRoute && unsupportedRouteCues.length > 0) {
          throw new Error(
            'Rendezvous response drawing contradicted its stated route uncertainty with directional imagery'
          );
        }
        if (responseInventsRouteCoordination(candidateDrawingPlan)) {
          throw new Error(
            'Rendezvous response promoted an inferred sheet meaning into route coordination'
          );
        }
        if (candidateDrawingPlan.contributionKind === 'own_action') {
          const citedDirections = namedCompassDirections(citedEvidence?.description);
          const authoredDirections = namedCompassDirections(
            candidateDrawingPlan.drawingIntent,
            candidateDrawingPlan.drawingPrompt
          );
          if (
            citedDirections.length > 0 &&
            authoredDirections.some(direction => !citedDirections.includes(direction))
          ) {
            throw new Error(
              'Rendezvous own-action drawing contradicted the cited compass direction'
            );
          }
        }
        if (
          candidateDrawingPlan.contributionKind === 'local_observation' &&
          unsupportedRouteCues.length > 0
        ) {
          if (attempt >= this.maxAttempts) {
            const visibleFeatures = candidateDrawingPlan.groundedFeatures.length > 0
              ? candidateDrawingPlan.groundedFeatures.join('; ')
              : candidateDrawingPlan.contributionSummary;
            candidateDrawingPlan.drawingIntent =
              `Show the cited local observation as the complete message: ${candidateDrawingPlan.contributionSummary}.`;
            candidateDrawingPlan.messageAction = 'unclear';
            candidateDrawingPlan.drawingPrompt =
              `Create one coherent handmade, wordless observational sketch centered only on this cited local evidence: ${visibleFeatures}. Make the observed place itself visually primary. Include no readable text, letters, numbers, labels, logos, or watermarks.`;
            this.logger.warn?.(
              `Rendezvous normalized uncited route imagery from local observation after ${attempt} attempts`
            );
          } else {
            throw new Error(
              'Rendezvous drawing planner added route-command imagery unrelated to its local observation'
            );
          }
        }
        drawingPlan = candidateDrawingPlan;
        break;
      } catch (error) {
        lastError = error;
        const status = error?.status ?? error?.response?.status;
        if (!status) {
          drawingPlanFailureKinds.add(
            cleanString(error?.message, 500).replace(/"[^"]+"/g, '"motif"')
          );
        }
        if (
          attempt === drawingPlanAttemptLimit &&
          drawingPlanAttemptLimit === this.maxAttempts &&
          drawingPlanFailureKinds.size >= 2
        ) {
          drawingPlanAttemptLimit += 1;
          this.logger.warn?.(
            'Rendezvous drawing planner received one extra attempt after distinct validation corrections exhausted the normal budget'
          );
        }
        this.logger.warn?.(`Rendezvous drawing plan attempt ${attempt}/${drawingPlanAttemptLimit} failed: ${error.message}`);
        drawingRetryFeedback = /multi-panel template/i.test(error.message)
          ? 'Start from a blank page and use one coherent composition centered on the cited contribution. You may retain one small recurring symbol, but do not use panels, a triptych, or the received sheet layout.'
          : (/response drawing contradicted/i.test(error.message)
            ? 'Your cited response explicitly withholds route certainty. Remove arrows, paths, vanishing-point movement, and directional commands. Communicate the uncertainty, non-confirmation, or unresolved relationship itself without turning it into a route.'
          : (/own-action drawing contradicted the cited compass direction/i.test(error.message)
            ? 'Keep the cited own action authoritative. Remove every named compass direction that conflicts with it, then depict that same action from a sender-framed or retrospective point of view without changing its direction.'
          : (/route-command imagery unrelated/i.test(error.message)
            ? 'The cited local observation is static evidence. Remove uncited routes, footprints, arrows, runners, progression, and directional cues. If movement is the actual contribution you want to send, cite an exact action evidence ID instead.'
          : (/labeled its contribution/i.test(error.message)
              ? 'Preserve the communicative act you actually intend. Cite an exact evidence ID whose prefix matches that contribution kind: local for local_observation, action for own_action, response for response, question for question, contradiction for correction, received for acknowledgement, or prior_sent for deliberate_repetition. Do not change the message kind merely to fit a mismatched ID.'
              : (/repeated outbound proposition/i.test(error.message)
              ? 'The proposed message repeats a recent outbound proposition that has already recurred. Choose a genuinely different grounded contribution or composition. If repetition itself is what you intend to communicate, cite an exact prior_sent evidence ID as deliberate_repetition and explain what the repetition is meant to communicate or test now.'
              : (/evaded an explicit received question/i.test(error.message)
              ? 'The current sheet visibly asks you something and your reconciliation contains grounded response evidence. Choose what you actually want to say back: cite response evidence to answer, question evidence to clarify, contradiction evidence to correct, received evidence to acknowledge that you cannot answer, or deliberately repeat unresolved evidence. Do not substitute an unrelated local postcard.'
              : (/(?:uncited motif|unsupported partner hypothesis)/i.test(error.message)
              ? 'Keep the cited contribution primary. Do not describe any inherited symbol, route, target, waypoint, district, or place as a known shared destination or otherwise promote an unsupported partner hypothesis into a movement goal. If you retain one, make it subordinate and explicitly uncertain, questioned, tested, transformed, or deliberately repeated.'
              : 'Correct the reported planning error. Cite an exact available evidence ID and make that contribution visually primary without enlarging its claim.')))))));
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

  async replanUnrenderableDrawing({
    agentName,
    partnerName,
    pending,
    privateMemory = null
  }) {
    const durableLocalEvidence = cleanStringList(
      (privateMemory?.ownObservations || [])
        .slice(-6)
        .map(observation => observation?.description),
      {
        limit: 6,
        maxLength: 220
      }
    );
    const compatiblePendingEvidence = ['local_observation', 'own_action']
      .includes(pending?.contributionKind)
      ? cleanStringList(pending?.groundedFeatures, {
          limit: 6,
          maxLength: 220
        })
      : [];
    const localEvidence = cleanStringList([
      ...durableLocalEvidence,
      ...compatiblePendingEvidence
    ].flatMap(atomizeLocalEvidenceDescription), {
      limit: 6,
      maxLength: 220
    })
      .map(description => sanitizeOutboundPlaceNames(description, [], 220))
      .filter(isConcreteLocalEvidence)
      .filter(Boolean);
    const latestReconciliation = (privateMemory?.reconciliations || []).at(-1);
    const latestQuestions = cleanStringList(
      latestReconciliation?.unresolvedQuestions,
      { limit: 3, maxLength: 220 }
    )
      .map(description => sanitizeOutboundPlaceNames(description, [], 220))
      .filter(Boolean);
    const latestCorrections = cleanStringList(
      latestReconciliation?.contradictions,
      { limit: 3, maxLength: 220 }
    )
      .map(description => sanitizeOutboundPlaceNames(description, [], 220))
      .filter(Boolean);
    const latestResponses = cleanStringList(
      latestReconciliation?.informationWorthSending,
      { limit: 3, maxLength: 220 }
    )
      .map(description => sanitizeOutboundPlaceNames(description, [], 220))
      .filter(Boolean);
    const priorContribution = contributionEvidenceText(
      pending?.informationDelta || pending?.contributionSummary
    );
    const catalog = [
      ...localEvidence.map((description, index) => ({
        id: `local:${index}`,
        kind: 'local_observation',
        description
      })),
      ...latestResponses.map((description, index) => ({
        id: `response:${index}`,
        kind: 'response',
        description
      })),
      ...latestQuestions.map((description, index) => ({
        id: `question:${index}`,
        kind: 'question',
        description
      })),
      ...latestCorrections.map((description, index) => ({
        id: `contradiction:${index}`,
        kind: 'correction',
        description
      }))
    ].filter(item =>
      !priorContribution ||
      visualDescriptionSimilarity(priorContribution, item.description) < 0.55
    ).filter(item =>
      pending?.contributionKind !== 'response' ||
      ['response', 'question', 'correction'].includes(item.kind)
    ).filter(item =>
      !repeatsRecentOutboundProposition({
        contributionKind: item.kind,
        contributionSummary: authoritativeContributionSummary(item.kind, item.description),
        informationDelta: authoritativeContributionSummary(item.kind, item.description)
      }, privateMemory)
    );
    if (catalog.length === 0) return null;

    const systemPrompt = `You are ${agentName}, reconsidering only the drawing you are about to pass to ${partnerName}. Your route choice is already made and does not change.

Your prior contribution repeatedly failed because a context-free recipient could not see its intended communicative function. Choose a different useful contribution from the supplied evidence catalog rather than retrying the same visual proposition. Start from a conceptually blank page. Do not retain the prior subject, relationship, symbol, person, arrow, path, route, directional cue, movement scene, or composition unless the newly cited alternative itself requires that element. This is not a request to adopt a prescribed code or strategy: decide which grounded observation, response, genuine question, or correction is most worth communicating now. If the failed contribution was a response to an explicit question, the alternatives intentionally remain conversationally responsive.

Use one coherent, wordless composition. Do not include readable text, letters, numbers, captions, street names, coordinates, labels, signatures, logos, or watermarks. Do not invent evidence or enlarge the cited claim.

Return only JSON:
{
  "contributionEvidenceId": "one exact ID from the catalog",
  "drawingIntent": "what you now choose to communicate",
  "messageAction": "movement" | "stillness" | "transition" | "unclear",
  "drawingPrompt": "complete visual instructions for one handmade wordless drawing",
  "groundedFeatureEvidenceIds": ["zero or more exact supporting IDs from the catalog"]
}`;
    let lastError = null;
    let tokenBudget = Math.min(this.maxTokens, 1600);
    let retryFeedback = '';
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.#client().chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: `${retryFeedback
                ? `AUTHORITATIVE REPLAN CORRECTION FROM THE PRIOR ATTEMPT: ${retryFeedback}\n\n`
                : ''}The unrenderable prior contribution was:
${JSON.stringify({
  contributionKind: pending?.contributionKind,
  contributionSummary: pending?.contributionSummary,
  drawingIntent: pending?.drawingIntent
}, null, 2)}

Available grounded alternatives:
${JSON.stringify(catalog, null, 2)}`
            }
          ],
          response_format: { type: 'json_object' },
          reasoning_effort: this.reasoningEffort,
          max_completion_tokens: tokenBudget
        });
        const parsed = parseJsonContent(response?.choices?.[0]?.message?.content);
        const evidenceId = cleanString(parsed?.contributionEvidenceId, 80);
        const cited = catalog.find(item => item.id === evidenceId);
        if (!cited) throw new Error('Rendezvous drawing replan cited invalid evidence');
        const supportingIds = cleanStringList(parsed?.groundedFeatureEvidenceIds, {
          limit: 5,
          maxLength: 80
        });
        const groundedFeatures = [
          cited.description,
          ...supportingIds.map(id => catalog.find(item => item.id === id)?.description)
        ].filter(Boolean);
        const drawingIntent = sanitizeOutboundPlaceNames(parsed?.drawingIntent, [], 700);
        const drawingPrompt = sanitizeOutboundPlaceNames(parsed?.drawingPrompt, [], 2400);
        const requestedMessageAction = ['movement', 'stillness', 'transition', 'unclear']
          .includes(parsed?.messageAction)
          ? parsed.messageAction
          : 'unclear';
        const contributionSummary = authoritativeContributionSummary(
          cited.kind,
          cited.description
        );
        const messageAction = reconcileRendezvousContributionAction(
          cited.kind,
          contributionSummary,
          requestedMessageAction,
          drawingIntent,
          drawingPrompt
        );
        if (
          !drawingIntent ||
          !drawingPrompt ||
          /^(?:movement|stillness|transition|unclear)$/i.test(drawingIntent)
        ) {
          throw new Error('Rendezvous drawing replan omitted its visual message');
        }
        if (
          requestedMessageAction !== 'unclear' &&
          messageAction !== requestedMessageAction &&
          !(
            cited.kind === 'local_observation' &&
            ['movement', 'transition'].includes(requestedMessageAction) &&
            messageAction === 'unclear'
          )
        ) {
          throw new Error('Rendezvous drawing replan action contradicted its visual instructions');
        }
        const unsupportedRouteCues = routeCommandCues(`${drawingIntent} ${drawingPrompt}`)
          .filter(cue => !routeCommandCues(cited.description).includes(cue));
        if (cited.kind === 'local_observation' && unsupportedRouteCues.length > 0) {
          throw new Error('Rendezvous drawing replan echoed route-command imagery unrelated to its local observation');
        }
        return {
          contributionKind: cited.kind,
          contributionEvidenceId: cited.id,
          contributionSummary,
          drawingIntent,
          informationDelta: contributionSummary,
          continuityReason: '',
          messageAction,
          drawingPrompt,
          groundedFeatures: [...new Set(groundedFeatures)].slice(0, 6)
        };
      } catch (error) {
        lastError = error;
        this.logger.warn?.(`Rendezvous drawing replan attempt ${attempt}/${this.maxAttempts} failed: ${error.message}`);
        retryFeedback = /omitted its visual message/i.test(error.message)
          ? 'Describe the actual information you want the drawing to convey; do not put an action enum such as "stillness" in drawingIntent.'
          : /action contradicted/i.test(error.message)
            ? 'Make messageAction agree with the strongest visible action in drawingPrompt. If the contribution is a static observation, remove route, progression, and movement cues rather than labeling it movement or transition.'
            : 'Choose a different cited fact and visual proposition that obeys the reported constraint.';
        tokenBudget = Math.min(this.maxRetryTokens, Math.max(tokenBudget * 2, 2600));
      }
    }
    throw lastError || new Error('Rendezvous drawing replan failed');
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

Classify frame of reference by communicative role, not camera perspective:
- "sender" means the image appears to report or reflect on what its author saw, chose, or did.
- "recipient" means the image appears to ask or command the viewer to see, choose, or do something.
- "shared" means the image visibly proposes a joint action or common relationship.
- "unclear" means those roles cannot be distinguished.
A figure seen from behind is not automatically recipient-framed. A completed trail, diary-like reflection, departure point, or other retrospective relationship may make it a sender report; an arrow or open route projected ahead toward the viewer's next action may make it recipient-framed.

Return only JSON:
{
  "literalContents": ["visible element and relationship"],
  "primarySubject": "the largest, darkest, or most compositionally dominant visible subject or relationship",
  "likelyMessage": "best context-free interpretation, including uncertainty",
  "dominantAction": "movement" | "stillness" | "transition" | "unclear",
  "frameOfReference": "sender" | "recipient" | "shared" | "unclear",
  "frameBasis": "specific visible cue establishing whose action, observation, or route this is",
  "communicationFunction": "report" | "request" | "acknowledgement" | "directive" | "deliberate_repetition" | "unclear",
  "movementCues": ["visible cue suggesting movement or direction"],
  "stillnessCues": ["visible cue suggesting waiting, stopping, anchoring, or no movement"],
  "textLikeMarks": ["every visible word, isolated letter, numeral, logo, street sign, vehicle sign, signature, or watermark; empty only when none are recognizable"],
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
        const textLikeMarks = cleanStringList(parsed?.textLikeMarks, { limit: 8, maxLength: 160 });
        blindRead = {
          literalContents: cleanStringList(parsed?.literalContents, { limit: 8, maxLength: 220 }),
          likelyMessage: cleanString(parsed?.likelyMessage, 700),
          primarySubject: cleanString(parsed?.primarySubject, 400),
          dominantAction: ['movement', 'stillness', 'transition', 'unclear'].includes(parsed?.dominantAction)
            ? parsed.dominantAction
            : 'unclear',
          frameOfReference: ['sender', 'recipient', 'shared', 'unclear'].includes(parsed?.frameOfReference)
            ? parsed.frameOfReference
            : 'unclear',
          frameBasis: cleanString(parsed?.frameBasis, 400),
          communicationFunction: [
            'report',
            'request',
            'acknowledgement',
            'directive',
            'deliberate_repetition',
            'unclear'
          ].includes(parsed?.communicationFunction)
            ? parsed.communicationFunction
            : 'unclear',
          movementCues: cleanStringList(parsed?.movementCues, { limit: 6, maxLength: 220 }),
          stillnessCues: cleanStringList(parsed?.stillnessCues, { limit: 6, maxLength: 220 }),
          textLikeMarks,
          readableText: parsed?.readableText === true || textLikeMarks.length > 0
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
    if (
      contributionKind === 'local_observation' &&
      visualDescriptionSimilarity(
        contributionEvidenceText(contributionSummary),
        blindRead.primarySubject || blindRead.likelyMessage
      ) < 0.4
    ) {
      const competingSubject = cleanString(
        blindRead.primarySubject || blindRead.likelyMessage,
        300
      );
      return {
        accepted: false,
        assessment: `Blind recipient saw "${blindRead.primarySubject || blindRead.likelyMessage}" as primary, not the cited local observation: ${contributionSummary}`,
        revisionPrompt: `Remove or strongly subordinate this competing focal subject: ${competingSubject}. Start from a blank composition and make the cited local observation itself the largest, darkest, or most central subject. Remove unrelated arrows, paths, runners, movement narratives, and inherited route imagery instead of using the observation as background scenery.`,
        blindRead
      };
    }
    const blindActionDescription = cleanString(
      [
        blindRead.primarySubject,
        blindRead.likelyMessage,
        blindRead.frameBasis,
        ...blindRead.literalContents,
        ...blindRead.movementCues
      ].filter(Boolean).join(' '),
      3000
    );
    const hasRetrospectiveActionFrame =
      /\b(?:figure|person|pedestrian|walker|someone|subject)\b/i.test(blindActionDescription) &&
      /\b(?:behind|completed|departure|departing|fading|footprints?|leaving|past|trail)\b/i
        .test(blindActionDescription);
    const explicitlyRecipientDirected =
      ['directive', 'request'].includes(blindRead.communicationFunction) ||
      /\b(?:recipient|viewer)\b[^.!;]{0,50}\b(?:follow|go|head|move|proceed|should|travel|walk)\b/i
        .test(blindActionDescription) ||
      /\b(?:command|instruction|invitation|invite|cue)\b[^.!;]{0,40}\b(?:follow|go|head|move|proceed|travel|walk)\b/i
        .test(blindActionDescription);
    if (
      contributionKind === 'response' &&
      responseWithholdsRouteCertainty(contributionSummary) &&
      (
        ['movement', 'transition'].includes(blindRead.dominantAction) ||
        ['directive', 'request'].includes(blindRead.communicationFunction) ||
        routeCommandCues(blindActionDescription).length > 0
      )
    ) {
      return {
        accepted: false,
        assessment: `Blind recipient saw route guidance in a response that explicitly withholds route certainty: ${blindRead.likelyMessage}`,
        revisionPrompt: 'Remove arrows, paths, vanishing-point movement, and directional commands. Make the non-confirmation, mismatch, interruption, or unresolved relationship itself visually primary, choosing your own wordless composition rather than issuing a route cue.',
        blindRead
      };
    }
    if (
      contributionKind === 'response' &&
      !responseExplicitlyDirectsRecipient(contributionSummary) &&
      (
        blindRead.communicationFunction === 'directive' ||
        (
          ['recipient', 'shared'].includes(blindRead.frameOfReference) &&
          ['movement', 'transition'].includes(blindRead.dominantAction)
        )
      )
    ) {
      return {
        accepted: false,
        assessment: `Blind recipient read a sender-framed response as route guidance for them: ${blindRead.likelyMessage}`,
        revisionPrompt: 'Frame the response as something the sender observed, concluded, chose, or did, not as a command or shared route projected ahead of the viewer. Remove any standalone arrow or open path that continues toward the recipient unless the cited response itself explicitly asks the recipient to move.',
        blindRead
      };
    }
    if (
      contributionKind === 'question' &&
      questionContrastsStillnessAndMovement(contributionSummary) &&
      (
        blindRead.movementCues.length === 0 ||
        blindRead.stillnessCues.length === 0
      )
    ) {
      return {
        accepted: false,
        assessment: `Blind recipient could not see both sides of the stated stillness-versus-movement question: ${blindRead.likelyMessage}`,
        revisionPrompt: 'Make both alternatives visibly concrete: one unmistakably stationary, anchored, stopped, or waiting state and one unmistakably moving or continuing state. Choose your own wordless composition, but do not substitute a left-versus-right route choice for the stated stop-versus-continue contrast.',
        blindRead
      };
    }
    if (
      contributionKind === 'own_action' &&
      (
        blindRead.frameOfReference === 'shared' ||
        (
          blindRead.frameOfReference === 'recipient' &&
          (explicitlyRecipientDirected || !hasRetrospectiveActionFrame)
        )
      )
    ) {
      return {
        accepted: false,
        assessment: `Blind recipient read the action frame as ${blindRead.frameOfReference}, not clearly the sender's own action: ${blindRead.likelyMessage}`,
        revisionPrompt: 'Make it visually clear that this is the sender reporting their own completed or chosen movement, like a self-authored visual diary rather than route guidance. Avoid any standalone arrow or route line continuing ahead of the figure. If direction needs emphasis, show completed motion behind the acting subject through footprints, a fading trail, changed posture, or another retrospective relationship of your choice. Do not add text, labels, or a prescribed identity symbol.',
        blindRead
      };
    }
    if (
      contributionKind === 'acknowledgement' &&
      blindRead.communicationFunction !== 'acknowledgement'
    ) {
      return {
        accepted: false,
        assessment: `Blind recipient read the response as ${blindRead.communicationFunction}, not an acknowledgement: ${blindRead.likelyMessage}`,
        revisionPrompt: 'Make the image visibly function as a response to something received rather than replaying the received scene as a fresh report or command. Show reception, recognition, reflection, transformation, or a reciprocal relationship in whatever visual language you choose. Do not add text, labels, or a prescribed code.',
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
        const intentionalNearCopy = contributionKind === 'deliberate_repetition'
          && Boolean(cleanString(continuityReason, 500));
        const accidentalNearCopy = comparisonSheets.length > 0
          && visualNovelty === 'near_copy'
          && !intentionalNearCopy;
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

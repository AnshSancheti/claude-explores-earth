export const RENDEZVOUS_MEMORY_VERSION = 5;

const MAX_TEXT_CHARS = 700;
const MAX_RECEIVED_SHEETS = 10;
const MAX_SENT_MESSAGES = 10;
const MAX_OBSERVATIONS = 14;
const MAX_CONVENTIONS = 8;
const MAX_HYPOTHESES = 6;
const MAX_RECONCILIATIONS = 8;
const MAX_ODOMETRY_HEADINGS = 16;
const MAX_ODOMETRY_LABELS = 8;

function cleanString(value, maxLength = MAX_TEXT_CHARS) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

function positiveInt(value, fallback = 0) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function confidence(value, fallback = 0.35) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}

function cleanList(values, { limit = 8, itemLength = 220 } = {}) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => cleanString(value, itemLength))
    .filter(Boolean))]
    .slice(-limit);
}

function enumValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function removeCommunicationFromLocalObservation(value) {
  const description = cleanString(value, 500);
  if (!description) return '';
  const communicationCue = /\b(?:arrow|draw(?:ing|n)?|sheet|visual cue|shared cue|latest message|newest message|latest note|scratchpad)\b/i;
  if (!communicationCue.test(description)) return description;

  const cleaned = description
    .split(/(?<=[.!?;])\s+|;\s*|,\s+(?=(?:and\s+)?(?:a|an|the)\s+[^,.;]{0,80}\b(?:arrow|draw(?:ing|n)?|sheet|visual cue|shared cue|latest message|newest message|latest note|scratchpad)\b)/i)
    .filter(fragment => !communicationCue.test(fragment))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || '';
}

function knownSequences(memory) {
  return new Set([
    ...(memory.receivedSheets || []).map(entry => entry.sequence),
    ...(memory.sentMessages || []).map(entry => entry.sequence)
  ].filter(sequence => sequence > 0));
}

function normalizeObservation(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const rawDescription = cleanString(entry.description || entry.observation, 500);
  if (
    !entry.sourcePanoId &&
    /^Legacy recollection, not yet reverified:/i.test(rawDescription) &&
    /\b(?:follows the only unexplored public continuation|waits at the choice until the drawing has finished crossing)\b/i
      .test(rawDescription)
  ) {
    return null;
  }
  const description = entry.sourcePanoId
    ? removeCommunicationFromLocalObservation(rawDescription)
    : rawDescription;
  if (!description) return null;
  return {
    turn: positiveInt(entry.turn),
    description,
    sourcePanoId: cleanString(entry.sourcePanoId, 240) || null,
    createdAt: entry.createdAt || null
  };
}

function normalizeReceived(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const interpretation = cleanString(entry.interpretation, 500);
  const sequence = positiveInt(entry.sequence);
  if (!interpretation || sequence < 1) return null;
  return {
    turn: positiveInt(entry.turn),
    sequence,
    from: entry.from === 'ada' || entry.from === 'theo' ? entry.from : null,
    interpretation,
    confidence: Math.min(confidence(entry.confidence), 0.8),
    literalContents: cleanList(entry.literalContents, { limit: 6, itemLength: 220 }),
    possiblePlaces: cleanList(entry.possiblePlaces, { limit: 4, itemLength: 220 }),
    possibleIntentions: cleanList(entry.possibleIntentions, { limit: 4, itemLength: 220 }),
    primarySubject: cleanString(entry.primarySubject, 400),
    communicationFunction: enumValue(
      entry.communicationFunction,
      ['report', 'request', 'question', 'acknowledgement', 'correction', 'shared_proposal', 'unclear'],
      'unclear'
    ),
    frameOfReference: enumValue(entry.frameOfReference, ['sender', 'recipient', 'shared', 'unclear'], 'unclear'),
    requestedResponse: cleanString(entry.requestedResponse, 400),
    informationNovelty: enumValue(entry.informationNovelty, ['new', 'mixed', 'repeated', 'unclear'], 'unclear'),
    createdAt: entry.createdAt || null
  };
}

function normalizeReconciliation(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const planAssessment = ['supporting', 'weakening', 'inconclusive'].includes(entry.planAssessment)
    ? entry.planAssessment
    : 'inconclusive';
  const normalized = {
    turn: positiveInt(entry.turn),
    sheetSequence: positiveInt(entry.sheetSequence),
    newEvidence: cleanList(entry.newEvidence, { limit: 6, itemLength: 220 }),
    repeatedEvidence: cleanList(entry.repeatedEvidence, { limit: 5, itemLength: 220 }),
    contradictions: cleanList(entry.contradictions, { limit: 5, itemLength: 220 }),
    unresolvedQuestions: cleanList(entry.unresolvedQuestions, { limit: 5, itemLength: 220 }),
    informationWorthSending: cleanList(entry.informationWorthSending, { limit: 5, itemLength: 220 }),
    planAssessment,
    createdAt: entry.createdAt || null
  };
  const hasContent = [
    normalized.newEvidence,
    normalized.repeatedEvidence,
    normalized.contradictions,
    normalized.unresolvedQuestions,
    normalized.informationWorthSending
  ].some(values => values.length > 0);
  return hasContent ? normalized : null;
}

function normalizeSent(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const intent = cleanString(entry.intent, 500);
  const sequence = positiveInt(entry.sequence);
  if (!intent || sequence < 1) return null;
  return {
    turn: positiveInt(entry.turn),
    sequence,
    to: entry.to === 'ada' || entry.to === 'theo' ? entry.to : null,
    intent,
    contributionKind: cleanString(entry.contributionKind, 80),
    contributionEvidenceId: cleanString(entry.contributionEvidenceId, 80),
    contributionSummary: cleanString(entry.contributionSummary, 500),
    informationDelta: cleanString(entry.informationDelta, 500),
    continuityReason: cleanString(entry.continuityReason, 400),
    groundedFeatures: cleanList(entry.groundedFeatures, { limit: 5, itemLength: 180 }),
    createdAt: entry.createdAt || null
  };
}

function normalizeBelief(entry, kind) {
  if (!entry || typeof entry !== 'object') return null;
  const key = cleanString(entry.key, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const description = cleanString(entry.description || entry.hypothesis, 500);
  if (!key || !description) return null;
  return {
    key,
    description,
    confidence: Math.min(confidence(entry.confidence, 0.25), kind === 'convention' ? 0.7 : 0.75),
    basisSequences: [...new Set((Array.isArray(entry.basisSequences) ? entry.basisSequences : [])
      .map(positiveInt)
      .filter(sequence => sequence > 0))]
      .slice(-8),
    evidenceStatus: enumValue(
      entry.evidenceStatus,
      ['new_corroboration', 'repetition_only', 'weakened', 'unclear', 'legacy'],
      'legacy'
    ),
    updatedTurn: positiveInt(entry.updatedTurn),
    kind
  };
}

function bounded(entries, normalize, limit) {
  return (Array.isArray(entries) ? entries : []).map(normalize).filter(Boolean).slice(-limit);
}

function migrateLegacyMemory(raw, recentNotes) {
  const remembered = [
    cleanString(raw?.journeySummary, 300),
    cleanString(raw?.partnerBelief, 300),
    cleanString(raw?.visualVocabulary, 300),
    cleanString(raw?.jointPlan, 300),
    ...cleanList(recentNotes, { limit: 4, itemLength: 240 })
  ].filter(Boolean).join(' ');
  const memory = createAgentMemory();
  const modernPlan = cleanString(raw?.currentPlan, 500);
  if (modernPlan) memory.currentPlan = modernPlan;
  memory.ownObservations = bounded(raw?.ownObservations, normalizeObservation, MAX_OBSERVATIONS);
  if (remembered) {
    memory.ownObservations = [...memory.ownObservations, {
      turn: positiveInt(raw?.updatedTurn),
      description: `Legacy recollection, not yet reverified: ${remembered}`.slice(0, 500),
      sourcePanoId: null,
      createdAt: raw?.updatedAt || null
    }].slice(-MAX_OBSERVATIONS);
  }
  memory.receivedSheets = bounded(raw?.receivedSheets, normalizeReceived, MAX_RECEIVED_SHEETS);
  memory.sentMessages = bounded(raw?.sentMessages, normalizeSent, MAX_SENT_MESSAGES);
  memory.visualConventions = bounded(raw?.visualConventions, entry => normalizeBelief(entry, 'convention'), MAX_CONVENTIONS);
  memory.partnerHypotheses = bounded(raw?.partnerHypotheses, entry => normalizeBelief(entry, 'hypothesis'), MAX_HYPOTHESES);
  memory.reconciliations = bounded(raw?.reconciliations, normalizeReconciliation, MAX_RECONCILIATIONS);
  memory.updatedTurn = positiveInt(raw?.updatedTurn);
  memory.updatedAt = raw?.updatedAt || null;
  return memory;
}

export function createAgentMemory({ recentNotes = [] } = {}) {
  const initial = cleanList(recentNotes, { limit: 4, itemLength: 240 }).join(' ');
  return {
    version: RENDEZVOUS_MEMORY_VERSION,
    currentPlan: 'Keep gathering local evidence and revise uncertain beliefs when a drawing or street contradicts them.',
    ownObservations: initial ? [{
      turn: 0,
      description: initial,
      sourcePanoId: null,
      createdAt: null
    }] : [],
    receivedSheets: [],
    sentMessages: [],
    visualConventions: [],
    partnerHypotheses: [],
    reconciliations: [],
    updatedTurn: 0,
    updatedAt: null
  };
}

export function normalizeAgentMemory(raw, { recentNotes = [] } = {}) {
  if (!raw || ![4, RENDEZVOUS_MEMORY_VERSION].includes(Number(raw.version))) {
    return migrateLegacyMemory(raw, recentNotes);
  }
  const base = createAgentMemory({ recentNotes: [] });
  return {
    ...base,
    currentPlan: cleanString(raw.currentPlan, 500) || base.currentPlan,
    ownObservations: bounded(raw.ownObservations, normalizeObservation, MAX_OBSERVATIONS),
    receivedSheets: bounded(raw.receivedSheets, normalizeReceived, MAX_RECEIVED_SHEETS),
    sentMessages: bounded(raw.sentMessages, normalizeSent, MAX_SENT_MESSAGES),
    visualConventions: bounded(raw.visualConventions, entry => normalizeBelief(entry, 'convention'), MAX_CONVENTIONS),
    partnerHypotheses: bounded(raw.partnerHypotheses, entry => normalizeBelief(entry, 'hypothesis'), MAX_HYPOTHESES),
    reconciliations: bounded(raw.reconciliations, normalizeReconciliation, MAX_RECONCILIATIONS),
    updatedTurn: positiveInt(raw.updatedTurn),
    updatedAt: raw.updatedAt || null
  };
}

function mergeBelief(memory, collectionName, update, turn) {
  const kind = collectionName === 'visualConventions' ? 'convention' : 'hypothesis';
  const candidate = normalizeBelief({ ...update, updatedTurn: turn }, kind);
  if (!candidate) return;

  const known = knownSequences(memory);
  candidate.basisSequences = candidate.basisSequences.filter(sequence => known.has(sequence));
  const evidenceCount = candidate.basisSequences.length;
  const evidenceCap = evidenceCount > 0
    ? (kind === 'convention' ? 0.7 : 0.75)
    : 0.35;
  candidate.confidence = Math.min(candidate.confidence, evidenceCap);

  const existing = memory[collectionName].find(entry => entry.key === candidate.key);
  if (existing) {
    if (candidate.evidenceStatus === 'new_corroboration' || candidate.evidenceStatus === 'legacy') {
      candidate.basisSequences = [...new Set([...existing.basisSequences, ...candidate.basisSequences])].slice(-8);
      const combinedCap = kind === 'convention' ? 0.7 : 0.75;
      candidate.confidence = Math.min(Math.max(existing.confidence, candidate.confidence), combinedCap);
    } else {
      candidate.basisSequences = existing.basisSequences;
      const decay = candidate.evidenceStatus === 'weakened'
        ? 0.12
        : (kind === 'hypothesis' ? (candidate.evidenceStatus === 'repetition_only' ? 0.05 : 0.025) : 0);
      candidate.confidence = Math.max(
        kind === 'convention' ? 0.2 : 0.1,
        Math.min(candidate.confidence, existing.confidence - decay)
      );
    }
  } else if (candidate.evidenceStatus !== 'new_corroboration' && candidate.evidenceStatus !== 'legacy') {
    const unsupportedCap = candidate.evidenceStatus === 'weakened' ? 0.25 : 0.35;
    candidate.confidence = Math.min(candidate.confidence, unsupportedCap);
    if (candidate.evidenceStatus === 'repetition_only') candidate.basisSequences = [];
  }
  memory[collectionName] = [
    ...memory[collectionName].filter(entry => entry.key !== candidate.key),
    candidate
  ].slice(collectionName === 'visualConventions' ? -MAX_CONVENTIONS : -MAX_HYPOTHESES);
}

export function applyMemoryRevision(memory, revision, {
  turn = 0,
  sheetMessage = null,
  sheetInterpretation = '',
  sheetConfidence = 0.35,
  sheetPerception = null,
  reconciliation = null,
  observation = '',
  sourcePanoId = null,
  updatedAt = new Date().toISOString()
} = {}) {
  const normalized = normalizeAgentMemory(memory);
  const update = revision && typeof revision === 'object' ? revision : {};
  const currentPlan = cleanString(update.currentPlan, 500);
  if (currentPlan) normalized.currentPlan = currentPlan;

  const sequence = positiveInt(sheetMessage?.sequence);
  const interpreted = cleanString(sheetInterpretation, 500);
  if (interpreted && sequence > 0) {
    const previous = normalized.receivedSheets.find(item => item.sequence === sequence);
    const entry = normalizeReceived({
      turn,
      sequence,
      from: sheetMessage?.from,
      interpretation: interpreted,
      confidence: sheetConfidence,
      literalContents: sheetPerception?.literalContents || previous?.literalContents,
      possiblePlaces: sheetPerception?.possiblePlaces || previous?.possiblePlaces,
      possibleIntentions: sheetPerception?.possibleIntentions || previous?.possibleIntentions,
      primarySubject: sheetPerception?.primarySubject || previous?.primarySubject,
      communicationFunction: sheetPerception?.communicationFunction || previous?.communicationFunction,
      frameOfReference: sheetPerception?.frameOfReference || previous?.frameOfReference,
      requestedResponse: sheetPerception?.requestedResponse || previous?.requestedResponse,
      informationNovelty: sheetPerception?.informationNovelty || previous?.informationNovelty,
      createdAt: updatedAt
    });
    normalized.receivedSheets = [
      ...normalized.receivedSheets.filter(item => item.sequence !== sequence),
      entry
    ].filter(Boolean).slice(-MAX_RECEIVED_SHEETS);
  }

  const observed = normalizeObservation({ turn, description: observation, sourcePanoId, createdAt: updatedAt });
  if (observed) normalized.ownObservations = [...normalized.ownObservations, observed].slice(-MAX_OBSERVATIONS);

  mergeBelief(normalized, 'visualConventions', update.conventionUpdate, turn);
  mergeBelief(normalized, 'partnerHypotheses', update.partnerHypothesis, turn);
  const reconciled = normalizeReconciliation({
    ...reconciliation,
    turn,
    sheetSequence: sequence,
    createdAt: updatedAt
  });
  if (reconciled) {
    normalized.reconciliations = [...normalized.reconciliations, reconciled].slice(-MAX_RECONCILIATIONS);
  }
  normalized.updatedTurn = positiveInt(turn);
  normalized.updatedAt = updatedAt;
  return normalized;
}

export function recordSentMessage(memory, {
  turn = 0,
  sequence = 0,
  to = null,
  intent = '',
  contributionKind = '',
  contributionEvidenceId = '',
  contributionSummary = '',
  informationDelta = '',
  continuityReason = '',
  groundedFeatures = [],
  createdAt = new Date().toISOString()
} = {}) {
  const normalized = normalizeAgentMemory(memory);
  const entry = normalizeSent({
    turn,
    sequence,
    to,
    intent,
    contributionKind,
    contributionEvidenceId,
    contributionSummary,
    informationDelta,
    continuityReason,
    groundedFeatures,
    createdAt
  });
  if (!entry) return normalized;
  normalized.sentMessages = [
    ...normalized.sentMessages.filter(item => item.sequence !== entry.sequence),
    entry
  ].slice(-MAX_SENT_MESSAGES);
  normalized.updatedTurn = Math.max(normalized.updatedTurn, positiveInt(turn));
  normalized.updatedAt = createdAt;
  return normalized;
}

export function createMovementMemory() {
  return { steps: 0, distanceMeters: 0, headings: [], routeLabels: [] };
}

export function normalizeMovementMemory(raw) {
  const base = createMovementMemory();
  if (!raw || typeof raw !== 'object') return base;
  return {
    steps: positiveInt(raw.steps),
    distanceMeters: positiveInt(raw.distanceMeters),
    headings: (Array.isArray(raw.headings) ? raw.headings : [])
      .map(Number)
      .filter(Number.isFinite)
      .map(value => ((value % 360) + 360) % 360)
      .slice(-MAX_ODOMETRY_HEADINGS),
    routeLabels: cleanList(raw.routeLabels, { limit: MAX_ODOMETRY_LABELS, itemLength: 120 })
  };
}

export function recordMovement(memory, { distanceMeters = 0, heading = null, label = '' } = {}) {
  const normalized = normalizeMovementMemory(memory);
  normalized.steps += 1;
  normalized.distanceMeters += positiveInt(Math.round(Number(distanceMeters) || 0));
  const numericHeading = Number(heading);
  if (Number.isFinite(numericHeading)) {
    normalized.headings = [...normalized.headings, ((numericHeading % 360) + 360) % 360]
      .slice(-MAX_ODOMETRY_HEADINGS);
  }
  const cleanLabel = cleanString(label, 120);
  if (cleanLabel) normalized.routeLabels = [...new Set([...normalized.routeLabels, cleanLabel])].slice(-MAX_ODOMETRY_LABELS);
  return normalized;
}

import { randomUUID } from 'crypto';
import sharp from 'sharp';

export const SCRATCHPAD_WIDTH = 768;
export const SCRATCHPAD_HEIGHT = 512;
export const SCRATCHPAD_MAX_OPERATIONS = 720;
export const SCRATCHPAD_MAX_OPS_PER_TURN = 12;
export const SCRATCHPAD_MAX_CURRENT_OPS_PER_AUTHOR = 9;
export const SCRATCHPAD_MAX_CURRENT_TEXT_OPS_PER_AUTHOR = 3;
export const SCRATCHPAD_LABEL_MAX_CHARS = 28;
export const RASTER_SCRATCHPAD_VERSION = 5;
export const RASTER_SCRATCHPAD_WIDTH = 1152;
export const RASTER_SCRATCHPAD_HEIGHT = 768;
export const RASTER_SCRATCHPAD_MAX_MESSAGES = 160;
export const RASTER_SCRATCHPAD_ATTEMPTS_PER_PLAN = 2;

const SCRATCHPAD_VERSION = 4;
const SKETCH_SCENES = new Set(['intersection', 'storefront', 'park', 'station', 'landmark']);
const SKETCH_DETAILS = new Set([
  'awning',
  'brick',
  'church',
  'clock',
  'scaffolding',
  'stairs',
  'storefront',
  'tower',
  'trafficLight',
  'tree'
]);
const SKETCH_MOVEMENTS = new Set(['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']);

const AGENT_INK = Object.freeze({
  ada: '#24211d',
  theo: '#087fa8'
});

function normalizedAgentId(value, fallback = 'ada') {
  return value === 'theo' ? 'theo' : value === 'ada' ? 'ada' : fallback;
}

function cleanString(value, maxLength = 4000) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength)
    : '';
}

function cleanStringList(values, { limit = 5, maxLength = 180 } = {}) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => cleanString(value, maxLength).replace(/\s+/g, ' '))
    .filter(Boolean))]
    .slice(0, limit);
}

function normalizeSnapshotPosition(raw) {
  const lat = Number(raw?.lat);
  const lng = Number(raw?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function normalizeSnapshotThought(raw) {
  const reasoning = cleanString(raw?.reasoning, 700);
  if (!reasoning) return null;
  return {
    reasoning,
    turn: Math.max(0, Math.floor(Number(raw?.turn) || 0)),
    stepCount: Math.max(0, Math.floor(Number(raw?.stepCount) || 0)),
    mode: cleanString(raw?.mode, 40) || 'decision',
    selectedLabel: cleanString(raw?.selectedLabel, 160) || null,
    createdAt: raw?.createdAt || null
  };
}

export function normalizeRasterSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const agents = {};
  for (const agentId of ['ada', 'theo']) {
    const agent = raw.agents?.[agentId];
    const position = normalizeSnapshotPosition(agent?.position);
    const panoId = cleanString(agent?.panoId, 240);
    if (!agent || !position || !panoId) return null;
    agents[agentId] = {
      name: cleanString(agent.name, 80) || (agentId === 'ada' ? 'Ada' : 'Theo'),
      panoId,
      position,
      heading: Number.isFinite(Number(agent.heading)) ? Number(agent.heading) : 0,
      stepCount: Math.max(0, Math.floor(Number(agent.stepCount) || 0)),
      pathLength: Math.max(1, Math.floor(Number(agent.pathLength) || 1)),
      status: cleanString(agent.status, 40) || 'searching',
      lastThought: normalizeSnapshotThought(agent.lastThought)
    };
  }
  const distanceMeters = Number(raw.distanceMeters);
  return {
    turn: Math.max(0, Math.floor(Number(raw.turn) || 0)),
    status: cleanString(raw.status, 40) || 'running',
    distanceMeters: Number.isFinite(distanceMeters) ? Math.max(0, distanceMeters) : null,
    capturedAt: raw.capturedAt || null,
    approximate: raw.approximate === true,
    agents
  };
}

function normalizeRasterMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const from = normalizedAgentId(raw.from, null);
  const to = normalizedAgentId(raw.to, null);
  const id = cleanString(raw.id, 120);
  const imageFile = cleanString(raw.imageFile, 240);
  if (!id || !from || !to || from === to || !/^[a-zA-Z0-9_.-]+$/.test(imageFile)) return null;
  return {
    id,
    from,
    to,
    turn: Math.max(0, Math.floor(Number(raw.turn) || 0)),
    sequence: Math.max(1, Math.floor(Number(raw.sequence) || 1)),
    imageFile,
    imageMimeType: cleanString(raw.imageMimeType, 80) || 'image/webp',
    imageSha256: cleanString(raw.imageSha256, 128) || null,
    snapshot: normalizeRasterSnapshot(raw.snapshot),
    createdAt: raw.createdAt || null,
    sentAt: raw.sentAt || raw.createdAt || null
  };
}

function normalizePendingRasterMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const from = normalizedAgentId(raw.from, null);
  const to = normalizedAgentId(raw.to, null);
  const id = cleanString(raw.id, 120);
  const drawingPrompt = cleanString(raw.drawingPrompt, 2400);
  if (!id || !from || !to || from === to || !drawingPrompt) return null;
  const attempts = Math.max(0, Math.floor(Number(raw.attempts) || 0));
  const replanCount = Math.min(2, Math.max(0, Math.floor(Number(raw.replanCount) || 0)));
  const persistedTotalAttempts = Number(raw.totalAttempts);
  const hasUsablePersistedTotal = Number.isFinite(persistedTotalAttempts) &&
    (persistedTotalAttempts > 0 || (attempts === 0 && replanCount === 0));
  const totalAttempts = hasUsablePersistedTotal
    ? Math.max(0, Math.floor(persistedTotalAttempts))
    : attempts + (replanCount * RASTER_SCRATCHPAD_ATTEMPTS_PER_PLAN);
  const referenceViewIndices = Array.isArray(raw.referenceViewIndices)
    ? [...new Set(raw.referenceViewIndices.map(Number).filter(Number.isInteger))].slice(0, 4)
    : [];
  const persistedAvailableReferenceViewIndices = Array.isArray(raw.availableReferenceViewIndices)
    ? [...new Set(raw.availableReferenceViewIndices.map(Number).filter(Number.isInteger))].slice(0, 1)
    : [];
  return {
    id,
    from,
    to,
    turn: Math.max(0, Math.floor(Number(raw.turn) || 0)),
    drawingPrompt,
    contributionKind: cleanString(raw.contributionKind, 80),
    contributionEvidenceId: cleanString(raw.contributionEvidenceId, 80),
    contributionSummary: cleanString(raw.contributionSummary, 500),
    drawingIntent: cleanString(raw.drawingIntent, 700),
    informationDelta: cleanString(raw.informationDelta, 700),
    continuityReason: cleanString(raw.continuityReason, 500),
    messageAction: ['movement', 'stillness', 'transition', 'unclear'].includes(raw.messageAction)
      ? raw.messageAction
      : 'unclear',
    groundedFeatures: cleanStringList(raw.groundedFeatures),
    referenceViewIndices,
    availableReferenceViewIndices:
      persistedAvailableReferenceViewIndices.length > 0
        ? persistedAvailableReferenceViewIndices
        : referenceViewIndices.slice(0, 1),
    availableReferenceFeatures: cleanStringList(raw.availableReferenceFeatures),
    sourcePanoId: cleanString(raw.sourcePanoId, 240) || null,
    snapshot: normalizeRasterSnapshot(raw.snapshot),
    status: cleanString(raw.status, 40) || 'generating',
    attempts,
    totalAttempts,
    replanCount,
    replanFailureCount: Math.min(2, Math.max(0, Math.floor(Number(raw.replanFailureCount) || 0))),
    lastError: cleanString(raw.lastError, 500) || null,
    nextAttemptAt: raw.nextAttemptAt || null,
    createdAt: raw.createdAt || new Date().toISOString()
  };
}

function auditablePendingRasterMessage(pending) {
  const {
    availableReferenceViewIndices: _availableReferenceViewIndices,
    availableReferenceFeatures: _availableReferenceFeatures,
    ...auditable
  } = pending;
  return auditable;
}

function normalizeRasterReceipt(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const recipientId = normalizedAgentId(raw.recipientId, null);
  const interpretation = cleanString(raw.interpretation, 500);
  if (!recipientId || !interpretation) return null;
  const numericConfidence = Number(raw.confidence);
  return {
    recipientId,
    turn: Math.max(0, Math.floor(Number(raw.turn) || 0)),
    interpretation,
    confidence: Number.isFinite(numericConfidence)
      ? Math.min(1, Math.max(0, numericConfidence))
      : 0.35,
    literalContents: cleanStringList(raw.literalContents, { limit: 6, maxLength: 220 }),
    possiblePlaces: cleanStringList(raw.possiblePlaces, { limit: 4, maxLength: 220 }),
    possibleIntentions: cleanStringList(raw.possibleIntentions, { limit: 4, maxLength: 220 }),
    primarySubject: cleanString(raw.primarySubject, 400),
    communicationFunction: [
      'report',
      'request',
      'question',
      'acknowledgement',
      'correction',
      'shared_proposal',
      'unclear'
    ].includes(raw.communicationFunction)
      ? raw.communicationFunction
      : 'unclear',
    frameOfReference: ['sender', 'recipient', 'shared', 'unclear'].includes(raw.frameOfReference)
      ? raw.frameOfReference
      : 'unclear',
    requestedResponse: cleanString(raw.requestedResponse, 400),
    informationNovelty: ['new', 'mixed', 'repeated', 'unclear'].includes(raw.informationNovelty)
      ? raw.informationNovelty
      : 'unclear',
    action: ['move', 'retrace', 'wait'].includes(raw.action) ? raw.action : null,
    reasoning: cleanString(raw.reasoning, 700),
    observation: cleanString(raw.observation, 700),
    currentPlan: cleanString(raw.currentPlan, 500),
    planAssessment: ['supporting', 'weakening', 'inconclusive'].includes(raw.planAssessment)
      ? raw.planAssessment
      : 'inconclusive',
    recordedAt: raw.recordedAt || null
  };
}

export function createRasterScratchpad({ owner = 'ada', turn = 0 } = {}) {
  return {
    version: RASTER_SCRATCHPAD_VERSION,
    width: RASTER_SCRATCHPAD_WIDTH,
    height: RASTER_SCRATCHPAD_HEIGHT,
    owner: normalizedAgentId(owner),
    sequence: 0,
    heldSinceTurn: Math.max(0, Math.floor(Number(turn) || 0)),
    currentMessage: null,
    pendingMessage: null,
    messageAudit: [],
    updatedAt: new Date().toISOString()
  };
}

export function normalizeRasterScratchpad(raw, { turn = 0 } = {}) {
  const base = createRasterScratchpad({ owner: raw?.owner, turn });
  if (!raw || Number(raw.version) !== RASTER_SCRATCHPAD_VERSION) return base;
  const currentMessage = normalizeRasterMessage(raw.currentMessage);
  const pendingMessage = normalizePendingRasterMessage(raw.pendingMessage);
  const audit = Array.isArray(raw.messageAudit)
    ? raw.messageAudit.slice(-RASTER_SCRATCHPAD_MAX_MESSAGES).map(entry => ({
        id: cleanString(entry?.id, 120),
        from: normalizedAgentId(entry?.from, null),
        to: normalizedAgentId(entry?.to, null),
        turn: Math.max(0, Math.floor(Number(entry?.turn) || 0)),
        sequence: Math.max(0, Math.floor(Number(entry?.sequence) || 0)),
        drawingPrompt: cleanString(entry?.drawingPrompt, 2400),
        contributionKind: cleanString(entry?.contributionKind, 80),
        contributionEvidenceId: cleanString(entry?.contributionEvidenceId, 80),
        contributionSummary: cleanString(entry?.contributionSummary, 500),
        drawingIntent: cleanString(entry?.drawingIntent, 700),
        informationDelta: cleanString(entry?.informationDelta, 700),
        continuityReason: cleanString(entry?.continuityReason, 500),
        messageAction: ['movement', 'stillness', 'transition', 'unclear'].includes(entry?.messageAction)
          ? entry.messageAction
          : 'unclear',
        groundedFeatures: cleanStringList(entry?.groundedFeatures),
        referenceViewIndices: Array.isArray(entry?.referenceViewIndices)
          ? [...new Set(entry.referenceViewIndices.map(Number).filter(Number.isInteger))].slice(0, 4)
          : [],
        sourcePanoId: cleanString(entry?.sourcePanoId, 240) || null,
        imageFile: cleanString(entry?.imageFile, 240) || null,
        imageMimeType: cleanString(entry?.imageMimeType, 80) || null,
        imageSha256: cleanString(entry?.imageSha256, 128) || null,
        sourceImageFile: cleanString(entry?.sourceImageFile, 240) || null,
        renderMode: ['source_grounded', 'authored'].includes(entry?.renderMode)
          ? entry.renderMode
          : 'authored',
        receipt: normalizeRasterReceipt(entry?.receipt),
        snapshot: normalizeRasterSnapshot(entry?.snapshot),
        imageModel: cleanString(entry?.imageModel, 120) || null,
        requestId: cleanString(entry?.requestId, 240) || null,
        reviewAssessment: cleanString(entry?.reviewAssessment, 500) || null,
        renderAttempts: Math.max(0, Math.floor(Number(entry?.renderAttempts) || 0)),
        attempts: Math.max(0, Math.floor(Number(entry?.attempts) || 0)),
        totalAttempts: Math.max(0, Math.floor(Number(entry?.totalAttempts) || 0)),
        replanCount: Math.min(2, Math.max(0, Math.floor(Number(entry?.replanCount) || 0))),
        status: cleanString(entry?.status, 40) || 'sent',
        error: cleanString(entry?.error, 500) || null,
        createdAt: entry?.createdAt || null,
        sentAt: entry?.sentAt || null
      })).filter(entry => entry.id && entry.from && entry.to)
    : [];
  return {
    ...base,
    owner: normalizedAgentId(raw.owner),
    sequence: Math.max(
      Math.max(0, Math.floor(Number(raw.sequence) || 0)),
      currentMessage?.sequence || 0
    ),
    heldSinceTurn: Math.max(0, Math.floor(Number(raw.heldSinceTurn) || turn)),
    currentMessage,
    pendingMessage,
    messageAudit: audit,
    updatedAt: raw.updatedAt || base.updatedAt
  };
}

export function queueRasterScratchpadMessage(scratchpad, {
  agentId,
  turn,
  drawingPrompt,
  contributionKind = '',
  contributionEvidenceId = '',
  contributionSummary = '',
  drawingIntent = '',
  informationDelta = '',
  continuityReason = '',
  messageAction = 'unclear',
  groundedFeatures = [],
  referenceViewIndices = [],
  availableReferenceViewIndices = [],
  availableReferenceFeatures = [],
  sourcePanoId = null,
  snapshot = null,
  id = randomUUID()
}) {
  const normalized = normalizeRasterScratchpad(scratchpad, { turn });
  if (normalized.owner !== agentId || normalized.pendingMessage) return normalized;
  normalized.pendingMessage = normalizePendingRasterMessage({
    id,
    from: agentId,
    to: oppositeAgent(agentId),
    turn,
    drawingPrompt,
    contributionKind,
    contributionEvidenceId,
    contributionSummary,
    drawingIntent,
    informationDelta,
    continuityReason,
    messageAction,
    groundedFeatures,
    referenceViewIndices,
    availableReferenceViewIndices,
    availableReferenceFeatures,
    sourcePanoId,
    snapshot,
    attempts: 0,
    totalAttempts: 0,
    replanCount: 0,
    replanFailureCount: 0,
    createdAt: new Date().toISOString()
  });
  normalized.updatedAt = new Date().toISOString();
  return normalized;
}

export function commitRasterScratchpadMessage(scratchpad, {
  pendingId,
  imageFile,
  imageMimeType = 'image/webp',
  imageSha256 = null,
  sourceImageFile = null,
  renderMode = 'authored',
  imageModel = null,
  requestId = null,
  reviewAssessment = null,
  renderAttempts = 1,
  sentAt = new Date().toISOString()
}) {
  const normalized = normalizeRasterScratchpad(scratchpad);
  const pending = normalized.pendingMessage;
  if (!pending || pending.id !== pendingId) return normalized;
  const sequence = normalized.sequence + 1;
  const message = normalizeRasterMessage({
    ...pending,
    sequence,
    imageFile,
    imageMimeType,
    imageSha256,
    sentAt
  });
  if (!message) return normalized;
  normalized.currentMessage = message;
  normalized.pendingMessage = null;
  normalized.sequence = sequence;
  normalized.owner = pending.to;
  normalized.heldSinceTurn = pending.turn;
  normalized.messageAudit = [...normalized.messageAudit, {
    ...auditablePendingRasterMessage(pending),
    sequence,
    imageFile,
    imageMimeType,
    imageSha256,
    sourceImageFile: cleanString(sourceImageFile, 240) || null,
    renderMode: renderMode === 'source_grounded' ? 'source_grounded' : 'authored',
    imageModel,
    requestId,
    reviewAssessment: cleanString(reviewAssessment, 500) || null,
    renderAttempts: Math.max(1, Math.floor(Number(renderAttempts) || 1)),
    status: 'sent',
    sentAt
  }].slice(-RASTER_SCRATCHPAD_MAX_MESSAGES);
  normalized.updatedAt = sentAt;
  return normalized;
}

export function markRasterScratchpadAttempt(scratchpad, { pendingId }) {
  const normalized = normalizeRasterScratchpad(scratchpad);
  const pending = normalized.pendingMessage;
  if (!pending || pending.id !== pendingId) return normalized;
  normalized.pendingMessage = {
    ...pending,
    status: 'generating',
    attempts: pending.attempts + 1,
    totalAttempts: pending.totalAttempts + 1,
    lastError: null,
    nextAttemptAt: null
  };
  normalized.updatedAt = new Date().toISOString();
  return normalized;
}

export function retryRasterScratchpadMessage(scratchpad, {
  pendingId,
  error,
  nextAttemptAt,
  drawingPrompt = null
}) {
  const normalized = normalizeRasterScratchpad(scratchpad);
  const pending = normalized.pendingMessage;
  if (!pending || pending.id !== pendingId) return normalized;
  normalized.pendingMessage = {
    ...pending,
    drawingPrompt: cleanString(drawingPrompt, 2400) || pending.drawingPrompt,
    status: 'retrying',
    lastError: cleanString(error, 500),
    nextAttemptAt: nextAttemptAt || null
  };
  normalized.updatedAt = new Date().toISOString();
  return normalized;
}

export function failRasterScratchpadMessage(scratchpad, { pendingId, error }) {
  const normalized = normalizeRasterScratchpad(scratchpad);
  const pending = normalized.pendingMessage;
  if (!pending || pending.id !== pendingId) return normalized;
  normalized.messageAudit = [...normalized.messageAudit, {
    ...auditablePendingRasterMessage(pending),
    sequence: normalized.sequence,
    status: 'failed',
    error: cleanString(error, 500),
    sentAt: null
  }].slice(-RASTER_SCRATCHPAD_MAX_MESSAGES);
  normalized.pendingMessage = null;
  normalized.updatedAt = new Date().toISOString();
  return normalized;
}

export function recordRasterScratchpadReceipt(scratchpad, {
  sequence,
  recipientId,
  turn = 0,
  interpretation = '',
  confidence = 0.35,
  perception = null,
  action = null,
  reasoning = '',
  observation = '',
  currentPlan = '',
  planAssessment = null,
  recordedAt = new Date().toISOString()
}) {
  const normalized = normalizeRasterScratchpad(scratchpad);
  const targetSequence = Math.max(1, Math.floor(Number(sequence) || 0));
  const index = normalized.messageAudit.findIndex(message =>
    message.status === 'sent' &&
    message.sequence === targetSequence &&
    message.to === recipientId
  );
  if (index < 0) return normalized;
  const previous = normalized.messageAudit[index].receipt;
  const receipt = normalizeRasterReceipt({
    ...previous,
    recipientId,
    turn,
    interpretation: interpretation || previous?.interpretation,
    confidence,
    literalContents: perception?.literalContents || previous?.literalContents,
    possiblePlaces: perception?.possiblePlaces || previous?.possiblePlaces,
    possibleIntentions: perception?.possibleIntentions || previous?.possibleIntentions,
    primarySubject: perception?.primarySubject || previous?.primarySubject,
    communicationFunction:
      perception?.communicationFunction || previous?.communicationFunction,
    frameOfReference: perception?.frameOfReference || previous?.frameOfReference,
    requestedResponse: perception?.requestedResponse || previous?.requestedResponse,
    informationNovelty: perception?.informationNovelty || previous?.informationNovelty,
    action: action || previous?.action,
    reasoning: reasoning || previous?.reasoning,
    observation: observation || previous?.observation,
    currentPlan: currentPlan || previous?.currentPlan,
    planAssessment: planAssessment || previous?.planAssessment,
    recordedAt
  });
  if (!receipt) return normalized;
  normalized.messageAudit[index] = {
    ...normalized.messageAudit[index],
    receipt
  };
  normalized.updatedAt = recordedAt;
  return normalized;
}

export function publicRasterScratchpad(scratchpad, { imageUrlFor = null } = {}) {
  const normalized = normalizeRasterScratchpad(scratchpad);
  const currentMessage = normalized.currentMessage
    ? {
        id: normalized.currentMessage.id,
        from: normalized.currentMessage.from,
        to: normalized.currentMessage.to,
        turn: normalized.currentMessage.turn,
        sequence: normalized.currentMessage.sequence,
        createdAt: normalized.currentMessage.createdAt,
        sentAt: normalized.currentMessage.sentAt,
        imageUrl: typeof imageUrlFor === 'function' ? imageUrlFor(normalized.currentMessage) : null
      }
    : null;
  return {
    version: normalized.version,
    width: normalized.width,
    height: normalized.height,
    owner: normalized.owner,
    sequence: normalized.sequence,
    heldSinceTurn: normalized.heldSinceTurn,
    currentMessage,
    messageFrom: currentMessage?.from || null,
    messageTo: currentMessage?.to || null,
    isGenerating: Boolean(normalized.pendingMessage),
    updatedAt: normalized.updatedAt
  };
}

export function publicRasterScratchpadHistory(scratchpad, {
  imageUrlFor = null,
  snapshotFor = null
} = {}) {
  const normalized = normalizeRasterScratchpad(scratchpad);
  const messages = normalized.messageAudit
    .filter(message => message.status === 'sent' && message.imageFile)
    .map(message => ({
      id: message.id,
      from: message.from,
      to: message.to,
      turn: message.turn,
      sequence: message.sequence,
      createdAt: message.createdAt,
      sentAt: message.sentAt,
      imageUrl: typeof imageUrlFor === 'function' ? imageUrlFor(message) : null,
      snapshot: message.snapshot || (typeof snapshotFor === 'function' ? snapshotFor(message) : null)
    }))
    .filter(message => message.snapshot)
    .sort((a, b) => a.sequence - b.sequence);
  return {
    sequence: normalized.sequence,
    items: messages
  };
}

function clamp(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function point(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    x: clamp(value.x, 0, 1, 0.5),
    y: clamp(value.y, 0, 1, 0.5)
  };
}

function textValue(value) {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SCRATCHPAD_LABEL_MAX_CHARS);
  if (/-?\d{1,3}\.\d{3,}/.test(text)) return '';
  if (/\b(?:ada|theo|friend|partner)\b.{0,14}\b\d+(?:\.\d+)?\s?(?:m|km|meters?|kilometers?)\b/i.test(text)) {
    return '';
  }
  if (/\b(?:go|head|follow|pursue|meet|intercept|target|rendezvous|to)\b/i.test(text)) return '';
  if (/\btoward(?:s)?\b|->/i.test(text)) return '';
  return text;
}

function persistedTextValue(value) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ')
    : '';
}

function directiveText(value) {
  return /\b(?:go|head|follow|pursue|meet|intercept|target|rendezvous|to)\b/i.test(value) ||
    /\btoward(?:s)?\b|->/i.test(value);
}

export function sanitizeScratchpadOperation(raw, agentId, { strictText = true, migratedFromVersion = 3 } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '').toLowerCase();
  const author = agentId === 'theo' ? 'theo' : 'ada';
  const base = {
    type,
    author,
    color: AGENT_INK[author] || AGENT_INK.ada,
    width: clamp(raw.width, 1, 12, 4)
  };

  if (type === 'replacemine') {
    return {
      type: 'replaceMine',
      author,
      color: base.color,
      scope: 'mine'
    };
  }

  if (type === 'replacesheet') {
    return {
      type: 'replaceSheet',
      author,
      color: base.color,
      scope: 'sheet'
    };
  }

  if (type === 'sketch') {
    const label = strictText
      ? textValue(raw.label || '')
      : persistedTextValue(raw.label || '').slice(0, SCRATCHPAD_LABEL_MAX_CHARS);
    const secondaryLabel = strictText
      ? textValue(raw.secondaryLabel || '')
      : persistedTextValue(raw.secondaryLabel || '').slice(0, SCRATCHPAD_LABEL_MAX_CHARS);
    const scene = SKETCH_SCENES.has(raw.scene) ? raw.scene : 'intersection';
    const details = Array.isArray(raw.details)
      ? [...new Set(raw.details.filter(detail => SKETCH_DETAILS.has(detail)))].slice(0, 4)
      : [];
    const movement = SKETCH_MOVEMENTS.has(raw.movement) ? raw.movement : null;
    return {
      type: 'sketch',
      author,
      color: base.color,
      scene,
      details,
      label,
      secondaryLabel,
      movement,
      migratedFromVersion
    };
  }

  if (type === 'text') {
    const text = strictText ? textValue(raw.text) : persistedTextValue(raw.text);
    const at = point(raw.at || raw);
    if (!text || !at) return null;
    return {
      ...base,
      text,
      at,
      size: clamp(raw.size, 14, 54, 28),
      rotation: clamp(raw.rotation, -18, 18, 0),
      migratedFromVersion
    };
  }

  if (type === 'landmark') {
    const center = point(raw.center || raw);
    if (!center) return null;
    const symbol = ['dot', 'star', 'park', 'station', 'square'].includes(raw.symbol)
      ? raw.symbol
      : 'dot';
    const label = strictText
      ? textValue(raw.label || raw.text || '')
      : persistedTextValue(raw.label || raw.text || '');
    return {
      ...base,
      center,
      symbol,
      label,
      radius: clamp(raw.radius, 0.025, 0.14, 0.055),
      migratedFromVersion
    };
  }

  if (type === 'circle') {
    const center = point(raw.center || raw);
    if (!center) return null;
    return {
      ...base,
      center,
      radiusX: clamp(raw.radiusX ?? raw.radius, 0.015, 0.35, 0.1),
      radiusY: clamp(raw.radiusY ?? raw.radius, 0.015, 0.35, 0.1),
      migratedFromVersion
    };
  }

  if (type === 'line' || type === 'arrow' || type === 'erase') {
    const from = point(raw.from);
    const to = point(raw.to);
    if (!from || !to) return null;
    return {
      ...base,
      from,
      to,
      width: type === 'erase' ? clamp(raw.width, 12, 80, 28) : base.width,
      migratedFromVersion
    };
  }

  if (type === 'stroke') {
    const points = Array.isArray(raw.points)
      ? raw.points.slice(0, 48).map(point).filter(Boolean)
      : [];
    if (points.length < 2) return null;
    return { ...base, points, migratedFromVersion };
  }

  return null;
}

export function createScratchpad({ owner = 'ada', turn = 0 } = {}) {
  return {
    version: SCRATCHPAD_VERSION,
    width: SCRATCHPAD_WIDTH,
    height: SCRATCHPAD_HEIGHT,
    owner,
    inTransit: null,
    sequence: 0,
    heldSinceTurn: turn,
    operations: [],
    archivedOperationCount: 0,
    archivedThroughSequence: 0,
    earliestRetainedSequence: 0,
    currentOperations: [],
    updatedAt: new Date().toISOString()
  };
}

function renderableOperation(operation) {
  return operation && !['replaceMine', 'replaceSheet'].includes(operation.type);
}

function distance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y));
}

function normalizedText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function endpoints(operation) {
  if (operation.type === 'stroke') {
    const points = Array.isArray(operation.points) ? operation.points : [];
    return { from: points[0], to: points.at(-1) };
  }
  return { from: operation.from, to: operation.to };
}

function similarGeometry(a, b) {
  const aEnds = endpoints(a);
  const bEnds = endpoints(b);
  const direct = distance(aEnds.from, bEnds.from) + distance(aEnds.to, bEnds.to);
  const reverse = distance(aEnds.from, bEnds.to) + distance(aEnds.to, bEnds.from);
  return Math.min(direct, reverse) < 0.075;
}

function similarOperation(a, b) {
  if (!a || !b || a.author !== b.author) return false;
  if (a.type === 'text' && b.type === 'text') {
    return normalizedText(a.text) === normalizedText(b.text) && distance(a.at, b.at) < 0.12;
  }
  if (['line', 'arrow', 'erase', 'stroke'].includes(a.type) && ['line', 'arrow', 'erase', 'stroke'].includes(b.type)) {
    return similarGeometry(a, b);
  }
  if (a.type === b.type && a.type === 'circle') {
    return distance(a.center, b.center) < 0.08 &&
      Math.abs(Number(a.radiusX) - Number(b.radiusX)) < 0.04 &&
      Math.abs(Number(a.radiusY) - Number(b.radiusY)) < 0.04;
  }
  if (a.type === b.type && a.type === 'landmark') {
    return distance(a.center, b.center) < 0.08 &&
      normalizedText(a.label) === normalizedText(b.label);
  }
  return false;
}

function supersede(operation, byOperation, reason) {
  if (!operation || operation.supersededAtSequence) return;
  operation.supersededBy = byOperation?.id || null;
  operation.supersededAtSequence = byOperation?.sequence || operation.sequence;
  operation.supersededReason = reason;
}

function isTextLike(operation) {
  return operation.type === 'text' || (operation.type === 'landmark' && operation.label);
}

function applyCurrentViewRules(operations) {
  const result = operations
    .map(operation => ({ ...operation }))
    .sort((a, b) => (a.sequence - b.sequence) || String(a.id).localeCompare(String(b.id)));

  for (const operation of result) {
    delete operation.supersededBy;
    delete operation.supersededAtSequence;
    delete operation.supersededReason;
  }

  const visibleNow = (author, predicate = () => true, throughSequence = Infinity) => result.filter(operation =>
    renderableOperation(operation) &&
    operation.author === author &&
    !operation.supersededAtSequence &&
    operation.sequence <= throughSequence &&
    predicate(operation)
  );

  for (const operation of result) {
    if (operation.type === 'replaceSheet') {
      for (const previous of result.filter(candidate =>
        renderableOperation(candidate) &&
        !candidate.supersededAtSequence &&
        candidate.sequence < operation.sequence
      )) {
        supersede(previous, operation, 'replaced_by_message');
      }
      continue;
    }

    if (operation.type === 'replaceMine') {
      for (const previous of visibleNow(operation.author, () => true, operation.sequence)) {
        if (previous.sequence < operation.sequence) supersede(previous, operation, 'replaced_by_author');
      }
      continue;
    }

    if (!renderableOperation(operation)) continue;

    if (
      Number(operation.migratedFromVersion || 3) < 3 &&
      (operation.type === 'text' || operation.type === 'landmark') &&
      directiveText(operation.text || operation.label || '')
    ) {
      supersede(operation, operation, 'legacy_directive_text');
      continue;
    }

    for (const previous of visibleNow(operation.author, () => true, operation.sequence)) {
      if (previous.id !== operation.id && previous.sequence < operation.sequence && similarOperation(previous, operation)) {
        supersede(previous, operation, 'deduplicated');
      }
    }

    let authorVisible = visibleNow(operation.author, () => true, operation.sequence);
    while (authorVisible.length > SCRATCHPAD_MAX_CURRENT_OPS_PER_AUTHOR) {
      const oldest = authorVisible[0];
      supersede(oldest, operation, 'compacted');
      authorVisible = visibleNow(operation.author, () => true, operation.sequence);
    }

    let textVisible = visibleNow(operation.author, isTextLike, operation.sequence);
    while (textVisible.length > SCRATCHPAD_MAX_CURRENT_TEXT_OPS_PER_AUTHOR) {
      const oldest = textVisible[0];
      supersede(oldest, operation, 'compacted_text');
      textVisible = visibleNow(operation.author, isTextLike, operation.sequence);
    }
  }

  return result;
}

function oppositeAgent(agentId) {
  return agentId === 'theo' ? 'ada' : 'theo';
}

function directionFromLegacyOperation(operation) {
  const ends = endpoints(operation || {});
  if (!ends.from || !ends.to) return null;
  const dx = Number(ends.to.x) - Number(ends.from.x);
  const dy = Number(ends.to.y) - Number(ends.from.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 0.04) return null;
  const horizontal = Math.abs(dx) > Math.abs(dy) * 1.8;
  const vertical = Math.abs(dy) > Math.abs(dx) * 1.8;
  if (horizontal) return dx > 0 ? 'east' : 'west';
  if (vertical) return dy > 0 ? 'south' : 'north';
  if (dx > 0) return dy > 0 ? 'southeast' : 'northeast';
  return dy > 0 ? 'southwest' : 'northwest';
}

function migrateLegacyCurrentMessage(operations, sequence, turn) {
  const ruled = applyCurrentViewRules(operations);
  const current = currentScratchpadOperations({ operations: ruled });
  if (current.length === 0) return { operations: ruled, sequence };

  const latest = [...current].sort((a, b) => b.sequence - a.sequence)[0];
  const author = latest.author === 'theo' ? 'theo' : 'ada';
  const authorOperations = current.filter(operation => operation.author === author);
  const labels = authorOperations
    .map(operation => operation.type === 'text' ? operation.text : operation.label)
    .map(value => persistedTextValue(value).trim().slice(0, SCRATCHPAD_LABEL_MAX_CHARS))
    .filter(Boolean)
    .slice(-2);
  const movement = [...authorOperations]
    .reverse()
    .map(directionFromLegacyOperation)
    .find(Boolean) || null;
  const landmark = [...authorOperations].reverse().find(operation => operation.type === 'landmark');
  const scene = landmark?.symbol === 'park'
    ? 'park'
    : landmark?.symbol === 'station'
      ? 'station'
      : 'intersection';
  const details = scene === 'park'
    ? ['tree', 'trafficLight']
    : scene === 'station'
      ? ['stairs', 'storefront', 'trafficLight']
      : ['brick', 'awning', 'trafficLight', 'tree'];
  const replacementSequence = sequence + 1;
  const sketchSequence = sequence + 2;
  const createdAt = latest.createdAt || new Date().toISOString();
  const migrated = [
    ...ruled,
    {
      type: 'replaceSheet',
      author,
      color: AGENT_INK[author],
      scope: 'sheet',
      id: `v4-message-${replacementSequence}`,
      sequence: replacementSequence,
      turn,
      createdAt
    },
    {
      type: 'sketch',
      author,
      color: AGENT_INK[author],
      scene,
      details,
      label: labels.at(-1) || '',
      secondaryLabel: labels.at(-2) || '',
      movement,
      migratedFromVersion: 3,
      id: `v4-sketch-${sketchSequence}`,
      sequence: sketchSequence,
      turn,
      createdAt
    }
  ];
  return {
    operations: applyCurrentViewRules(migrated),
    sequence: sketchSequence
  };
}

function retainScratchpadAudit(operations, raw = {}) {
  let retained = operations
    .map(operation => ({ ...operation }))
    .sort((a, b) => (a.sequence - b.sequence) || String(a.id).localeCompare(String(b.id)));
  const previouslyArchivedCount = Math.max(0, Math.floor(Number(raw.archivedOperationCount) || 0));
  const previouslyArchivedThrough = Math.max(0, Math.floor(Number(raw.archivedThroughSequence) || 0));

  if (retained.length <= SCRATCHPAD_MAX_OPERATIONS) {
    return {
      operations: retained,
      archivedOperationCount: previouslyArchivedCount,
      archivedThroughSequence: previouslyArchivedThrough,
      earliestRetainedSequence: retained[0]?.sequence || 0
    };
  }

  let archivedOperationCount = previouslyArchivedCount;
  let archivedThroughSequence = previouslyArchivedThrough;

  while (retained.length > SCRATCHPAD_MAX_OPERATIONS) {
    const [dropped] = retained.splice(0, 1);
    archivedOperationCount += 1;
    archivedThroughSequence = Math.max(archivedThroughSequence, Number(dropped.sequence) || 0);
  }

  retained = retained.sort((a, b) => (a.sequence - b.sequence) || String(a.id).localeCompare(String(b.id)));
  return {
    operations: retained,
    archivedOperationCount,
    archivedThroughSequence,
    earliestRetainedSequence: retained[0]?.sequence || 0
  };
}

export function currentScratchpadOperations(scratchpad, { throughSequence = Infinity } = {}) {
  const sequenceLimit = Number.isFinite(Number(throughSequence)) ? Number(throughSequence) : Infinity;
  const operations = Array.isArray(scratchpad?.operations) ? scratchpad.operations : [];
  return operations.filter(operation =>
    renderableOperation(operation) &&
    Number(operation.sequence) <= sequenceLimit &&
    (!Number.isFinite(Number(operation.supersededAtSequence)) ||
      Number(operation.supersededAtSequence) > sequenceLimit)
  );
}

export function normalizeScratchpad(raw, { turn = 0 } = {}) {
  if (Number(raw?.version) === RASTER_SCRATCHPAD_VERSION) {
    return normalizeRasterScratchpad(raw, { turn });
  }
  const base = createScratchpad({ turn });
  if (!raw || typeof raw !== 'object' || Number(raw.version) < 2) return base;
  const migratedFromVersion = Math.max(2, Math.floor(Number(raw.version) || 2));

  const rawOperations = Array.isArray(raw.operations)
    ? raw.operations
        .map((operation, index) => {
          const sanitized = sanitizeScratchpadOperation(operation, operation?.author, {
            strictText: false,
            migratedFromVersion
          });
          if (!sanitized) return null;
          return {
            ...sanitized,
            id: String(operation.id || `legacy-${Math.max(1, Math.floor(Number(operation.sequence) || index + 1))}-${index}`),
            sequence: Math.max(1, Math.floor(Number(operation.sequence) || 1)),
            turn: Math.max(0, Math.floor(Number(operation.turn) || 0)),
            createdAt: operation.createdAt || null
          };
        })
        .filter(Boolean)
    : [];
  const rawSequence = Math.max(
    Math.floor(Number(raw.sequence) || 0),
    rawOperations.reduce((max, operation) => Math.max(max, operation.sequence), 0)
  );
  const migrated = migratedFromVersion < SCRATCHPAD_VERSION
    ? migrateLegacyCurrentMessage(rawOperations, rawSequence, turn)
    : { operations: applyCurrentViewRules(rawOperations), sequence: rawSequence };
  const retainedAudit = retainScratchpadAudit(migrated.operations, raw);
  const operations = retainedAudit.operations;

  const owner = raw.owner === 'ada' || raw.owner === 'theo' ? raw.owner : null;
  const inTransit = raw.inTransit && typeof raw.inTransit === 'object'
    ? {
        from: raw.inTransit.from === 'theo' ? 'theo' : 'ada',
        to: raw.inTransit.to === 'ada' ? 'ada' : 'theo',
        sentTurn: Math.max(0, Math.floor(Number(raw.inTransit.sentTurn) || 0)),
        deliverTurn: Math.max(0, Math.floor(Number(raw.inTransit.deliverTurn) || 0))
      }
    : null;

  return {
    ...base,
    owner: inTransit ? null : owner || 'ada',
    inTransit,
    sequence: Math.max(migrated.sequence, operations.reduce((max, operation) => Math.max(max, operation.sequence), 0)),
    heldSinceTurn: Math.max(0, Math.floor(Number(raw.heldSinceTurn) || turn)),
    operations,
    archivedOperationCount: retainedAudit.archivedOperationCount,
    archivedThroughSequence: retainedAudit.archivedThroughSequence,
    earliestRetainedSequence: retainedAudit.earliestRetainedSequence,
    currentOperations: currentScratchpadOperations({ operations }),
    messageFrom: currentScratchpadOperations({ operations }).at(-1)?.author || null,
    messageTo: currentScratchpadOperations({ operations }).at(-1)?.author
      ? oppositeAgent(currentScratchpadOperations({ operations }).at(-1).author)
      : null,
    updatedAt: raw.updatedAt || base.updatedAt
  };
}

function sketchFromIncomingOperations(incoming, agentId) {
  const sanitized = incoming
    .slice(0, SCRATCHPAD_MAX_OPS_PER_TURN)
    .map(operation => sanitizeScratchpadOperation(operation, agentId))
    .filter(Boolean);
  const explicitSketch = [...sanitized].reverse().find(operation => operation.type === 'sketch');
  if (explicitSketch) return explicitSketch;

  const renderable = sanitized.filter(renderableOperation);
  if (renderable.length === 0) return null;
  const labels = renderable
    .map(operation => operation.type === 'text' ? operation.text : operation.label)
    .filter(Boolean)
    .slice(-2);
  const landmark = [...renderable].reverse().find(operation => operation.type === 'landmark');
  const movement = [...renderable].reverse().map(directionFromLegacyOperation).find(Boolean) || null;
  const scene = landmark?.symbol === 'park' ? 'park' : landmark?.symbol === 'station' ? 'station' : 'intersection';
  return sanitizeScratchpadOperation({
    type: 'sketch',
    scene,
    label: labels.at(-1) || '',
    secondaryLabel: labels.at(-2) || '',
    movement,
    details: scene === 'park'
      ? ['tree', 'trafficLight']
      : scene === 'station'
        ? ['stairs', 'storefront', 'trafficLight']
        : ['brick', 'awning', 'trafficLight', 'tree']
  }, agentId);
}

export function appendScratchpadOperations(scratchpad, rawOperations, { agentId, turn }) {
  const normalized = normalizeScratchpad(scratchpad, { turn });
  const incoming = Array.isArray(rawOperations) ? rawOperations : [];
  const sketch = sketchFromIncomingOperations(incoming, agentId);
  let accepted = sketch
    ? [sanitizeScratchpadOperation({ type: 'replaceSheet' }, agentId), sketch]
    : [];
  accepted = accepted
    .map(operation => ({
      ...operation,
      id: randomUUID(),
      sequence: ++normalized.sequence,
      turn,
      createdAt: new Date().toISOString()
    }));

  const retainedAudit = retainScratchpadAudit(applyCurrentViewRules([...normalized.operations, ...accepted]), normalized);
  normalized.operations = retainedAudit.operations;
  normalized.archivedOperationCount = retainedAudit.archivedOperationCount;
  normalized.archivedThroughSequence = retainedAudit.archivedThroughSequence;
  normalized.earliestRetainedSequence = retainedAudit.earliestRetainedSequence;
  normalized.currentOperations = currentScratchpadOperations(normalized);
  normalized.messageFrom = normalized.currentOperations.at(-1)?.author || null;
  normalized.messageTo = normalized.messageFrom ? oppositeAgent(normalized.messageFrom) : null;
  normalized.updatedAt = new Date().toISOString();
  return { scratchpad: normalized, accepted };
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function svgPoint(value) {
  return {
    x: Number(value.x) * SCRATCHPAD_WIDTH,
    y: Number(value.y) * SCRATCHPAD_HEIGHT
  };
}

export function landmarkSymbolSvg(operation, { className = '', pathLength = false } = {}) {
  const center = svgPoint(operation.center);
  const color = escapeXml(operation.color || AGENT_INK[operation.author] || AGENT_INK.ada);
  const width = Number(operation.width) || 4;
  const radius = (Number(operation.radius) || 0.055) * SCRATCHPAD_WIDTH;
  const strokeAttrs = `stroke="${color}" stroke-width="${width}"`;
  const classAttr = className ? ` class="${escapeXml(className)}"` : '';
  const pathLengthAttr = pathLength ? ' pathLength="1"' : '';
  const symbol = operation.symbol || 'dot';

  if (symbol === 'dot') {
    return `<circle${classAttr} cx="${center.x}" cy="${center.y}" r="${radius * 0.55}" fill="${color}" ${strokeAttrs} />`;
  }

  if (symbol === 'square') {
    const size = radius * 1.25;
    return `<rect${classAttr} x="${center.x - size / 2}" y="${center.y - size / 2}" width="${size}" height="${size}" fill="none" ${strokeAttrs} />`;
  }

  if (symbol === 'park') {
    const canopy = `<circle${classAttr} cx="${center.x}" cy="${center.y - radius * 0.18}" r="${radius * 0.52}" fill="none" ${strokeAttrs} />`;
    const trunk = `<path${classAttr}${pathLengthAttr} d="M ${center.x} ${center.y + radius * 0.3} L ${center.x} ${center.y + radius * 0.85} M ${center.x - radius * 0.32} ${center.y + radius * 0.85} L ${center.x + radius * 0.32} ${center.y + radius * 0.85}" fill="none" ${strokeAttrs} stroke-linecap="round" stroke-linejoin="round" />`;
    return `${canopy}${trunk}`;
  }

  if (symbol === 'star') {
    const points = Array.from({ length: 10 }, (_, index) => {
      const angle = -Math.PI / 2 + index * Math.PI / 5;
      const pointRadius = index % 2 === 0 ? radius * 0.72 : radius * 0.32;
      return `${center.x + Math.cos(angle) * pointRadius} ${center.y + Math.sin(angle) * pointRadius}`;
    }).join(' L ');
    return `<path${classAttr}${pathLengthAttr} d="M ${points} Z" fill="none" ${strokeAttrs} stroke-linejoin="round" />`;
  }

  const diamond = [
    `${center.x} ${center.y - radius}`,
    `${center.x + radius} ${center.y}`,
    `${center.x} ${center.y + radius}`,
    `${center.x - radius} ${center.y}`
  ].join(' L ');
  return `<path${classAttr}${pathLengthAttr} d="M ${diamond} Z" fill="none" ${strokeAttrs} stroke-linejoin="round" />`;
}

function sketchLabel(value, fallback = '') {
  return escapeXml(String(value || fallback).slice(0, SCRATCHPAD_LABEL_MAX_CHARS));
}

export function sketchOperationSvg(operation, { className = '' } = {}) {
  const color = escapeXml(operation.color || AGENT_INK[operation.author] || AGENT_INK.ada);
  const classAttr = className ? ` class="${escapeXml(className)}"` : '';
  const details = new Set(Array.isArray(operation.details) ? operation.details : []);
  const label = sketchLabel(operation.label, operation.scene === 'park' ? 'THE PARK' : 'STREET');
  const secondary = sketchLabel(operation.secondaryLabel);
  const buildingFill = operation.author === 'theo' ? '#cbdde0' : '#d8d0bf';
  const wash = operation.author === 'theo' ? '#8fbcc7' : '#a89c87';
  const windows = Array.from({ length: 15 }, (_, index) => {
    const side = index < 8 ? 'left' : 'right';
    const local = side === 'left' ? index : index - 8;
    const col = local % 2;
    const row = Math.floor(local / 2);
    const x = side === 'left' ? 92 + col * 74 + row * 10 : 592 + col * 68 - row * 10;
    const y = 112 + row * 58;
    return `<rect x="${x}" y="${y}" width="42" height="28" rx="2" fill="none" stroke="${color}" stroke-width="3" opacity="0.72" />`;
  }).join('');
  const tree = details.has('tree') || operation.scene === 'park'
    ? `<g transform="translate(${operation.scene === 'park' ? 250 : 535} 236)">
        <path d="M 0 58 C 4 28 2 2 8 -30" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" />
        <path d="M 8 -24 C -34 -34 -49 -77 -16 -95 C 2 -130 48 -113 48 -80 C 78 -62 55 -24 8 -24 Z" fill="${wash}" fill-opacity="0.3" stroke="${color}" stroke-width="5" />
      </g>`
    : '';
  const trafficLight = details.has('trafficLight')
    ? `<g transform="translate(493 111)">
        <path d="M 0 0 L 0 184 M 0 18 L 64 18" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" />
        <rect x="52" y="4" width="36" height="83" rx="6" fill="${buildingFill}" stroke="${color}" stroke-width="4" />
        <circle cx="70" cy="23" r="8" fill="#b45a4c" /><circle cx="70" cy="45" r="8" fill="#cfad50" /><circle cx="70" cy="67" r="8" fill="#69936f" />
      </g>`
    : '';
  const awning = details.has('awning') || details.has('storefront') || operation.scene === 'storefront'
    ? `<g><path d="M 70 314 L 258 314 L 238 350 L 88 350 Z" fill="${wash}" fill-opacity="0.38" stroke="${color}" stroke-width="4" />
       <path d="M 99 315 L 99 348 M 132 315 L 132 348 M 165 315 L 165 348 M 198 315 L 198 348 M 231 315 L 231 348" stroke="${color}" stroke-width="3" opacity="0.7" />
       <rect x="105" y="350" width="116" height="80" fill="none" stroke="${color}" stroke-width="4" /></g>`
    : '';
  const station = operation.scene === 'station' || details.has('stairs')
    ? `<g transform="translate(465 340)"><path d="M 0 0 L 145 0 L 117 94 L 25 94 Z" fill="${buildingFill}" fill-opacity="0.72" stroke="${color}" stroke-width="5" />
       <path d="M 22 18 L 126 18 M 30 36 L 121 36 M 36 54 L 115 54 M 42 72 L 109 72" stroke="${color}" stroke-width="3" />
       <circle cx="13" cy="-24" r="24" fill="${wash}" fill-opacity="0.28" stroke="${color}" stroke-width="5" /><text x="13" y="-13" text-anchor="middle" fill="${color}" font-family="serif" font-size="31">M</text></g>`
    : '';
  const landmark = details.has('tower') || details.has('church') || details.has('clock') || operation.scene === 'landmark'
    ? `<g transform="translate(324 80)"><path d="M 0 184 L 20 58 L 45 20 L 70 58 L 91 184 Z" fill="${buildingFill}" fill-opacity="0.74" stroke="${color}" stroke-width="5" />
       <path d="M 45 20 L 45 -18" stroke="${color}" stroke-width="5" /><circle cx="45" cy="82" r="18" fill="none" stroke="${color}" stroke-width="4" /></g>`
    : '';
  const park = operation.scene === 'park'
    ? `<path d="M 52 352 C 154 305 266 316 356 371 C 446 425 562 414 716 346 L 716 486 L 52 486 Z" fill="#aabf9c" fill-opacity="0.28" stroke="${color}" stroke-width="5" />`
    : '';
  const movementRotation = {
    north: -90, northeast: -45, east: 0, southeast: 45,
    south: 90, southwest: 135, west: 180, northwest: 225
  }[operation.movement];
  const movement = Number.isFinite(movementRotation)
    ? `<g transform="translate(384 453) rotate(${movementRotation})"><path d="M -54 0 C -18 -15 18 -15 54 0 M 38 -16 L 56 0 L 38 16" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" /></g>`
    : '';

  return `<g${classAttr} filter="url(#rv-pencil)">
    <path d="M 42 90 L 278 58 L 300 358 L 48 424 Z" fill="${buildingFill}" fill-opacity="0.62" stroke="${color}" stroke-width="5" />
    <path d="M 726 86 L 490 58 L 468 358 L 720 424 Z" fill="${buildingFill}" fill-opacity="0.62" stroke="${color}" stroke-width="5" />
    ${windows}${awning}${park}${tree}${trafficLight}${station}${landmark}
    <path d="M 301 358 L 467 358 L 632 512 L 136 512 Z" fill="${wash}" fill-opacity="0.16" stroke="${color}" stroke-width="5" />
    <path d="M 384 358 L 384 512" stroke="${color}" stroke-width="4" stroke-dasharray="22 18" opacity="0.58" />
    <g transform="translate(278 44) rotate(-2)"><path d="M 0 0 L 214 0 L 205 56 L 8 56 Z" fill="#eee4cc" stroke="${color}" stroke-width="5" />
      <text x="107" y="37" text-anchor="middle" fill="${color}" font-family="serif" font-size="27">${label}</text></g>
    ${secondary ? `<g transform="translate(405 96) rotate(3)"><path d="M 0 0 L 185 0 L 178 46 L 8 46 Z" fill="#eee4cc" stroke="${color}" stroke-width="4" /><text x="92" y="31" text-anchor="middle" fill="${color}" font-family="serif" font-size="21">${secondary}</text></g>` : ''}
    ${movement}
  </g>`;
}

function operationSvg(operation) {
  const color = escapeXml(operation.color || AGENT_INK[operation.author] || AGENT_INK.ada);
  const width = Number(operation.width) || 4;
  if (operation.type === 'sketch') return sketchOperationSvg(operation);
  if (operation.type === 'text') {
    const at = svgPoint(operation.at);
    return `<text x="${at.x}" y="${at.y}" fill="${color}" font-family="sans-serif" font-size="${operation.size}" transform="rotate(${operation.rotation} ${at.x} ${at.y})">${escapeXml(operation.text)}</text>`;
  }
  if (operation.type === 'circle') {
    const center = svgPoint(operation.center);
    return `<ellipse cx="${center.x}" cy="${center.y}" rx="${operation.radiusX * SCRATCHPAD_WIDTH}" ry="${operation.radiusY * SCRATCHPAD_HEIGHT}" fill="none" stroke="${color}" stroke-width="${width}" />`;
  }
  if (operation.type === 'landmark') {
    const center = svgPoint(operation.center);
    const radius = (Number(operation.radius) || 0.055) * SCRATCHPAD_WIDTH;
    const label = operation.label
      ? `<text x="${center.x + radius + 8}" y="${center.y + 5}" fill="${color}" font-family="sans-serif" font-size="22">${escapeXml(operation.label)}</text>`
      : '';
    return `${landmarkSymbolSvg(operation)}${label}`;
  }
  if (operation.type === 'stroke') {
    const points = operation.points.map(svgPoint);
    const d = points.map((entry, index) => `${index === 0 ? 'M' : 'L'} ${entry.x} ${entry.y}`).join(' ');
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" />`;
  }
  if (operation.type === 'line' || operation.type === 'arrow' || operation.type === 'erase') {
    const from = svgPoint(operation.from);
    const to = svgPoint(operation.to);
    const stroke = operation.type === 'erase' ? '#f2ecdd' : color;
    let result = `<path d="M ${from.x} ${from.y} L ${to.x} ${to.y}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" />`;
    if (operation.type === 'arrow') {
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const length = Math.max(12, width * 4);
      const left = { x: to.x - Math.cos(angle - Math.PI / 6) * length, y: to.y - Math.sin(angle - Math.PI / 6) * length };
      const right = { x: to.x - Math.cos(angle + Math.PI / 6) * length, y: to.y - Math.sin(angle + Math.PI / 6) * length };
      result += `<path d="M ${left.x} ${left.y} L ${to.x} ${to.y} L ${right.x} ${right.y}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" />`;
    }
    return result;
  }
  return '';
}

export async function renderScratchpad(scratchpad, { throughSequence = Infinity } = {}) {
  if (Number(scratchpad?.version) === RASTER_SCRATCHPAD_VERSION) {
    const rules = Array.from({ length: 12 }, (_, index) => {
      const y = 78 + index * 57;
      return `<line x1="32" y1="${y}" x2="1120" y2="${y}" stroke="#48676f" stroke-opacity="0.08" stroke-width="1" />`;
    }).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${RASTER_SCRATCHPAD_WIDTH}" height="${RASTER_SCRATCHPAD_HEIGHT}" viewBox="0 0 ${RASTER_SCRATCHPAD_WIDTH} ${RASTER_SCRATCHPAD_HEIGHT}">
      <rect width="100%" height="100%" fill="#f2ecdd" />
      ${rules}
      <line x1="86" y1="28" x2="86" y2="740" stroke="#b44d43" stroke-opacity="0.12" stroke-width="1" />
    </svg>`;
    return sharp(Buffer.from(svg)).webp({ quality: 88 }).toBuffer();
  }
  const normalized = normalizeScratchpad(scratchpad);
  const rules = Array.from({ length: 12 }, (_, index) => {
    const y = 52 + index * 38;
    return `<line x1="22" y1="${y}" x2="746" y2="${y}" stroke="#48676f" stroke-opacity="0.10" stroke-width="1" />`;
  }).join('');
  const operations = currentScratchpadOperations(normalized, { throughSequence })
    .map(operationSvg)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SCRATCHPAD_WIDTH}" height="${SCRATCHPAD_HEIGHT}" viewBox="0 0 ${SCRATCHPAD_WIDTH} ${SCRATCHPAD_HEIGHT}">
    <defs><filter id="rv-pencil" x="-4%" y="-4%" width="108%" height="108%"><feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="2" seed="7" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="1.35" xChannelSelector="R" yChannelSelector="G"/></filter></defs>
    <rect width="100%" height="100%" fill="#f2ecdd" />
    ${rules}
    <line x1="58" y1="18" x2="58" y2="494" stroke="#b44d43" stroke-opacity="0.16" stroke-width="1" />
    ${operations}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export const RENDEZVOUS_MEMORY_VERSION = 1;

const MAX_SUMMARY_CHARS = 900;
const MAX_EPISODE_CHARS = 500;
const MAX_RECEIVED_SHEETS = 8;
const MAX_SENT_MESSAGES = 8;
const MAX_OBSERVATIONS = 12;
const MAX_ODOMETRY_HEADINGS = 16;
const MAX_ODOMETRY_LABELS = 8;

function cleanString(value, maxLength = MAX_SUMMARY_CHARS) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

function positiveInt(value, fallback = 0) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeEpisode(entry, kind) {
  if (!entry || typeof entry !== 'object') return null;
  const common = {
    turn: positiveInt(entry.turn),
    sequence: positiveInt(entry.sequence),
    createdAt: entry.createdAt || null
  };
  if (kind === 'received') {
    const interpretation = cleanString(entry.interpretation, MAX_EPISODE_CHARS);
    if (!interpretation || common.sequence < 1) return null;
    return { ...common, from: entry.from === 'ada' || entry.from === 'theo' ? entry.from : null, interpretation };
  }
  if (kind === 'sent') {
    const intent = cleanString(entry.intent, MAX_EPISODE_CHARS);
    if (!intent || common.sequence < 1) return null;
    return { ...common, to: entry.to === 'ada' || entry.to === 'theo' ? entry.to : null, intent };
  }
  const observation = cleanString(entry.observation, MAX_EPISODE_CHARS);
  if (!observation) return null;
  return { turn: common.turn, observation, createdAt: common.createdAt };
}

function boundedEpisodes(entries, kind, limit) {
  return (Array.isArray(entries) ? entries : [])
    .map(entry => normalizeEpisode(entry, kind))
    .filter(Boolean)
    .slice(-limit);
}

export function createAgentMemory({ recentNotes = [] } = {}) {
  const rememberedNotes = (Array.isArray(recentNotes) ? recentNotes : [])
    .map(note => cleanString(note, 300))
    .filter(Boolean)
    .slice(-4)
    .join(' ');
  return {
    version: RENDEZVOUS_MEMORY_VERSION,
    journeySummary: rememberedNotes || 'I began on an unfamiliar street corner and know only what I have personally observed.',
    partnerBelief: 'My friend is also moving through this unfamiliar city and trying to meet me.',
    visualVocabulary: 'We have not established a reliable shared visual language yet.',
    jointPlan: 'Observe carefully, communicate useful grounded clues, and adapt to what my friend sends back.',
    receivedSheets: [],
    sentMessages: [],
    recentObservations: [],
    updatedTurn: 0,
    updatedAt: null
  };
}

export function normalizeAgentMemory(raw, { recentNotes = [] } = {}) {
  const base = createAgentMemory({ recentNotes });
  if (!raw || Number(raw.version) !== RENDEZVOUS_MEMORY_VERSION) return base;
  return {
    ...base,
    journeySummary: cleanString(raw.journeySummary) || base.journeySummary,
    partnerBelief: cleanString(raw.partnerBelief) || base.partnerBelief,
    visualVocabulary: cleanString(raw.visualVocabulary) || base.visualVocabulary,
    jointPlan: cleanString(raw.jointPlan) || base.jointPlan,
    receivedSheets: boundedEpisodes(raw.receivedSheets, 'received', MAX_RECEIVED_SHEETS),
    sentMessages: boundedEpisodes(raw.sentMessages, 'sent', MAX_SENT_MESSAGES),
    recentObservations: boundedEpisodes(raw.recentObservations, 'observation', MAX_OBSERVATIONS),
    updatedTurn: positiveInt(raw.updatedTurn),
    updatedAt: raw.updatedAt || null
  };
}

export function applyMemoryRevision(memory, revision, {
  turn = 0,
  sheetMessage = null,
  sheetInterpretation = '',
  observation = '',
  updatedAt = new Date().toISOString()
} = {}) {
  const normalized = normalizeAgentMemory(memory);
  const update = revision && typeof revision === 'object' ? revision : {};
  for (const key of ['journeySummary', 'partnerBelief', 'visualVocabulary', 'jointPlan']) {
    const value = cleanString(update[key]);
    if (value) normalized[key] = value;
  }

  const interpreted = cleanString(sheetInterpretation, MAX_EPISODE_CHARS);
  const sequence = positiveInt(sheetMessage?.sequence);
  if (interpreted && sequence > 0) {
    const entry = normalizeEpisode({
      turn,
      sequence,
      from: sheetMessage?.from,
      interpretation: interpreted,
      createdAt: updatedAt
    }, 'received');
    normalized.receivedSheets = [
      ...normalized.receivedSheets.filter(item => item.sequence !== sequence),
      entry
    ].filter(Boolean).slice(-MAX_RECEIVED_SHEETS);
  }

  const observed = cleanString(observation, MAX_EPISODE_CHARS);
  if (observed) {
    normalized.recentObservations = [...normalized.recentObservations, {
      turn: positiveInt(turn),
      observation: observed,
      createdAt: updatedAt
    }].slice(-MAX_OBSERVATIONS);
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
  createdAt = new Date().toISOString()
} = {}) {
  const normalized = normalizeAgentMemory(memory);
  const entry = normalizeEpisode({ turn, sequence, to, intent, createdAt }, 'sent');
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
  return {
    steps: 0,
    distanceMeters: 0,
    headings: [],
    routeLabels: []
  };
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
    routeLabels: [...new Set((Array.isArray(raw.routeLabels) ? raw.routeLabels : [])
      .map(label => cleanString(label, 120))
      .filter(Boolean))]
      .slice(-MAX_ODOMETRY_LABELS)
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
  if (cleanLabel) {
    normalized.routeLabels = [...new Set([...normalized.routeLabels, cleanLabel])]
      .slice(-MAX_ODOMETRY_LABELS);
  }
  return normalized;
}

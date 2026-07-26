import path from 'path';
import * as fsp from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import { StreetViewHeadless } from '../services/streetViewHeadless.js';
import { calculateBearing } from '../utils/geoUtils.js';
import { RendezvousModelService } from './rendezvousModel.js';
import { RendezvousImageService } from './rendezvousImage.js';
import {
  RENDEZVOUS_MEMORY_VERSION,
  applyMemoryRevision,
  createAgentMemory,
  createMovementMemory,
  normalizeAgentMemory,
  normalizeMovementMemory,
  recordMovement,
  recordSentMessage
} from './rendezvousMemory.js';
import {
  commitRasterScratchpadMessage,
  createRasterScratchpad,
  markRasterScratchpadAttempt,
  normalizeScratchpad,
  normalizeRasterScratchpad,
  publicRasterScratchpad,
  publicRasterScratchpadHistory,
  queueRasterScratchpadMessage,
  retryRasterScratchpadMessage,
  renderScratchpad
} from './scratchpad.js';

const AGENT_ORDER = ['ada', 'theo'];
const RENDER_REVISION_MARKER = 'Authoritative rendering correction:';

function composeDrawingRevisionPrompt(drawingPrompt, revisionPrompt, messageAction = 'unclear') {
  const actionConstraint = messageAction === 'stillness'
    ? 'The dominant action must be stillness: remove arrows, directional lines, motion trails, and route cues that read as movement; make stopping, waiting, anchoring, or uncertainty visually dominant.'
    : messageAction === 'movement'
      ? 'The dominant action must be movement: make the moving subject or progression visually dominant and subordinate barriers, static figures, and stopping cues.'
      : messageAction === 'transition'
        ? 'The dominant action must be a transition, with the before and after states both clearly visible.'
        : 'Make the intended information delta visually dominant and unambiguous.';
  const correction = String(revisionPrompt || '').trim()
    || 'Correct the rejected image so a context-free recipient can read the intended information delta.';

  return `${RENDER_REVISION_MARKER} ${correction} ${actionConstraint} Rebuild the image from these instructions and the compatible visual anchors supplied separately. Do not reuse the rejected composition or any earlier instruction that conflicts with this correction.`;
}

function compatibleRevisionFeatures(drawingPrompt, groundedFeatures, messageAction) {
  if (!String(drawingPrompt || '').startsWith(RENDER_REVISION_MARKER)) return groundedFeatures;
  const conflictPattern = messageAction === 'stillness'
    ? /\b(?:arrow|direction|motion|movement|path|progress|route|travel|toward)\b/i
    : messageAction === 'movement'
      ? /\b(?:halt|pause|remain|still|stop|wait)\b/i
      : null;
  if (!conflictPattern) return groundedFeatures;
  return (Array.isArray(groundedFeatures) ? groundedFeatures : [])
    .filter(feature => !conflictPattern.test(String(feature || '')));
}

function canAcceptRecipientLegibleRetry(review, messageAction, attemptNumber) {
  const blindRead = review?.blindRead;
  return attemptNumber >= 4
    && ['movement', 'stillness', 'transition'].includes(messageAction)
    && blindRead?.dominantAction === messageAction
    && blindRead.readableText !== true
    && Boolean(blindRead.likelyMessage);
}

const AGENTS = Object.freeze({
  ada: {
    id: 'ada',
    name: 'Ada',
    color: '#ffcc4d',
    accent: '#ff8a3d',
    style: 'landmark-first, cautious, good at reading civic spaces'
  },
  theo: {
    id: 'theo',
    name: 'Theo',
    color: '#55d6ff',
    accent: '#7c9cff',
    style: 'route-first, decisive, good at following street rhythm'
  }
});

const GUIDEBOOK_LANDMARKS = Object.freeze([
  {
    id: 'bryant-park',
    name: 'Bryant Park',
    position: { lat: 40.753596, lng: -73.983233 },
    clue: 'the library lawn and a busy midtown park'
  },
  {
    id: 'grand-central',
    name: 'Grand Central Terminal',
    position: { lat: 40.752726, lng: -73.977229 },
    clue: 'the great terminal and clock-facing avenues'
  },
  {
    id: 'union-square',
    name: 'Union Square',
    position: { lat: 40.735863, lng: -73.991084 },
    clue: 'the square with broad sidewalks and market energy'
  },
  {
    id: 'washington-square',
    name: 'Washington Square Arch',
    position: { lat: 40.730823, lng: -73.997332 },
    clue: 'the park arch and village blocks'
  },
  {
    id: 'columbus-circle',
    name: 'Columbus Circle',
    position: { lat: 40.768044, lng: -73.981893 },
    clue: 'the circle at the southwest corner of Central Park'
  }
]);

const START_PAIRS = Object.freeze([
  {
    ada: { lat: 40.759011, lng: -73.984472, label: 'theater district corner' },
    theo: { lat: 40.750298, lng: -73.977873, label: 'terminal-side avenue' }
  },
  {
    ada: { lat: 40.741184, lng: -73.989747, label: 'flatiron side street' },
    theo: { lat: 40.730944, lng: -73.991705, label: 'noho corner' }
  },
  {
    ada: { lat: 40.73491, lng: -73.992605, label: 'union square south edge' },
    theo: { lat: 40.72571, lng: -74.000735, label: 'soho block' }
  },
  {
    ada: { lat: 40.761619, lng: -73.981552, label: 'midtown theater block' },
    theo: { lat: 40.774137, lng: -73.982194, label: 'lincoln square corner' }
  }
]);

const STREET_SEARCH_RADII_METERS = Object.freeze([18, 36, 72]);
const STREET_SEARCH_BEARINGS = Object.freeze([0, 45, 90, 135, 180, 225, 270, 315]);
const LEGACY_RENDEZVOUS_HINT_PATTERN = /rough wire|last telegram|telegrams said|telegram puts|somewhere around|nearest guidebook|wire before|meeting place|Bryant Park|Grand Central|Union Square|Washington Square|Columbus Circle/i;
const MODEL_THOUGHT_MODES = new Set(['decision', 'decision_wait', 'retrace']);
const DEFAULT_MAX_CONSECUTIVE_WAIT_DECISIONS = 2;
const MAX_PANORAMA_DRIFT_METERS = 250;
const DEFAULT_MAX_BRANCH_DECISIONS = 120;

function parseIntOr(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function calculateDistance(pos1, pos2) {
  if (!pos1 || !pos2) return Infinity;
  const lat1 = Number(pos1.lat);
  const lng1 = Number(pos1.lng);
  const lat2 = Number(pos2.lat);
  const lng2 = Number(pos2.lng);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return Infinity;

  const earthRadius = 6371e3;
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const deltaPhi = (lat2 - lat1) * Math.PI / 180;
  const deltaLambda = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(deltaPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function compassDirection(heading) {
  const directions = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  const normalized = ((Number(heading) || 0) % 360 + 360) % 360;
  return directions[Math.round(normalized / 45) % directions.length];
}

function offsetPosition(position, meters, bearingDegrees) {
  const lat = Number(position?.lat);
  const lng = Number(position?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const bearing = Number(bearingDegrees) * Math.PI / 180;
  const latMeters = 111320;
  const lngMeters = latMeters * Math.cos(lat * Math.PI / 180);
  if (!Number.isFinite(lngMeters) || Math.abs(lngMeters) < 1) return null;

  return {
    lat: lat + Math.cos(bearing) * meters / latMeters,
    lng: lng + Math.sin(bearing) * meters / lngMeters
  };
}

function publicPoint(point) {
  if (!point) return null;
  return {
    lat: Number(point.lat),
    lng: Number(point.lng),
    panoId: point.panoId || null,
    timestamp: point.timestamp || null
  };
}

function hasStreetLinks(panorama) {
  return Array.isArray(panorama?.links) && panorama.links.some(link => link?.pano);
}

export function isShortPanoLoop(visitedPanos = []) {
  const activeTail = visitedPanos.slice(-4);
  if (
    activeTail.length === 4 &&
    activeTail[0] !== activeTail[1] &&
    activeTail[0] === activeTail[2] &&
    activeTail[1] === activeTail[3]
  ) {
    return true;
  }

  const tail = visitedPanos.slice(-6);
  if (tail.length < 4) return false;
  const unique = new Set(tail);
  if (unique.size <= 2) return true;
  return tail.length >= 6 && tail.slice(2).every((panoId, index) => panoId === tail[index]);
}

export function isAgentPositionPathConsistent(agent, maxDriftMeters = MAX_PANORAMA_DRIFT_METERS) {
  const pathTail = Array.isArray(agent?.path) ? agent.path.at(-1) : null;
  if (!agent?.position || !pathTail) return false;
  return calculateDistance(agent.position, pathTail) <= maxDriftMeters;
}

export function areAgentsStreetViewAdjacent(first, second) {
  if (!first?.panoId || !second?.panoId) return false;
  if (first.panoId === second.panoId) return true;
  return (first.neighborPanoIds || []).includes(second.panoId) ||
    (second.neighborPanoIds || []).includes(first.panoId);
}

function stripTelegramInternal(telegram) {
  if (!telegram) return telegram;
  const { roughPosition, ...publicTelegram } = telegram;
  if (publicTelegram.clues && typeof publicTelegram.clues === 'object') {
    const publicClues = { ...publicTelegram.clues };
    for (const key of ['neighborhood', 'nearestLandmark', 'landmarkDistance', 'intention', 'target']) {
      delete publicClues[key];
    }
    publicTelegram.clues = publicClues;
  }
  if (publicTelegram.kind !== 'notebook_update') {
    publicTelegram.text = 'Legacy wire archived; the drawing sheet is now the only shared channel.';
  }
  return publicTelegram;
}

function publicLegacyReason(agent) {
  const agentName = agent?.name || 'The agent';
  if (agent?.status === 'found') {
    return `${agentName} reached the rendezvous after following the shared drawing sheet.`;
  }
  if (agent?.status === 'waiting') {
    return `${agentName} is holding briefly and remembering the last version of the shared sheet.`;
  }
  return `${agentName} is searching from personal street observations and the last shared sheet.`;
}

function sanitizeLegacyNotebookText(text, fallback) {
  if (typeof text !== 'string') return text;
  return LEGACY_RENDEZVOUS_HINT_PATTERN.test(text) ? fallback : text;
}

function normalizeLastThought(raw) {
  if (!raw) return null;
  const source = typeof raw === 'string' ? { reasoning: raw } : raw;
  const reasoning = typeof source.reasoning === 'string' ? source.reasoning.trim().slice(0, 700) : '';
  if (!reasoning) return null;
  return {
    reasoning,
    turn: Math.max(0, Math.floor(Number(source.turn) || 0)),
    stepCount: Math.max(0, Math.floor(Number(source.stepCount) || 0)),
    mode: MODEL_THOUGHT_MODES.has(source.mode) ? source.mode : 'decision',
    selectedLabel: typeof source.selectedLabel === 'string' ? source.selectedLabel.slice(0, 160) : null,
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : null
  };
}

function isModelAuthoredThought(payload) {
  return payload &&
    MODEL_THOUGHT_MODES.has(payload.mode) &&
    !payload.fallbackCause &&
    typeof payload.reasoning === 'string' &&
    payload.reasoning.trim().length > 0 &&
    !/model unavailable/i.test(payload.reasoning);
}

function recoverLastThought(agentId, storedThought, eventLog = []) {
  const normalized = normalizeLastThought(storedThought);
  if (normalized) return normalized;
  for (let index = eventLog.length - 1; index >= 0; index -= 1) {
    const event = eventLog[index];
    const payload = event?.payload || event?.data;
    if (event?.type !== 'agent_step' || payload?.agentId !== agentId || !isModelAuthoredThought(payload)) continue;
    return normalizeLastThought({
      ...payload,
      turn: event.turn ?? payload.turn,
      createdAt: event.timestamp || null
    });
  }
  return null;
}

function recoverConsecutiveWaitDecisions(agentId, storedValue, eventLog = [], lastThought = null) {
  if (Number.isFinite(Number(storedValue))) {
    return Math.max(0, Math.floor(Number(storedValue)));
  }
  let stepCount = null;
  let count = 0;
  for (let index = eventLog.length - 1; index >= 0; index -= 1) {
    const event = eventLog[index];
    const payload = event?.payload || event?.data;
    if (event?.type !== 'agent_step' || payload?.agentId !== agentId) continue;
    if (stepCount === null) stepCount = Number(payload.stepCount);
    if (Number(payload.stepCount) !== stepCount) break;
    if (payload.mode === 'decision_wait' && !payload.fallbackCause) {
      count += 1;
    } else if (MODEL_THOUGHT_MODES.has(payload.mode)) {
      break;
    }
  }
  if (count > 0) return count;
  return normalizeLastThought(lastThought)?.mode === 'decision_wait' ? 1 : 0;
}

function sanitizePublicAgent(agent) {
  const {
    privateMemory: _privateMemory,
    movementSinceDecision: _movementSinceDecision,
    waitTurnsRemaining: _waitTurnsRemaining,
    consecutiveWaitDecisions: _consecutiveWaitDecisions,
    branchDecisionCount: _branchDecisionCount,
    neighborPanoIds: _neighborPanoIds,
    sheetBlockedPanoId: _sheetBlockedPanoId,
    ...publicFields
  } = agent;
  const fallback = publicLegacyReason(agent);
  const lastDecision = agent.lastDecision
    ? {
        ...agent.lastDecision,
        reasoning: sanitizeLegacyNotebookText(agent.lastDecision.reasoning, fallback)
      }
    : agent.lastDecision;
  const lastThought = normalizeLastThought(agent.lastThought);
  if (lastThought) {
    lastThought.reasoning = sanitizeLegacyNotebookText(lastThought.reasoning, fallback);
  }
  if (lastDecision) {
    delete lastDecision.targetName;
    delete lastDecision.distanceToTarget;
  }
  return {
    ...publicFields,
    lastDecision,
    lastThought,
    recentNotes: Array.isArray(agent.recentNotes)
      ? agent.recentNotes.map(note => sanitizeLegacyNotebookText(note, fallback))
      : agent.recentNotes
  };
}

function sanitizePublicEvent(event) {
  if (!event || typeof event !== 'object') return event;
  const payload = event.payload || event.data;
  if (!payload || typeof payload !== 'object') return event;
  if (event.type === 'telegram_sent' || event.type === 'telegram_delivered') {
    const sanitizedTelegram = stripTelegramInternal(payload);
    return {
      ...event,
      payload: event.payload ? sanitizedTelegram : event.payload,
      data: event.data ? sanitizedTelegram : event.data
    };
  }
  const agentName = payload.agentName || payload.name || payload.agentId;
  const fallback = publicLegacyReason({ name: agentName || 'The agent', status: payload.status });
  const sanitizedPayload = {
    ...payload,
    reasoning: sanitizeLegacyNotebookText(payload.reasoning, fallback),
    reason: sanitizeLegacyNotebookText(payload.reason, fallback),
    target: event.type === 'run_created' || event.type === 'run_started'
      ? undefined
      : payload.target
  };
  delete sanitizedPayload.targetName;
  delete sanitizedPayload.distanceToTarget;
  return {
    ...event,
    payload: event.payload ? sanitizedPayload : event.payload,
    data: event.data ? sanitizedPayload : event.data
  };
}

export class RendezvousController {
  constructor({
    emit = () => {},
    dataDir,
    logger = console,
    streetView = null,
    agentModel = null,
    imageModel = null
  } = {}) {
    this.emit = emit;
    this.logger = logger;
    this.dataDir = dataDir;
    this.savePath = path.join(dataDir, 'rendezvous-current.json');
    this.streetView = streetView || new StreetViewHeadless();
    this.agentModel = agentModel || new RendezvousModelService({ logger });
    this.imageModel = imageModel || new RendezvousImageService({ logger });
    this.streetViewReady = false;
    this.panoramaCache = new Map();
    this.timer = null;
    this.running = false;
    this.stepInFlight = false;
    this.tickInFlight = null;
    this.drawingInFlight = null;
    this.saveQueue = Promise.resolve();
    this.state = this.#emptyState();

    this.stepIntervalMs = parseIntOr(process.env.RENDEZVOUS_STEP_INTERVAL_MS, 1800);
    this.foundRadiusMeters = Math.min(
      50,
      Math.max(5, parseIntOr(process.env.RENDEZVOUS_FOUND_RADIUS_M, 35))
    );
    this.maxBranchDecisions = Math.max(
      2,
      parseIntOr(process.env.RENDEZVOUS_MAX_BRANCH_DECISIONS, DEFAULT_MAX_BRANCH_DECISIONS)
    );
    this.maxConsecutiveWaitDecisions = Math.max(
      1,
      parseIntOr(process.env.RENDEZVOUS_MAX_CONSECUTIVE_WAIT_DECISIONS, DEFAULT_MAX_CONSECUTIVE_WAIT_DECISIONS)
    );
    this.drawingRetryBaseMs = Math.max(
      1000,
      parseIntOr(process.env.RENDEZVOUS_DRAWING_RETRY_BASE_MS, 5000)
    );
    this.drawingRetryMaxMs = Math.max(
      this.drawingRetryBaseMs,
      parseIntOr(process.env.RENDEZVOUS_DRAWING_RETRY_MAX_MS, 120000)
    );
  }

  #emptyState() {
    return {
      mode: 'rendezvous',
      runId: null,
      status: 'idle',
      city: 'Manhattan',
      title: 'Two Friends, One City',
      turn: 0,
      startedAt: null,
      updatedAt: null,
      foundAt: null,
      foundReason: null,
      lostAt: null,
      lostReason: null,
      meeting: {
        goal: 'find_each_other',
        target: null,
        distanceMeters: null,
        adaDistanceToTarget: null,
        theoDistanceToTarget: null
      },
      notebook: null,
      scratchpad: null,
      agents: {},
      telegrams: [],
      eventLog: []
    };
  }

  async ensureStreetView() {
    if (this.streetViewReady) return;
    await this.streetView.initialize({
      position: GUIDEBOOK_LANDMARKS[0].position
    });
    this.streetViewReady = true;
  }

  async loadState() {
    try {
      const raw = JSON.parse(await fsp.readFile(this.savePath, 'utf8'));
      if (raw?.mode === 'rendezvous' && raw?.runId) {
        const needsMemoryMigration = raw.status !== 'found' && AGENT_ORDER.some(agentId =>
          raw.agents?.[agentId] && Number(raw.agents[agentId].privateMemory?.version) !== RENDEZVOUS_MEMORY_VERSION
        );
        if (raw.status !== 'found' && Number(raw.scratchpad?.version) === 4) {
          await this.#archivePreV5State(raw.runId);
        }
        if (needsMemoryMigration) {
          await this.#archivePreMemoryState(raw.runId);
        }
        this.state = this.#normalizeLoadedState(raw);
        if (this.state.status !== 'found' && Number(this.state.scratchpad?.version) === 4) {
          await this.#migrateLegacyScratchpadToRaster();
          await this.saveState();
        } else if (needsMemoryMigration) {
          await this.saveState();
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn?.(`Failed to read rendezvous state: ${error.message}`);
      }
    }
    await this.#pruneUnreferencedDrawingFiles();
    return this.getPublicState();
  }

  async #archivePreV5State(runId) {
    const safeRunId = String(runId).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeRunId) throw new Error('Cannot archive rendezvous state with an invalid run ID');
    const archiveDir = path.join(this.dataDir, 'rendezvous-runs');
    const archivePath = path.join(archiveDir, `${safeRunId}-pre-v5.json`);
    await fsp.mkdir(archiveDir, { recursive: true });
    try {
      await fsp.access(archivePath);
    } catch {
      await fsp.copyFile(this.savePath, archivePath);
    }
  }

  async #archivePreMemoryState(runId) {
    const safeRunId = String(runId).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeRunId) throw new Error('Cannot archive rendezvous state with an invalid run ID');
    const archiveDir = path.join(this.dataDir, 'rendezvous-runs');
    const archivePath = path.join(archiveDir, `${safeRunId}-pre-memory-v${RENDEZVOUS_MEMORY_VERSION}.json`);
    await fsp.mkdir(archiveDir, { recursive: true });
    try {
      await fsp.access(archivePath);
    } catch {
      await fsp.copyFile(this.savePath, archivePath);
    }
  }

  async #migrateLegacyScratchpadToRaster() {
    if (Number(this.state.scratchpad?.version) !== 4 || !this.state.runId) return false;
    const legacy = normalizeScratchpad(this.state.scratchpad, { turn: this.state.turn });
    const messageFrom = legacy.messageFrom === 'theo' ? 'theo' : legacy.messageFrom === 'ada' ? 'ada' : null;
    const messageTo = messageFrom ? this.#partnerId(messageFrom) : null;
    const owner = legacy.inTransit?.to === 'theo' || legacy.inTransit?.to === 'ada'
      ? legacy.inTransit.to
      : legacy.owner === 'theo' ? 'theo' : 'ada';
    const raster = createRasterScratchpad({ owner, turn: this.state.turn });

    if (messageFrom && messageTo) {
      const messageId = `legacy-v4-${Math.max(1, legacy.sequence)}`;
      const imageFile = `${messageId}.png`;
      const directory = this.#drawingDirectory();
      await fsp.mkdir(directory, { recursive: true });
      const buffer = await renderScratchpad(legacy);
      const destination = path.join(directory, imageFile);
      const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
      await fsp.writeFile(temporary, buffer);
      await fsp.rename(temporary, destination);
      const imageSha256 = createHash('sha256').update(buffer).digest('hex');
      raster.sequence = Math.max(1, legacy.sequence);
      raster.currentMessage = {
        id: messageId,
        from: messageFrom,
        to: messageTo,
        turn: Math.max(0, Number(legacy.currentOperations?.at(-1)?.turn) || this.state.turn),
        sequence: raster.sequence,
        imageFile,
        imageMimeType: 'image/png',
        imageSha256,
        createdAt: legacy.currentOperations?.at(-1)?.createdAt || legacy.updatedAt,
        sentAt: legacy.updatedAt
      };
      raster.messageAudit = [{
        ...raster.currentMessage,
        drawingPrompt: '',
        referenceViewIndices: [],
        sourcePanoId: null,
        imageModel: 'legacy-v4-renderer',
        requestId: null,
        status: 'migrated'
      }];
    }
    raster.updatedAt = new Date().toISOString();
    this.state.scratchpad = normalizeRasterScratchpad(raster, { turn: this.state.turn });
    this.#recordEvent('scratchpad_migrated', {
      fromVersion: 4,
      toVersion: 5,
      sequence: this.state.scratchpad.sequence,
      owner: this.state.scratchpad.owner
    });
    return true;
  }

  async saveState() {
    this.saveQueue = this.saveQueue.catch(() => {}).then(async () => {
      await fsp.mkdir(path.dirname(this.savePath), { recursive: true });
      const tempPath = `${this.savePath}.${process.pid}.${randomUUID()}.tmp`;
      await fsp.writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`);
      await fsp.rename(tempPath, this.savePath);
    });
    return this.saveQueue;
  }

  async #archiveCurrentState() {
    if (!this.state?.runId) return;
    const safeRunId = String(this.state.runId).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeRunId) return;
    const archiveDir = path.join(this.dataDir, 'rendezvous-runs');
    const archivePath = path.join(archiveDir, `${safeRunId}.json`);
    await fsp.mkdir(archiveDir, { recursive: true });
    try {
      await fsp.access(archivePath);
      return;
    } catch {
      // The immutable archive does not exist yet.
    }
    let archivedState = this.state;
    try {
      const persisted = JSON.parse(await fsp.readFile(this.savePath, 'utf8'));
      if (persisted?.runId === this.state.runId) archivedState = persisted;
    } catch {
      // Fall back to the in-memory snapshot when no persisted state is available.
    }
    const tempPath = `${archivePath}.${process.pid}.${randomUUID()}.tmp`;
    await fsp.writeFile(tempPath, `${JSON.stringify(archivedState, null, 2)}\n`);
    await fsp.rename(tempPath, archivePath);
  }

  #normalizeLoadedState(raw) {
    const hasCausalScratchpad = Number(raw?.scratchpad?.version) >= 2;
    const state = {
      ...this.#emptyState(),
      ...raw,
      agents: raw.agents || {},
      meeting: {
        ...this.#emptyState().meeting,
        ...(raw.meeting || {}),
        goal: 'find_each_other',
        target: null,
        adaDistanceToTarget: null,
        theoDistanceToTarget: null
      },
      notebook: null,
      scratchpad: hasCausalScratchpad
        ? normalizeScratchpad(raw.scratchpad, { turn: raw.turn || 0 })
        : null,
      telegrams: Array.isArray(raw.telegrams) ? raw.telegrams : [],
      eventLog: Array.isArray(raw.eventLog) ? raw.eventLog.slice(-80) : []
    };
    for (const agentId of AGENT_ORDER) {
      if (!state.agents[agentId]) continue;
      const loadedAgent = state.agents[agentId];
      const recentNotes = hasCausalScratchpad && Array.isArray(loadedAgent.recentNotes)
        ? loadedAgent.recentNotes
        : ['I remember only the public streets I have personally walked.'];
      const lastThought = recoverLastThought(agentId, loadedAgent.lastThought, state.eventLog);
      state.agents[agentId] = {
        ...AGENTS[agentId],
        ...loadedAgent,
        path: Array.isArray(loadedAgent.path) ? loadedAgent.path : [],
        inbox: Array.isArray(loadedAgent.inbox) ? loadedAgent.inbox : [],
        outbox: Array.isArray(loadedAgent.outbox) ? loadedAgent.outbox : [],
        recentNotes,
        visitedPanos: Array.isArray(loadedAgent.visitedPanos) ? loadedAgent.visitedPanos : [],
        padSeenSequence: Math.max(0, Math.floor(Number(loadedAgent.padSeenSequence) || 0)),
        privateMemory: normalizeAgentMemory(loadedAgent.privateMemory, { recentNotes }),
        movementSinceDecision: normalizeMovementMemory(loadedAgent.movementSinceDecision),
        waitTurnsRemaining: Math.min(6, Math.max(0, Math.floor(Number(loadedAgent.waitTurnsRemaining) || 0))),
        consecutiveWaitDecisions: recoverConsecutiveWaitDecisions(
          agentId,
          loadedAgent.consecutiveWaitDecisions,
          state.eventLog,
          lastThought
        ),
        branchDecisionCount: Math.max(0, Math.floor(Number(loadedAgent.branchDecisionCount) || 0)),
        neighborPanoIds: Array.isArray(loadedAgent.neighborPanoIds)
          ? [...new Set(loadedAgent.neighborPanoIds.filter(Boolean))].slice(0, 16)
          : [],
        sheetBlockedPanoId: typeof loadedAgent.sheetBlockedPanoId === 'string'
          ? loadedAgent.sheetBlockedPanoId
          : null,
        lastThought,
        friendEstimate: null,
      };
    }
    this.running = state.status === 'running';
    return state;
  }

  getPublicState() {
    const agents = {};
    for (const [agentId, agent] of Object.entries(this.state.agents || {})) {
      const publicAgent = sanitizePublicAgent(agent);
      agents[agentId] = {
        ...publicAgent,
        path: (publicAgent.path || []).map(publicPoint),
        inbox: (publicAgent.inbox || []).map(stripTelegramInternal),
        outbox: (publicAgent.outbox || []).map(stripTelegramInternal),
        friendEstimate: publicAgent.friendEstimate
          ? {
              label: publicAgent.friendEstimate.label,
              uncertaintyMeters: publicAgent.friendEstimate.uncertaintyMeters,
              receivedTurn: publicAgent.friendEstimate.receivedTurn
            }
          : null
      };
    }

    const scratchpad = Number(this.state.scratchpad?.version) === 5
      ? publicRasterScratchpad(this.state.scratchpad, {
          imageUrlFor: message => `/api/rendezvous/drawings/${encodeURIComponent(this.state.runId)}/${encodeURIComponent(message.id)}`
        })
      : normalizeScratchpad(this.state.scratchpad, { turn: this.state.turn });
    return {
      ...this.state,
      notebook: null,
      scratchpad,
      agents,
      eventLog: (this.state.eventLog || []).map(event => sanitizePublicEvent(event)),
      telegrams: (this.state.telegrams || []).map(stripTelegramInternal)
    };
  }

  getDrawingPath(runId, messageId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(runId)) || !/^[a-zA-Z0-9_-]+$/.test(String(messageId))) return null;
    if (runId !== this.state.runId || Number(this.state.scratchpad?.version) !== 5) return null;
    const scratchpad = normalizeRasterScratchpad(this.state.scratchpad);
    const message = [scratchpad.currentMessage, ...scratchpad.messageAudit]
      .find(candidate => candidate?.id === messageId && candidate.imageFile && (!candidate.status || candidate.status === 'sent'));
    if (!message) return null;
    const expected = path.resolve(this.dataDir, 'rendezvous-drawings', runId, message.imageFile);
    const root = path.resolve(this.dataDir, 'rendezvous-drawings', runId);
    return expected.startsWith(`${root}${path.sep}`) ? expected : null;
  }

  getPublicHistory() {
    if (!this.state.runId || Number(this.state.scratchpad?.version) !== 5) {
      return { runId: this.state.runId, sequence: 0, items: [] };
    }
    return {
      runId: this.state.runId,
      ...publicRasterScratchpadHistory(this.state.scratchpad, {
        imageUrlFor: message => `/api/rendezvous/drawings/${encodeURIComponent(this.state.runId)}/${encodeURIComponent(message.id)}`,
        snapshotFor: message => this.#approximateSheetSnapshot(message)
      })
    };
  }

  #captureSheetSnapshot(authorId = null, authoredThought = null) {
    const agents = {};
    for (const agentId of AGENT_ORDER) {
      const agent = this.state.agents?.[agentId];
      if (!agent?.position || !agent?.panoId) return null;
      const publicAgent = sanitizePublicAgent(agent);
      agents[agentId] = {
        name: publicAgent.name,
        panoId: publicAgent.panoId,
        position: publicPoint(publicAgent.position),
        heading: Number(publicAgent.heading) || 0,
        stepCount: Math.max(0, Math.floor(Number(publicAgent.stepCount) || 0)),
        pathLength: Math.max(1, publicAgent.path?.length || 1),
        status: publicAgent.status || 'searching',
        lastThought: agentId === authorId && authoredThought
          ? normalizeLastThought(authoredThought)
          : (publicAgent.lastThought || null)
      };
    }
    return {
      turn: Math.max(0, Math.floor(Number(this.state.turn) || 0)),
      status: this.state.status || 'running',
      distanceMeters: Math.round(calculateDistance(agents.ada.position, agents.theo.position)),
      capturedAt: new Date().toISOString(),
      approximate: false,
      agents
    };
  }

  #approximateSheetSnapshot(message) {
    const capturedTime = Date.parse(message.createdAt || message.sentAt || '');
    const agents = {};
    for (const agentId of AGENT_ORDER) {
      const agent = this.state.agents?.[agentId];
      const pathPoints = Array.isArray(agent?.path) ? agent.path.filter(Boolean) : [];
      if (!agent || pathPoints.length === 0) return null;
      let pointIndex = pathPoints.length - 1;
      if (Number.isFinite(capturedTime)) {
        const atOrBefore = pathPoints.findLastIndex(point => {
          const pointTime = Date.parse(point.timestamp || '');
          return Number.isFinite(pointTime) && pointTime <= capturedTime;
        });
        if (atOrBefore >= 0) pointIndex = atOrBefore;
      }
      const point = pathPoints[pointIndex];
      const previous = pathPoints[Math.max(0, pointIndex - 1)];
      const heading = pointIndex > 0 ? calculateBearing(previous, point) : 0;
      agents[agentId] = {
        name: agent.name || (agentId === 'ada' ? 'Ada' : 'Theo'),
        panoId: agentId === message.from && message.sourcePanoId ? message.sourcePanoId : point.panoId,
        position: publicPoint(point),
        heading: Number.isFinite(heading) ? heading : 0,
        stepCount: pointIndex,
        pathLength: pointIndex + 1,
        status: 'searching',
        lastThought: null
      };
    }
    if (!agents.ada.panoId || !agents.theo.panoId) return null;
    return {
      turn: message.turn,
      status: 'running',
      distanceMeters: Math.round(calculateDistance(agents.ada.position, agents.theo.position)),
      capturedAt: message.createdAt || message.sentAt || null,
      approximate: true,
      agents
    };
  }

  async start({ reset = false } = {}) {
    const hasCausalScratchpad = Number(this.state.scratchpad?.version) >= 2;
    if (reset || !this.state.runId || ['found', 'lost'].includes(this.state.status) || !hasCausalScratchpad) {
      await this.createRun();
    } else if (!this.state.runId) {
      await this.loadState();
      if (!this.state.runId) await this.createRun();
    }

    if (this.state.status !== 'found') {
      this.state.status = 'running';
      this.running = true;
      this.#recordEvent('run_started', {
        goal: 'find_each_other'
      });
      await this.saveState();
      this.broadcastState();
      void this.resumePendingDrawing();
      this.#scheduleNextTick(200);
    }

    return this.getPublicState();
  }

  async stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.state.status === 'running') {
      this.state.status = 'paused';
      this.#recordEvent('run_paused', {});
    }
    await this.saveState();
    this.broadcastState();
    return this.getPublicState();
  }

  async reset() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.createRun();
    this.broadcastState();
    return this.getPublicState();
  }

  async createRun() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.tickInFlight) await this.tickInFlight.catch(() => {});
    await this.ensureStreetView();
    await this.#archiveCurrentState();

    const pairIndex = parseIntOr(process.env.RENDEZVOUS_START_PAIR_INDEX, Date.now()) % START_PAIRS.length;
    const pair = START_PAIRS[((pairIndex % START_PAIRS.length) + START_PAIRS.length) % START_PAIRS.length];

    const agents = {};
    for (const agentId of AGENT_ORDER) {
      const start = pair[agentId];
      const pano = await this.#resolveStartPanorama(start, agentId);
      agents[agentId] = this.#createAgent(agentId, pano, start.label);
    }

    this.state = {
      ...this.#emptyState(),
      runId: randomUUID(),
      status: 'idle',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      meeting: {
        goal: 'find_each_other',
        target: null,
        distanceMeters: calculateDistance(agents.ada.position, agents.theo.position),
        adaDistanceToTarget: null,
        theoDistanceToTarget: null
      },
      notebook: null,
      scratchpad: createRasterScratchpad({ owner: 'ada', turn: 0 }),
      agents,
      telegrams: [],
      eventLog: []
    };

    this.#recordEvent('run_created', {
      goal: 'find_each_other',
      starts: {
        ada: agents.ada.startLabel,
        theo: agents.theo.startLabel
      }
    });
    // Old image work may still finish, but run-id fences prevent it from committing.
    this.drawingInFlight = null;
    this.#updateMeetingMetrics();
    await this.saveState();
    await this.#pruneArchivedDrawingDirectories();
  }

  #createAgent(agentId, pano, startLabel) {
    const config = AGENTS[agentId];
    const position = {
      lat: pano.position.lat,
      lng: pano.position.lng
    };
    return {
      ...config,
      startLabel,
      status: 'searching',
      stepCount: 0,
      panoId: pano.panoId,
      position,
      heading: 0,
      path: [{ ...position, panoId: pano.panoId, timestamp: new Date().toISOString() }],
      visitedPanos: [pano.panoId],
      inbox: [],
      outbox: [],
      recentNotes: [
        'I opened my eyes on an unfamiliar Manhattan corner.'
      ],
      privateMemory: createAgentMemory({
        recentNotes: ['I opened my eyes on an unfamiliar Manhattan corner.']
      }),
      movementSinceDecision: createMovementMemory(),
      waitTurnsRemaining: 0,
      consecutiveWaitDecisions: 0,
      branchDecisionCount: 0,
      neighborPanoIds: (pano.links || []).map(link => link?.pano).filter(Boolean).slice(0, 16),
      sheetBlockedPanoId: null,
      lastDecision: null,
      lastThought: null,
      friendEstimate: null,
      padSeenSequence: 0
    };
  }

  #scheduleNextTick(delay = this.stepIntervalMs) {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.tick().catch(error => {
        this.logger.error?.('Rendezvous tick failed:', error);
        this.#recordEvent('error', { message: error.message });
        this.broadcastState();
      });
      if (this.running && this.state.status === 'running') {
        this.#scheduleNextTick();
      }
    }, delay);
  }

  async tick() {
    if (this.tickInFlight) return this.tickInFlight;
    if (!this.running || this.state.status !== 'running') return this.getPublicState();
    const runId = this.state.runId;
    this.stepInFlight = true;
    const work = (async () => {
      const agentId = AGENT_ORDER[this.state.turn % AGENT_ORDER.length];
      await this.#stepAgent(agentId);
      if (this.state.runId !== runId) return this.getPublicState();
      this.state.turn += 1;
      this.#updateMeetingMetrics();
      this.#checkFound();
      this.#checkExhausted();
      this.state.updatedAt = new Date().toISOString();
      await this.saveState();
      if (this.state.runId !== runId) return this.getPublicState();
      this.broadcastState();
      void this.resumePendingDrawing();
      return this.getPublicState();
    })();
    this.tickInFlight = work;
    try {
      return await work;
    } finally {
      if (this.tickInFlight === work) this.tickInFlight = null;
      this.stepInFlight = false;
    }
  }

  async #stepAgent(agentId) {
    const agent = this.state.agents[agentId];
    const partner = this.state.agents[this.#partnerId(agentId)];
    if (!agent || !partner) return;

    const activeSheet = Number(this.state.scratchpad?.version) === 5
      ? normalizeRasterScratchpad(this.state.scratchpad, { turn: this.state.turn })
      : null;
    if (
      agent.sheetBlockedPanoId === agent.panoId &&
      activeSheet &&
      (activeSheet.pendingMessage || activeSheet.owner !== agentId)
    ) {
      agent.status = 'waiting';
      return;
    }
    agent.sheetBlockedPanoId = null;

    const current = await this.#navigateAndGetPanorama(agent.panoId, agent.position);
    agent.panoId = current.panoId;
    agent.position = { lat: current.position.lat, lng: current.position.lng };
    agent.neighborPanoIds = (current.links || []).map(link => link?.pano).filter(Boolean).slice(0, 16);

    let selected = null;
    let decisionReason = null;
    let mode = 'auto';
    let modelFallbackCause = null;
    let hasFreshModelThought = false;
    let waitingAtBranch = false;
    let deliberateWait = agent.waitTurnsRemaining > 0;

    if (deliberateWait) {
      agent.waitTurnsRemaining -= 1;
      agent.status = 'waiting';
      waitingAtBranch = true;
      mode = 'deliberate_wait';
      decisionReason = `${agent.name} remains at the chosen anchor while ${partner.name} searches too. ` +
        `${agent.waitTurnsRemaining} planned wait turn${agent.waitTurnsRemaining === 1 ? '' : 's'} remain.`;
    }

    const localCandidates = deliberateWait ? [] : await this.#candidatePanoramas(current.links || []);
    const unvisitedCandidates = localCandidates.filter(candidate =>
      !(agent.visitedPanos || []).includes(candidate.panoId)
    );
    let candidates = localCandidates;
    let loopEscapePanoId = null;

    if (isShortPanoLoop(agent.visitedPanos || [])) {
      if (unvisitedCandidates.length > 0) {
        candidates = unvisitedCandidates;
      } else {
        const escape = await this.#findNearbyStreetPanorama({
          origin: agent.position,
          avoidPanoIds: new Set(agent.visitedPanos || [])
        });
        if (escape) {
          loopEscapePanoId = escape.panoId;
          candidates = [{
            panoId: escape.panoId,
            position: { lat: escape.position.lat, lng: escape.position.lng },
            heading: calculateBearing(agent.position, escape.position),
            label: 'nearby public corner that breaks the loop'
          }];
        }
      }
    }
    if (candidates.length > 0) {
      const unexplored = candidates.filter(candidate => !(agent.visitedPanos || []).includes(candidate.panoId));
      const choicePool = unexplored.length > 0 ? unexplored : candidates;
      if (choicePool.length === 1) {
        selected = choicePool[0];
        decisionReason = `${agent.name} follows the only unexplored public continuation.`;
      } else {
        const retraceCandidates = localCandidates
          .filter(candidate => (agent.visitedPanos || []).includes(candidate.panoId))
          .filter(candidate => !choicePool.some(choice => choice.panoId === candidate.panoId))
          .slice(0, 2);
        const decisionPool = [...choicePool, ...retraceCandidates].map(candidate => ({
          ...candidate,
          visited: (agent.visitedPanos || []).includes(candidate.panoId)
        }));
        mode = 'decision';
        if (Number(this.state.scratchpad?.version) !== 5) {
          await this.#migrateLegacyScratchpadToRaster();
        }
        if (Number(this.state.scratchpad?.version) !== 5) {
          throw new Error('Rendezvous sheet must be migrated before resolving a branch');
        }
        const scratchpad = normalizeRasterScratchpad(this.state.scratchpad, { turn: this.state.turn });
        this.state.scratchpad = scratchpad;
        if (scratchpad.pendingMessage || scratchpad.owner !== agentId) {
          waitingAtBranch = true;
          mode = 'waiting_for_sheet';
          agent.status = 'waiting';
          agent.sheetBlockedPanoId = agent.panoId;
          decisionReason = scratchpad.pendingMessage
            ? `${agent.name} waits at the choice until the drawing has finished crossing between them.`
            : `${agent.name} waits at the choice because ${partner.name} still holds the sheet.`;
        } else {
          const allowWait = agent.consecutiveWaitDecisions < this.maxConsecutiveWaitDecisions;
          const [screenshots, scratchpadImage, visualHistory] = await Promise.all([
            this.#captureCandidateScreenshots(decisionPool),
            this.#readScratchpadImage(scratchpad),
            this.#readVisualHistory(agentId, scratchpad)
          ]);
          const decision = await this.agentModel.decide({
            agent: {
              id: agent.id,
              name: agent.name,
              style: agent.style,
              visitedPanos: [...(agent.visitedPanos || [])],
              recentNotes: [...(agent.recentNotes || [])]
            },
            partnerName: partner.name,
            options: decisionPool.map(candidate => ({
              panoId: candidate.panoId,
              heading: candidate.heading,
              label: candidate.label,
              visited: candidate.visited
            })),
            screenshots,
            scratchpadBuffer: scratchpadImage.buffer,
            scratchpadMimeType: scratchpadImage.mimeType,
            sheetMessage: scratchpad.currentMessage,
            visualHistory,
            privateMemory: normalizeAgentMemory(agent.privateMemory, { recentNotes: agent.recentNotes }),
            movementSinceDecision: normalizeMovementMemory(agent.movementSinceDecision),
            allowWait,
            consecutiveWaitDecisions: agent.consecutiveWaitDecisions
          });
          decisionReason = decision.reasoning;
          modelFallbackCause = decision.fallbackCause || null;
          if (modelFallbackCause) {
            waitingAtBranch = true;
            mode = 'decision_retry';
            agent.status = 'waiting';
            agent.waitTurnsRemaining = 0;
            selected = null;
            this.#recordEvent('decision_retry_scheduled', {
              agentId,
              agentName: agent.name,
              panoId: current.panoId,
              cause: modelFallbackCause
            });
          } else if (!allowWait && decision.action === 'wait') {
            this.#recordEvent('wait_patience_expired', {
              agentId,
              agentName: agent.name,
              panoId: current.panoId,
              consecutiveWaitDecisions: agent.consecutiveWaitDecisions
            });
            decision.action = 'move';
            decision.waitTurns = 0;
            decision.reasoning = 'I have learned nothing new by holding this corner, so I choose a public route and keep searching.';
            decisionReason = decision.reasoning;
          }
          if (!modelFallbackCause) {
            agent.branchDecisionCount += 1;
            hasFreshModelThought = true;
            agent.privateMemory = applyMemoryRevision(agent.privateMemory, decision.memoryUpdate, {
              turn: this.state.turn,
              sheetMessage: scratchpad.currentMessage,
              sheetInterpretation: decision.sheetInterpretation,
              sheetConfidence: decision.sheetConfidence,
              sheetPerception: decision.sheetPerception,
              reconciliation: decision.reconciliation,
              observation: decision.observation,
              sourcePanoId: current.panoId
            });
            agent.movementSinceDecision = createMovementMemory();
          }

          const requested = decisionPool[decision.selectedIndex] || decisionPool[0];
          if (modelFallbackCause) {
            // Keep the holder at the branch. A later turn retries the complete
            // decision and message rather than advancing without a handoff.
          } else if (decision.action === 'wait') {
            agent.consecutiveWaitDecisions += 1;
            deliberateWait = true;
            waitingAtBranch = true;
            mode = 'decision_wait';
            agent.status = 'waiting';
            agent.waitTurnsRemaining = Math.max(0, decision.waitTurns - 1);
          } else if (decision.action === 'retrace') {
            selected = requested?.visited
              ? requested
              : decisionPool.find(candidate => candidate.visited) || requested;
            mode = selected?.visited ? 'retrace' : 'decision';
          } else {
            selected = !requested?.visited
              ? requested
              : decisionPool.find(candidate => !candidate.visited) || requested;
          }
          if (decision.drawingPrompt) {
            const pendingId = randomUUID();
            this.state.scratchpad = queueRasterScratchpadMessage(scratchpad, {
              id: pendingId,
              agentId,
              turn: this.state.turn,
              drawingPrompt: decision.drawingPrompt,
              contributionKind: decision.contributionKind,
              contributionEvidenceId: decision.contributionEvidenceId,
              contributionSummary: decision.contributionSummary,
              drawingIntent: decision.drawingIntent,
              informationDelta: decision.informationDelta,
              continuityReason: decision.continuityReason,
              messageAction: decision.messageAction,
              groundedFeatures: decision.observedFeatures,
              sourcePanoId: current.panoId,
              snapshot: this.#captureSheetSnapshot(agentId, {
                reasoning: decision.reasoning,
                turn: this.state.turn,
                stepCount: agent.stepCount,
                mode,
                selectedLabel: requested?.label || null,
                createdAt: new Date().toISOString()
              })
            });
            this.#recordEvent('scratchpad_queued', {
              id: pendingId,
              from: agentId,
              to: partner.id,
              medium: 'symbolic_prompt_only'
            });
          }
        }
      }
    }

    if (!selected && !waitingAtBranch) {
      const recovered = await this.#recoverFromBlockedPano(agent, current);
      if (recovered) {
        mode = 'recovering';
        selected = {
          panoId: recovered.panoId,
          position: recovered.position,
          label: 'nearby outdoor Street View'
        };
        decisionReason = `${agent.name} was stranded in a Street View pano without public turns, so they step back to a nearby outdoor corner and keep searching for ${partner.name}.`;
      } else {
        mode = 'waiting';
        agent.status = 'waiting';
        decisionReason = `${agent.name} cannot find a useful public turn here, so they hold position briefly and listen for the other trail.`;
      }
    } else if (selected) {
      const previousPosition = { ...agent.position };
      const pano = await this.#navigateAndGetPanorama(selected.panoId, selected.position);
      agent.panoId = pano.panoId;
      agent.position = { lat: pano.position.lat, lng: pano.position.lng };
      agent.neighborPanoIds = (pano.links || []).map(link => link?.pano).filter(Boolean).slice(0, 16);
      agent.heading = calculateBearing(previousPosition, agent.position);
      agent.movementSinceDecision = recordMovement(agent.movementSinceDecision, {
        distanceMeters: calculateDistance(previousPosition, agent.position),
        heading: agent.heading,
        label: selected.label
      });
      agent.consecutiveWaitDecisions = 0;
      agent.sheetBlockedPanoId = null;
      agent.status = 'searching';
      agent.path.push({
        ...agent.position,
        panoId: agent.panoId,
        timestamp: new Date().toISOString()
      });
      agent.visitedPanos.push(agent.panoId);
      if (agent.visitedPanos.length > 120) agent.visitedPanos.shift();
      agent.stepCount += 1;
      if (loopEscapePanoId && agent.panoId === loopEscapePanoId) {
        mode = 'loop_break';
        this.#recordEvent('loop_recovery', {
          agentId,
          agentName: agent.name,
          toPanoId: agent.panoId,
          distanceMeters: Math.round(calculateDistance(previousPosition, agent.position))
        });
      }
      decisionReason = decisionReason || `${agent.name} follows the clearest unfamiliar public route.`;
    }

    const step = {
      runId: this.state.runId,
      turn: this.state.turn,
      agentId,
      agentName: agent.name,
      stepCount: agent.stepCount,
      mode,
      panoId: agent.panoId,
      position: agent.position,
      heading: agent.heading,
      distanceToFriend: Math.round(calculateDistance(agent.position, partner.position)),
      reasoning: decisionReason,
      selectedLabel: selected?.label || null,
      fallbackCause: modelFallbackCause,
      scratchpadSequence: this.state.scratchpad?.sequence || 0,
      scratchpadOwner: this.state.scratchpad?.owner || null
    };
    if (hasFreshModelThought) {
      agent.lastThought = normalizeLastThought({
        reasoning: step.reasoning,
        turn: step.turn,
        stepCount: step.stepCount,
        mode: step.mode,
        selectedLabel: step.selectedLabel,
        createdAt: new Date().toISOString()
      });
    }
    agent.lastDecision = step;
    agent.recentNotes.push(decisionReason);
    agent.recentNotes = agent.recentNotes.slice(-8);
    this.#recordEvent('agent_step', step);
    this.emit('rendezvous-step', step);
  }

  async #resolveStartPanorama(start, agentId) {
    const preferred = await this.#getPanorama(start);
    if (hasStreetLinks(preferred)) return preferred;

    this.logger.warn?.(
      `Rendezvous ${AGENTS[agentId]?.name || agentId} start resolved to pano ` +
        `${preferred.panoId} without street links; searching nearby outdoor panos.`
    );

    const nearby = await this.#findNearbyStreetPanorama({
      origin: start,
      avoidPanoIds: new Set([preferred.panoId])
    });
    if (nearby) return nearby;

    throw new Error(
      `Could not find a usable outdoor Street View pano near ${start.label || `${start.lat},${start.lng}`}`
    );
  }

  async #candidatePanoramas(links = []) {
    const candidates = [];
    for (const link of links.slice(0, 6)) {
      if (!link?.pano) continue;
      try {
        const pano = await this.#getPanorama(link.pano);
        candidates.push({
          panoId: pano.panoId,
          position: { lat: pano.position.lat, lng: pano.position.lng },
          heading: Number(link.heading),
          label: link.description || ''
        });
      } catch (error) {
        this.logger.warn?.(`Skipping candidate pano ${link.pano}: ${error.message}`);
      }
    }
    return candidates;
  }

  async #captureCandidateScreenshots(candidates) {
    const screenshots = [];
    for (const candidate of candidates) {
      await this.streetView.setHeading(candidate.heading);
      screenshots.push(await this.streetView.getScreenshot());
    }
    return screenshots;
  }

  #drawingDirectory(runId = this.state.runId) {
    return path.join(this.dataDir, 'rendezvous-drawings', runId || 'unknown');
  }

  async #pruneUnreferencedDrawingFiles() {
    if (
      Number(this.state.scratchpad?.version) !== 5 ||
      !/^[a-zA-Z0-9_-]+$/.test(String(this.state.runId || ''))
    ) {
      return 0;
    }

    const scratchpad = normalizeRasterScratchpad(this.state.scratchpad, { turn: this.state.turn });
    const referenced = new Set([
      scratchpad.currentMessage?.imageFile,
      ...scratchpad.messageAudit.map(message => message.imageFile)
    ].filter(Boolean));

    let entries;
    try {
      entries = await fsp.readdir(this.#drawingDirectory(), { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      this.logger.warn?.(`Could not inspect rendezvous drawings for cleanup: ${error.message}`);
      return 0;
    }

    let removed = 0;
    await Promise.all(entries.map(async entry => {
      if (
        !entry.isFile() ||
        !/\.(?:png|webp)$/i.test(entry.name) ||
        referenced.has(entry.name)
      ) {
        return;
      }
      try {
        await fsp.unlink(path.join(this.#drawingDirectory(), entry.name));
        removed += 1;
      } catch (error) {
        if (error.code !== 'ENOENT') {
          this.logger.warn?.(`Could not remove unreferenced rendezvous drawing ${entry.name}: ${error.message}`);
        }
      }
    }));
    return removed;
  }

  async #pruneArchivedDrawingDirectories() {
    const root = path.join(this.dataDir, 'rendezvous-drawings');
    let entries;
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      this.logger.warn?.(`Could not inspect archived rendezvous drawings: ${error.message}`);
      return 0;
    }

    const activeRunId = String(this.state.runId || '');
    const archived = entries.filter(entry =>
      entry.isDirectory() &&
      entry.name !== activeRunId &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.name)
    );
    let removed = 0;
    for (const entry of archived) {
      try {
        await fsp.rm(path.join(root, entry.name), { recursive: true, force: true });
        removed += 1;
      } catch (error) {
        this.logger.warn?.(`Could not remove archived rendezvous drawings ${entry.name}: ${error.message}`);
      }
    }
    return removed;
  }

  async #readScratchpadImage(scratchpad) {
    const message = normalizeRasterScratchpad(scratchpad).currentMessage;
    if (message?.imageFile) {
      try {
        return {
          buffer: await fsp.readFile(path.join(this.#drawingDirectory(), message.imageFile)),
          mimeType: message.imageMimeType || 'image/webp'
        };
      } catch (error) {
        this.logger.warn?.(`Could not read current rendezvous drawing: ${error.message}`);
      }
    }
    return {
      buffer: await renderScratchpad(createRasterScratchpad({ owner: scratchpad?.owner, turn: this.state.turn })),
      mimeType: 'image/webp'
    };
  }

  async #readVisualHistory(agentId, scratchpad, limit = 4) {
    const normalized = normalizeRasterScratchpad(scratchpad);
    const currentId = normalized.currentMessage?.id || null;
    const messages = normalized.messageAudit
      .filter(message =>
        message.status === 'sent' &&
        message.imageFile &&
        message.id !== currentId &&
        (message.from === agentId || message.to === agentId)
      )
      .slice(-limit);
    const history = [];
    for (const message of messages) {
      try {
        history.push({
          sequence: message.sequence,
          direction: message.from === agentId ? 'sent' : 'received',
          mimeType: message.imageMimeType || (message.imageFile.endsWith('.png') ? 'image/png' : 'image/webp'),
          buffer: await fsp.readFile(path.join(this.#drawingDirectory(), message.imageFile))
        });
      } catch (error) {
        this.logger.warn?.(`Could not read rendezvous visual history ${message.id}: ${error.message}`);
      }
    }
    return history;
  }

  async #removePendingReferences(pendingId, runId = this.state.runId) {
    await Promise.all(Array.from({ length: 4 }, (_, index) =>
      fsp.unlink(path.join(this.#drawingDirectory(runId), `${pendingId}-reference-${index}.jpg`)).catch(() => {})
    ));
  }

  async resumePendingDrawing() {
    if (this.drawingInFlight) return this.drawingInFlight;
    const runId = this.state.runId;
    const pending = Number(this.state.scratchpad?.version) === 5
      ? normalizeRasterScratchpad(this.state.scratchpad).pendingMessage
      : null;
    if (!pending) return null;
    const nextAttemptAt = Date.parse(pending.nextAttemptAt || '');
    if (Number.isFinite(nextAttemptAt) && nextAttemptAt > Date.now()) return null;

    const work = (async () => {
      try {
        this.state.scratchpad = markRasterScratchpadAttempt(this.state.scratchpad, {
          pendingId: pending.id
        });
        await this.saveState();
        let generated = await this.imageModel.generate({
          drawingPrompt: pending.drawingPrompt,
          groundedFeatures: compatibleRevisionFeatures(
            pending.drawingPrompt,
            pending.groundedFeatures,
            pending.messageAction
          )
        });
        let review = typeof this.agentModel.reviewDrawing === 'function'
          ? await this.agentModel.reviewDrawing({
              agentName: this.state.agents[pending.from]?.name || pending.from,
              partnerName: this.state.agents[pending.to]?.name || pending.to,
              contributionKind: pending.contributionKind,
              contributionEvidenceId: pending.contributionEvidenceId,
              contributionSummary: pending.contributionSummary,
              drawingIntent: pending.drawingIntent,
              informationDelta: pending.informationDelta,
              continuityReason: pending.continuityReason,
              messageAction: pending.messageAction,
              drawingPrompt: pending.drawingPrompt,
              groundedFeatures: pending.groundedFeatures,
              imageBuffer: generated.buffer,
              imageMimeType: generated.mimeType
            })
          : { accepted: true, assessment: 'Drawing review is not available in this model adapter.', revisionPrompt: '' };
        let renderAttempts = 1;
        if (!review.accepted) {
          const revisionPrompt = composeDrawingRevisionPrompt(
            pending.drawingPrompt,
            review.revisionPrompt,
            pending.messageAction
          );
          generated = await this.imageModel.generate({
            drawingPrompt: revisionPrompt,
            groundedFeatures: compatibleRevisionFeatures(
              revisionPrompt,
              pending.groundedFeatures,
              pending.messageAction
            )
          });
          renderAttempts += 1;
          review = typeof this.agentModel.reviewDrawing === 'function'
            ? await this.agentModel.reviewDrawing({
                agentName: this.state.agents[pending.from]?.name || pending.from,
                partnerName: this.state.agents[pending.to]?.name || pending.to,
                contributionKind: pending.contributionKind,
                contributionEvidenceId: pending.contributionEvidenceId,
                contributionSummary: pending.contributionSummary,
                drawingIntent: pending.drawingIntent,
                informationDelta: pending.informationDelta,
                continuityReason: pending.continuityReason,
                messageAction: pending.messageAction,
                drawingPrompt: revisionPrompt,
                groundedFeatures: pending.groundedFeatures,
                imageBuffer: generated.buffer,
                imageMimeType: generated.mimeType
              })
            : { accepted: true, assessment: 'Drawing review is not available in this model adapter.', revisionPrompt: '' };
        }
        const attemptNumber = Math.max(1, Number(pending.attempts || 0) + 1);
        if (!review.accepted && canAcceptRecipientLegibleRetry(review, pending.messageAction, attemptNumber)) {
          review = {
            ...review,
            accepted: true,
            assessment: `${review.assessment} Accepted after ${attemptNumber} durable attempts because the independent recipient read the intended dominant action without readable text.`
          };
        }
        if (!review.accepted) {
          const error = new Error(`Sender rejected the generated drawing: ${review.assessment}`);
          error.retryable = true;
          error.nextDrawingPrompt = composeDrawingRevisionPrompt(
            pending.drawingPrompt,
            review.revisionPrompt,
            pending.messageAction
          );
          throw error;
        }
        if (this.state.runId !== runId) return null;
        const currentPendingBeforeWrite = normalizeRasterScratchpad(this.state.scratchpad).pendingMessage;
        if (!currentPendingBeforeWrite || currentPendingBeforeWrite.id !== pending.id) return null;
        const directory = this.#drawingDirectory(runId);
        await fsp.mkdir(directory, { recursive: true });
        const imageFile = `${pending.id}.webp`;
        const destination = path.join(directory, imageFile);
        const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
        await fsp.writeFile(temporary, generated.buffer);
        await fsp.rename(temporary, destination);

        if (this.state.runId !== runId) {
          await fsp.unlink(destination).catch(() => {});
          return null;
        }
        const currentPending = normalizeRasterScratchpad(this.state.scratchpad).pendingMessage;
        if (!currentPending || currentPending.id !== pending.id) return null;
        const imageSha256 = createHash('sha256').update(generated.buffer).digest('hex');
        this.state.scratchpad = commitRasterScratchpadMessage(this.state.scratchpad, {
          pendingId: pending.id,
          imageFile,
          imageMimeType: generated.mimeType,
          imageSha256,
          imageModel: generated.model,
          requestId: generated.requestId,
          reviewAssessment: review.assessment,
          renderAttempts
        });
        const sent = this.state.scratchpad.currentMessage;
        const sender = this.state.agents[sent.from];
        if (sender && pending.drawingIntent) {
          sender.privateMemory = recordSentMessage(sender.privateMemory, {
            turn: sent.turn,
            sequence: sent.sequence,
            to: sent.to,
            intent: pending.drawingIntent,
            contributionKind: pending.contributionKind,
            contributionEvidenceId: pending.contributionEvidenceId,
            contributionSummary: pending.contributionSummary,
            informationDelta: pending.informationDelta,
            continuityReason: pending.continuityReason,
            groundedFeatures: pending.groundedFeatures,
            createdAt: sent.sentAt
          });
        }
        if (this.state.agents[sent.to]) this.state.agents[sent.to].padSeenSequence = sent.sequence;
        this.#recordEvent('scratchpad_sent', {
          id: sent.id,
          from: sent.from,
          to: sent.to,
          sequence: sent.sequence,
          imageSha256,
          renderAttempts,
          reviewAssessment: review.assessment
        });
        await this.saveState();
        this.emit('rendezvous-scratchpad', {
          kind: 'sent',
          id: sent.id,
          from: sent.from,
          to: sent.to,
          sequence: sent.sequence
        });
        this.broadcastState();
        return sent;
      } catch (error) {
        const currentPending = this.state.runId === runId
          ? normalizeRasterScratchpad(this.state.scratchpad).pendingMessage
          : null;
        if (currentPending?.id === pending.id) {
          const attempts = Math.max(1, currentPending.attempts);
          const backoffMs = Math.min(
            this.drawingRetryMaxMs,
            this.drawingRetryBaseMs * (2 ** Math.min(6, attempts - 1))
          );
          const retryAt = new Date(Date.now() + backoffMs).toISOString();
          this.state.scratchpad = retryRasterScratchpadMessage(this.state.scratchpad, {
            pendingId: pending.id,
            error: error.message,
            nextAttemptAt: retryAt,
            drawingPrompt: error.nextDrawingPrompt
          });
          this.#recordEvent('scratchpad_retry_scheduled', {
            id: pending.id,
            from: pending.from,
            to: pending.to,
            error: error.message,
            attempts,
            retryAt
          });
          await this.saveState();
          this.broadcastState();
        }
        this.logger.warn?.(`Rendezvous drawing ${pending.id} will retry: ${error.message}`);
        return null;
      } finally {
        await this.#removePendingReferences(pending.id, runId);
        if (this.state.runId === runId) await this.#pruneUnreferencedDrawingFiles();
      }
    })();
    this.drawingInFlight = work;
    try {
      return await work;
    } finally {
      if (this.drawingInFlight === work) this.drawingInFlight = null;
    }
  }

  async #recoverFromBlockedPano(agent, current) {
    if (hasStreetLinks(current)) return null;

    const recovered = await this.#findNearbyStreetPanorama({
      origin: agent.position,
      avoidPanoIds: new Set(agent.visitedPanos || [])
    });
    if (!recovered) return null;

    const previousPosition = { ...agent.position };
    agent.panoId = recovered.panoId;
    agent.position = { lat: recovered.position.lat, lng: recovered.position.lng };
    agent.heading = calculateBearing(previousPosition, agent.position);
    agent.status = 'searching';
    agent.path.push({
      ...agent.position,
      panoId: agent.panoId,
      timestamp: new Date().toISOString()
    });
    agent.visitedPanos.push(agent.panoId);
    if (agent.visitedPanos.length > 120) agent.visitedPanos.shift();
    this.#recordEvent('street_recovery', {
      agentId: agent.id,
      agentName: agent.name,
      fromPanoId: current.panoId,
      toPanoId: recovered.panoId,
      distanceMeters: Math.round(calculateDistance(previousPosition, recovered.position))
    });
    return recovered;
  }

  async #findNearbyStreetPanorama({ origin, avoidPanoIds = new Set() }) {
    const points = [origin];
    for (const radius of STREET_SEARCH_RADII_METERS) {
      for (const bearing of STREET_SEARCH_BEARINGS) {
        const point = offsetPosition(origin, radius, bearing);
        if (point) points.push(point);
      }
    }

    const seen = new Set();
    const candidates = [];
    for (const point of points) {
      const key = `${Number(point.lat).toFixed(6)},${Number(point.lng).toFixed(6)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const pano = await this.#getPanorama(point);
        if (!hasStreetLinks(pano) || avoidPanoIds.has(pano.panoId)) continue;
        candidates.push({
          ...pano,
          recoveryDistanceMeters: calculateDistance(origin, pano.position)
        });
      } catch (error) {
        this.logger.warn?.(`Nearby street pano lookup failed: ${error.message}`);
      }
    }

    return candidates
      .filter(candidate => Number.isFinite(candidate.recoveryDistanceMeters))
      .sort((a, b) => {
        const aScore = a.recoveryDistanceMeters - (a.links?.length || 0) * 8;
        const bScore = b.recoveryDistanceMeters - (b.links?.length || 0) * 8;
        return aScore - bScore;
      })[0] || null;
  }

  #updateMeetingMetrics() {
    const ada = this.state.agents.ada;
    const theo = this.state.agents.theo;
    if (!ada || !theo) return;
    this.state.meeting.goal = 'find_each_other';
    this.state.meeting.target = null;
    this.state.meeting.distanceMeters = Math.round(calculateDistance(ada.position, theo.position));
    this.state.meeting.adaDistanceToTarget = null;
    this.state.meeting.theoDistanceToTarget = null;
  }

  #checkFound() {
    if (this.state.status === 'found') return;
    const ada = this.state.agents.ada;
    const theo = this.state.agents.theo;
    if (!ada || !theo) return;

    const distance = calculateDistance(ada.position, theo.position);
    const foundByDistance = distance <= this.foundRadiusMeters;

    if (!foundByDistance) return;
    if (!isAgentPositionPathConsistent(ada) || !isAgentPositionPathConsistent(theo)) {
      this.#recordEvent('found_position_rejected', {
        distanceMeters: Math.round(distance),
        adaPathDriftMeters: Math.round(calculateDistance(ada.position, ada.path?.at(-1))),
        theoPathDriftMeters: Math.round(calculateDistance(theo.position, theo.path?.at(-1)))
      });
      return;
    }
    if (!areAgentsStreetViewAdjacent(ada, theo)) {
      this.#recordEvent('found_connectivity_rejected', {
        distanceMeters: Math.round(distance),
        adaPanoId: ada.panoId,
        theoPanoId: theo.panoId
      });
      return;
    }

    this.state.status = 'found';
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.state.foundAt = new Date().toISOString();
    this.state.foundReason = `${AGENTS.ada.name} and ${AGENTS.theo.name} reached the same connected Street View place, ${Math.round(distance)}m apart.`;
    this.state.agents.ada.status = 'found';
    this.state.agents.theo.status = 'found';
    const payload = {
      runId: this.state.runId,
      turn: this.state.turn,
      distanceMeters: Math.round(distance),
      reason: this.state.foundReason
    };
    this.#recordEvent('rendezvous_found', payload);
    this.emit('rendezvous-found', payload);
  }

  #checkExhausted() {
    if (this.state.status !== 'running') return;
    const branchDecisions = AGENT_ORDER.reduce((total, agentId) =>
      total + Math.max(0, Number(this.state.agents[agentId]?.branchDecisionCount) || 0), 0);
    if (branchDecisions < this.maxBranchDecisions) return;

    this.state.status = 'lost';
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.state.lostAt = new Date().toISOString();
    this.state.lostReason = `The friends used their ${this.maxBranchDecisions}-decision search budget without finding each other.`;
    for (const agentId of AGENT_ORDER) this.state.agents[agentId].status = 'lost';
    const payload = {
      runId: this.state.runId,
      turn: this.state.turn,
      branchDecisions,
      reason: this.state.lostReason
    };
    this.#recordEvent('rendezvous_lost', payload);
    this.emit('rendezvous-lost', payload);
  }

  async #getPanorama(positionOrPanoId) {
    const key = typeof positionOrPanoId === 'string'
      ? `pano:${positionOrPanoId}`
      : `loc:${Number(positionOrPanoId?.lat).toFixed(6)},${Number(positionOrPanoId?.lng).toFixed(6)}`;
    const cached = this.panoramaCache.get(key);
    if (cached) return cached;
    const panorama = await this.streetView.getPanorama(positionOrPanoId);
    this.panoramaCache.set(key, panorama);
    this.panoramaCache.set(`pano:${panorama.panoId}`, panorama);
    while (this.panoramaCache.size > 500) {
      this.panoramaCache.delete(this.panoramaCache.keys().next().value);
    }
    return panorama;
  }

  async #navigateAndGetPanorama(panoId, expectedPosition = null) {
    await this.ensureStreetView();
    const panorama = await this.streetView.navigateAndGetPanorama(panoId);
    const expected = expectedPosition || this.panoramaCache.get(`pano:${panoId}`)?.position;
    const driftMeters = expected ? calculateDistance(expected, panorama?.position) : 0;
    if (expected && (!Number.isFinite(driftMeters) || driftMeters > MAX_PANORAMA_DRIFT_METERS)) {
      throw new Error(
        `Street View navigation for ${panoId} settled ${Math.round(driftMeters)}m from its expected position`
      );
    }
    this.panoramaCache.set(`pano:${panorama.panoId}`, panorama);
    return panorama;
  }

  #partnerId(agentId) {
    return agentId === 'ada' ? 'theo' : 'ada';
  }

  #recordEvent(type, payload) {
    this.state.eventLog.push({
      id: randomUUID(),
      type,
      turn: this.state.turn,
      timestamp: new Date().toISOString(),
      payload
    });
    this.state.eventLog = this.state.eventLog.slice(-100);
  }

  broadcastState() {
    this.emit('rendezvous-state', this.getPublicState());
  }

  async shutdown() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.saveState().catch(() => {});
    if (this.streetViewReady) {
      await this.streetView.close().catch(() => {});
      this.streetViewReady = false;
    }
  }
}

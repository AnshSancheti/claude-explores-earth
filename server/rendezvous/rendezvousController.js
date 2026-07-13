import path from 'path';
import * as fsp from 'fs/promises';
import { randomUUID } from 'crypto';
import { StreetViewHeadless } from '../services/streetViewHeadless.js';
import { calculateBearing } from '../utils/geoUtils.js';
import { RendezvousModelService } from './rendezvousModel.js';
import {
  appendScratchpadOperations,
  createScratchpad,
  normalizeScratchpad,
  renderScratchpad
} from './scratchpad.js';

const AGENT_ORDER = ['ada', 'theo'];
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

function isShortPanoLoop(visitedPanos = []) {
  const tail = visitedPanos.slice(-6);
  if (tail.length < 4) return false;
  const unique = new Set(tail);
  if (unique.size <= 2) return true;
  return tail.length >= 6 && tail.slice(2).every((panoId, index) => panoId === tail[index]);
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

function sanitizePublicAgent(agent) {
  const fallback = publicLegacyReason(agent);
  const lastDecision = agent.lastDecision
    ? {
        ...agent.lastDecision,
        reasoning: sanitizeLegacyNotebookText(agent.lastDecision.reasoning, fallback)
      }
    : agent.lastDecision;
  if (lastDecision) {
    delete lastDecision.targetName;
    delete lastDecision.distanceToTarget;
  }
  return {
    ...agent,
    lastDecision,
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
    agentModel = null
  } = {}) {
    this.emit = emit;
    this.logger = logger;
    this.dataDir = dataDir;
    this.savePath = path.join(dataDir, 'rendezvous-current.json');
    this.streetView = streetView || new StreetViewHeadless();
    this.agentModel = agentModel || new RendezvousModelService({ logger });
    this.streetViewReady = false;
    this.panoramaCache = new Map();
    this.timer = null;
    this.running = false;
    this.stepInFlight = false;
    this.state = this.#emptyState();

    this.stepIntervalMs = parseIntOr(process.env.RENDEZVOUS_STEP_INTERVAL_MS, 1800);
    this.padHandoffDelayTurns = parseIntOr(process.env.RENDEZVOUS_PAD_HANDOFF_DELAY_TURNS, 2);
    this.padMaxHoldTurns = parseIntOr(process.env.RENDEZVOUS_PAD_MAX_HOLD_TURNS, 8);
    this.foundRadiusMeters = parseIntOr(process.env.RENDEZVOUS_FOUND_RADIUS_M, 125);
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
        this.state = this.#normalizeLoadedState(raw);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn?.(`Failed to read rendezvous state: ${error.message}`);
      }
    }
    return this.getPublicState();
  }

  async saveState() {
    await fsp.mkdir(path.dirname(this.savePath), { recursive: true });
    const tempPath = `${this.savePath}.${process.pid}.${randomUUID()}.tmp`;
    await fsp.writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`);
    await fsp.rename(tempPath, this.savePath);
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
      state.agents[agentId] = {
        ...AGENTS[agentId],
        ...state.agents[agentId],
        path: Array.isArray(state.agents[agentId].path) ? state.agents[agentId].path : [],
        inbox: Array.isArray(state.agents[agentId].inbox) ? state.agents[agentId].inbox : [],
        outbox: Array.isArray(state.agents[agentId].outbox) ? state.agents[agentId].outbox : [],
        recentNotes: hasCausalScratchpad && Array.isArray(state.agents[agentId].recentNotes)
          ? state.agents[agentId].recentNotes
          : ['I remember only the public streets I have personally walked.'],
        visitedPanos: Array.isArray(state.agents[agentId].visitedPanos) ? state.agents[agentId].visitedPanos : [],
        padSeenSequence: Math.max(0, Math.floor(Number(state.agents[agentId].padSeenSequence) || 0)),
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

    return {
      ...this.state,
      notebook: null,
      scratchpad: normalizeScratchpad(this.state.scratchpad, { turn: this.state.turn }),
      agents,
      eventLog: (this.state.eventLog || []).map(event => sanitizePublicEvent(event)),
      telegrams: (this.state.telegrams || []).map(stripTelegramInternal)
    };
  }

  async start({ reset = false } = {}) {
    const hasCausalScratchpad = Number(this.state.scratchpad?.version) >= 2;
    if (reset || !this.state.runId || this.state.status === 'found' || !hasCausalScratchpad) {
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
      scratchpad: createScratchpad({ owner: 'ada', turn: 0 }),
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
    this.#updateMeetingMetrics();
    await this.saveState();
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
      lastDecision: null,
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
    if (this.stepInFlight || !this.running || this.state.status !== 'running') return this.getPublicState();
    this.stepInFlight = true;
    try {
      this.#deliverScratchpad();
      const agentId = AGENT_ORDER[this.state.turn % AGENT_ORDER.length];
      await this.#stepAgent(agentId);
      this.state.turn += 1;
      this.#deliverScratchpad();
      this.#updateMeetingMetrics();
      this.#checkFound();
      this.state.updatedAt = new Date().toISOString();
      await this.saveState();
      this.broadcastState();
      return this.getPublicState();
    } finally {
      this.stepInFlight = false;
    }
  }

  async #stepAgent(agentId) {
    const agent = this.state.agents[agentId];
    const partner = this.state.agents[this.#partnerId(agentId)];
    if (!agent || !partner) return;

    agent.stepCount += 1;
    const current = await this.#navigateAndGetPanorama(agent.panoId);
    agent.panoId = current.panoId;
    agent.position = { lat: current.position.lat, lng: current.position.lng };

    let selected = null;
    let decisionReason = null;
    let mode = 'search';
    let modelFallbackCause = null;

    const localCandidates = await this.#candidatePanoramas(current.links || []);
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
      const scratchpad = normalizeScratchpad(this.state.scratchpad, { turn: this.state.turn });
      this.state.scratchpad = scratchpad;
      const canEditPad = scratchpad.owner === agentId && !scratchpad.inTransit;
      if (canEditPad) agent.padSeenSequence = scratchpad.sequence;
      const throughSequence = Math.min(agent.padSeenSequence || 0, scratchpad.sequence);
      const partnerPadText = scratchpad.operations
        .filter(operation =>
          operation.author === partner.id &&
          operation.type === 'text' &&
          operation.sequence <= throughSequence
        )
        .slice(-6)
        .map(operation => operation.text);
      const [screenshots, scratchpadBuffer] = await Promise.all([
        this.#captureCandidateScreenshots(candidates),
        renderScratchpad(scratchpad, { throughSequence })
      ]);
      const forcePass = canEditPad && this.state.turn - scratchpad.heldSinceTurn >= this.padMaxHoldTurns;
      const decision = await this.agentModel.decide({
        agent: {
          id: agent.id,
          name: agent.name,
          style: agent.style,
          visitedPanos: [...(agent.visitedPanos || [])],
          recentNotes: [...(agent.recentNotes || [])]
        },
        partnerName: partner.name,
        options: candidates.map(candidate => ({
          panoId: candidate.panoId,
          heading: candidate.heading,
          label: candidate.label
        })),
        screenshots,
        scratchpadBuffer,
        canEditPad,
        forcePass,
        partnerPadText,
        padStatus: this.#padStatusFor(agentId)
      });
      selected = candidates[decision.selectedIndex] || candidates[0];
      decisionReason = decision.reasoning;
      modelFallbackCause = decision.fallbackCause || null;
      this.#applyScratchpadDecision(agentId, decision);
    }

    if (!selected) {
      const recovered = await this.#recoverFromBlockedPano(agent, current);
      if (recovered) {
        mode = 'recovering';
        selected = {
          panoId: recovered.panoId,
          label: 'nearby outdoor Street View'
        };
        decisionReason = `${agent.name} was stranded in a Street View pano without public turns, so they step back to a nearby outdoor corner and keep searching for ${partner.name}.`;
      } else {
        mode = 'waiting';
        agent.status = 'waiting';
        decisionReason = `${agent.name} cannot find a useful public turn here, so they hold position briefly and listen for the other trail.`;
      }
    } else {
      const previousPosition = { ...agent.position };
      const pano = await this.#navigateAndGetPanorama(selected.panoId);
      agent.panoId = pano.panoId;
      agent.position = { lat: pano.position.lat, lng: pano.position.lng };
      agent.heading = calculateBearing(previousPosition, agent.position);
      agent.status = 'searching';
      agent.path.push({
        ...agent.position,
        panoId: agent.panoId,
        timestamp: new Date().toISOString()
      });
      agent.visitedPanos.push(agent.panoId);
      if (agent.visitedPanos.length > 120) agent.visitedPanos.shift();
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

  #padStatusFor(agentId) {
    const scratchpad = normalizeScratchpad(this.state.scratchpad, { turn: this.state.turn });
    if (scratchpad.inTransit) {
      return scratchpad.inTransit.to === agentId
        ? `in transit to you from ${AGENTS[scratchpad.inTransit.from]?.name || 'your friend'}`
        : `in transit to ${AGENTS[scratchpad.inTransit.to]?.name || 'your friend'}`;
    }
    if (scratchpad.owner === agentId) return 'in your hands';
    return `held by ${AGENTS[scratchpad.owner]?.name || 'your friend'}`;
  }

  #applyScratchpadDecision(agentId, decision) {
    const scratchpad = normalizeScratchpad(this.state.scratchpad, { turn: this.state.turn });
    if (scratchpad.owner !== agentId || scratchpad.inTransit) return;

    const { scratchpad: updated, accepted } = appendScratchpadOperations(
      scratchpad,
      decision.padOperations,
      { agentId, turn: this.state.turn }
    );
    this.state.scratchpad = updated;
    this.state.agents[agentId].padSeenSequence = updated.sequence;
    if (accepted.length > 0) {
      this.#recordEvent('scratchpad_drawn', {
        agentId,
        agentName: AGENTS[agentId].name,
        operationIds: accepted.map(operation => operation.id),
        fromSequence: accepted[0].sequence,
        toSequence: accepted.at(-1).sequence
      });
      this.emit('rendezvous-scratchpad', {
        kind: 'drawn',
        agentId,
        operations: accepted,
        sequence: updated.sequence
      });
    }

    if (decision.passPad) this.#passScratchpad(agentId);
  }

  #passScratchpad(agentId) {
    const scratchpad = normalizeScratchpad(this.state.scratchpad, { turn: this.state.turn });
    if (scratchpad.owner !== agentId || scratchpad.inTransit) return;
    const recipientId = this.#partnerId(agentId);
    scratchpad.owner = null;
    scratchpad.inTransit = {
      from: agentId,
      to: recipientId,
      sentTurn: this.state.turn,
      deliverTurn: this.state.turn + this.padHandoffDelayTurns
    };
    scratchpad.updatedAt = new Date().toISOString();
    this.state.scratchpad = scratchpad;
    this.#recordEvent('scratchpad_passed', { ...scratchpad.inTransit, sequence: scratchpad.sequence });
    this.emit('rendezvous-scratchpad', {
      kind: 'passed',
      ...scratchpad.inTransit,
      sequence: scratchpad.sequence
    });
  }

  #deliverScratchpad() {
    const scratchpad = normalizeScratchpad(this.state.scratchpad, { turn: this.state.turn });
    const transit = scratchpad.inTransit;
    if (!transit || transit.deliverTurn > this.state.turn) {
      this.state.scratchpad = scratchpad;
      return;
    }
    scratchpad.owner = transit.to;
    scratchpad.inTransit = null;
    scratchpad.heldSinceTurn = this.state.turn;
    scratchpad.updatedAt = new Date().toISOString();
    this.state.scratchpad = scratchpad;
    if (this.state.agents[transit.to]) {
      this.state.agents[transit.to].padSeenSequence = scratchpad.sequence;
    }
    this.#recordEvent('scratchpad_delivered', { ...transit, sequence: scratchpad.sequence });
    this.emit('rendezvous-scratchpad', {
      kind: 'delivered',
      ...transit,
      sequence: scratchpad.sequence
    });
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

    this.state.status = 'found';
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.state.foundAt = new Date().toISOString();
    this.state.foundReason = `${AGENTS.ada.name} and ${AGENTS.theo.name} came within ${Math.round(distance)}m of each other.`;
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

  async #navigateAndGetPanorama(panoId) {
    await this.ensureStreetView();
    const panorama = await this.streetView.navigateAndGetPanorama(panoId);
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

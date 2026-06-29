import path from 'path';
import * as fsp from 'fs/promises';
import { randomUUID } from 'crypto';
import { StreetViewHeadless } from '../services/streetViewHeadless.js';
import { calculateBearing } from '../utils/geoUtils.js';

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
const NOTEBOOK_REVISION_LIMIT = 18;
const LEGACY_RENDEZVOUS_HINT_PATTERN = /rough wire|last telegram|telegrams said|telegram puts|somewhere around|nearest guidebook|wire before|meeting place|Bryant Park|Grand Central|Union Square|Washington Square|Columbus Circle/i;
const QUESTION_CARDS = Object.freeze([
  {
    id: 'warmer-colder',
    label: 'Warmer / colder',
    prompt: 'Did that move seem to bring the friends closer?',
    answer: ({ agent, partner }) => {
      const distance = calculateDistance(agent.position, partner.position);
      const previous = Number(agent.lastSharedDistanceMeters);
      if (!Number.isFinite(previous)) {
        if (distance < 260) return 'first read: close enough to slow down and scan faces';
        if (distance < 850) return 'first read: the trail feels reachable, but not solved';
        return 'first read: still a wide city between the two trails';
      }
      const delta = previous - distance;
      if (delta > 120) return 'warmer: the two trails feel like they are bending closer';
      if (delta < -120) return 'colder: that move seems to have widened the gap';
      return 'level: the distance feels mostly unchanged';
    }
  },
  {
    id: 'street-texture',
    label: 'Street texture',
    prompt: 'What kind of city edge are you reading?',
    answer: ({ agent }) => {
      const lat = Number(agent.position?.lat);
      if (lat >= 40.765) return 'park-edge streets and broad crossings';
      if (lat >= 40.755) return 'bright midtown blocks with busy sidewalks';
      if (lat >= 40.738) return 'mixed avenues and narrower commercial streets';
      return 'lower blocks with tighter corners and slower turns';
    }
  },
  {
    id: 'landmark-class',
    label: 'Trail class',
    prompt: 'What kind of trace should the other trust?',
    answer: ({ agent }) => {
      const texture = streetTextureFor(agent.position);
      if (/park-edge/i.test(texture)) return 'park-edge trace with open crossings, not an exact corner';
      if (/midtown/i.test(texture)) return 'busy avenue trace with tall blocks and frequent turns';
      if (/mixed/i.test(texture)) return 'mixed avenue trace, useful for direction but not a block';
      return 'tight-block trace where turns can mislead quickly';
    }
  },
  {
    id: 'confidence-check',
    label: 'Confidence check',
    prompt: 'Should the seeker hold, sweep, or reverse?',
    answer: ({ agent, partner }) => {
      const distance = calculateDistance(agent.position, partner.position);
      if (distance < 260) return 'slow sweep: look across intersections before committing';
      if (distance < 850) return 'keep sweeping; one more coarse clue should matter';
      return 'wide sweep; do not assume the other is near';
    }
  }
]);

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

function bearingWord(bearing) {
  if (!Number.isFinite(Number(bearing))) return 'onward';
  const labels = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  const index = Math.round((((bearing % 360) + 360) % 360) / 45) % 8;
  return labels[index];
}

function neighborhoodFor(position) {
  const lat = Number(position?.lat);
  const lng = Number(position?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 'Manhattan';
  if (lat >= 40.765) return 'the upper west / park edge';
  if (lat >= 40.755 && lng < -73.985) return 'the Theater District';
  if (lat >= 40.748 && lng >= -73.981) return 'Midtown East';
  if (lat >= 40.748) return 'Midtown';
  if (lat >= 40.738) return 'Chelsea / Flatiron';
  if (lat >= 40.731 && lng < -73.994) return 'Greenwich Village';
  if (lat >= 40.731) return 'NoHo / East Village';
  return 'Lower Manhattan';
}

function streetTextureFor(position) {
  const lat = Number(position?.lat);
  if (!Number.isFinite(lat)) return 'ordinary Manhattan blocks';
  if (lat >= 40.765) return 'park-edge streets';
  if (lat >= 40.755) return 'busy midtown blocks';
  if (lat >= 40.738) return 'mixed avenue blocks';
  return 'tighter downtown blocks';
}

function uncertaintyLabel(distanceToTarget) {
  if (!Number.isFinite(distanceToTarget)) return 'unknown';
  if (distanceToTarget < 260) return 'low';
  if (distanceToTarget < 850) return 'medium';
  return 'high';
}

function notebookPlanFor(agent, partner) {
  const distance = calculateDistance(agent?.position, partner?.position);
  const partnerName = partner?.name || 'the other friend';
  if (distance < 260) return `Slow the sweep and scan for ${partnerName} across nearby intersections.`;
  if (distance < 850) return `Keep sweeping toward ${partnerName}'s stale trail; ask for coarse confirmation.`;
  return `Widen the search for ${partnerName}; do not lock onto a single landmark.`;
}

function pointPosition(point) {
  if (!point) return null;
  if (point.position) return point.position;
  if (Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng))) {
    return { lat: Number(point.lat), lng: Number(point.lng) };
  }
  return null;
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
    publicTelegram.text = 'Legacy wire archived; use the shared notebook for durable clues.';
  }
  return publicTelegram;
}

function publicNotebookReason(agent, target) {
  const agentName = agent?.name || 'The agent';
  if (agent?.status === 'found') {
    return `${agentName} reached the rendezvous using the shared notebook and low-resolution clues.`;
  }
  if (agent?.status === 'waiting') {
    return `${agentName} is holding position briefly, reading the shared notebook instead of waiting at a fixed spot.`;
  }
  return `${agentName} is following the shared notebook through the other trail, keeping clues low-resolution.`;
}

function sanitizeLegacyNotebookText(text, fallback) {
  if (typeof text !== 'string') return text;
  return LEGACY_RENDEZVOUS_HINT_PATTERN.test(text) ? fallback : text;
}

function sanitizePublicAgent(agent, target) {
  const fallback = publicNotebookReason(agent, target);
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

function sanitizePublicEvent(event, target) {
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
  const fallback = publicNotebookReason({ name: agentName || 'The agent', status: payload.status }, target);
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
    streetView = null
  } = {}) {
    this.emit = emit;
    this.logger = logger;
    this.dataDir = dataDir;
    this.savePath = path.join(dataDir, 'rendezvous-current.json');
    this.streetView = streetView || new StreetViewHeadless();
    this.streetViewReady = false;
    this.panoramaCache = new Map();
    this.timer = null;
    this.running = false;
    this.stepInFlight = false;
    this.state = this.#emptyState();

    this.stepIntervalMs = parseIntOr(process.env.RENDEZVOUS_STEP_INTERVAL_MS, 1800);
    this.telegramEverySteps = parseIntOr(process.env.RENDEZVOUS_TELEGRAM_EVERY_STEPS, 4);
    this.telegramDelayTurns = parseIntOr(process.env.RENDEZVOUS_TELEGRAM_DELAY_TURNS, 2);
    this.foundRadiusMeters = parseIntOr(process.env.RENDEZVOUS_FOUND_RADIUS_M, 125);
    this.trailLagPoints = parseIntOr(process.env.RENDEZVOUS_TRAIL_LAG_POINTS, 3);
    this.trailUncertaintyMeters = parseIntOr(process.env.RENDEZVOUS_TRAIL_UNCERTAINTY_M, 140);
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
    await fsp.writeFile(this.savePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  #normalizeLoadedState(raw) {
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
      notebook: this.#normalizeNotebook(raw.notebook),
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
        recentNotes: Array.isArray(state.agents[agentId].recentNotes) ? state.agents[agentId].recentNotes : [],
        visitedPanos: Array.isArray(state.agents[agentId].visitedPanos) ? state.agents[agentId].visitedPanos : [],
        friendEstimate: null,
        lastSharedDistanceMeters: Number.isFinite(Number(state.agents[agentId].lastSharedDistanceMeters))
          ? Number(state.agents[agentId].lastSharedDistanceMeters)
          : null
      };
    }
    this.running = state.status === 'running';
    return state;
  }

  #createNotebook() {
    return {
      version: 1,
      search: {
        name: 'Find each other',
        shortName: 'Each other',
        status: 'active',
        rationale: 'No meeting spot. Follow the other trail through coarse, stale clues.'
      },
      proposedMeeting: {
        name: 'Find each other',
        status: 'retired',
        rationale: 'No fixed meeting place; the only goal is to come within sight.'
      },
      lastReliableClue: 'Only durable, low-resolution clues belong here.',
      uncertainty: 'high',
      nextQuestion: {
        from: 'Ada',
        to: 'Theo',
        card: 'Warmer / colder',
        prompt: 'Did that move seem to bring the friends closer?'
      },
      plans: {
        ada: 'Search for Theo through coarse trail clues; do not lock onto a landmark.',
        theo: 'Search for Ada through coarse trail clues; do not lock onto a landmark.'
      },
      revisions: [],
      updatedTurn: this.state.turn || 0,
      updatedBy: null
    };
  }

  #normalizeNotebook(notebook) {
    const base = this.#createNotebook();
    if (!notebook || typeof notebook !== 'object') return base;
    return {
      ...base,
      ...notebook,
      search: {
        ...base.search,
        ...(notebook.search || {}),
        name: 'Find each other',
        shortName: 'Each other',
        rationale: notebook.search?.rationale || base.search.rationale
      },
      proposedMeeting: {
        ...base.proposedMeeting,
        ...(notebook.proposedMeeting || {}),
        name: 'Find each other',
        status: 'retired',
        rationale: 'No fixed meeting place; the only goal is to come within sight.'
      },
      nextQuestion: {
        ...base.nextQuestion,
        ...(notebook.nextQuestion || {}),
        prompt: sanitizeLegacyNotebookText(notebook.nextQuestion?.prompt, base.nextQuestion.prompt) ||
          base.nextQuestion.prompt
      },
      plans: {
        ada: sanitizeLegacyNotebookText(notebook.plans?.ada, base.plans.ada) || base.plans.ada,
        theo: sanitizeLegacyNotebookText(notebook.plans?.theo, base.plans.theo) || base.plans.theo
      },
      revisions: Array.isArray(notebook.revisions)
        ? notebook.revisions.slice(0, NOTEBOOK_REVISION_LIMIT)
        : []
    };
  }

  getPublicState() {
    const target = this.state.meeting?.target || null;
    const agents = {};
    for (const [agentId, agent] of Object.entries(this.state.agents || {})) {
      const publicAgent = sanitizePublicAgent(agent, target);
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
      notebook: this.#normalizeNotebook(this.state.notebook),
      agents,
      eventLog: (this.state.eventLog || []).map(event => sanitizePublicEvent(event, target)),
      telegrams: (this.state.telegrams || []).map(stripTelegramInternal)
    };
  }

  async start({ reset = false } = {}) {
    if (reset || !this.state.runId || this.state.status === 'found') {
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

    const pairIndex = parseIntOr(process.env.RENDEZVOUS_START_PAIR_INDEX, Date.now()) % START_PAIRS.length;
    const pair = START_PAIRS[((pairIndex % START_PAIRS.length) + START_PAIRS.length) % START_PAIRS.length];

    const agents = {};
    for (const agentId of AGENT_ORDER) {
      const start = pair[agentId];
      const partnerStart = pair[this.#partnerId(agentId)];
      const pano = await this.#resolveStartPanorama(start, partnerStart, agentId);
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
      notebook: this.#createNotebook(),
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
    await this.#sendTelegram('ada', { opening: true });
    await this.#sendTelegram('theo', { opening: true });
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
        `Started from ${startLabel} in ${neighborhoodFor(position)}.`
      ],
      lastDecision: null,
      friendEstimate: null,
      lastSharedDistanceMeters: null
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
      this.#deliverTelegrams();
      const agentId = AGENT_ORDER[this.state.turn % AGENT_ORDER.length];
      await this.#stepAgent(agentId);
      this.state.turn += 1;
      this.#deliverTelegrams();
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

    const target = this.#targetForAgent(agent);
    let selected = null;
    let decisionReason = null;
    let mode = 'search';

    const candidates = await this.#candidatePanoramas(current.links || []);
    selected = this.#chooseCandidate(agent, target, candidates);
    if (!selected) {
      const recovered = await this.#recoverFromBlockedPano(agent, target, current);
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
      decisionReason = this.#decisionReason(agent, selected, target);
    }

    if (agent.stepCount === 1 || agent.stepCount % this.telegramEverySteps === 0) {
      await this.#sendTelegram(agentId);
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
      searchTargetName: target.name,
      searchTargetSource: target.source,
      distanceToSearchTarget: Math.round(calculateDistance(agent.position, target.position)),
      distanceToFriend: Math.round(calculateDistance(agent.position, partner.position)),
      reasoning: decisionReason,
      selectedLabel: selected?.label || null
    };
    agent.lastDecision = step;
    agent.recentNotes.push(decisionReason);
    agent.recentNotes = agent.recentNotes.slice(-8);
    this.#recordEvent('agent_step', step);
    this.emit('rendezvous-step', step);
  }

  async #resolveStartPanorama(start, target, agentId) {
    const preferred = await this.#getPanorama(start);
    if (hasStreetLinks(preferred)) return preferred;

    this.logger.warn?.(
      `Rendezvous ${AGENTS[agentId]?.name || agentId} start resolved to pano ` +
        `${preferred.panoId} without street links; searching nearby outdoor panos.`
    );

    const nearby = await this.#findNearbyStreetPanorama({
      origin: start,
      target,
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

  async #recoverFromBlockedPano(agent, target, current) {
    if (hasStreetLinks(current)) return null;

    const recovered = await this.#findNearbyStreetPanorama({
      origin: agent.position,
      target,
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

  async #findNearbyStreetPanorama({ origin, target, avoidPanoIds = new Set() }) {
    const targetPosition = pointPosition(target);
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
          recoveryDistanceMeters: calculateDistance(origin, pano.position),
          targetDistanceMeters: targetPosition ? calculateDistance(pano.position, targetPosition) : 0
        });
      } catch (error) {
        this.logger.warn?.(`Nearby street pano lookup failed: ${error.message}`);
      }
    }

    return candidates
      .filter(candidate => Number.isFinite(candidate.recoveryDistanceMeters))
      .sort((a, b) => {
        const aScore = a.recoveryDistanceMeters + a.targetDistanceMeters * 0.08 - (a.links?.length || 0) * 8;
        const bScore = b.recoveryDistanceMeters + b.targetDistanceMeters * 0.08 - (b.links?.length || 0) * 8;
        return aScore - bScore;
      })[0] || null;
  }

  #chooseCandidate(agent, target, candidates) {
    if (!candidates.length) return null;
    const recent = new Set((agent.visitedPanos || []).slice(-8));

    return candidates
      .map(candidate => {
        const targetDistance = calculateDistance(candidate.position, target.position);
        const currentTargetDistance = calculateDistance(agent.position, target.position);
        const progress = currentTargetDistance - targetDistance;
        const revisitPenalty = recent.has(candidate.panoId) ? 180 : 0;
        const noveltyBonus = recent.has(candidate.panoId) ? 0 : 35;
        return {
          ...candidate,
          score: targetDistance + revisitPenalty - progress * 0.35 - noveltyBonus
        };
      })
      .sort((a, b) => a.score - b.score)[0];
  }

  #targetForAgent(agent) {
    const partnerId = this.#partnerId(agent.id);
    const partner = this.state.agents[partnerId];
    const partnerName = partner?.name || 'the other friend';
    const partnerPath = Array.isArray(partner?.path) ? partner.path : [];
    const latestIndex = Math.max(0, partnerPath.length - 1);
    const lag = Math.min(this.trailLagPoints, latestIndex);
    const stalePoint = partnerPath[Math.max(0, latestIndex - lag)] || partner?.position || agent.position;
    const basePosition = pointPosition(stalePoint) || partner?.position || agent.position;
    const bearingSeed = (this.state.turn * 47) + (agent.id === 'ada' ? 35 : 215);
    const uncertainty = Math.max(0, this.trailUncertaintyMeters - Math.min(latestIndex, 6) * 10);
    const blurredPosition = offsetPosition(basePosition, uncertainty, bearingSeed) || basePosition;

    return {
      id: `${partnerId}-stale-trail`,
      name: `${partnerName}'s stale trail`,
      source: 'partner_trail',
      baseTargetName: `${partnerName}'s trail`,
      position: blurredPosition,
      trailAgePoints: lag,
      uncertaintyMeters: uncertainty
    };
  }

  #decisionReason(agent, selected, target) {
    const bearing = calculateBearing(agent.position, target.position);
    const direction = bearingWord(bearing);
    const texture = streetTextureFor(agent.position);
    const linkLine = selected?.label ? ' A public turn is available, so the plan can keep moving.' : '';
    return `${agent.name} moves ${direction} along ${target.baseTargetName || target.name}. Notebook rule: follow stale traces, share one low-resolution clue, and never settle on a fixed meeting spot. The street reads as ${texture}.${linkLine}`;
  }

  async #sendTelegram(agentId, { opening = false } = {}) {
    const agent = this.state.agents[agentId];
    const partnerId = this.#partnerId(agentId);
    const partner = this.state.agents[partnerId];
    if (!agent || !partner) return null;

    const card = this.#selectQuestionCard(agentId, opening);
    const answer = card.answer({ agent, partner });
    const notebookRevision = this.#applyNotebookUpdate({
      agentId,
      partnerId,
      card,
      answer,
      opening
    });
    const message = this.#telegramText({
      agent,
      partner,
      card,
      answer,
      opening,
      notebookRevision
    });

    const telegram = {
      id: randomUUID(),
      kind: 'notebook_update',
      from: agentId,
      fromName: agent.name,
      to: partnerId,
      toName: partner.name,
      sentTurn: this.state.turn,
      deliverTurn: this.state.turn + this.telegramDelayTurns,
      status: 'in_transit',
      text: message,
      clues: {
        card: card.label,
        answer,
        uncertainty: notebookRevision.uncertainty,
        expiresTurn: notebookRevision.expiresTurn
      },
      notebookRevision,
      createdAt: new Date().toISOString()
    };

    this.state.telegrams.push(telegram);
    agent.outbox.push(telegram);
    agent.outbox = agent.outbox.slice(-10);
    this.#recordEvent('telegram_sent', stripTelegramInternal(telegram));
    this.emit('rendezvous-telegram', stripTelegramInternal(telegram));
    return telegram;
  }

  #selectQuestionCard(agentId, opening) {
    const agentOffset = agentId === 'ada' ? 0 : 1;
    const openingOffset = opening ? 0 : 2;
    const index = (this.state.turn + agentOffset + openingOffset) % QUESTION_CARDS.length;
    return QUESTION_CARDS[index];
  }

  #applyNotebookUpdate({ agentId, partnerId, card, answer, opening }) {
    const agent = this.state.agents[agentId];
    const partner = this.state.agents[partnerId];
    const notebook = this.#normalizeNotebook(this.state.notebook);
    const nextCard = QUESTION_CARDS[(QUESTION_CARDS.findIndex(entry => entry.id === card.id) + 1) % QUESTION_CARDS.length];
    const distanceToPartner = calculateDistance(agent.position, partner.position);
    const uncertainty = uncertaintyLabel(distanceToPartner);
    const revision = {
      id: randomUUID(),
      turn: this.state.turn,
      by: agent.name,
      agentId,
      card: card.label,
      prompt: card.prompt,
      answer,
      uncertainty,
      expiresTurn: this.state.turn + 12,
      createdAt: new Date().toISOString()
    };

    notebook.search = {
      ...notebook.search,
      name: 'Find each other',
      shortName: 'Each other',
      status: 'active',
      rationale: 'No meeting spot. Follow the other trail through coarse, stale clues.'
    };
    notebook.proposedMeeting = {
      ...notebook.proposedMeeting,
      name: 'Find each other',
      status: 'retired',
      rationale: 'No fixed meeting place; the only goal is to come within sight.'
    };
    notebook.lastReliableClue = `${agent.name}: ${answer}`;
    notebook.uncertainty = uncertainty;
    notebook.nextQuestion = {
      from: partner.name,
      to: agent.name,
      card: nextCard.label,
      prompt: nextCard.prompt
    };
    notebook.plans = {
      ...notebook.plans,
      [agentId]: notebookPlanFor(agent, partner),
      [partnerId]: notebook.plans?.[partnerId] || notebookPlanFor(partner, agent)
    };
    notebook.updatedTurn = this.state.turn;
    notebook.updatedBy = agent.name;
    notebook.revisions = [revision, ...(notebook.revisions || [])].slice(0, NOTEBOOK_REVISION_LIMIT);
    this.state.notebook = notebook;
    agent.lastSharedDistanceMeters = Number.isFinite(distanceToPartner) ? Math.round(distanceToPartner) : null;
    this.#recordEvent('notebook_updated', revision);
    return revision;
  }

  #telegramText({ agent, partner, card, answer, opening }) {
    const opener = opening
      ? `FIRST NOTEBOOK PASS TO ${partner.name.toUpperCase()}:`
      : `NOTEBOOK PASS TO ${partner.name.toUpperCase()}:`;
    return `${opener} ${card.label}. ${answer}. One clue only; keep searching, no meeting spot.`;
  }

  #deliverTelegrams() {
    for (const telegram of this.state.telegrams) {
      if (telegram.status !== 'in_transit' || telegram.deliverTurn > this.state.turn) continue;
      const recipient = this.state.agents[telegram.to];
      if (!recipient) continue;
      telegram.status = 'delivered';
      telegram.deliveredAt = new Date().toISOString();
      recipient.inbox.push(telegram);
      recipient.inbox = recipient.inbox.slice(-10);
      recipient.friendEstimate = null;
      this.#recordEvent('telegram_delivered', stripTelegramInternal(telegram));
      this.emit('rendezvous-telegram', stripTelegramInternal(telegram));
    }
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

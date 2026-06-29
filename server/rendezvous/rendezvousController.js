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
    targetId: 'bryant-park',
    ada: { lat: 40.759011, lng: -73.984472, label: 'theater district corner' },
    theo: { lat: 40.750298, lng: -73.977873, label: 'terminal-side avenue' }
  },
  {
    targetId: 'union-square',
    ada: { lat: 40.741184, lng: -73.989747, label: 'flatiron side street' },
    theo: { lat: 40.730944, lng: -73.991705, label: 'noho corner' }
  },
  {
    targetId: 'washington-square',
    ada: { lat: 40.73491, lng: -73.992605, label: 'union square south edge' },
    theo: { lat: 40.72571, lng: -74.000735, label: 'soho block' }
  },
  {
    targetId: 'columbus-circle',
    ada: { lat: 40.761619, lng: -73.981552, label: 'midtown theater block' },
    theo: { lat: 40.774137, lng: -73.982194, label: 'lincoln square corner' }
  }
]);

const STREET_SEARCH_RADII_METERS = Object.freeze([18, 36, 72]);
const STREET_SEARCH_BEARINGS = Object.freeze([0, 45, 90, 135, 180, 225, 270, 315]);
const NOTEBOOK_REVISION_LIMIT = 18;
const LEGACY_RENDEZVOUS_HINT_PATTERN = /rough wire|last telegram|telegrams said|telegram puts|somewhere around|nearest guidebook|wire before/i;
const QUESTION_CARDS = Object.freeze([
  {
    id: 'warmer-colder',
    label: 'Warmer / colder',
    prompt: 'Did that move make the meeting place feel closer?',
    answer: ({ agent, target }) => {
      const distance = calculateDistance(agent.position, target.position);
      if (distance < 180) return 'warmer: the streets feel close enough to slow down and verify';
      if (distance < 650) return 'warmer: the route still feels pointed at the agreement';
      return 'uncertain: the city has not resolved into the meeting place yet';
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
    label: 'Landmark class',
    prompt: 'What kind of anchor should we trust next?',
    answer: ({ target }) => {
      if (/park|square|circle/i.test(target.name)) return 'open public space, not a private storefront';
      if (/terminal/i.test(target.name)) return 'major transit landmark with obvious approaches';
      return 'large civic landmark visible from more than one block';
    }
  },
  {
    id: 'confidence-check',
    label: 'Confidence check',
    prompt: 'How strongly should the shared plan hold?',
    answer: ({ agent, target }) => {
      const distance = calculateDistance(agent.position, target.position);
      if (distance < 250) return 'hold the plan; verify at the edges';
      if (distance < 900) return 'hold the plan, but keep one doubt open';
      return 'keep the plan provisional until another clue agrees';
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
  if (distanceToTarget < 180) return 'low';
  if (distanceToTarget < 650) return 'medium';
  return 'high';
}

function notebookPlanFor(agent, target) {
  const distance = calculateDistance(agent?.position, target?.position);
  const targetName = target?.name || 'the public meeting place';
  if (distance < 180) return `Verify the edges of ${targetName}; avoid overshooting.`;
  if (distance < 650) return `Keep moving toward ${targetName}; ask only for coarse confirmation.`;
  return `Treat ${targetName} as the anchor; do not chase exact clues.`;
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
  const targetName = target?.name || 'the agreed public landmark';
  if (agent?.status === 'found') {
    return `${agentName} reached the rendezvous using the shared notebook and low-resolution clues.`;
  }
  if (agent?.status === 'waiting') {
    return `${agentName} is waiting at ${targetName}, holding the shared plan instead of chasing exact clues.`;
  }
  return `${agentName} is following the shared notebook toward ${targetName}, keeping clues low-resolution.`;
}

function sanitizeLegacyNotebookText(text, fallback) {
  if (typeof text !== 'string') return text;
  return LEGACY_RENDEZVOUS_HINT_PATTERN.test(text) ? fallback : text;
}

function sanitizePublicAgent(agent, target) {
  const fallback = publicNotebookReason(agent, target);
  return {
    ...agent,
    lastDecision: agent.lastDecision
      ? {
          ...agent.lastDecision,
          reasoning: sanitizeLegacyNotebookText(agent.lastDecision.reasoning, fallback)
        }
      : agent.lastDecision,
    recentNotes: Array.isArray(agent.recentNotes)
      ? agent.recentNotes.map(note => sanitizeLegacyNotebookText(note, fallback))
      : agent.recentNotes
  };
}

function sanitizePublicEvent(event, target) {
  if (!event || typeof event !== 'object') return event;
  const payload = event.payload || event.data;
  if (!payload || typeof payload !== 'object') return event;
  const agentName = payload.agentName || payload.name || payload.agentId;
  const fallback = publicNotebookReason({ name: agentName || 'The agent', status: payload.status }, target);
  const sanitizedPayload = {
    ...payload,
    reasoning: sanitizeLegacyNotebookText(payload.reasoning, fallback),
    reason: sanitizeLegacyNotebookText(payload.reason, fallback)
  };
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
    this.meetTargetRadiusMeters = parseIntOr(process.env.RENDEZVOUS_TARGET_RADIUS_M, 85);
    this.waitRadiusMeters = parseIntOr(process.env.RENDEZVOUS_WAIT_RADIUS_M, 55);
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
      notebook: this.#normalizeNotebook(raw.notebook, raw.meeting?.target),
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
        friendEstimate: null
      };
    }
    this.running = state.status === 'running';
    return state;
  }

  #createNotebook(target) {
    const targetName = target?.name || 'the agreed public landmark';
    return {
      version: 1,
      proposedMeeting: {
        name: targetName,
        status: 'agreed',
        rationale: 'A public landmark is easier to converge on than chasing each other.'
      },
      lastReliableClue: 'Only durable, low-resolution clues belong here.',
      uncertainty: 'high',
      nextQuestion: {
        from: 'Ada',
        to: 'Theo',
        card: 'Warmer / colder',
        prompt: 'Did that move make the meeting place feel closer?'
      },
      plans: {
        ada: `Move toward ${targetName}; do not infer Theo's exact block.`,
        theo: `Move toward ${targetName}; do not infer Ada's exact block.`
      },
      revisions: [],
      updatedTurn: this.state.turn || 0,
      updatedBy: null
    };
  }

  #normalizeNotebook(notebook, target) {
    const base = this.#createNotebook(target);
    if (!notebook || typeof notebook !== 'object') return base;
    return {
      ...base,
      ...notebook,
      proposedMeeting: {
        ...base.proposedMeeting,
        ...(notebook.proposedMeeting || {})
      },
      nextQuestion: {
        ...base.nextQuestion,
        ...(notebook.nextQuestion || {})
      },
      plans: {
        ...base.plans,
        ...(notebook.plans || {})
      },
      revisions: Array.isArray(notebook.revisions)
        ? notebook.revisions.slice(0, NOTEBOOK_REVISION_LIMIT)
        : []
    };
  }

  getPublicState() {
    const target = this.state.meeting?.target || GUIDEBOOK_LANDMARKS[0];
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
        target: this.state.meeting.target?.name || null
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
    const target = GUIDEBOOK_LANDMARKS.find(landmark => landmark.id === pair.targetId) || GUIDEBOOK_LANDMARKS[0];

    const agents = {};
    for (const agentId of AGENT_ORDER) {
      const start = pair[agentId];
      const pano = await this.#resolveStartPanorama(start, target, agentId);
      agents[agentId] = this.#createAgent(agentId, pano, start.label);
    }

    this.state = {
      ...this.#emptyState(),
      runId: randomUUID(),
      status: 'idle',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      meeting: {
        target,
        distanceMeters: calculateDistance(agents.ada.position, agents.theo.position),
        adaDistanceToTarget: calculateDistance(agents.ada.position, target.position),
        theoDistanceToTarget: calculateDistance(agents.theo.position, target.position)
      },
      notebook: this.#createNotebook(target),
      agents,
      telegrams: [],
      eventLog: []
    };

    this.#recordEvent('run_created', {
      target: target.name,
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
      friendEstimate: null
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
    const distanceToTarget = calculateDistance(agent.position, target.position);
    let selected = null;
    let decisionReason = null;
    let mode = 'search';

    if (distanceToTarget <= this.waitRadiusMeters) {
      mode = 'waiting';
      agent.status = 'waiting';
      decisionReason = `${agent.name} has reached ${target.name} and waits at the agreed public landmark instead of chasing exact clues.`;
    } else {
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
          decisionReason = `${agent.name} was stranded in a Street View pano without public turns, so they step back to a nearby outdoor corner and keep the meeting plan alive.`;
        } else {
          mode = 'waiting';
          decisionReason = `${agent.name} cannot find a useful public turn here, so they hold position and scan for better signs.`;
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
      targetName: target.name,
      distanceToTarget: Math.round(calculateDistance(agent.position, target.position)),
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
          targetDistanceMeters: calculateDistance(pano.position, target.position)
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
    const target = this.state.meeting.target || GUIDEBOOK_LANDMARKS[0];
    return {
      ...target,
      source: 'guidebook',
      baseTargetName: target.name,
      position: target.position
    };
  }

  #decisionReason(agent, selected, target) {
    const bearing = calculateBearing(agent.position, target.position);
    const direction = bearingWord(bearing);
    const texture = streetTextureFor(agent.position);
    const linkLine = selected?.label ? ' A public turn is available, so the plan can keep moving.' : '';
    return `${agent.name} moves ${direction} toward ${target.baseTargetName || target.name}. Notebook rule: keep the shared plan, share one low-resolution clue, and avoid chasing an exact block. The street reads as ${texture}.${linkLine}`;
  }

  async #sendTelegram(agentId, { opening = false } = {}) {
    const agent = this.state.agents[agentId];
    const partnerId = this.#partnerId(agentId);
    const partner = this.state.agents[partnerId];
    if (!agent || !partner) return null;

    const target = this.state.meeting.target || GUIDEBOOK_LANDMARKS[0];
    const card = this.#selectQuestionCard(agentId, opening);
    const answer = card.answer({ agent, partner, target });
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
    const target = this.state.meeting.target || GUIDEBOOK_LANDMARKS[0];
    const notebook = this.#normalizeNotebook(this.state.notebook, target);
    const nextCard = QUESTION_CARDS[(QUESTION_CARDS.findIndex(entry => entry.id === card.id) + 1) % QUESTION_CARDS.length];
    const distanceToTarget = calculateDistance(agent.position, target.position);
    const uncertainty = uncertaintyLabel(distanceToTarget);
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

    notebook.proposedMeeting = {
      ...notebook.proposedMeeting,
      name: target.name,
      status: opening ? 'proposed' : 'agreed',
      rationale: 'Meet at the same public landmark; do not trade exact locations.'
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
      [agentId]: notebookPlanFor(agent, target),
      [partnerId]: notebook.plans?.[partnerId] || notebookPlanFor(partner, target)
    };
    notebook.updatedTurn = this.state.turn;
    notebook.updatedBy = agent.name;
    notebook.revisions = [revision, ...(notebook.revisions || [])].slice(0, NOTEBOOK_REVISION_LIMIT);
    this.state.notebook = notebook;
    this.#recordEvent('notebook_updated', revision);
    return revision;
  }

  #telegramText({ agent, partner, card, answer, opening }) {
    const opener = opening
      ? `FIRST NOTEBOOK PASS TO ${partner.name.toUpperCase()}:`
      : `NOTEBOOK PASS TO ${partner.name.toUpperCase()}:`;
    return `${opener} ${card.label}. ${answer}. One clue only; keep the meeting card intact.`;
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
    const target = this.state.meeting.target;
    if (!ada || !theo || !target) return;
    this.state.meeting.distanceMeters = Math.round(calculateDistance(ada.position, theo.position));
    this.state.meeting.adaDistanceToTarget = Math.round(calculateDistance(ada.position, target.position));
    this.state.meeting.theoDistanceToTarget = Math.round(calculateDistance(theo.position, target.position));
  }

  #checkFound() {
    if (this.state.status === 'found') return;
    const ada = this.state.agents.ada;
    const theo = this.state.agents.theo;
    const target = this.state.meeting.target;
    if (!ada || !theo || !target) return;

    const distance = calculateDistance(ada.position, theo.position);
    const adaToTarget = calculateDistance(ada.position, target.position);
    const theoToTarget = calculateDistance(theo.position, target.position);
    const foundByDistance = distance <= this.foundRadiusMeters;
    const foundAtTarget = adaToTarget <= this.meetTargetRadiusMeters && theoToTarget <= this.meetTargetRadiusMeters;

    if (!foundByDistance && !foundAtTarget) return;

    this.state.status = 'found';
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.state.foundAt = new Date().toISOString();
    this.state.foundReason = foundByDistance
      ? `${AGENTS.ada.name} and ${AGENTS.theo.name} came within ${Math.round(distance)}m of each other.`
      : `Both friends reached ${target.name}, close enough to spot each other.`;
    this.state.agents.ada.status = 'found';
    this.state.agents.theo.status = 'found';
    const payload = {
      runId: this.state.runId,
      turn: this.state.turn,
      targetName: target.name,
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

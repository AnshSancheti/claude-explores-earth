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

function parseIntOr(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function blendPositions(primary, secondary, secondaryWeight) {
  const weight = clamp(Number(secondaryWeight), 0, 1);
  return {
    lat: Number(primary.lat) * (1 - weight) + Number(secondary.lat) * weight,
    lng: Number(primary.lng) * (1 - weight) + Number(secondary.lng) * weight
  };
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

function roughDistanceLabel(meters) {
  if (!Number.isFinite(meters)) return 'unknown distance';
  if (meters < 120) return 'a few blocks';
  if (meters < 450) return 'several blocks';
  if (meters < 900) return 'about half a mile';
  if (meters < 1700) return 'about a mile';
  return `${Math.round(meters / 1000)} km or more`;
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

function nearestLandmark(position) {
  return GUIDEBOOK_LANDMARKS
    .map(landmark => ({
      ...landmark,
      distanceMeters: calculateDistance(position, landmark.position)
    }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters)[0];
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
  return publicTelegram;
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
    this.friendEstimateUncertaintyMeters = parseIntOr(process.env.RENDEZVOUS_FRIEND_ESTIMATE_M, 220);
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
        visitedPanos: Array.isArray(state.agents[agentId].visitedPanos) ? state.agents[agentId].visitedPanos : []
      };
    }
    this.running = state.status === 'running';
    return state;
  }

  getPublicState() {
    const agents = {};
    for (const [agentId, agent] of Object.entries(this.state.agents || {})) {
      agents[agentId] = {
        ...agent,
        path: (agent.path || []).map(publicPoint),
        inbox: (agent.inbox || []).map(stripTelegramInternal),
        outbox: (agent.outbox || []).map(stripTelegramInternal),
        friendEstimate: agent.friendEstimate
          ? {
              label: agent.friendEstimate.label,
              uncertaintyMeters: agent.friendEstimate.uncertaintyMeters,
              receivedTurn: agent.friendEstimate.receivedTurn
            }
          : null
      };
    }

    return {
      ...this.state,
      agents,
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
      decisionReason = `${agent.name} has reached ${target.name} and is waiting where the telegrams said a friend would look.`;
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
    const estimate = agent.friendEstimate?.position || null;

    return candidates
      .map(candidate => {
        const targetDistance = calculateDistance(candidate.position, target.position);
        const currentTargetDistance = calculateDistance(agent.position, target.position);
        const progress = currentTargetDistance - targetDistance;
        const revisitPenalty = recent.has(candidate.panoId) ? 180 : 0;
        const estimateDistance = estimate ? calculateDistance(candidate.position, estimate) : 0;
        const estimatePull = estimate ? Math.min(estimateDistance, 700) * 0.16 : 0;
        const noveltyBonus = recent.has(candidate.panoId) ? 0 : 35;
        return {
          ...candidate,
          score: targetDistance + estimatePull + revisitPenalty - progress * 0.35 - noveltyBonus
        };
      })
      .sort((a, b) => a.score - b.score)[0];
  }

  #targetForAgent(agent) {
    const target = this.state.meeting.target || GUIDEBOOK_LANDMARKS[0];
    const estimate = agent.friendEstimate?.position;
    if (estimate) {
      const age = Math.max(0, this.state.turn - Number(agent.friendEstimate.receivedTurn || this.state.turn));
      const freshness = clamp(1 - age / 12, 0.2, 1);
      const estimateWeight = 0.18 + freshness * 0.18;
      return {
        ...target,
        id: `${target.id}-wire-intercept`,
        name: `${target.name} via ${agent.friendEstimate.label}`,
        source: 'telegram_intercept',
        baseTargetName: target.name,
        position: blendPositions(target.position, estimate, estimateWeight)
      };
    }
    return {
      ...target,
      source: 'guidebook',
      baseTargetName: target.name,
      position: target.position
    };
  }

  #decisionReason(agent, selected, target) {
    const bearing = calculateBearing(agent.position, target.position);
    const landmark = nearestLandmark(agent.position);
    const direction = bearingWord(bearing);
    const label = selected?.label ? ` The Street View label reads "${selected.label}".` : '';
    const friendLine = agent.friendEstimate
      ? ` The last telegram puts their friend somewhere around ${agent.friendEstimate.label}, so the route bends toward that rough wire before ${target.baseTargetName || target.name}.`
      : ' The old agreement says a public landmark beats wandering.';
    return `${agent.name} turns ${direction} toward ${target.name}, using ${landmark.name} as the nearest guidebook anchor.${friendLine}${label}`;
  }

  async #sendTelegram(agentId, { opening = false } = {}) {
    const agent = this.state.agents[agentId];
    const partnerId = this.#partnerId(agentId);
    const partner = this.state.agents[partnerId];
    if (!agent || !partner) return null;

    const target = this.state.meeting.target || GUIDEBOOK_LANDMARKS[0];
    const landmark = nearestLandmark(agent.position);
    const bearingToTarget = calculateBearing(agent.position, target.position);
    const neighborhood = neighborhoodFor(agent.position);
    const message = this.#telegramText({
      agent,
      partner,
      target,
      landmark,
      neighborhood,
      opening,
      bearingToTarget
    });

    const telegram = {
      id: randomUUID(),
      from: agentId,
      fromName: agent.name,
      to: partnerId,
      toName: partner.name,
      sentTurn: this.state.turn,
      deliverTurn: this.state.turn + this.telegramDelayTurns,
      status: 'in_transit',
      text: message,
      clues: {
        neighborhood,
        nearestLandmark: landmark.name,
        landmarkDistance: roughDistanceLabel(landmark.distanceMeters),
        intention: `moving ${bearingWord(bearingToTarget)} toward ${target.name}`,
        target: target.name
      },
      roughPosition: {
        position: this.#roughPosition(agent.position),
        label: neighborhood,
        uncertaintyMeters: this.friendEstimateUncertaintyMeters
      },
      createdAt: new Date().toISOString()
    };

    this.state.telegrams.push(telegram);
    agent.outbox.push(telegram);
    agent.outbox = agent.outbox.slice(-10);
    this.#recordEvent('telegram_sent', stripTelegramInternal(telegram));
    this.emit('rendezvous-telegram', stripTelegramInternal(telegram));
    return telegram;
  }

  #telegramText({ agent, partner, target, landmark, neighborhood, opening, bearingToTarget }) {
    const distanceLabel = roughDistanceLabel(landmark.distanceMeters);
    const targetDirection = bearingWord(bearingToTarget);
    const recent = agent.recentNotes?.at(-1) || `${agent.name} is taking stock of the street signs.`;
    const opener = opening
      ? `FIRST WIRE TO ${partner.name.toUpperCase()}:`
      : `WIRE TO ${partner.name.toUpperCase()}:`;
    return `${opener} I am in ${neighborhood}, ${distanceLabel} from ${landmark.name}. ` +
      `I will make ${targetDirection} for ${target.name}. ` +
      `${recent.replace(/\s+/g, ' ').slice(0, 120)}`;
  }

  #roughPosition(position) {
    const meters = this.friendEstimateUncertaintyMeters;
    const latMeters = 111320;
    const lngMeters = latMeters * Math.cos(Number(position.lat) * Math.PI / 180);
    const turnOffset = ((this.state.turn % 5) - 2) * (meters / 9);
    return {
      lat: Number(position.lat) + turnOffset / latMeters,
      lng: Number(position.lng) - turnOffset / lngMeters
    };
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
      recipient.friendEstimate = {
        label: telegram.roughPosition?.label || telegram.clues?.neighborhood || 'their last telegram district',
        position: telegram.roughPosition?.position || null,
        uncertaintyMeters: telegram.roughPosition?.uncertaintyMeters || this.friendEstimateUncertaintyMeters,
        receivedTurn: this.state.turn
      };
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

import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import * as fsp from 'fs/promises';
import { RunStore } from '../services/runStore.js';
import { PathProjection } from '../services/pathProjection.js';
import {
  TILE_RENDERER_REVISION,
  archivedPointCount,
  archiveVersionForPoints,
  drawArchiveTileFromPath,
  pruneArchiveTileVersions
} from '../services/archiveTileRenderer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '../..');
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/data' : join(ROOT_DIR, 'runs');

const parseIntOr = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const DEFAULT_COMMAND_TIMEOUT_MS = parseIntOr(process.env.WORKER_COMMAND_TIMEOUT_MS, 120000);
const DEFAULT_BOOT_TIMEOUT_MS = parseIntOr(process.env.WORKER_BOOT_TIMEOUT_MS, DEFAULT_COMMAND_TIMEOUT_MS);
const DEFAULT_HEARTBEAT_STALE_MS = parseIntOr(process.env.WORKER_HEARTBEAT_STALE_MS, 120000);
const DEFAULT_RESTART_WINDOW_MS = parseIntOr(process.env.WORKER_RESTART_WINDOW_MS, 300000);
const DEFAULT_MAX_RESTARTS = parseIntOr(process.env.WORKER_MAX_RESTARTS, 5);
const TILE_TAIL_POINTS = parseIntOr(process.env.TILE_RECENT_TAIL_POINTS || process.env.MINIMAP_VECTOR_TAIL_POINTS, 1500);
const TILE_MAX_CACHE = parseIntOr(process.env.TILE_MAX_CACHE, 256);
const TILE_WARM_MAX_TILES = parseIntOr(process.env.MINIMAP_TILE_WARM_MAX_TILES, 32);
const TILE_WARM_ZOOMS = (process.env.MINIMAP_TILE_WARM_ZOOMS || '8,9,10')
  .split(',')
  .map(value => parseInt(value, 10))
  .filter(value => Number.isFinite(value) && value >= 0 && value <= 22);
const VECTOR_COORDINATE_PRECISION = parseIntOr(process.env.MINIMAP_VECTOR_COORDINATE_PRECISION, 6);
const START_LOCATION = {
  lat: parseFloat(process.env.START_LAT),
  lng: parseFloat(process.env.START_LNG)
};
const START_PANO_ID = process.env.START_PANO_ID || null;

function createFallbackState() {
  return {
    isExploring: false,
    position: START_LOCATION,
    panoId: START_PANO_ID,
    stats: { locationsVisited: 0, distanceTraveled: 0 },
    stepCount: 0,
    runId: null,
    stepStatus: 'worker-unavailable',
    recentHistory: []
  };
}

function cacheSet(map, key, value) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size > TILE_MAX_CACHE) {
    const firstKey = map.keys().next().value;
    map.delete(firstKey);
  }
}

function resolveRequestedArchivedCount(tileVersion, currentArchivedCount) {
  const requested = Number(tileVersion);
  if (!Number.isFinite(requested) || requested < 0) return currentArchivedCount;
  if (currentArchivedCount > 10000 && requested < 10000) return currentArchivedCount;
  return Math.max(0, Math.min(Math.floor(requested), currentArchivedCount));
}

function lonLatToTile(lng, lat, z) {
  const n = Math.pow(2, z);
  const boundedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const latRad = boundedLat * Math.PI / 180;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y))
  };
}

function overviewTilesForBounds(bounds, zooms = TILE_WARM_ZOOMS, maxTiles = TILE_WARM_MAX_TILES) {
  if (!bounds || maxTiles <= 0) return [];
  const minLat = Number(bounds.minLat);
  const minLng = Number(bounds.minLng);
  const maxLat = Number(bounds.maxLat);
  const maxLng = Number(bounds.maxLng);
  if (![minLat, minLng, maxLat, maxLng].every(Number.isFinite)) return [];

  const tiles = [];
  for (const z of zooms) {
    const sw = lonLatToTile(Math.min(minLng, maxLng), Math.min(minLat, maxLat), z);
    const ne = lonLatToTile(Math.max(minLng, maxLng), Math.max(minLat, maxLat), z);
    const minX = Math.min(sw.x, ne.x);
    const maxX = Math.max(sw.x, ne.x);
    const minY = Math.min(sw.y, ne.y);
    const maxY = Math.max(sw.y, ne.y);
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        tiles.push({ z, x, y });
        if (tiles.length >= maxTiles) return tiles;
      }
    }
  }
  return tiles;
}

function roundCoordinate(value, precision = VECTOR_COORDINATE_PRECISION) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = Math.pow(10, Math.max(0, precision));
  return Math.round(number * factor) / factor;
}

export class WorkerSupervisor {
  constructor({
    workerPath = join(__dirname, 'explorationWorker.js'),
    onBroadcast = () => {},
    logger = console,
    dataDir = DATA_DIR,
    forkFn = fork,
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    bootTimeoutMs = DEFAULT_BOOT_TIMEOUT_MS,
    heartbeatStaleMs = DEFAULT_HEARTBEAT_STALE_MS,
    restartWindowMs = DEFAULT_RESTART_WINDOW_MS,
    maxRestarts = DEFAULT_MAX_RESTARTS
  } = {}) {
    this.workerPath = workerPath;
    this.onBroadcast = onBroadcast;
    this.logger = logger;
    this.forkFn = forkFn;
    this.runStore = new RunStore({ dataDir, logger });
    this.pathProjection = new PathProjection({ runStore: this.runStore, logger });
    this.connectedClients = new Set();
    this.pendingRequests = new Map();
    this.tileCache = new Map();
    this.tilePathCache = new Map();
    this.tileRenderPromises = new Map();
    this.tileWarmupKeys = new Set();
    this.fullVectorBinaryCache = new Map();
    this.lastState = createFallbackState();
    this.lastMetrics = {};
    this.lastHeartbeatAt = null;
    this.worker = null;
    this.workerPid = null;
    this.workerReady = false;
    this.workerBooting = false;
    this.workerBootStartedAt = null;
    this.workerRestarts = 0;
    this.restartTimestamps = [];
    this.restartTimer = null;
    this.monitorTimer = null;
    this.starting = null;
    this.shuttingDown = false;
    this.desiredExploring = false;
    this.commandTimeoutMs = commandTimeoutMs;
    this.bootTimeoutMs = bootTimeoutMs;
    this.heartbeatStaleMs = heartbeatStaleMs;
    this.restartWindowMs = restartWindowMs;
    this.maxRestarts = maxRestarts;
  }

  getSavePath() {
    return this.runStore.getCurrentSavePath();
  }

  async start({ autoRestore = true, autoStart = false } = {}) {
    if (this.starting) return this.starting;
    if (this.#hasFreshWorkerHeartbeat()) return { success: true };

    this.desiredExploring = Boolean(autoStart);
    if (autoRestore) {
      this.#seedStateFromSaveSummary();
    }
    this.starting = this.#startWorker({ autoRestore, autoStart })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  async #startWorker({ autoRestore, autoStart }) {
    if (this.#hasFreshWorkerHeartbeat()) {
      return { success: true, reusedLiveWorker: true };
    }
    if (this.worker) {
      this.#discardCurrentWorker('Replacing stale exploration worker before boot');
    }

    this.workerBooting = true;
    this.workerBootStartedAt = Date.now();
    this.#spawnWorker();
    this.#startHeartbeatMonitor();
    try {
      const result = await this.#sendCommand('boot', { autoRestore, autoStart }, {
        timeoutMs: this.bootTimeoutMs
      });
      this.#warmCurrentArchiveOverview();
      return result;
    } catch (error) {
      if (!this.#hasFreshWorkerHeartbeat()) {
        this.#discardCurrentWorker(`Exploration worker boot failed without a fresh heartbeat: ${error.message}`, {
          scheduleRestart: true
        });
      }
      throw error;
    } finally {
      this.workerBooting = false;
      this.workerBootStartedAt = null;
    }
  }

  #spawnWorker() {
    if (this.worker) return;

    this.workerReady = false;
    const worker = this.forkFn(this.workerPath, [], {
      env: {
        ...process.env,
        EXPLORATION_WORKER: '1'
      },
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      serialization: 'advanced'
    });

    this.worker = worker;
    this.workerPid = worker.pid;

    worker.on('message', (message) => {
      if (worker !== this.worker) return;
      this.#handleWorkerMessage(message);
    });
    worker.on('exit', (code, signal) => this.#handleWorkerExit(worker, code, signal));
    worker.on('error', (error) => {
      this.logger.error('Exploration worker process error:', error);
    });
  }

  #hasFreshWorkerHeartbeat() {
    if (!this.worker || !this.worker.connected || !this.workerReady || !this.lastHeartbeatAt) {
      return false;
    }
    return Date.now() - this.lastHeartbeatAt <= this.heartbeatStaleMs;
  }

  #handleWorkerMessage(message) {
    if (!message || typeof message !== 'object') return;

    if (message.kind === 'response') {
      const pending = this.pendingRequests.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(message.requestId);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error || 'Worker command failed'));
      }
      return;
    }

    if (message.kind === 'broadcast') {
      this.#recordBroadcast(message.name, message.data);
      this.onBroadcast(message.name, message.data);
      return;
    }

    if (message.kind === 'state') {
      if (this.#shouldPreserveKnownRunProgress(message.data || {})) {
        this.lastState = {
          ...this.lastState,
          stepStatus: this.workerBooting ? 'worker-booting' : 'worker-recovering'
        };
        return;
      }
      this.lastState = {
        ...this.lastState,
        ...(message.data || {})
      };
      return;
    }

    if (message.kind === 'metrics') {
      this.#recordWorkerMetrics(message.data || {});
      return;
    }

    if (message.kind === 'heartbeat') {
      this.lastHeartbeatAt = Date.now();
      this.workerReady = true;
      this.#recordWorkerMetrics(message.metrics || {});
      return;
    }

    if (message.kind === 'log') {
      const level = ['error', 'warn', 'info'].includes(message.level) ? message.level : 'log';
      this.logger[level](`[worker] ${message.message}`);
    }
  }

  #recordWorkerMetrics(metrics) {
    if (!metrics || typeof metrics !== 'object') return;

    const previous = this.lastMetrics || {};
    const previousRunId = previous.runId || this.lastState?.runId || null;
    const previousStep = Math.max(
      Number(previous.lastCompletedStep ?? previous.stepCount) || 0,
      Number(this.lastState?.stepCount) || 0
    );
    const nextStep = Number(metrics.lastCompletedStep ?? metrics.stepCount) || 0;
    const lostRun = Boolean(previousRunId && !metrics.runId);
    const regressedWhileInactive = (
      previousStep > 0 &&
      nextStep < previousStep &&
      !metrics.isExploring
    );

    if (this.desiredExploring && (lostRun || regressedWhileInactive)) {
      this.lastMetrics = {
        ...previous,
        stepStatus: this.workerBooting ? 'worker-booting' : 'worker-recovering'
      };
      return;
    }

    this.lastMetrics = metrics;
  }

  #shouldPreserveKnownRunProgress(nextState) {
    if (!this.desiredExploring || !nextState || typeof nextState !== 'object') {
      return false;
    }

    const previousRunId = this.lastState?.runId || this.lastMetrics?.runId || null;
    if (!previousRunId) return false;

    const previousStep = Math.max(
      Number(this.lastState?.stepCount) || 0,
      Number(this.lastMetrics?.lastCompletedStep ?? this.lastMetrics?.stepCount) || 0
    );
    const nextStep = Number(nextState.stepCount ?? nextState.lastCompletedStep) || 0;
    const lostRun = !nextState.runId;
    const regressedWhileInactive = (
      previousStep > 0 &&
      nextStep < previousStep &&
      !nextState.isExploring
    );

    return lostRun || regressedWhileInactive;
  }

  #seedStateFromSaveSummary() {
    const saveSummary = this.readSaveSummary();
    if (!saveSummary || saveSummary.stepCount <= 0) return;

    this.lastMetrics = {
      ...this.lastMetrics,
      isExploring: false,
      runId: saveSummary.runId,
      activeEpoch: saveSummary.activeEpoch,
      stepStatus: 'worker-booting',
      lastCompletedStep: saveSummary.stepCount,
      stepCount: saveSummary.stepCount,
      locationsVisited: saveSummary.locationsVisited,
      distanceTraveled: saveSummary.distanceTraveled,
      pathLength: saveSummary.pathLength,
      restoreSource: 'saved-snapshot'
    };
    this.lastState = {
      ...this.lastState,
      runId: saveSummary.runId,
      stepCount: saveSummary.stepCount,
      stats: {
        locationsVisited: saveSummary.locationsVisited,
        distanceTraveled: saveSummary.distanceTraveled,
        pathLength: saveSummary.pathLength
      },
      stepStatus: 'worker-booting'
    };
  }

  #recordBroadcast(name, data) {
    if (name === 'exploration-started') {
      this.lastState = { ...this.lastState, isExploring: true };
      this.lastMetrics = {
        ...this.lastMetrics,
        isExploring: true,
        stepStatus: this.lastMetrics.stepStatus === 'worker-booting' ? 'idle' : this.lastMetrics.stepStatus
      };
    } else if (name === 'exploration-stopped') {
      this.lastState = { ...this.lastState, isExploring: false };
      this.lastMetrics = {
        ...this.lastMetrics,
        isExploring: false,
        stepStatus: 'idle'
      };
    } else if (name === 'position-update') {
      this.lastState = {
        ...this.lastState,
        position: data?.position ?? this.lastState.position,
        panoId: data?.panoId ?? this.lastState.panoId,
        stats: data?.stats ?? this.lastState.stats
      };
    } else if (name === 'move-decision') {
      const stats = data?.stats || {};
      this.lastState = {
        ...this.lastState,
        position: data?.newPosition ?? this.lastState.position,
        panoId: data?.panoId ?? this.lastState.panoId,
        stats: data?.stats ?? this.lastState.stats,
        stepCount: data?.stepCount ?? this.lastState.stepCount,
        runId: data?.runId ?? this.lastState.runId,
        lastEventSequence: data?.sequence ?? this.lastState.lastEventSequence
      };
      if (!data?.intermediate) {
        const recentHistory = Array.isArray(this.lastState.recentHistory) ? this.lastState.recentHistory : [];
        const dedupedHistory = recentHistory.filter(entry => entry?.stepCount !== data?.stepCount);
        this.lastState = {
          ...this.lastState,
          recentHistory: [...dedupedHistory, data].slice(-100)
        };
        this.#recordWorkerMetrics({
          ...this.lastMetrics,
          isExploring: true,
          runId: data?.runId ?? this.lastMetrics.runId,
          stepStatus: 'idle',
          lastCompletedStep: data?.stepCount ?? this.lastMetrics.lastCompletedStep,
          stepCount: data?.stepCount ?? this.lastMetrics.stepCount,
          locationsVisited: stats.locationsVisited ?? this.lastMetrics.locationsVisited,
          distanceTraveled: stats.distanceTraveled ?? this.lastMetrics.distanceTraveled,
          pathLength: stats.pathLength ?? this.lastMetrics.pathLength,
          lastEventSequence: data?.sequence ?? this.lastMetrics.lastEventSequence
        });
        this.pathProjection.recordLiveMove(data)
          .then(pathState => this.#warmArchiveOverviewTiles(pathState))
          .catch(error => {
            this.logger.warn('Failed to update minimap path projection from live move:', error.message);
          });
      }
    } else if (name === 'state-loaded') {
      const stats = data?.stats || {};
      this.lastState = {
        ...this.lastState,
        runId: data?.runId ?? this.lastState.runId,
        position: data?.position ?? this.lastState.position,
        panoId: data?.panoId ?? this.lastState.panoId,
        stats: data?.stats ?? this.lastState.stats,
        stepCount: data?.stepCount ?? this.lastState.stepCount,
        recentHistory: data?.decisionHistory ?? this.lastState.recentHistory,
        lastEventSequence: data?.sequence ?? this.lastState.lastEventSequence
      };
      this.#recordWorkerMetrics({
        ...this.lastMetrics,
        runId: data?.runId ?? this.lastMetrics.runId,
        stepCount: data?.stepCount ?? this.lastMetrics.stepCount,
        lastCompletedStep: data?.stepCount ?? this.lastMetrics.lastCompletedStep,
        locationsVisited: stats.locationsVisited ?? this.lastMetrics.locationsVisited,
        distanceTraveled: stats.distanceTraveled ?? this.lastMetrics.distanceTraveled,
        pathLength: stats.pathLength ?? this.lastMetrics.pathLength,
        lastEventSequence: data?.sequence ?? this.lastMetrics.lastEventSequence
      });
      if (this.lastState.runId) {
        this.pathProjection.invalidateRun(this.lastState.runId);
        this.tileCache.clear();
        this.tilePathCache.clear();
        this.fullVectorBinaryCache.clear();
        this.#broadcastPathState(this.lastState.runId);
      }
    } else if (name === 'exploration-reset') {
      this.lastState = createFallbackState();
      this.tileCache.clear();
      this.tilePathCache.clear();
      this.fullVectorBinaryCache.clear();
    }
  }

  #handleWorkerExit(worker, code, signal) {
    if (worker !== this.worker) {
      this.logger.warn?.(`Ignored exit from stale exploration worker pid=${worker?.pid}: code=${code} signal=${signal}`);
      return;
    }
    this.logger.error(`Exploration worker exited: code=${code} signal=${signal}`);
    this.worker = null;
    this.workerPid = null;
    this.workerReady = false;
    this.lastHeartbeatAt = null;
    this.workerBooting = false;
    this.workerBootStartedAt = null;
    this.lastState = {
      ...this.lastState,
      isExploring: false,
      stepStatus: 'worker-exited'
    };

    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Exploration worker exited'));
      this.pendingRequests.delete(requestId);
    }

    if (!this.shuttingDown) {
      this.#scheduleRestart();
    }
  }

  #scheduleRestart() {
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter(
      timestamp => now - timestamp < this.restartWindowMs
    );
    if (this.restartTimestamps.length >= this.maxRestarts) {
      this.logger.error(`Exploration worker restart limit reached (${this.maxRestarts}/${this.restartWindowMs}ms)`);
      this.onBroadcast('error', { message: 'Exploration worker restart limit reached.' });
      return;
    }

    if (this.restartTimer) return;
    const delayMs = Math.min(30000, 1000 * Math.pow(2, this.restartTimestamps.length));
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      if (this.#hasFreshWorkerHeartbeat()) {
        this.logger.warn?.('Skipping exploration worker restart; existing worker heartbeat is healthy.');
        this.onBroadcast('worker-recovered', {
          restarts: this.workerRestarts,
          desiredExploring: this.desiredExploring
        });
        return;
      }
      this.restartTimestamps.push(Date.now());
      this.workerRestarts += 1;
      try {
        await this.#startWorker({
          autoRestore: true,
          autoStart: this.desiredExploring
        });
        this.onBroadcast('worker-restarted', {
          restarts: this.workerRestarts,
          desiredExploring: this.desiredExploring
        });
      } catch (error) {
        this.logger.error('Failed to restart exploration worker:', error);
        this.#scheduleRestart();
      }
    }, delayMs);
  }

  #startHeartbeatMonitor() {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(() => {
      if (!this.worker || !this.lastHeartbeatAt || this.shuttingDown) return;
      const heartbeatAge = Date.now() - this.lastHeartbeatAt;
      const staleThresholdMs = this.workerBooting
        ? Math.max(this.heartbeatStaleMs, this.bootTimeoutMs)
        : this.heartbeatStaleMs;
      if (heartbeatAge <= staleThresholdMs) return;
      this.logger.error(`Exploration worker heartbeat stale (${heartbeatAge}ms); restarting worker`);
      this.onBroadcast('error', { message: 'Exploration worker heartbeat went stale; restarting.' });
      this.#discardCurrentWorker('Exploration worker heartbeat went stale', {
        signal: 'SIGKILL',
        scheduleRestart: true
      });
    }, Math.max(1000, Math.floor(this.heartbeatStaleMs / 2)));
  }

  #discardCurrentWorker(reason, { signal = 'SIGKILL', scheduleRestart = false } = {}) {
    const worker = this.worker;
    if (!worker) {
      if (scheduleRestart && !this.shuttingDown) {
        this.#scheduleRestart();
      }
      return false;
    }

    const pid = this.workerPid || worker.pid;
    this.logger.error(`${reason}; discarding worker pid=${pid}`);
    this.worker = null;
    this.workerPid = null;
    this.workerReady = false;
    this.lastHeartbeatAt = null;
    this.workerBooting = false;
    this.workerBootStartedAt = null;
    this.lastState = {
      ...this.lastState,
      isExploring: false,
      stepStatus: scheduleRestart ? 'worker-restarting' : 'worker-unavailable'
    };
    this.lastMetrics = {
      ...this.lastMetrics,
      isExploring: false,
      stepStatus: scheduleRestart ? 'worker-restarting' : 'worker-unavailable'
    };

    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pendingRequests.delete(requestId);
    }

    try {
      worker.kill(signal);
    } catch (error) {
      this.logger.warn?.(`Failed to ${signal} stale exploration worker pid=${pid}: ${error.message}`);
    }

    if (scheduleRestart && !this.shuttingDown) {
      this.#scheduleRestart();
    }
    return true;
  }

  async #sendCommand(command, payload = {}, { timeoutMs = this.commandTimeoutMs } = {}) {
    if (!this.worker || !this.worker.connected) {
      throw new Error('Exploration worker is not running');
    }

    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Exploration worker command timed out: ${command}`));
      }, timeoutMs);
      this.pendingRequests.set(requestId, { resolve, reject, timer, command });
      this.worker.send({ kind: 'request', requestId, command, payload }, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        reject(error);
      });
    });
  }

  async startExploration() {
    this.desiredExploring = true;
    try {
      return await this.#sendCommand('start');
    } catch (error) {
      this.desiredExploring = false;
      throw error;
    }
  }

  async stopExploration(options = {}) {
    this.desiredExploring = false;
    return this.#sendCommand('stop', options);
  }

  async takeSingleStep() {
    return this.#sendCommand('step');
  }

  async resetExploration() {
    this.desiredExploring = false;
    return this.#sendCommand('reset');
  }

  async loadState() {
    return this.#sendCommand('load');
  }

  async saveNow() {
    return this.#sendCommand('saveNow');
  }

  async renderTile(z, x, y, { tileVersion = null } = {}) {
    const runId = this.lastState?.runId || this.lastMetrics?.runId || null;
    if (!runId) {
      return drawArchiveTileFromPath([], z, x, y, { archivedCount: 0 });
    }

    const renderPath = await this.pathProjection.getRenderPath(runId, {
      expectedSequence: this.lastState?.lastEventSequence || this.lastMetrics?.lastEventSequence || 0,
      clonePoints: false
    });
    const currentArchivedCount = archivedPointCount(renderPath.points.length, TILE_TAIL_POINTS);
    const requestedArchivedCount = resolveRequestedArchivedCount(tileVersion, currentArchivedCount);
    const version = archiveVersionForPoints(requestedArchivedCount);
    const cacheKey = `${runId}/${z}/${x}/${y}@r${TILE_RENDERER_REVISION}@v${version}`;
    const cached = this.tileCache.get(cacheKey);
    if (cached) return cached;
    const inFlight = this.tileRenderPromises.get(cacheKey);
    if (inFlight) return inFlight;

    const filePath = join(
      DATA_DIR,
      'tiles',
      runId,
      `renderer-${TILE_RENDERER_REVISION}`,
      String(version),
      String(z),
      String(x),
      `${y}.png`
    );
    const renderPromise = (async () => {
      try {
        const data = fs.readFileSync(filePath);
        cacheSet(this.tileCache, cacheKey, data);
        return data;
      } catch {
        const tile = await drawArchiveTileFromPath(renderPath.points, z, x, y, {
          archivedCount: requestedArchivedCount,
          pathCache: this.tilePathCache
        });
        fsp.mkdir(join(DATA_DIR, 'tiles', runId, `renderer-${TILE_RENDERER_REVISION}`, String(version), String(z), String(x)), { recursive: true })
          .then(() => fsp.writeFile(filePath, tile))
          .then(() => pruneArchiveTileVersions(DATA_DIR, runId))
          .catch(() => {});
        cacheSet(this.tileCache, cacheKey, tile);
        return tile;
      }
    })().finally(() => {
      this.tileRenderPromises.delete(cacheKey);
    });
    this.tileRenderPromises.set(cacheKey, renderPromise);
    return renderPromise;
  }

  async getCurrentState({ includeFullPath = true, timeoutMs = 15000 } = {}) {
    try {
      const state = await this.#sendCommand('getState', { includeFullPath }, { timeoutMs });
      this.lastState = { ...this.lastState, ...state };
      return this.lastState;
    } catch (error) {
      this.logger.warn('Falling back to cached exploration state:', error.message);
      return this.lastState || createFallbackState();
    }
  }

  async getFullPathForInitialLoad() {
    const pathState = await this.getPathState(this.lastState?.runId, {
      expectedSequence: this.lastState?.lastEventSequence
    });
    return pathState.fullPath || [];
  }

  async getPathState(runId, options = {}) {
    if (!runId) {
      return { runId: null, sequence: 0, pathSequence: 0, stepCount: 0, fullPath: [] };
    }
    return this.pathProjection.getPathState(runId, options);
  }

  async getFullPathVectorSnapshot({
    runId = null,
    expectedSequence = 0
  } = {}) {
    const currentRunId = this.lastState?.runId || this.lastMetrics?.runId || null;
    const resolvedRunId = runId || currentRunId;
    if (!resolvedRunId) {
      return {
        runId: null,
        sequence: 0,
        pathSequence: 0,
        stepCount: 0,
        totalPoints: 0,
        coordinates: []
      };
    }
    if (currentRunId && resolvedRunId !== currentRunId) {
      const error = new Error('Requested path run is not current');
      error.statusCode = 404;
      throw error;
    }

    const renderPath = await this.pathProjection.getRenderPath(resolvedRunId, {
      expectedSequence,
      maxStaleEvents: 0,
      clonePoints: false
    });
    const coordinates = [];
    for (const point of renderPath.points) {
      const lng = roundCoordinate(point?.lng);
      const lat = roundCoordinate(point?.lat);
      if (lng == null || lat == null) continue;
      coordinates.push([lng, lat]);
    }

    return {
      runId: renderPath.runId,
      sequence: renderPath.sequence,
      pathSequence: renderPath.pathSequence,
      stepCount: renderPath.stepCount,
      totalPoints: renderPath.points.length,
      coordinatePrecision: VECTOR_COORDINATE_PRECISION,
      coordinates
    };
  }

  async getFullPathVectorBinarySnapshot({
    runId = null,
    expectedSequence = 0
  } = {}) {
    const currentRunId = this.lastState?.runId || this.lastMetrics?.runId || null;
    const resolvedRunId = runId || currentRunId;
    if (!resolvedRunId) {
      return {
        runId: null,
        sequence: 0,
        pathSequence: 0,
        stepCount: 0,
        totalPoints: 0,
        coordinateCount: 0,
        coordinatePrecision: VECTOR_COORDINATE_PRECISION,
        body: Buffer.alloc(0)
      };
    }
    if (currentRunId && resolvedRunId !== currentRunId) {
      const error = new Error('Requested path run is not current');
      error.statusCode = 404;
      throw error;
    }

    const renderPath = await this.pathProjection.getRenderPath(resolvedRunId, {
      expectedSequence,
      maxStaleEvents: 0,
      clonePoints: false
    });
    const cacheKey = `${renderPath.runId}:${renderPath.pathSequence}:${renderPath.points.length}:${VECTOR_COORDINATE_PRECISION}`;
    const cached = this.fullVectorBinaryCache.get(cacheKey);
    if (cached) return cached;

    const scale = Math.pow(10, VECTOR_COORDINATE_PRECISION);
    const body = Buffer.allocUnsafe(renderPath.points.length * 8);
    let offset = 0;
    for (const point of renderPath.points) {
      const lng = Math.round(Number(point?.lng) * scale);
      const lat = Math.round(Number(point?.lat) * scale);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      body.writeInt32LE(lng, offset);
      body.writeInt32LE(lat, offset + 4);
      offset += 8;
    }

    const snapshot = {
      runId: renderPath.runId,
      sequence: renderPath.sequence,
      pathSequence: renderPath.pathSequence,
      stepCount: renderPath.stepCount,
      totalPoints: renderPath.points.length,
      coordinateCount: offset / 8,
      coordinatePrecision: VECTOR_COORDINATE_PRECISION,
      body: offset === body.length ? body : body.subarray(0, offset)
    };
    this.fullVectorBinaryCache.set(cacheKey, snapshot);
    while (this.fullVectorBinaryCache.size > 3) {
      this.fullVectorBinaryCache.delete(this.fullVectorBinaryCache.keys().next().value);
    }
    return snapshot;
  }

  #emitPathState(socket, runId) {
    this.getPathState(runId, {
      expectedSequence: this.lastState?.lastEventSequence
    }).then(pathState => {
      this.#warmArchiveOverviewTiles(pathState);
      if (socket.connected && pathState.fullPath.length > 0) {
        socket.emit('path-state', pathState);
      }
    }).catch(error => {
      this.logger.error('Failed to prepare path for client:', error);
      if (socket.connected) {
        socket.emit('error', { message: 'Failed to load minimap path' });
      }
    });
  }

  #broadcastPathState(runId) {
    this.getPathState(runId, {
      expectedSequence: this.lastState?.lastEventSequence
    }).then(pathState => {
      this.#warmArchiveOverviewTiles(pathState);
      if (pathState.fullPath.length > 0) {
        this.onBroadcast('path-state', pathState);
      }
    }).catch(error => {
      this.logger.warn('Failed to broadcast minimap path state:', error.message);
    });
  }

  #warmCurrentArchiveOverview() {
    const runId = this.lastState?.runId || this.lastMetrics?.runId || null;
    if (!runId) return;
    this.getPathState(runId, {
      expectedSequence: this.lastState?.lastEventSequence || this.lastMetrics?.lastEventSequence || 0
    })
      .then(pathState => this.#warmArchiveOverviewTiles(pathState))
      .catch(error => {
        this.logger.warn('Failed to warm minimap archive overview:', error.message);
      });
  }

  #warmArchiveOverviewTiles(pathState) {
    const runId = pathState?.runId;
    const version = Number(pathState?.tileVersion);
    if (!runId || !Number.isFinite(version) || version <= 0) return;

    const warmupKey = `${runId}@r${TILE_RENDERER_REVISION}@v${version}`;
    if (this.tileWarmupKeys.has(warmupKey)) return;
    this.tileWarmupKeys.add(warmupKey);
    while (this.tileWarmupKeys.size > 20) {
      this.tileWarmupKeys.delete(this.tileWarmupKeys.values().next().value);
    }

    const tiles = overviewTilesForBounds(pathState.bounds);
    if (tiles.length === 0) return;

    (async () => {
      for (const tile of tiles) {
        await this.renderTile(tile.z, tile.x, tile.y, { tileVersion: version });
      }
      this.logger.log(`Warmed ${tiles.length} minimap archive tiles for v${version}`);
    })().catch(error => {
      this.logger.warn(`Failed to warm minimap archive tiles for v${version}: ${error.message}`);
    });
  }

  addClient(socket) {
    this.connectedClients.add(socket.id);
    this.logger.log(`Client connected: ${socket.id}. Total clients: ${this.connectedClients.size}`);

    const emitClientState = (eventName, state) => {
      if (!socket.connected) return;
      socket.emit(eventName, {
        ...state,
        startLocation: START_LOCATION,
        startPanoId: START_PANO_ID,
        recentHistory: state.recentHistory || [],
        connectedClients: this.connectedClients.size
      });
    };

    const scheduledPathRunIds = new Set();
    const schedulePathState = (runId) => {
      if (!runId || scheduledPathRunIds.has(runId)) return;
      scheduledPathRunIds.add(runId);
      setTimeout(async () => {
        if (!socket.connected) return;
        this.#emitPathState(socket, runId);
      }, 100);
    };

    const cachedState = this.lastState || createFallbackState();
    emitClientState('initial-state', cachedState);
    schedulePathState(cachedState.runId);

    this.getCurrentState({ includeFullPath: false, timeoutMs: 1000 }).then(state => {
      emitClientState('state-refresh', state);
      schedulePathState(state.runId);
    }).catch(error => {
      this.logger.warn('Failed to refresh worker state for client:', error.message);
    });
  }

  removeClient(socketId) {
    this.connectedClients.delete(socketId);
    this.logger.log(`Client disconnected: ${socketId}. Total clients: ${this.connectedClients.size}`);
    this.onBroadcast('client-count', { count: this.connectedClients.size });
  }

  getMetrics() {
    const lastHeartbeatAgeSec = this.lastHeartbeatAt
      ? Math.floor((Date.now() - this.lastHeartbeatAt) / 1000)
      : null;
    const workerBootAgeSec = this.workerBootStartedAt
      ? Math.floor((Date.now() - this.workerBootStartedAt) / 1000)
      : null;
    return {
      ...this.lastMetrics,
      workerPid: this.workerPid,
      workerRestarts: this.workerRestarts,
      workerReady: this.workerReady,
      workerBooting: this.workerBooting,
      workerBootAgeSec,
      workerBootTimeoutSec: Math.floor(this.bootTimeoutMs / 1000),
      workerLastHeartbeatAgeSec: lastHeartbeatAgeSec,
      workerHeartbeatStaleThresholdSec: Math.floor(this.heartbeatStaleMs / 1000),
      workerDesiredExploring: this.desiredExploring,
      clientsConnected: this.connectedClients.size,
      ...this.pathProjection.getMetrics()
    };
  }

  async shutdown() {
    this.shuttingDown = true;
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (!this.worker) return { success: true };

    try {
      const result = await this.#sendCommand('shutdown', {}, { timeoutMs: this.commandTimeoutMs });
      await this.pathProjection.flushWrites();
      return result || { success: true };
    } finally {
      if (this.worker && !this.worker.killed) {
        this.worker.kill('SIGTERM');
      }
    }
  }

  dispose() {
    this.shuttingDown = true;
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Worker supervisor disposed'));
      this.pendingRequests.delete(requestId);
    }
    if (this.worker && this.worker.connected && !this.worker.killed) {
      this.worker.kill('SIGTERM');
    }
    this.worker = null;
    this.workerPid = null;
    this.workerReady = false;
    this.workerBooting = false;
    this.workerBootStartedAt = null;
  }

  readSaveSummary() {
    const savePath = this.getSavePath();
    if (!fs.existsSync(savePath)) return null;
    try {
      const saveData = JSON.parse(fs.readFileSync(savePath, 'utf8'));
      return {
        savePath,
        runId: saveData.runId || null,
        activeEpoch: Number(saveData.activeEpoch) || 0,
        stepCount: Number(saveData.stepCount) || 0,
        locationsVisited: Number(saveData.stats?.locationsVisited) || 0,
        distanceTraveled: Number(saveData.stats?.distanceTraveled) || 0,
        pathLength: Number(saveData.stats?.pathLength) || 0
      };
    } catch {
      return null;
    }
  }
}

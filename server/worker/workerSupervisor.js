import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { RunStore } from '../services/runStore.js';
import { PathProjection } from '../services/pathProjection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '../..');
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/data' : join(ROOT_DIR, 'runs');

const parseIntOr = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const DEFAULT_COMMAND_TIMEOUT_MS = parseIntOr(process.env.WORKER_COMMAND_TIMEOUT_MS, 120000);
const DEFAULT_HEARTBEAT_STALE_MS = parseIntOr(process.env.WORKER_HEARTBEAT_STALE_MS, 120000);
const DEFAULT_RESTART_WINDOW_MS = parseIntOr(process.env.WORKER_RESTART_WINDOW_MS, 300000);
const DEFAULT_MAX_RESTARTS = parseIntOr(process.env.WORKER_MAX_RESTARTS, 5);
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

export class WorkerSupervisor {
  constructor({
    workerPath = join(__dirname, 'explorationWorker.js'),
    onBroadcast = () => {},
    logger = console,
    dataDir = DATA_DIR,
    forkFn = fork,
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
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
    this.heartbeatStaleMs = heartbeatStaleMs;
    this.restartWindowMs = restartWindowMs;
    this.maxRestarts = maxRestarts;
  }

  getSavePath() {
    return this.runStore.getCurrentSavePath();
  }

  async start({ autoRestore = true, autoStart = false } = {}) {
    if (this.starting) return this.starting;
    if (this.worker && this.workerReady) return { success: true };

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
    this.workerBooting = true;
    this.workerBootStartedAt = Date.now();
    this.#spawnWorker();
    this.#startHeartbeatMonitor();
    try {
      return await this.#sendCommand('boot', { autoRestore, autoStart }, {
        timeoutMs: this.commandTimeoutMs
      });
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

    worker.on('message', (message) => this.#handleWorkerMessage(message));
    worker.on('exit', (code, signal) => this.#handleWorkerExit(code, signal));
    worker.on('error', (error) => {
      this.logger.error('Exploration worker process error:', error);
    });
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
    const previousStep = Number(previous.lastCompletedStep ?? previous.stepCount) || 0;
    const nextStep = Number(metrics.lastCompletedStep ?? metrics.stepCount) || 0;
    const lostRun = Boolean(previous.runId && !metrics.runId);
    const regressedDuringBoot = (
      previousStep > 0 &&
      nextStep < previousStep &&
      !metrics.isExploring
    );

    if (this.workerBooting && this.desiredExploring && (lostRun || regressedDuringBoot)) {
      this.lastMetrics = {
        ...previous,
        stepStatus: 'worker-booting'
      };
      return;
    }

    this.lastMetrics = metrics;
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
        this.pathProjection.recordLiveMove(data).catch(error => {
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
        this.#broadcastPathState(this.lastState.runId);
      }
    } else if (name === 'exploration-reset') {
      this.lastState = createFallbackState();
    }
  }

  #handleWorkerExit(code, signal) {
    this.logger.error(`Exploration worker exited: code=${code} signal=${signal}`);
    this.worker = null;
    this.workerPid = null;
    this.workerReady = false;
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
        ? Math.max(this.heartbeatStaleMs, this.commandTimeoutMs)
        : this.heartbeatStaleMs;
      if (heartbeatAge <= staleThresholdMs) return;
      this.logger.error(`Exploration worker heartbeat stale (${heartbeatAge}ms); restarting worker`);
      this.onBroadcast('error', { message: 'Exploration worker heartbeat went stale; restarting.' });
      this.worker.kill('SIGTERM');
    }, Math.max(1000, Math.floor(this.heartbeatStaleMs / 2)));
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

  async renderTile(z, x, y) {
    return this.#sendCommand('renderTile', { z, x, y }, {
      timeoutMs: parseIntOr(process.env.WORKER_TILE_TIMEOUT_MS, 30000)
    });
  }

  async getCurrentState({ includeFullPath = true } = {}) {
    try {
      const state = await this.#sendCommand('getState', { includeFullPath }, { timeoutMs: 15000 });
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

  #emitPathState(socket, runId) {
    this.getPathState(runId, {
      expectedSequence: this.lastState?.lastEventSequence
    }).then(pathState => {
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
      if (pathState.fullPath.length > 0) {
        this.onBroadcast('path-state', pathState);
      }
    }).catch(error => {
      this.logger.warn('Failed to broadcast minimap path state:', error.message);
    });
  }

  addClient(socket) {
    this.connectedClients.add(socket.id);
    this.logger.log(`Client connected: ${socket.id}. Total clients: ${this.connectedClients.size}`);

    const sendInitialState = async () => {
      const state = await this.getCurrentState({ includeFullPath: false });
      if (!socket.connected) return;
      socket.emit('initial-state', {
        ...state,
        startLocation: START_LOCATION,
        startPanoId: START_PANO_ID,
        recentHistory: state.recentHistory || [],
        connectedClients: this.connectedClients.size
      });

      setTimeout(async () => {
        if (!socket.connected) return;
        this.#emitPathState(socket, state.runId);
      }, 100);
    };

    sendInitialState().catch(error => {
      this.logger.error('Failed to send initial worker state:', error);
      socket.emit('error', { message: 'Failed to load exploration state' });
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

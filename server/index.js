import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import cors from 'cors';
import { ExplorationAgent } from './agents/explorationAgent.js';
import { Logger } from './utils/logger.js';
import { simplifyPathWithTiers, getSimplificationStats } from './utils/pathSimplification.js';
import fs from 'fs';
import * as fsp from 'fs/promises';
import path from 'path';
import crypto, { randomUUID } from 'crypto';
import { verifySignature } from './utils/urlSigner.js';
import { RunStore } from './services/runStore.js';
import { WorkerSupervisor } from './worker/workerSupervisor.js';
import {
  DEFAULT_PERSISTENT_LOG_MAX_BYTES,
  DEFAULT_PERSISTENT_LOG_MAX_FILE_BYTES,
  DEFAULT_PERSISTENT_LOG_MAX_FILES,
  prunePersistentLogs,
  shouldRotatePersistentLog
} from './utils/persistentLogRetention.js';

dotenv.config();
const IS_WORKER_PROCESS = process.env.EXPLORATION_WORKER === '1';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/data' : join(ROOT_DIR, 'runs');

const app = express();

// Trust proxy headers in production (for fly.io)
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', true);
}

const server = createServer(app);

// Configure Socket.io for production environment
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      // In production, allow the app's domain and handle proxy headers
      if (process.env.NODE_ENV === 'production') {
        // Allow requests with no origin (same-origin requests)
        if (!origin) return callback(null, true);

        // Allow fly.dev domains
        if (origin.includes('fly.dev')) {
          return callback(null, true);
        }

        // Allow localhost for development
        if (origin.includes('localhost')) {
          return callback(null, true);
        }

        // Reject other origins
        return callback(new Error('Not allowed by CORS'));
      } else {
        // In development, allow all origins
        callback(null, true);
      }
    },
    methods: ["GET", "POST"],
    credentials: true
  },
  // Add connection settings for production
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['polling', 'websocket'],
  allowEIO3: true,
  // Allow upgrades from polling to websocket
  allowUpgrades: true,
  // Handle proxy headers from fly.io
  path: '/socket.io/'
});

app.use(cors());
app.use(express.json());

// Serve static files
app.use(express.static(join(ROOT_DIR, 'public')));

// Protected routes for sensitive data (/runs)
// In production with URL_SIGNING_SECRET, require signed URLs; otherwise allow
const runsDirectory = join(ROOT_DIR, 'runs');
const runsMiddleware = express.static(runsDirectory);
app.use('/runs', (req, res, next) => {
  const enforce = process.env.NODE_ENV === 'production' && !!process.env.URL_SIGNING_SECRET;
  if (!enforce) return next();
  const fullPath = req.baseUrl + req.path; // ensures path starts with /runs
  const { exp, sig } = req.query;
  if (!verifySignature(fullPath, exp, sig)) {
    return res.status(403).send('Forbidden');
  }
  next();
}, runsMiddleware);

// Admin authentication endpoint
app.post('/api/admin/auth', express.json(), (req, res) => {
  const { password } = req.body;
  const controlPassword = process.env.CONTROL_PASSWORD;

  if (!controlPassword) {
    return res.status(500).json({ error: 'Admin authentication not configured' });
  }

  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }

  if (password === controlPassword) {
    const token = createAdminToken();
    res.json({
      success: true,
      token,
      message: 'Authentication successful'
    });
  } else {
    // Add delay to prevent brute force
    setTimeout(() => {
      res.status(401).json({ error: 'Invalid password' });
    }, 1000);
  }
});

// Serve Google Maps API loader with API key from environment
app.get('/api/maps-loader', (req, res) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.error('GOOGLE_MAPS_API_KEY not configured in environment variables');
    return res.status(500).send('Google Maps API key not configured. Please set GOOGLE_MAPS_API_KEY.');
  }

  res.type('application/javascript');
  res.send(`
    window.initStreetView = function() {
      window.streetViewReady = true;
    };

    const script = document.createElement('script');
    script.src = 'https://maps.googleapis.com/maps/api/js?key=${apiKey}&callback=initStreetView';
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  `);
});

// Use PORT from environment, default to 3000 for Fly.io
const PORT = process.env.PORT || 3000;
const parseIntOr = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const requestedStepInterval = parseInt(process.env.STEP_INTERVAL_MS, 10);
const minStepInterval = Math.max(0, parseIntOr(process.env.MIN_STEP_INTERVAL_MS, 200));
const STEP_INTERVAL = Math.max(
  Number.isFinite(requestedStepInterval) ? requestedStepInterval : 5000,
  minStepInterval
);
const STEP_INTERVAL_CLAMPED = Number.isFinite(requestedStepInterval) && requestedStepInterval < minStepInterval;
const DECISION_HISTORY_LIMIT = parseInt(process.env.DECISION_HISTORY_LIMIT) || 20;
const SAVE_INTERVAL = parseIntOr(process.env.SAVE_INTERVAL, 25); // Save every N completed steps
const INITIAL_FORCE_SAVE_STEPS = parseIntOr(process.env.INITIAL_FORCE_SAVE_STEPS, 10);
const BACKGROUND_SAVE_INTERVAL_MS = parseIntOr(process.env.BACKGROUND_SAVE_INTERVAL_MS, 30000);
const MAX_CONSECUTIVE_STEP_ERRORS = parseInt(process.env.MAX_CONSECUTIVE_STEP_ERRORS || '25', 10);
const OPENAI_RATE_LIMIT_BACKOFF_MS = parseIntOr(process.env.OPENAI_RATE_LIMIT_BACKOFF_MS, 30000);
const STOP_STEP_DRAIN_TIMEOUT_MS = parseIntOr(process.env.STOP_STEP_DRAIN_TIMEOUT_MS, 120000);
const TILE_TAIL_POINTS = parseInt(process.env.TILE_RECENT_TAIL_POINTS) || 1500; // recent points kept as vector
const TILE_MAX_CACHE = parseInt(process.env.TILE_MAX_CACHE) || 256;
const TILE_VERSION_STEP = parseInt(process.env.TILE_VERSION_STEP) || 1000; // archive version increments every N archived points
const PERSISTENT_LOG_MAX_FILES = parseIntOr(
  process.env.PERSISTENT_LOG_MAX_FILES,
  DEFAULT_PERSISTENT_LOG_MAX_FILES
);
const PERSISTENT_LOG_MAX_BYTES = parseIntOr(
  process.env.PERSISTENT_LOG_MAX_BYTES,
  DEFAULT_PERSISTENT_LOG_MAX_BYTES
);
const PERSISTENT_LOG_MAX_FILE_BYTES = parseIntOr(
  process.env.PERSISTENT_LOG_MAX_FILE_BYTES,
  DEFAULT_PERSISTENT_LOG_MAX_FILE_BYTES
);

// Path simplification settings (configurable via environment variables)
const PATH_SIMPLIFICATION = {
  enabled: process.env.DISABLE_PATH_SIMPLIFICATION !== 'true',  // Set to false to disable
  // Epsilon values in degrees (1 degree ≈ 111km at equator, ~85km longitude in NYC)
  recentEpsilon: parseFloat(process.env.PATH_EPSILON_RECENT) || 0.000005,     // ~0.5m for recent paths
  mediumEpsilon: parseFloat(process.env.PATH_EPSILON_MEDIUM) || 0.00002,      // ~2m for medium age
  oldEpsilon: parseFloat(process.env.PATH_EPSILON_OLD) || 0.00005,            // ~5m for old paths
  recentThreshold: 60 * 60 * 1000,      // 1 hour
  mediumThreshold: 6 * 60 * 60 * 1000,  // 6 hours
};

const START_LOCATION = {
  lat: parseFloat(process.env.START_LAT),
  lng: parseFloat(process.env.START_LNG)
};
const START_PANO_ID = process.env.START_PANO_ID || null;
const EMPTY_TILE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAAAGUlEQVR42u3BAQ0AAADCoPdPbQ43oAAAAAAAAAAA4N8AAQAAATGM2YAAAAAASUVORK5CYII=',
  'base64'
);
let createCanvasFn = null;

async function getCreateCanvas() {
  if (!createCanvasFn) {
    ({ createCanvas: createCanvasFn } = await import('canvas'));
  }
  return createCanvasFn;
}

// Global exploration state
class GlobalExploration {
  constructor({ emit = null } = {}) {
    this.agent = null;
    this.emit = emit || ((event, data) => io.emit(event, data));
    this.isExploring = false;
    this.explorationInterval = null;
    this.connectedClients = new Set();
    this.decisionHistory = [];
    this.screenshotCache = new Map(); // Cache only screenshot URLs, not data
    this.logger = new Logger();
    this.persistentLogger = this.createPersistentLogger();
    this.runStore = new RunStore({ dataDir: DATA_DIR });
    // Keep enough history for new clients to see recent decisions with screenshots
    this.maxHistoryInMemory = Math.max(DECISION_HISTORY_LIMIT * 2, 50);
    this.cacheSize = this.maxHistoryInMemory; // Match cache to history size

    // Save optimization - only save periodically
    this.saveInterval = SAVE_INTERVAL; // Save every N steps (configurable)
    this.lastSaveStep = 0;
    this.pendingSave = false;
    this._saveInFlight = null; // Mutex: only one saveState writes at a time
    this._logQueue = Promise.resolve(); // Serial queue for log appends
    this.backgroundSaveTimer = null;
    this.backgroundSaveInterval = BACKGROUND_SAVE_INTERVAL_MS;
    this.gcInterval = null;
    // Tile cache for archived path rendering
    this.tileCache = new Map(); // key: `${z}/${x}/${y}@${archivedCount}` -> Buffer
    this.fullPathCache = {
      stepCount: null,
      generatedAt: 0,
      fullPath: null
    };
    this.lifecycleLock = Promise.resolve();
    this.activeEpoch = 0;
    this.activeStepId = null;
    this.stepStatus = 'idle';
    this.lastEventSequence = 0;
    this.lastEventId = null;
    this.lastSnapshotSequence = 0;
    this.lastSnapshotAt = null;
    this.lastCompletedStep = 0;
    this.restoreSource = 'none';
    this.allowEmptySaveOnce = false;
    this.consecutiveStepErrors = 0;
    this.isStepPipelineActive = false;
  }

  getSavePath() {
    return this.runStore.getCurrentSavePath();
  }

  async withLifecycleLock(context, fn) {
    const previous = this.lifecycleLock;
    let release = null;
    this.lifecycleLock = new Promise(resolve => {
      release = resolve;
    });

    await previous.catch(error => {
      console.error(`${context}: previous lifecycle operation failed:`, error);
    });

    try {
      return await fn();
    } finally {
      release();
    }
  }

  getRunId() {
    return this.agent?.runId || null;
  }

  getEventLogMeta() {
    return {
      lastSequence: this.lastEventSequence,
      lastEventId: this.lastEventId
    };
  }

  createSaveSnapshot(overrides = {}) {
    if (!this.agent || !this.agent.coverage) return null;

    return {
      schemaVersion: 2,
      runId: this.agent.runId,
      activeEpoch: this.activeEpoch,
      lastUpdated: new Date().toISOString(),
      stepCount: this.agent.stepCount,
      currentState: {
        panoId: this.agent.currentPanoId,
        position: this.agent.currentPosition,
        heading: this.agent.currentHeading,
        mode: this.agent.mode
      },
      stats: this.agent.coverage.getStats(),
      graph: this.agent.coverage.serializeGraph(),
      panoAliases: this.agent.coverage.serializePanoAliases(),
      recentHistory: this.agent.coverage.recentHistory,
      decisionHistory: this.decisionHistory.slice(-DECISION_HISTORY_LIMIT),
      eventLog: this.getEventLogMeta(),
      ...overrides
    };
  }

  async appendRunEvent(type, payload = {}, { stepId = null, stepCount = null, epoch = this.activeEpoch, runId = null } = {}) {
    const eventRunId = runId || this.getRunId() || payload.runId;
    if (!eventRunId) return null;

    const event = await this.runStore.appendEvent(eventRunId, {
      type,
      epoch,
      stepId,
      stepCount,
      payload
    });
    this.lastEventSequence = event.sequence;
    this.lastEventId = event.eventId;
    return event;
  }

  hasMeaningfulAgentState() {
    if (!this.agent) return false;
    const stats = this.agent.coverage ? this.agent.coverage.getStats() : {};
    return (
      (this.agent.stepCount || 0) > 0 ||
      (stats.locationsVisited || 0) > 1 ||
      (stats.pathLength || 0) > 1
    );
  }

  readSaveSummary() {
    const savePath = this.getSavePath();
    if (!fs.existsSync(savePath)) return null;

    try {
      const saveData = JSON.parse(fs.readFileSync(savePath, 'utf8'));
      const stepCount = Number(saveData.stepCount) || 0;
      const locationsVisited = Number(saveData.stats?.locationsVisited) || 0;
      const pathLength = Number(saveData.stats?.pathLength) || 0;
      return { savePath, stepCount, locationsVisited, pathLength };
    } catch (error) {
      console.error(`Failed to read save summary at ${savePath}:`, error);
      return null;
    }
  }

  async maybeRestoreSavedRunBeforeStart() {
    if (process.env.NODE_ENV !== 'production') return null;
    if (this.hasMeaningfulAgentState()) return null;

    const saveSummary = this.readSaveSummary();
    if (!saveSummary) return null;

    const saveHasProgress = (
      saveSummary.stepCount > 0 ||
      saveSummary.locationsVisited > 1 ||
      saveSummary.pathLength > 1
    );
    if (!saveHasProgress) return null;

    console.log(
      `🔄 Resuming saved run before start: ${saveSummary.stepCount} steps, ` +
      `${saveSummary.locationsVisited} locations`
    );
    const result = await this.loadState({ skipLock: true });
    if (result.error) {
      return { error: `Failed to resume saved run: ${result.error}` };
    }
    return result;
  }

  startGcTimer() {
    if (!global.gc || this.gcInterval) return;
    this.gcInterval = setInterval(() => {
      if (global.gc) {
        console.log('Running garbage collection...');
        global.gc();
      }
    }, 60000);
  }

  async waitForStepToFinish(context = 'Operation') {
    if (!this.isStepPipelineActive && !this.agent?.isStepExecuting) {
      return { success: true };
    }

    console.log(`${context}: waiting for in-flight step to finish before mutating exploration state...`);
    const start = Date.now();
    while (this.isStepPipelineActive || this.agent?.isStepExecuting) {
      if (Date.now() - start > STOP_STEP_DRAIN_TIMEOUT_MS) {
        const message = `${context} timed out waiting for the current step to finish`;
        console.error(message);
        return { error: message };
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    console.log(`${context}: in-flight step finished.`);
    return { success: true };
  }

  createPersistentLogger() {
    const logsDir = path.join(DATA_DIR, 'persistent_logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = path.join(logsDir, `exploration-${timestamp}.jsonl`);
    return logPath;
  }

  async enforcePersistentLogRetention() {
    const logsDir = path.join(DATA_DIR, 'persistent_logs');
    try {
      if (await shouldRotatePersistentLog(this.persistentLogger, {
        maxFileBytes: PERSISTENT_LOG_MAX_FILE_BYTES
      })) {
        this.persistentLogger = this.createPersistentLogger();
      }
      await prunePersistentLogs(logsDir, {
        currentLogPath: this.persistentLogger,
        maxFiles: PERSISTENT_LOG_MAX_FILES,
        maxBytes: PERSISTENT_LOG_MAX_BYTES,
        logger: console
      });
    } catch (error) {
      console.warn('Failed to enforce persistent log retention:', error.message);
    }
  }

  // Save current state to a JSON file (serialized: only one write at a time)
  async saveState(force = false) {
    if (!this.agent || !this.agent.coverage) return;

    if (this.agent.isStepExecuting) {
      this.pendingSave = true;
      console.warn('Skipping save while a step is still executing; preserving last completed state.');
      return;
    }

    // Only save if forced or enough steps have passed
    if (!force && (this.agent.stepCount - this.lastSaveStep) < this.saveInterval) {
      this.pendingSave = true;
      return;
    }

    // Chain onto the previous save to guarantee serial execution
    const prevSave = this._saveInFlight || Promise.resolve();
    const thisSave = prevSave.then(() => this._doSave()).catch(err => {
      console.error('Save chain error:', err);
    });
    this._saveInFlight = thisSave;
    await thisSave;
  }

  async _doSave() {
    const saveData = this.createSaveSnapshot();
    if (!saveData) return;
    const graphSize = Object.keys(saveData.graph || {}).length;
    if ((Number(saveData.stepCount) || 0) === 0 && graphSize === 0 && !this.allowEmptySaveOnce) {
      console.warn('Skipping empty save to avoid overwriting an existing run after a failed restore.');
      this.pendingSave = false;
      return;
    }
    this.allowEmptySaveOnce = false;

    try {
      await this.runStore.writeSnapshot(this.agent.runId, saveData);
      console.log(`State saved: ${this.agent.stepCount} steps, ${graphSize} nodes`);
      this.lastSaveStep = this.agent.stepCount;
      this.lastSnapshotSequence = saveData.eventLog.lastSequence;
      this.lastSnapshotAt = Date.now();
      this.pendingSave = false;
    } catch (error) {
      console.error('Failed to save state:', error);
    }
  }

  // Load state from save file
  async loadState(options = {}) {
    if (!options.skipLock) {
      return this.withLifecycleLock('Load state', () =>
        this.loadState({ ...options, skipLock: true })
      );
    }

    const savePath = this.getSavePath();
    const hadAgentBeforeLoad = !!this.agent;

    console.log('📄 Loading save file from:', savePath);
    try {
      const restore = await this.runStore.restoreCurrent();
      if (!restore.snapshot) {
        console.log('📄 No save file found at:', savePath);
        return { error: 'No save file found' };
      }

      for (const warning of restore.warnings || []) {
        console.warn(warning);
      }

      const saveData = restore.snapshot;
      this.restoreSource = restore.restoreSource;
      console.log(
        `📊 Save file details: runId=${saveData.runId}, stepCount=${saveData.stepCount}, ` +
        `lastUpdated=${saveData.lastUpdated}, source=${restore.restoreSource}, replayedEvents=${restore.events.length}`
      );

      // Stop current exploration and wait for any in-flight step before replacing state.
      // Loading is a destructive restore, so do not overwrite the selected save
      // with the state being replaced.
      const stopResult = await this.stopExploration({ flushPendingSave: false, skipLock: true });
      if (stopResult?.error) {
        return stopResult;
      }

      // Initialize agent if needed
      if (!this.agent) {
        await this.initialize();
      }

      this.activeEpoch = Math.max(this.activeEpoch, Number(saveData.activeEpoch) || 0) + 1;
      this.lastEventSequence = Number(saveData.eventLog?.lastSequence) || 0;
      this.lastEventId = saveData.eventLog?.lastEventId || null;
      this.lastSnapshotSequence = this.lastEventSequence;
      this.lastSnapshotAt = saveData.lastUpdated ? Date.parse(saveData.lastUpdated) : null;
      this.lastCompletedStep = Number(saveData.stepCount) || 0;
      this.stepStatus = 'idle';
      this.activeStepId = null;

      // Restore coverage state
      this.agent.coverage.restoreFromSave(saveData);

      // Restore agent state
      this.agent.runId = saveData.runId;
      this.agent.stepCount = saveData.stepCount;
      this.agent.currentPanoId = saveData.currentState.panoId;
      this.agent.currentPosition = saveData.currentState.position;
      this.agent.currentHeading = saveData.currentState.heading || 0;
      this.agent.mode = saveData.currentState.mode || 'exploration';
      this.agent.stepsSinceNewCell = 0;

      // Update screenshot service with restored runId
      const { ScreenshotService } = await import('./utils/screenshot.js');
      this.agent.screenshot = new ScreenshotService(this.agent.runId);
      await this.agent.screenshot.initialize();

      // Restore decision history
      this.decisionHistory = saveData.decisionHistory || [];

      // Navigate to saved position
      if (this.agent.streetViewHeadless && this.agent.currentPanoId) {
        await this.agent.streetViewHeadless.navigateToPano(this.agent.currentPanoId);
      }

      // Validate/repair the loaded panorama before broadcasting to clients.
      let currentPano = null;
      const candidatePanoIds = [];
      if (this.agent.currentPanoId) {
        candidatePanoIds.push(this.agent.currentPanoId);
      }
      if (saveData.graph && this.agent.currentPosition) {
        const sortedGraphPanos = Object.entries(saveData.graph)
          .filter(([panoId]) => panoId !== this.agent.currentPanoId)
          .map(([panoId, node]) => ({
            panoId,
            distance: this.agent.coverage.calculateDistance(
              this.agent.currentPosition,
              { lat: node.lat, lng: node.lng }
            )
          }))
          .sort((a, b) => a.distance - b.distance)
          .slice(0, 50)
          .map(item => item.panoId);
        candidatePanoIds.push(...sortedGraphPanos);
      }

      for (const panoId of candidatePanoIds) {
        try {
          currentPano = await this.agent.streetViewHeadless.getPanorama(panoId);
          break;
        } catch {
          // Try next candidate pano
        }
      }

      // Last-resort fallback: query by position.
      if (!currentPano && this.agent.currentPosition) {
        try {
          currentPano = await this.agent.streetViewHeadless.getPanorama(this.agent.currentPosition);
        } catch {
          // Keep null and fail below.
        }
      }

      if (!currentPano) {
        throw new Error('Failed to restore a valid panorama from loaded save state');
      }

      await this.agent.streetViewHeadless.navigateToPano(currentPano.panoId);
      this.agent.currentPanoId = currentPano.panoId;
      this.agent.currentPosition = {
        lat: currentPano.position.lat,
        lng: currentPano.position.lng
      };

      const loadEventType = this.restoreSource === 'legacy-snapshot'
        ? 'legacy_snapshot_imported'
        : 'state_loaded';
      await this.appendRunEvent(loadEventType, {
        restoreSource: this.restoreSource,
        replayedEvents: restore.events.length,
        snapshot: this.createSaveSnapshot()
      });

      this.pendingSave = true;
      await this.saveState(true);

      // Clear in-memory tile cache; tiles will be re-generated for this run/version
      if (this.tileCache) {
        this.tileCache.clear();
      }

      // Broadcast restored state to all clients
      this.broadcast('state-loaded', {
        runId: this.agent.runId,
        sequence: this.lastEventSequence,
        stepCount: this.agent.stepCount,
        position: this.agent.currentPosition,
        panoId: this.agent.currentPanoId,
        stats: this.agent.coverage.getStats(),
        decisionHistory: this.decisionHistory
      });

      console.log(`State loaded: ${this.agent.stepCount} steps, ${this.agent.coverage.visitedPanos.size} locations visited`);

      // Check if we loaded into a dead-end panorama
      if (!currentPano.links || currentPano.links.length === 0) {
        console.warn('⚠️ Loaded into a dead-end panorama. Attempting to find a valid starting point...');

        // Try to use the last known good heading from movement history
        if (this.agent.recentMovements && this.agent.recentMovements.length > 0) {
          const lastMove = this.agent.recentMovements[this.agent.recentMovements.length - 1];
          this.agent.lastNavigationHeading = lastMove.heading || 0;
          console.log(`Using last known heading: ${this.agent.lastNavigationHeading}°`);
        } else {
          // Default to north if no history
          this.agent.lastNavigationHeading = 0;
          console.log('No movement history available, defaulting to north (0°)');
        }
      }

      return {
        success: true,
        stepCount: this.agent.stepCount,
        locationsVisited: this.agent.coverage.visitedPanos.size,
        graphSize: this.agent.coverage.graph.size,
        restoreSource: this.restoreSource
      };

    } catch (error) {
      console.error('Failed to load state:', error);
      this.pendingSave = false;
      this.stepStatus = 'restore-failed';
      if (!hadAgentBeforeLoad && this.agent) {
        await this.agent.close().catch(() => {});
        this.agent = null;
      }
      return { error: error.message };
    }
  }

  async initialize() {
    if (!this.agent) {
      this.agent = new ExplorationAgent(this, this.logger);
      await this.agent.initialize();
      console.log('Global exploration agent initialized');
    }
  }

  createStepContext({ manual = false } = {}) {
    return {
      runId: this.agent.runId,
      epoch: this.activeEpoch,
      stepId: randomUUID(),
      stepCount: (this.agent.stepCount || 0) + 1,
      startedAt: new Date().toISOString(),
      manual
    };
  }

  isCurrentStepContext(stepContext) {
    return (
      this.agent &&
      stepContext &&
      this.agent.runId === stepContext.runId &&
      this.activeEpoch === stepContext.epoch &&
      this.activeStepId === stepContext.stepId
    );
  }

  getStepStats(stepData) {
    if (stepData?.stats) return stepData.stats;
    return this.agent?.coverage ? this.agent.coverage.getStats() : {};
  }

  stripInternalStepData(stepData) {
    if (!stepData || typeof stepData !== 'object') return stepData;
    const { coverageDelta, ...publicStepData } = stepData;
    return publicStepData;
  }

  logCommittedStep(stepData) {
    if (!stepData) return;

    this.logger.log('exploration-step', {
      step: stepData.stepCount,
      from: stepData.previousPanoId || null,
      to: stepData.panoId,
      decision: stepData.reasoning,
      actionReason: stepData.actionReason,
      eventType: stepData.eventType,
      autoMove: stepData.autoMove,
      fallbackCause: stepData.fallbackCause,
      sceneTag: stepData.sceneTag || null,
      position: stepData.newPosition || this.agent?.currentPosition || null,
      stats: this.getStepStats(stepData)
    });
  }

  async commitStepResult(stepContext, stepData) {
    if (!this.isCurrentStepContext(stepContext)) {
      console.warn(`Suppressing stale step ${stepContext?.stepId || 'unknown'} for run ${stepContext?.runId || 'unknown'}`);
      await this.appendRunEvent('step_abandoned', {
        reason: 'stale_step_context',
        runId: stepContext?.runId,
        stepData: stepData ? {
          stepCount: stepData.stepCount,
          panoId: stepData.panoId,
          eventType: stepData.eventType
        } : null
      }, {
        runId: stepContext?.runId,
        epoch: stepContext?.epoch,
        stepId: stepContext?.stepId,
        stepCount: stepContext?.stepCount
      }).catch(error => {
        console.error('Failed to record stale step abandonment:', error);
      });
      return { committed: false };
    }

    const publicStepData = this.stripInternalStepData(stepData);

    if (publicStepData) {
      this.addToHistory(publicStepData);
      this.cacheScreenshots(publicStepData);
    }

    const event = await this.appendRunEvent('step_completed', {
      stepData
    }, {
      runId: stepContext.runId,
      epoch: stepContext.epoch,
      stepId: stepContext.stepId,
      stepCount: stepData?.stepCount || this.agent.stepCount
    });

    this.lastCompletedStep = this.agent.stepCount;
    this.pendingSave = true;
    this.logCommittedStep(stepData);

    if (publicStepData) {
      const { intermediateEvents = [], ...primaryStepData } = publicStepData;
      for (const intermediateEvent of intermediateEvents) {
        this.broadcast('move-decision', {
          ...intermediateEvent,
          runId: stepContext.runId,
          activeEpoch: stepContext.epoch,
          stepId: stepContext.stepId,
          sequence: event?.sequence || null,
          intermediate: true
        });
      }

      this.broadcast('move-decision', {
        ...primaryStepData,
        newPosition: stepData.newPosition || this.agent.currentPosition,
        stats: this.getStepStats(stepData),
        runId: stepContext.runId,
        activeEpoch: stepContext.epoch,
        stepId: stepContext.stepId,
        sequence: event?.sequence || null
      });
    }

    return { committed: true, event };
  }

  async commitStepError(stepContext, error) {
    const isCurrent = this.isCurrentStepContext(stepContext);
    const type = isCurrent ? 'step_failed' : 'step_abandoned';
    await this.appendRunEvent(type, {
      reason: isCurrent ? 'step_error' : 'stale_step_error',
      message: error?.message || String(error),
      stack: error?.stack || null
    }, {
      runId: stepContext?.runId,
      epoch: stepContext?.epoch,
      stepId: stepContext?.stepId,
      stepCount: stepContext?.stepCount
    }).catch(logError => {
      console.error(`Failed to record ${type}:`, logError);
    });
  }

  async runCommittedStep({ manual = false } = {}) {
    const stepContext = this.createStepContext({ manual });
    this.activeStepId = stepContext.stepId;
    this.stepStatus = 'running';
    this.isStepPipelineActive = true;

    try {
      await this.appendRunEvent('step_started', {
        manual,
        startPanoId: this.agent.currentPanoId,
        startPosition: this.agent.currentPosition,
        runId: stepContext.runId
      }, {
        runId: stepContext.runId,
        epoch: stepContext.epoch,
        stepId: stepContext.stepId,
        stepCount: stepContext.stepCount
      });

      const stepData = await this.agent.exploreStep();
      const commitResult = await this.commitStepResult(stepContext, stepData);
      return { stepData, ...commitResult };
    } catch (error) {
      if (this.activeStepId === stepContext.stepId) {
        this.stepStatus = 'error';
      }
      await this.commitStepError(stepContext, error);
      throw error;
    } finally {
      if (this.activeStepId === stepContext.stepId) {
        this.activeStepId = null;
        this.stepStatus = 'idle';
        this.isStepPipelineActive = false;
      }
    }
  }

  async startExploration(options = {}) {
    if (!options.skipLock) {
      return this.withLifecycleLock('Start exploration', () =>
        this.startExploration({ ...options, skipLock: true })
      );
    }

    if (this.isExploring) {
      return { error: 'Exploration already in progress' };
    }
    if (this.isStepPipelineActive || this.agent?.isStepExecuting) {
      return { error: 'Cannot start while another step is still finishing' };
    }

    let resumeResult = null;
    try {
      resumeResult = await this.maybeRestoreSavedRunBeforeStart();
      if (resumeResult?.error) {
        return { error: resumeResult.error };
      }

      if (!this.agent) {
        await this.initialize();
      }
    } catch (error) {
      this.isExploring = false;
      return { error: error.message };
    }

    this.isExploring = true;
    this.activeEpoch += 1;
    this.stepStatus = 'idle';
    this.startGcTimer();

    await this.appendRunEvent('run_started', {
      resumed: !!resumeResult?.success,
      startPanoId: this.agent.currentPanoId,
      startPosition: this.agent.currentPosition
    });
    this.pendingSave = true;
    await this.saveState(true);

    // Start background save timer (saves every 5 minutes as backup)
    if (this.backgroundSaveTimer) {
      clearInterval(this.backgroundSaveTimer);
    }
    this.backgroundSaveTimer = setInterval(async () => {
      if (this.pendingSave && this.agent) {
        if (this.isStepPipelineActive || this.agent.isStepExecuting) {
          return;
        }
        console.log('Background save triggered (5-minute interval)');
        await this.saveState(true);
      }
    }, this.backgroundSaveInterval);

    // Broadcast to all clients
    this.broadcast('exploration-started', {
      startLocation: START_LOCATION,
      startPanoId: START_PANO_ID,
      timestamp: new Date().toISOString()
    });

    // Start continuous exploration
    const runExplorationStep = async () => {
      if (!this.isExploring || !this.agent) {
        return;
      }
      if (this.isStepPipelineActive || this.agent.isStepExecuting) {
        console.warn('Step pipeline already active, delaying scheduled step');
        if (this.isExploring) {
          this.explorationInterval = setTimeout(runExplorationStep, STEP_INTERVAL);
        }
        return;
      }

      try {
        const { stepData, committed } = await this.runCommittedStep();
        if (!committed) {
          return;
        }
        this.consecutiveStepErrors = 0;

        // Save early steps eagerly so restarts do not jump back to the first pano.
        await this.saveState(this.agent.stepCount <= INITIAL_FORCE_SAVE_STEPS);

        // Schedule next step
        if (this.isExploring) {
          const nextDelay = stepData?.fallbackCause === 'api_error_429'
            ? Math.max(STEP_INTERVAL, OPENAI_RATE_LIMIT_BACKOFF_MS)
            : STEP_INTERVAL;
          if (nextDelay !== STEP_INTERVAL) {
            console.log(`OpenAI rate limit fallback; backing off next step for ${nextDelay}ms`);
          }
          this.explorationInterval = setTimeout(runExplorationStep, nextDelay);
        }
      } catch (error) {
        this.consecutiveStepErrors += 1;
        console.error('Exploration step error:', error);
        this.broadcast('error', { message: error.message });

        if (this.consecutiveStepErrors >= MAX_CONSECUTIVE_STEP_ERRORS) {
          console.error(
            `Stopping exploration after ${this.consecutiveStepErrors} consecutive step errors ` +
            `(threshold ${MAX_CONSECUTIVE_STEP_ERRORS}).`
          );
          await this.stopExploration({ waitForActiveStep: false });
          this.broadcast('error', {
            message: `Exploration halted after repeated errors (${this.consecutiveStepErrors}).`
          });
          return;
        }

        // Continue exploration even after errors
        if (this.isExploring) {
          this.explorationInterval = setTimeout(runExplorationStep, STEP_INTERVAL);
        }
      } finally {
        // runCommittedStep owns the active-step flags.
      }
    };

    // Start the first step
    this.explorationInterval = setTimeout(runExplorationStep, STEP_INTERVAL);
    return { success: true };
  }

  async stopExploration({ waitForActiveStep = true, flushPendingSave = true, skipLock = false } = {}) {
    if (!skipLock) {
      return this.withLifecycleLock('Stop exploration', () =>
        this.stopExploration({ waitForActiveStep, flushPendingSave, skipLock: true })
      );
    }

    if (this.explorationInterval) {
      clearTimeout(this.explorationInterval);
      this.explorationInterval = null;
    }
    this.isExploring = false;
    this.consecutiveStepErrors = 0;

    // Clear background save timer
    if (this.backgroundSaveTimer) {
      clearInterval(this.backgroundSaveTimer);
      this.backgroundSaveTimer = null;
    }

    if (this.gcInterval) {
      clearInterval(this.gcInterval);
      this.gcInterval = null;
    }

    if (waitForActiveStep) {
      const waitResult = await this.waitForStepToFinish('Stop exploration');
      if (waitResult.error) {
        this.broadcast('error', { message: waitResult.error });
        return waitResult;
      }
    }

    // Force save when stopping
    if (flushPendingSave && this.pendingSave) {
      await this.saveState(true);
    }

    if (this.agent) {
      await this.appendRunEvent('run_stopped', {
        stepCount: this.agent.stepCount,
        position: this.agent.currentPosition,
        reason: 'user_or_shutdown'
      });
      this.pendingSave = true;
      if (flushPendingSave) {
        await this.saveState(true);
      }
    }

    this.broadcast('exploration-stopped', {});
    return { success: true };
  }

  async takeSingleStep(options = {}) {
    if (!options.skipLock) {
      return this.withLifecycleLock('Take single step', () =>
        this.takeSingleStep({ ...options, skipLock: true })
      );
    }

    if (this.isExploring) {
      return { error: 'Cannot take step while exploration is running' };
    }
    if (this.isStepPipelineActive || this.agent?.isStepExecuting) {
      return { error: 'Cannot take step while another step is still finishing' };
    }

    if (!this.agent) {
      await this.initialize();
      this.activeEpoch += 1;
      await this.appendRunEvent('run_started', {
        manual: true,
        startPanoId: this.agent.currentPanoId,
        startPosition: this.agent.currentPosition
      });
      this.broadcast('exploration-started', {
        startLocation: START_LOCATION,
        timestamp: new Date().toISOString()
      });
    } else {
      this.activeEpoch += 1;
    }

    try {
      const { committed } = await this.runCommittedStep({ manual: true });
      if (!committed) {
        return { error: 'Step was not committed because exploration state changed' };
      }

      // Force save after manual step
      await this.saveState(true);

      this.consecutiveStepErrors = 0;
      this.broadcast('step-complete', {});
      return { success: true };
    } catch (error) {
      this.consecutiveStepErrors += 1;
      throw error;
    }
  }

  async saveNow(options = {}) {
    if (!options.skipLock) {
      return this.withLifecycleLock('Save now', () =>
        this.saveNow({ ...options, skipLock: true })
      );
    }

    const waitResult = await this.waitForStepToFinish('Save now');
    if (waitResult.error) {
      return waitResult;
    }

    await this.saveState(true);
    return { success: true, stepCount: this.agent?.stepCount || 0 };
  }

  async resetExploration(options = {}) {
    if (!options.skipLock) {
      return this.withLifecycleLock('Reset exploration', () =>
        this.resetExploration({ ...options, skipLock: true })
      );
    }

    const stopResult = await this.stopExploration({ skipLock: true });
    if (stopResult?.error) {
      return stopResult;
    }

    // Clean up all screenshots from the current run before resetting
    if (this.agent && this.agent.runId) {
      try {
        const runDir = path.join(ROOT_DIR, 'runs', 'shots', this.agent.runId);
        if (fs.existsSync(runDir)) {
          fs.rmSync(runDir, { recursive: true, force: true });
          console.log(`Cleaned up all screenshots for run ${this.agent.runId}`);
        }
      } catch (error) {
        console.error('Error cleaning up run screenshots:', error);
      }
    }

    // Clear all history and cache
    this.decisionHistory = [];
    this.screenshotCache.clear();
    this.lastEventSequence = 0;
    this.lastEventId = null;
    this.lastSnapshotSequence = 0;
    this.lastSnapshotAt = null;
    this.lastCompletedStep = 0;
    this.restoreSource = 'reset';
    this.activeEpoch += 1;
    this.activeStepId = null;
    this.stepStatus = 'idle';
    if (this.tileCache) {
      this.tileCache.clear();
    }

    // Reset the agent
    if (this.agent) {
      await this.agent.reset();
      this.lastSaveStep = 0;
      await this.appendRunEvent('run_reset', {
        snapshot: this.createSaveSnapshot()
      });
      this.pendingSave = true;
      this.allowEmptySaveOnce = true;
      await this.saveState(true);
    } else {
      await fsp.rm(this.getSavePath(), { force: true });
    }

    this.lastSaveStep = 0;
    this.pendingSave = false;

    // Create new persistent log file
    this.persistentLogger = this.createPersistentLogger();

    this.broadcast('exploration-reset', {});
    return { success: true };
  }

  addToHistory(stepData) {
    // stepData.screenshots already contains thumbnail URLs without base64
    // Just store it as-is since base64 was already removed in explorationAgent

    // Add to memory history
    this.decisionHistory.push(stepData);

    // Cap memory usage and clean up old screenshots
    if (this.decisionHistory.length > this.maxHistoryInMemory) {
      const removedEntry = this.decisionHistory.shift();
      // Clean up old screenshot files from disk
      this.cleanupOldScreenshots(removedEntry);
    }

    // Write to persistent log (queued async to preserve ordering without blocking)
    const logData = {
      ...stepData,
      timestamp: stepData.timestamp || new Date().toISOString()
    };
    const logLine = JSON.stringify(logData) + '\n';
    this._logQueue = this._logQueue.then(async () => {
      await this.enforcePersistentLogRetention();
      const logPath = this.persistentLogger;
      await fsp.appendFile(logPath, logLine);
    }).catch(err => {
      console.error('Failed to write persistent log:', err);
    });
  }

  cacheScreenshots(stepData) {
    if (stepData.screenshots) {
      // Only cache URLs, not base64 data
      const urls = stepData.screenshots.map(s => s.filename);
      this.screenshotCache.set(stepData.stepCount, urls);

      // Aggressively prune old screenshots
      if (this.screenshotCache.size > this.cacheSize) {
        const oldestStep = Math.min(...this.screenshotCache.keys());
        this.screenshotCache.delete(oldestStep);
      }
    }
  }

  cleanupOldScreenshots(entry) {
    if (!entry || !entry.screenshots || !this.agent) return;

    try {
      // Get the screenshot directory for this step
      const stepDir = path.join(
        ROOT_DIR,
        'runs',
        'shots',
        this.agent.runId,
        entry.stepCount.toString()
      );

      // Check if directory exists before attempting deletion
      if (fs.existsSync(stepDir)) {
        // Remove the entire step directory
        fs.rmSync(stepDir, { recursive: true, force: true });
        console.log(`Cleaned up screenshots for step ${entry.stepCount}`);
      }
    } catch (error) {
      console.error(`Error cleaning up screenshots for step ${entry.stepCount}:`, error);
    }
  }

  getRecentHistory() {
    // Return last N entries for new connections
    return this.decisionHistory.slice(-DECISION_HISTORY_LIMIT);
  }

  getFullPathForInitialLoad() {
    if (!this.agent || !this.agent.coverage || this.agent.coverage.graph.size === 0) {
      return [];
    }

    const now = Date.now();
    const cacheTtlMs = 30 * 1000;
    if (
      this.fullPathCache.fullPath &&
      this.fullPathCache.stepCount === this.agent.stepCount &&
      now - this.fullPathCache.generatedAt < cacheTtlMs
    ) {
      return this.fullPathCache.fullPath;
    }

    const originalPath = Array.from(this.agent.coverage.graph.entries())
      .filter(([id, node]) => node.timestamp)
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .map(([id, node]) => ({
        lat: node.lat,
        lng: node.lng,
        panoId: id,
        timestamp: node.timestamp
      }));

    const fullPath = this.simplifyPath(originalPath);
    this.fullPathCache = {
      stepCount: this.agent.stepCount,
      generatedAt: now,
      fullPath
    };
    return fullPath;
  }

  getCurrentState({ includeFullPath = true } = {}) {
    if (!this.agent) {
      return {
        isExploring: false,
        position: START_LOCATION,
        panoId: START_PANO_ID,
        stats: { locationsVisited: 0, distanceTraveled: 0 },
        stepCount: 0,
        runId: null,
        activeEpoch: this.activeEpoch,
        stepStatus: this.stepStatus,
        activeStepId: this.activeStepId,
        lastEventSequence: this.lastEventSequence,
        lastSnapshotSequence: this.lastSnapshotSequence,
        restoreSource: this.restoreSource,
        recentHistory: this.getRecentHistory()
      };
    }

    const state = {
      isExploring: this.isExploring,
      position: this.agent.currentPosition,
      panoId: this.agent.currentPanoId,
      stats: this.agent.coverage ? this.agent.coverage.getStats() : {},
      stepCount: this.agent.stepCount,
      runId: this.agent.runId,
      activeEpoch: this.activeEpoch,
      stepStatus: this.stepStatus,
      activeStepId: this.activeStepId,
      lastEventSequence: this.lastEventSequence,
      lastSnapshotSequence: this.lastSnapshotSequence,
      restoreSource: this.restoreSource,
      recentHistory: this.getRecentHistory()
    };

    if (includeFullPath) {
      state.fullPath = this.getFullPathForInitialLoad();
    }

    return state;
  }

  getMetrics() {
    const stats = this.agent && this.agent.coverage
      ? this.agent.coverage.getStats()
      : { locationsVisited: 0, distanceTraveled: 0, pathLength: 0 };
    const lastSnapshotAgeSec = this.lastSnapshotAt
      ? Math.floor((Date.now() - this.lastSnapshotAt) / 1000)
      : null;
    return {
      uptimeSec: Math.floor(process.uptime()),
      isExploring: this.isExploring,
      runId: this.agent ? this.agent.runId : null,
      activeEpoch: this.activeEpoch,
      stepStatus: this.stepStatus,
      activeStepId: this.activeStepId,
      lastEventSequence: this.lastEventSequence,
      lastSnapshotSequence: this.lastSnapshotSequence,
      lastCompletedStep: this.lastCompletedStep,
      lastSnapshotAgeSec,
      consecutiveStepErrors: this.consecutiveStepErrors,
      restoreSource: this.restoreSource,
      stepCount: this.agent ? this.agent.stepCount : 0,
      locationsVisited: stats.locationsVisited,
      distanceTraveled: stats.distanceTraveled,
      pathLength: stats.pathLength
    };
  }

  async renderTile(z, x, y) {
    if (!this.agent || !this.agent.coverage) {
      return emptyTilePng();
    }

    const version = getArchiveVersion(this.agent);
    const cacheKey = `${z}/${x}/${y}@v${version}`;
    const cached = this.tileCache.get(cacheKey);
    if (cached) return cached;

    const runId = this.agent.runId || 'current';
    const filePath = path.join(DATA_DIR, 'tiles', runId, String(version), String(z), String(x), `${y}.png`);
    try {
      const data = fs.readFileSync(filePath);
      cacheSet(this.tileCache, cacheKey, data);
      return data;
    } catch {
      const buf = await drawArchiveTile(this.agent, z, x, y);
      fsp.mkdir(path.dirname(filePath), { recursive: true })
        .then(() => fsp.writeFile(filePath, buf))
        .catch(() => {});
      cacheSet(this.tileCache, cacheKey, buf);
      return buf;
    }
  }

  /**
   * Centralized path simplification method
   * Can be disabled or tuned via environment variables
   */
  simplifyPath(originalPath) {
    // If simplification is disabled, return original path
    if (!PATH_SIMPLIFICATION.enabled) {
      console.log(`📍 Path simplification disabled: ${originalPath.length} points sent as-is`);
      return originalPath;
    }

    // Apply simplification with configured settings
    const simplifiedPath = simplifyPathWithTiers(originalPath, {
      recentThreshold: PATH_SIMPLIFICATION.recentThreshold,
      mediumThreshold: PATH_SIMPLIFICATION.mediumThreshold,
      recentEpsilon: PATH_SIMPLIFICATION.recentEpsilon,
      mediumEpsilon: PATH_SIMPLIFICATION.mediumEpsilon,
      oldEpsilon: PATH_SIMPLIFICATION.oldEpsilon
    });

    // Log statistics
    const stats = getSimplificationStats(originalPath, simplifiedPath);
    console.log(`📍 Path simplification: ${stats.originalCount} → ${stats.simplifiedCount} points (${stats.reductionPercent}% reduction, ${(stats.sizeSaved/1024).toFixed(1)}KB saved)`);

    return simplifiedPath;
  }

  broadcast(event, data) {
    this.emit(event, data);
  }

  addClient(socket) {
    this.connectedClients.add(socket.id);
    console.log(`Client connected: ${socket.id}. Total clients: ${this.connectedClients.size}`);

    // Send lightweight state immediately so maps initialize before the large path payload is prepared.
    socket.emit('initial-state', {
      ...this.getCurrentState({ includeFullPath: false }),
      startLocation: START_LOCATION,
      startPanoId: START_PANO_ID,
      recentHistory: this.getRecentHistory(),
      connectedClients: this.connectedClients.size
    });

    setTimeout(() => {
      if (!socket.connected) return;
      try {
        const fullPath = this.getFullPathForInitialLoad();
        if (fullPath.length > 0) {
          socket.emit('path-state', {
            runId: this.agent?.runId || null,
            sequence: this.lastEventSequence,
            pathSequence: this.lastEventSequence,
            stepCount: this.agent?.stepCount || 0,
            fullPath
          });
        }
      } catch (error) {
        console.error('Failed to prepare path for client:', error);
        socket.emit('error', { message: 'Failed to load minimap path' });
      }
    }, 100);
  }

  removeClient(socketId) {
    this.connectedClients.delete(socketId);
    console.log(`Client disconnected: ${socketId}. Total clients: ${this.connectedClients.size}`);

    // Broadcast updated client count
    this.broadcast('client-count', { count: this.connectedClients.size });
  }
}

// Initialize global exploration
const globalExploration = IS_WORKER_PROCESS
  ? new GlobalExploration({ emit: sendWorkerBroadcast })
  : new WorkerSupervisor({
      onBroadcast: (event, data) => io.emit(event, data)
    });

// Tile rendering helpers
function lonLatToWorldPixels(lng, lat, z) {
  const tile = 256;
  const scale = tile * Math.pow(2, z);
  const x = (lng + 180) / 360 * scale;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return [x, y];
}

function getArchivedCount(agent) {
  if (!agent || !agent.coverage) return 0;
  const len = agent.coverage.path.length;
  return Math.max(0, len - TILE_TAIL_POINTS);
}

function getArchiveVersion(agent) {
  const archived = getArchivedCount(agent);
  if (archived <= 0) return 0;
  return Math.floor(archived / Math.max(1, TILE_VERSION_STEP));
}

async function drawArchiveTile(agent, z, x, y) {
  const createCanvas = await getCreateCanvas();
  const archivedCount = getArchivedCount(agent);
  if (archivedCount < 2) {
    const c = createCanvas(256, 256);
    return c.toBuffer('image/png');
  }
  const pathArr = agent.coverage.path; // [{lat,lng,...}]
  const canvas = createCanvas(256, 256);
  const ctx = canvas.getContext('2d');
  // Scale stroke width with zoom so lines remain visible when zoomed in
  function strokeWidthForZoom(zoom) {
    if (zoom >= 20) return 12;
    if (zoom >= 19) return 10;
    if (zoom >= 18) return 8;
    if (zoom >= 17) return 6;
    if (zoom >= 16) return 4;
    if (zoom >= 15) return 3;
    return 2;
  }
  const strokeWidth = strokeWidthForZoom(z);
  ctx.lineWidth = strokeWidth;
  ctx.strokeStyle = '#f44336';
  ctx.globalAlpha = 0.8;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const tileOriginX = x * 256;
  const tileOriginY = y * 256;
  const margin = strokeWidth;
  const minPixelStep = z <= 9 ? 0.75 : z <= 12 ? 0.5 : 0.25;
  const minPixelStepSq = minPixelStep * minPixelStep;

  let started = false;
  let lastDrawn = null;
  let lastVisible = false;
  let segmentsDrawn = 0;
  ctx.beginPath();

  for (let i = 0; i < archivedCount; i += 1) {
    const point = pathArr[i];
    if (!point) continue;

    const [worldX, worldY] = lonLatToWorldPixels(point.lng, point.lat, z);
    const px = worldX - tileOriginX;
    const py = worldY - tileOriginY;
    const visible = px >= -margin && px <= 256 + margin && py >= -margin && py <= 256 + margin;

    if (!started) {
      ctx.moveTo(px, py);
      started = true;
      lastDrawn = [px, py];
      lastVisible = visible;
      continue;
    }

    const dx = px - lastDrawn[0];
    const dy = py - lastDrawn[1];
    const movedEnough = dx * dx + dy * dy >= minPixelStepSq;
    if (visible || lastVisible || movedEnough || i === archivedCount - 1) {
      ctx.lineTo(px, py);
      lastDrawn = [px, py];
      segmentsDrawn += 1;
    }
    lastVisible = visible;
  }

  if (segmentsDrawn > 0) {
    ctx.stroke();
  }

  return canvas.toBuffer('image/png');
}

// Simple LRU eviction for tile cache
function cacheSet(map, key, value) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size > TILE_MAX_CACHE) {
    const firstKey = map.keys().next().value;
    map.delete(firstKey);
  }
}

function emptyTilePng() {
  return EMPTY_TILE_PNG;
}

function toTileBuffer(tile) {
  if (Buffer.isBuffer(tile)) return tile;
  if (tile?.type === 'Buffer' && Array.isArray(tile.data)) return Buffer.from(tile.data);
  if (ArrayBuffer.isView(tile)) return Buffer.from(tile.buffer, tile.byteOffset, tile.byteLength);
  if (tile instanceof ArrayBuffer) return Buffer.from(tile);
  return emptyTilePng();
}

// Raster tiles for archived path
app.get('/tiles/:z/:x/:y.png', async (req, res) => {
  const z = parseInt(req.params.z, 10);
  const x = parseInt(req.params.x, 10);
  const y = parseInt(req.params.y, 10);
  const maxTile = Math.pow(2, z);
  if (
    !Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y) ||
    z < 0 || z > 22 || x < 0 || y < 0 || x >= maxTile || y >= maxTile
  ) {
    return res.status(400).send('bad tile');
  }

  try {
    const tile = await globalExploration.renderTile(z, x, y);
    const body = toTileBuffer(tile);
    res
      .set('Cache-Control', 'public, max-age=31536000, immutable')
      .type('image/png')
      .send(body);
  } catch (error) {
    console.warn(`Failed to render archive tile ${z}/${x}/${y}: ${error.message}`);
    res
      .set('Cache-Control', 'public, max-age=30')
      .type('image/png')
      .send(emptyTilePng());
  }
});

// Lightweight health and metrics endpoints
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/metrics', (req, res) => {
  res.json(globalExploration.getMetrics());
});

const ADMIN_TOKEN_TTL_MS = 60 * 60 * 1000;

function signAdminTokenBody(body) {
  const controlPassword = process.env.CONTROL_PASSWORD;
  if (!controlPassword) return null;
  return crypto
    .createHmac('sha256', controlPassword)
    .update(body)
    .digest('base64url');
}

function createAdminToken() {
  const body = Buffer.from(JSON.stringify({
    prefix: 'admin',
    timestamp: Date.now()
  })).toString('base64url');
  const signature = signAdminTokenBody(body);
  return `${body}.${signature}`;
}

// Helper function to verify admin token
function verifyAdminToken(token) {
  if (!token || !process.env.CONTROL_PASSWORD) return false;

  try {
    const [body, signature] = token.split('.');
    if (!body || !signature) return false;

    const expectedSignature = signAdminTokenBody(body);
    const provided = Buffer.from(signature, 'base64url');
    const expected = Buffer.from(expectedSignature, 'base64url');
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      return false;
    }

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.prefix !== 'admin' || !Number.isFinite(payload.timestamp)) {
      return false;
    }

    const tokenAge = Date.now() - payload.timestamp;
    return tokenAge >= 0 && tokenAge < ADMIN_TOKEN_TTL_MS;
  } catch {
    return false;
  }
}

function sendWorkerMessage(message) {
  if (typeof process.send === 'function') {
    try {
      process.send(message);
    } catch (error) {
      console.error('Failed to send worker IPC message:', error.message);
    }
  }
}

const WORKER_TELEMETRY_FLUSH_MS = parseIntOr(process.env.WORKER_TELEMETRY_FLUSH_MS, 1000);
let workerTelemetryTimer = null;

function flushWorkerTelemetry() {
  if (!IS_WORKER_PROCESS) return;
  if (workerTelemetryTimer) {
    clearTimeout(workerTelemetryTimer);
    workerTelemetryTimer = null;
  }
  sendWorkerState(false);
  sendWorkerMetrics();
}

function scheduleWorkerTelemetry({ immediate = false } = {}) {
  if (!IS_WORKER_PROCESS) return;
  if (immediate) {
    flushWorkerTelemetry();
    return;
  }
  if (workerTelemetryTimer) return;
  workerTelemetryTimer = setTimeout(() => {
    workerTelemetryTimer = null;
    sendWorkerState(false);
    sendWorkerMetrics();
  }, WORKER_TELEMETRY_FLUSH_MS);
}

function sendWorkerState(includeFullPath = false) {
  if (!IS_WORKER_PROCESS) return;
  try {
    sendWorkerMessage({
      kind: 'state',
      data: globalExploration.getCurrentState({ includeFullPath })
    });
  } catch (error) {
    sendWorkerMessage({
      kind: 'log',
      level: 'error',
      message: `Failed to send worker state: ${error.message}`
    });
  }
}

function sendWorkerMetrics() {
  if (!IS_WORKER_PROCESS) return;
  try {
    sendWorkerMessage({
      kind: 'metrics',
      data: globalExploration.getMetrics()
    });
  } catch (error) {
    sendWorkerMessage({
      kind: 'log',
      level: 'error',
      message: `Failed to send worker metrics: ${error.message}`
    });
  }
}

function sendWorkerBroadcast(name, data) {
  sendWorkerMessage({ kind: 'broadcast', name, data });
  scheduleWorkerTelemetry();
}

async function bootWorker({ autoRestore = true, autoStart = false } = {}) {
  let restoreResult = null;
  let startResult = null;
  const savePath = globalExploration.getSavePath();
  const hasSave = fs.existsSync(savePath);

  if (autoRestore && hasSave) {
    restoreResult = await globalExploration.loadState();
  }

  if (autoStart && (!restoreResult || !restoreResult.error)) {
    startResult = await globalExploration.startExploration();
  }

  scheduleWorkerTelemetry();
  return {
    success: !(restoreResult?.error || startResult?.error),
    savePath,
    restored: restoreResult || null,
    started: startResult || null
  };
}

async function shutdownWorkerRuntime() {
  const stopResult = await globalExploration.stopExploration();
  if (!stopResult?.error && (globalExploration.pendingSave || globalExploration.hasMeaningfulAgentState())) {
    await globalExploration.saveState(true);
  }
  await globalExploration._logQueue;
  if (globalExploration.agent) {
    await globalExploration.agent.close();
  }
  return stopResult?.error ? stopResult : { success: true };
}

async function dispatchWorkerCommand(command, payload = {}) {
  switch (command) {
    case 'boot':
      return bootWorker(payload);
    case 'start':
      return globalExploration.startExploration();
    case 'stop':
      return globalExploration.stopExploration(payload);
    case 'step':
      return globalExploration.takeSingleStep();
    case 'reset':
      return globalExploration.resetExploration();
    case 'load':
      return globalExploration.loadState();
    case 'saveNow':
      return globalExploration.saveNow();
    case 'getState':
      return globalExploration.getCurrentState({
        includeFullPath: payload.includeFullPath !== false
      });
    case 'getFullPath':
      return { fullPath: globalExploration.getFullPathForInitialLoad() };
    case 'getMetrics':
      return globalExploration.getMetrics();
    case 'renderTile':
      return globalExploration.renderTile(payload.z, payload.x, payload.y);
    case 'shutdown':
      return shutdownWorkerRuntime();
    default:
      throw new Error(`Unknown worker command: ${command}`);
  }
}

function runWorkerProcess() {
  const heartbeatIntervalMs = parseIntOr(process.env.WORKER_HEARTBEAT_INTERVAL_MS, 5000);
  const heartbeatTimer = setInterval(() => {
    sendWorkerMessage({
      kind: 'heartbeat',
      data: { pid: process.pid, timestamp: new Date().toISOString() },
      metrics: globalExploration.getMetrics()
    });
  }, heartbeatIntervalMs);

  process.on('message', async (message) => {
    if (!message || message.kind !== 'request') return;

    try {
      const result = await dispatchWorkerCommand(message.command, message.payload || {});
      sendWorkerMessage({
        kind: 'response',
        requestId: message.requestId,
        ok: true,
        result
      });
      scheduleWorkerTelemetry({ immediate: true });

      if (message.command === 'shutdown') {
        clearInterval(heartbeatTimer);
        if (workerTelemetryTimer) {
          clearTimeout(workerTelemetryTimer);
          workerTelemetryTimer = null;
        }
        setTimeout(() => process.exit(result?.error ? 1 : 0), 25);
      }
    } catch (error) {
      sendWorkerMessage({
        kind: 'response',
        requestId: message.requestId,
        ok: false,
        error: error.message
      });
    }
  });

  process.on('SIGTERM', async () => {
    clearInterval(heartbeatTimer);
    if (workerTelemetryTimer) {
      clearTimeout(workerTelemetryTimer);
      workerTelemetryTimer = null;
    }
    const result = await shutdownWorkerRuntime().catch(error => ({ error: error.message }));
    process.exit(result?.error ? 1 : 0);
  });

  process.on('SIGINT', async () => {
    clearInterval(heartbeatTimer);
    if (workerTelemetryTimer) {
      clearTimeout(workerTelemetryTimer);
      workerTelemetryTimer = null;
    }
    const result = await shutdownWorkerRuntime().catch(error => ({ error: error.message }));
    process.exit(result?.error ? 1 : 0);
  });

  sendWorkerMessage({
    kind: 'heartbeat',
    data: { pid: process.pid, timestamp: new Date().toISOString() },
    metrics: globalExploration.getMetrics()
  });
}

// Socket.io connection handling
if (IS_WORKER_PROCESS) {
  runWorkerProcess();
} else {
io.on('connection', (socket) => {
  globalExploration.addClient(socket);

  // Control operations require authentication
  socket.on('start-exploration', async (data) => {
    // Check for admin token
    const token = data?.token;
    if (!verifyAdminToken(token)) {
      socket.emit('error', { message: 'Admin authentication required' });
      return;
    }

    try {
      const result = await globalExploration.startExploration();
      if (result.error) {
        socket.emit('error', { message: result.error });
      }
    } catch (error) {
      console.error('Start exploration error:', error);
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('stop-exploration', async (data) => {
    // Check for admin token
    const token = data?.token;
    if (!verifyAdminToken(token)) {
      socket.emit('error', { message: 'Admin authentication required' });
      return;
    }

    try {
      const result = await globalExploration.stopExploration();
      if (result?.error) {
        socket.emit('error', { message: result.error });
      }
    } catch (error) {
      console.error('Stop exploration error:', error);
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('take-single-step', async (data) => {
    // Check for admin token
    const token = data?.token;
    if (!verifyAdminToken(token)) {
      socket.emit('error', { message: 'Admin authentication required' });
      return;
    }

    try {
      const result = await globalExploration.takeSingleStep();
      if (result.error) {
        socket.emit('error', { message: result.error });
      }
    } catch (error) {
      console.error('Single step error:', error);
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('reset-exploration', async (data) => {
    // Check for admin token
    const token = data?.token;
    if (!verifyAdminToken(token)) {
      socket.emit('error', { message: 'Admin authentication required' });
      return;
    }

    try {
      const result = await globalExploration.resetExploration();
      if (result?.error) {
        socket.emit('error', { message: result.error });
      }
    } catch (error) {
      console.error('Reset exploration error:', error);
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('load-save', async (data) => {
    // Check for admin token
    const token = data?.token;
    if (!verifyAdminToken(token)) {
      socket.emit('error', { message: 'Admin authentication required' });
      return;
    }

    try {
      console.log('📂 User requested to load saved state...');
      const result = await globalExploration.loadState();

      if (result.error) {
        console.log(`❌ Failed to load state: ${result.error}`);
        socket.emit('error', { message: result.error });
      } else {
        console.log(`✅ Successfully loaded state: ${result.stepCount} steps, ${result.locationsVisited} locations, ${result.graphSize} nodes`);
        socket.emit('save-loaded', result);
      }
    } catch (error) {
      console.error('Load save error:', error);
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('save-now', async (data) => {
    const token = data?.token;
    if (!verifyAdminToken(token)) {
      socket.emit('error', { message: 'Admin authentication required' });
      return;
    }
    try {
      const result = await globalExploration.saveNow();
      if (result?.error) {
        socket.emit('error', { message: result.error });
      } else {
        socket.emit('save-complete', { success: true, stepCount: result.stepCount });
      }
    } catch (e) {
      console.error('Save now error:', e);
      socket.emit('error', { message: 'Failed to save state' });
    }
  });

  socket.on('disconnect', () => {
    globalExploration.removeClient(socket.id);
  });
});

// Listen on all network interfaces (0.0.0.0) for production deployments
const HOST = '0.0.0.0'; // Always bind to 0.0.0.0 for containerized environments
server.listen(PORT, HOST, async () => {
  console.log(`🚀 Server listening on ${HOST}:${PORT}`);
  console.log(`📍 Starting location: ${START_LOCATION.lat}, ${START_LOCATION.lng}`);
  console.log(`⏱️  Step interval: ${STEP_INTERVAL}ms (min floor: ${minStepInterval}ms)`);
  if (STEP_INTERVAL_CLAMPED) {
    console.log(`⚠️  STEP_INTERVAL_MS=${requestedStepInterval}ms was below floor; clamped to ${STEP_INTERVAL}ms`);
  }
  console.log(`💾 Save interval: Every ${SAVE_INTERVAL} steps`);
  console.log(`💾 Initial force-save steps: ${INITIAL_FORCE_SAVE_STEPS}`);
  console.log(`💾 Background save interval: ${BACKGROUND_SAVE_INTERVAL_MS}ms`);
  console.log(`📜 Decision history limit: ${DECISION_HISTORY_LIMIT} entries`);
  console.log(`🗺️  Path simplification: ${PATH_SIMPLIFICATION.enabled ? `Enabled (epsilon: ${PATH_SIMPLIFICATION.recentEpsilon}/${PATH_SIMPLIFICATION.mediumEpsilon}/${PATH_SIMPLIFICATION.oldEpsilon})` : 'Disabled'}`);
  console.log(`🚧 Dead-end recovery: ${process.env.MAX_DEAD_END_DISTANCE || 200}m max distance`);
  console.log(`🔐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔑 Google Maps API: ${process.env.GOOGLE_MAPS_API_KEY ? 'Configured' : 'NOT CONFIGURED'}`);
  console.log(`🔑 OpenAI API: ${process.env.OPENAI_API_KEY ? 'Configured' : 'NOT CONFIGURED'}`);
  console.log(`🔑 Admin Password: ${process.env.CONTROL_PASSWORD ? 'Configured' : 'NOT CONFIGURED'}`);
  console.log(`💾 Data directory: ${DATA_DIR}`);

  try {
    const autoSavePath = globalExploration.getSavePath();
    const hasSave = fs.existsSync(autoSavePath);
    const shouldAutoStart = process.env.NODE_ENV === 'production' && hasSave;
    console.log(`👷 Starting exploration worker (autoStart=${shouldAutoStart})`);
    const workerBoot = await globalExploration.start({
      autoRestore: true,
      autoStart: shouldAutoStart
    });
    if (workerBoot?.error) {
      console.error('❌ Worker boot failed:', workerBoot.error);
    } else if (shouldAutoStart) {
      console.log('▶️  Exploration worker auto-started from saved state');
    } else if (!hasSave) {
      console.log('📄 No save file found at', autoSavePath, '— waiting for manual start');
    }
  } catch (error) {
    console.error('❌ Worker startup error:', error);
  }
});

// Graceful shutdown handling
let shutdownInProgress = false;
async function gracefulShutdown(signal) {
  if (shutdownInProgress) {
    console.log(`${signal} received while shutdown is already in progress.`);
    return;
  }
  shutdownInProgress = true;

  console.log(`${signal} received, saving state and shutting down...`);
  const stopResult = await globalExploration.shutdown();
  process.exit(stopResult?.error ? 1 : 0);
}

process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM').catch(error => {
    console.error('Graceful SIGTERM shutdown failed:', error);
    process.exit(1);
  });
});

process.on('SIGINT', () => {
  gracefulShutdown('SIGINT').catch(error => {
    console.error('Graceful SIGINT shutdown failed:', error);
    process.exit(1);
  });
});
}

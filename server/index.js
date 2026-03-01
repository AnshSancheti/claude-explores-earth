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
import { createCanvas } from 'canvas';
import { verifySignature } from './utils/urlSigner.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');

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
    // Generate a simple session token (in production, use proper JWT)
    const token = Buffer.from(`admin:${Date.now()}`).toString('base64');
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
const STEP_INTERVAL = parseInt(process.env.STEP_INTERVAL_MS) || 5000;
const DECISION_HISTORY_LIMIT = parseInt(process.env.DECISION_HISTORY_LIMIT) || 20;
const SAVE_INTERVAL = parseInt(process.env.SAVE_INTERVAL) || 500; // Save every N steps
const MAX_CONSECUTIVE_STEP_ERRORS = parseInt(process.env.MAX_CONSECUTIVE_STEP_ERRORS || '25', 10);
const TILE_TAIL_POINTS = parseInt(process.env.TILE_RECENT_TAIL_POINTS) || 1500; // recent points kept as vector
const TILE_MAX_CACHE = parseInt(process.env.TILE_MAX_CACHE) || 256;
const TILE_VERSION_STEP = parseInt(process.env.TILE_VERSION_STEP) || 1000; // archive version increments every N archived points

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

// Global exploration state
class GlobalExploration {
  constructor() {
    this.agent = null;
    this.isExploring = false;
    this.explorationInterval = null;
    this.connectedClients = new Set();
    this.decisionHistory = [];
    this.screenshotCache = new Map(); // Cache only screenshot URLs, not data
    this.logger = new Logger();
    this.persistentLogger = this.createPersistentLogger();
    // Keep enough history for new clients to see recent decisions with screenshots
    this.maxHistoryInMemory = Math.max(DECISION_HISTORY_LIMIT * 2, 50); 
    this.cacheSize = this.maxHistoryInMemory; // Match cache to history size
    
    // Save optimization - only save periodically
    this.saveInterval = SAVE_INTERVAL; // Save every N steps (configurable)
    this.lastSaveStep = 0;
    this.pendingSave = false;
    this.backgroundSaveTimer = null;
    this.backgroundSaveInterval = 5 * 60 * 1000; // 5 minutes in milliseconds
    // Tile cache for archived path rendering
    this.tileCache = new Map(); // key: `${z}/${x}/${y}@${archivedCount}` -> Buffer
    this.consecutiveStepErrors = 0;
  }

  createPersistentLogger() {
    const logsDir = path.join(ROOT_DIR, 'runs', 'persistent_logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = path.join(logsDir, `exploration-${timestamp}.jsonl`);
    return logPath;
  }
  
  // Save current state to a JSON file
  async saveState(force = false) {
    if (!this.agent || !this.agent.coverage) return;
    
    // Only save if forced or enough steps have passed
    if (!force && (this.agent.stepCount - this.lastSaveStep) < this.saveInterval) {
      this.pendingSave = true;
      return;
    }
    
    const saveDir = path.join(ROOT_DIR, 'runs', 'saves');
    if (!fs.existsSync(saveDir)) {
      fs.mkdirSync(saveDir, { recursive: true });
    }
    
    const saveData = {
      runId: this.agent.runId,
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
      recentHistory: this.agent.coverage.recentHistory,
      decisionHistory: this.decisionHistory.slice(-DECISION_HISTORY_LIMIT)
      // Path removed - will be reconstructed from graph
    };
    
    // Write to temp file first, then rename (atomic write)
    const tempPath = path.join(saveDir, 'current-run.tmp.json');
    const finalPath = path.join(saveDir, 'current-run.json');
    
    try {
      fs.writeFileSync(tempPath, JSON.stringify(saveData, null, 2));
      // Atomic rename
      fs.renameSync(tempPath, finalPath);
      console.log(`State saved: ${this.agent.stepCount} steps, ${Object.keys(saveData.graph).length} nodes`);
      this.lastSaveStep = this.agent.stepCount;
      this.pendingSave = false;
    } catch (error) {
      console.error('Failed to save state:', error);
      // Clean up temp file if it exists
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    }
  }
  
  // Load state from save file
  async loadState() {
    const savePath = path.join(ROOT_DIR, 'runs', 'saves', 'current-run.json');
    
    if (!fs.existsSync(savePath)) {
      console.log('📄 No save file found at:', savePath);
      return { error: 'No save file found' };
    }
    
    console.log('📄 Loading save file from:', savePath);
    try {
      const saveData = JSON.parse(fs.readFileSync(savePath, 'utf8'));
      console.log(`📊 Save file details: runId=${saveData.runId}, stepCount=${saveData.stepCount}, lastUpdated=${saveData.lastUpdated}`);
      
      // Stop current exploration
      await this.stopExploration();
      
      // Initialize agent if needed
      if (!this.agent) {
        await this.initialize();
      }
      
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
      
      // Reconstruct path from graph for minimap (all nodes in graph are visited)
      const originalPath = Array.from(this.agent.coverage.graph.entries())
        .filter(([id, node]) => node.timestamp)  // All have timestamps
        .sort((a, b) => a[1].timestamp - b[1].timestamp)
        .map(([id, node]) => ({
          lat: node.lat,
          lng: node.lng,
          panoId: id,
          timestamp: node.timestamp
        }));
      
      // Use the same simplification logic as initial state
      const simplifiedPath = this.simplifyPath(originalPath);
      
      // Clear in-memory tile cache; tiles will be re-generated for this run/version
      if (this.tileCache) {
        this.tileCache.clear();
      }

      // Broadcast restored state to all clients
      this.broadcast('state-loaded', {
        stepCount: this.agent.stepCount,
        position: this.agent.currentPosition,
        panoId: this.agent.currentPanoId,
        stats: this.agent.coverage.getStats(),
        fullPath: simplifiedPath,  // Send simplified path for minimap
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
        graphSize: this.agent.coverage.graph.size
      };
      
    } catch (error) {
      console.error('Failed to load state:', error);
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

  async startExploration() {
    if (this.isExploring) {
      return { error: 'Exploration already in progress' };
    }

    this.isExploring = true;
    
    if (!this.agent) {
      await this.initialize();
    }
    
    // Force garbage collection periodically if available (V8 only)
    if (global.gc) {
      setInterval(() => {
        if (global.gc) {
          console.log('Running garbage collection...');
          global.gc();
        }
      }, 60000); // Every minute
    }

    // Start background save timer (saves every 5 minutes as backup)
    if (this.backgroundSaveTimer) {
      clearInterval(this.backgroundSaveTimer);
    }
    this.backgroundSaveTimer = setInterval(async () => {
      if (this.pendingSave && this.agent) {
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
      
      try {
        const stepData = await this.agent.exploreStep();
        this.consecutiveStepErrors = 0;
        this.addToHistory(stepData);
        this.cacheScreenshots(stepData);
        
        // Save state periodically (not every step)
        await this.saveState();
        
        // Schedule next step
        if (this.isExploring) {
          this.explorationInterval = setTimeout(runExplorationStep, STEP_INTERVAL);
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
          await this.stopExploration();
          this.broadcast('error', {
            message: `Exploration halted after repeated errors (${this.consecutiveStepErrors}).`
          });
          return;
        }
        
        // Continue exploration even after errors
        if (this.isExploring) {
          this.explorationInterval = setTimeout(runExplorationStep, STEP_INTERVAL);
        }
      }
    };
    
    // Start the first step
    this.explorationInterval = setTimeout(runExplorationStep, STEP_INTERVAL);
    return { success: true };
  }

  async stopExploration() {
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
    
    // Force save when stopping
    if (this.pendingSave) {
      await this.saveState(true);
    }
    
    this.broadcast('exploration-stopped', {});
  }

  async takeSingleStep() {
    if (this.isExploring) {
      return { error: 'Cannot take step while exploration is running' };
    }

    if (!this.agent) {
      await this.initialize();
      this.broadcast('exploration-started', {
        startLocation: START_LOCATION,
        timestamp: new Date().toISOString()
      });
    }

    const stepData = await this.agent.exploreStep();
    this.addToHistory(stepData);
    this.cacheScreenshots(stepData);
    
    // Force save after manual step
    await this.saveState(true);
    
    this.broadcast('step-complete', {});
    return { success: true };
  }

  async resetExploration() {
    await this.stopExploration();
    
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
    if (this.tileCache) {
      this.tileCache.clear();
    }
    
    // Reset the agent
    if (this.agent) {
      await this.agent.reset();
    }
    
    // Create new persistent log file
    this.persistentLogger = this.createPersistentLogger();
    
    this.broadcast('exploration-reset', {});
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
    
    // Write to persistent log
    const logData = {
      ...stepData,
      timestamp: stepData.timestamp || new Date().toISOString()
    };
    fs.appendFileSync(this.persistentLogger, JSON.stringify(logData) + '\n');
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

  getCurrentState() {
    if (!this.agent) {
      return {
        isExploring: false,
        position: START_LOCATION,
        panoId: START_PANO_ID,
        stats: { locationsVisited: 0, distanceTraveled: 0 },
        stepCount: 0
      };
    }
    
    // Reconstruct path from graph for initial load (all nodes are visited)
    let fullPath = [];
    if (this.agent.coverage && this.agent.coverage.graph.size > 0) {
      const originalPath = Array.from(this.agent.coverage.graph.entries())
        .filter(([id, node]) => node.timestamp)
        .sort((a, b) => a[1].timestamp - b[1].timestamp)
        .map(([id, node]) => ({
          lat: node.lat,
          lng: node.lng,
          panoId: id,
          timestamp: node.timestamp
        }));
      
      // Use centralized simplification method
      fullPath = this.simplifyPath(originalPath);
    }
    
    return {
      isExploring: this.isExploring,
      position: this.agent.currentPosition,
      panoId: this.agent.currentPanoId,
      stats: this.agent.coverage ? this.agent.coverage.getStats() : {},
      stepCount: this.agent.stepCount,
      fullPath  // Only sent on initial connection
    };
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
    io.emit(event, data);
  }

  addClient(socket) {
    this.connectedClients.add(socket.id);
    console.log(`Client connected: ${socket.id}. Total clients: ${this.connectedClients.size}`);
    
    // Send current state to new client
    socket.emit('initial-state', {
      ...this.getCurrentState(),
      startLocation: START_LOCATION,
      startPanoId: START_PANO_ID,
      recentHistory: this.getRecentHistory(),
      connectedClients: this.connectedClients.size
    });
  }

  removeClient(socketId) {
    this.connectedClients.delete(socketId);
    console.log(`Client disconnected: ${socketId}. Total clients: ${this.connectedClients.size}`);
    
    // Broadcast updated client count
    this.broadcast('client-count', { count: this.connectedClients.size });
  }
}

// Initialize global exploration
const globalExploration = new GlobalExploration();

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

function drawArchiveTile(agent, z, x, y) {
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

  let prevPx = null;
  for (let i = 0; i < archivedCount - 1; i++) {
    const a = pathArr[i];
    const b = pathArr[i + 1];
    if (!a || !b) continue;
    const [awx, awy] = lonLatToWorldPixels(a.lng, a.lat, z);
    const [bwx, bwy] = lonLatToWorldPixels(b.lng, b.lat, z);
    const ax = awx - tileOriginX;
    const ay = awy - tileOriginY;
    const bx = bwx - tileOriginX;
    const by = bwy - tileOriginY;
    const margin = strokeWidth;
    const minX = Math.min(ax, bx) - margin;
    const maxX = Math.max(ax, bx) + margin;
    const minY = Math.min(ay, by) - margin;
    const maxY = Math.max(ay, by) + margin;
    if (maxX < 0 || maxY < 0 || minX > 256 || minY > 256) {
      continue; // no intersection with tile
    }
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
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

// Raster tiles for archived path
app.get('/tiles/:z/:x/:y.png', (req, res) => {
  const agent = globalExploration.agent;
  if (!agent || !agent.coverage) {
    res.type('image/png').send(createCanvas(256, 256).toBuffer('image/png'));
    return;
  }
  const z = parseInt(req.params.z, 10);
  const x = parseInt(req.params.x, 10);
  const y = parseInt(req.params.y, 10);
  if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) {
    return res.status(400).send('bad tile');
  }
  const version = getArchiveVersion(agent);
  const archivedCount = getArchivedCount(agent);
  const cacheKey = `${z}/${x}/${y}@v${version}`;
  const cached = globalExploration.tileCache.get(cacheKey);
  if (cached) {
    res.type('image/png').send(cached);
    return;
  }
  const runId = agent.runId || 'current';
  const filePath = path.join(ROOT_DIR, 'runs', 'tiles', runId, String(version), String(z), String(x), `${y}.png`);
  // Attempt to read from disk cache
  fs.readFile(filePath, (err, data) => {
    if (!err && data) {
      cacheSet(globalExploration.tileCache, cacheKey, data);
      res.type('image/png').send(data);
      return;
    }
    // Render, write to disk, and serve
    try {
      const buf = drawArchiveTile(agent, z, x, y);
      const dir = path.dirname(filePath);
      fsp.mkdir(dir, { recursive: true })
        .then(() => fsp.writeFile(filePath, buf))
        .catch(() => {})
        .finally(() => {
          cacheSet(globalExploration.tileCache, cacheKey, buf);
          res.type('image/png').send(buf);
        });
    } catch (e) {
      console.error('Tile render error:', e);
      res.status(500).send('tile error');
    }
  });
});

// Lightweight health and metrics endpoints
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/metrics', (req, res) => {
  const agent = globalExploration.agent;
  const stats = agent && agent.coverage ? agent.coverage.getStats() : { locationsVisited: 0, distanceTraveled: 0, pathLength: 0 };
  res.json({
    uptimeSec: Math.floor(process.uptime()),
    clientsConnected: globalExploration.connectedClients.size,
    isExploring: globalExploration.isExploring,
    stepCount: agent ? agent.stepCount : 0,
    locationsVisited: stats.locationsVisited,
    distanceTraveled: stats.distanceTraveled,
    pathLength: stats.pathLength
  });
});

// Helper function to verify admin token
function verifyAdminToken(token) {
  if (!token) return false;
  
  try {
    // Decode the simple token (in production, use proper JWT)
    const decoded = Buffer.from(token, 'base64').toString();
    const [prefix, timestamp] = decoded.split(':');
    
    // Check if token is valid and not expired (1 hour)
    if (prefix === 'admin' && timestamp) {
      const tokenAge = Date.now() - parseInt(timestamp);
      return tokenAge < 60 * 60 * 1000; // 1 hour expiry
    }
  } catch (e) {
    return false;
  }
  
  return false;
}

// Socket.io connection handling
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
    
    const result = await globalExploration.startExploration();
    if (result.error) {
      socket.emit('error', { message: result.error });
    }
  });

  socket.on('stop-exploration', async (data) => {
    // Check for admin token
    const token = data?.token;
    if (!verifyAdminToken(token)) {
      socket.emit('error', { message: 'Admin authentication required' });
      return;
    }
    
    await globalExploration.stopExploration();
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
    
    await globalExploration.resetExploration();
  });
  
  socket.on('load-save', async (data) => {
    // Check for admin token
    const token = data?.token;
    if (!verifyAdminToken(token)) {
      socket.emit('error', { message: 'Admin authentication required' });
      return;
    }
    
    console.log('📂 User requested to load saved state...');
    const result = await globalExploration.loadState();
    
    if (result.error) {
      console.log(`❌ Failed to load state: ${result.error}`);
      socket.emit('error', { message: result.error });
    } else {
      console.log(`✅ Successfully loaded state: ${result.stepCount} steps, ${result.locationsVisited} locations, ${result.graphSize} nodes`);
      socket.emit('save-loaded', result);
    }
  });

  socket.on('save-now', async (data) => {
    const token = data?.token;
    if (!verifyAdminToken(token)) {
      socket.emit('error', { message: 'Admin authentication required' });
      return;
    }
    try {
      await globalExploration.saveState(true);
      socket.emit('save-complete', { success: true, stepCount: globalExploration.agent?.stepCount || 0 });
    } catch (e) {
      socket.emit('error', { message: 'Failed to save state' });
    }
  });

  socket.on('disconnect', () => {
    globalExploration.removeClient(socket.id);
  });
});

// Listen on all network interfaces (0.0.0.0) for production deployments
const HOST = '0.0.0.0'; // Always bind to 0.0.0.0 for containerized environments
server.listen(PORT, HOST, () => {
  console.log(`🚀 Server listening on ${HOST}:${PORT}`);
  console.log(`📍 Starting location: ${START_LOCATION.lat}, ${START_LOCATION.lng}`);
  console.log(`⏱️  Step interval: ${STEP_INTERVAL}ms`);
  console.log(`💾 Save interval: Every ${SAVE_INTERVAL} steps`);
  console.log(`📜 Decision history limit: ${DECISION_HISTORY_LIMIT} entries`);
  console.log(`🗺️  Path simplification: ${PATH_SIMPLIFICATION.enabled ? `Enabled (epsilon: ${PATH_SIMPLIFICATION.recentEpsilon}/${PATH_SIMPLIFICATION.mediumEpsilon}/${PATH_SIMPLIFICATION.oldEpsilon})` : 'Disabled'}`);
  console.log(`🚧 Dead-end recovery: ${process.env.MAX_DEAD_END_DISTANCE || 200}m max distance`);
  console.log(`🔐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔑 Google Maps API: ${process.env.GOOGLE_MAPS_API_KEY ? 'Configured' : 'NOT CONFIGURED'}`);
  console.log(`🔑 OpenAI API: ${process.env.OPENAI_API_KEY ? 'Configured' : 'NOT CONFIGURED'}`);
  console.log(`🔑 Admin Password: ${process.env.CONTROL_PASSWORD ? 'Configured' : 'NOT CONFIGURED'}`);
});

// Graceful shutdown handling
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, saving state and shutting down...');
  await globalExploration.stopExploration();
  if (globalExploration.pendingSave || globalExploration.agent) {
    await globalExploration.saveState(true);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, saving state and shutting down...');
  await globalExploration.stopExploration();
  if (globalExploration.pendingSave || globalExploration.agent) {
    await globalExploration.saveState(true);
  }
  process.exit(0);
});

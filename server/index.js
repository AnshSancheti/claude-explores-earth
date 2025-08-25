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
import { productionSecurity } from './middleware/secureRuns.js';
import fs from 'fs';
import path from 'path';

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

// Protected routes for sensitive data
// In development: Allow all access for testing
// In production: Allow read-only access to recent files (for screenshots in decision log)
const runsMiddleware = express.static(join(ROOT_DIR, 'runs'));
app.use('/runs', runsMiddleware);

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
      const currentPano = await this.agent.streetViewHeadless.getCurrentPanorama();
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
        this.addToHistory(stepData);
        this.cacheScreenshots(stepData);
        
        // Save state periodically (not every step)
        await this.saveState();
        
        // Schedule next step
        if (this.isExploring) {
          this.explorationInterval = setTimeout(runExplorationStep, STEP_INTERVAL);
        }
      } catch (error) {
        console.error('Exploration step error:', error);
        this.broadcast('error', { message: error.message });
        
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
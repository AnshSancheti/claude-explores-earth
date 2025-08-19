import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import cors from 'cors';
import { ExplorationAgent } from './agents/explorationAgent.js';
import { Logger } from './utils/logger.js';
import { productionSecurity } from './middleware/secureRuns.js';
import fs from 'fs';
import path from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
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
    this.screenshotCache = new Map(); // Cache screenshots by step
    this.logger = new Logger();
    this.persistentLogger = this.createPersistentLogger();
    this.maxHistoryInMemory = 1000; // Cap memory usage
    this.cacheSize = DECISION_HISTORY_LIMIT * 3;
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

  stopExploration() {
    if (this.explorationInterval) {
      clearTimeout(this.explorationInterval);
      this.explorationInterval = null;
    }
    this.isExploring = false;
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
    this.broadcast('step-complete', {});
    return { success: true };
  }

  async resetExploration() {
    this.stopExploration();
    
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
    // Add to memory history
    this.decisionHistory.push(stepData);
    
    // Cap memory usage
    if (this.decisionHistory.length > this.maxHistoryInMemory) {
      this.decisionHistory.shift();
    }
    
    // Write to persistent log
    fs.appendFileSync(this.persistentLogger, JSON.stringify(stepData) + '\n');
  }

  cacheScreenshots(stepData) {
    if (stepData.screenshots) {
      // Add new screenshots to cache
      this.screenshotCache.set(stepData.stepCount, stepData.screenshots);
      
      // Remove old screenshots beyond cache limit
      if (this.screenshotCache.size > this.cacheSize) {
        const oldestStep = Math.min(...this.screenshotCache.keys());
        this.screenshotCache.delete(oldestStep);
      }
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
    
    return {
      isExploring: this.isExploring,
      position: this.agent.currentPosition,
      panoId: this.agent.currentPanoId,
      stats: this.agent.coverage ? this.agent.coverage.getStats() : {},
      stepCount: this.agent.stepCount,
      fullPath: this.agent.coverage ? this.agent.coverage.path : []
    };
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

  socket.on('stop-exploration', (data) => {
    // Check for admin token
    const token = data?.token;
    if (!verifyAdminToken(token)) {
      socket.emit('error', { message: 'Admin authentication required' });
      return;
    }
    
    globalExploration.stopExploration();
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
  console.log(`📜 Decision history limit: ${DECISION_HISTORY_LIMIT} entries`);
  console.log(`🔐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔑 Google Maps API: ${process.env.GOOGLE_MAPS_API_KEY ? 'Configured' : 'NOT CONFIGURED'}`);
  console.log(`🔑 OpenAI API: ${process.env.OPENAI_API_KEY ? 'Configured' : 'NOT CONFIGURED'}`);
  console.log(`🔑 Admin Password: ${process.env.CONTROL_PASSWORD ? 'Configured' : 'NOT CONFIGURED'}`);
});
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import cors from 'cors';
import { ExplorationAgent } from './agents/explorationAgent.js';
import { Logger } from './utils/logger.js';

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
app.use(express.static(join(ROOT_DIR, 'public')));
app.use('/runs', express.static(join(ROOT_DIR, 'runs')));

// Serve Google Maps API loader with API key from environment
app.get('/api/maps-loader', (req, res) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return res.status(500).send('Google Maps API key not configured');
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

const PORT = process.env.PORT || 5173;
const STEP_INTERVAL = parseInt(process.env.STEP_INTERVAL_MS) || 5000;
const START_LOCATION = {
  lat: parseFloat(process.env.START_LAT),
  lng: parseFloat(process.env.START_LNG)
};
const START_PANO_ID = process.env.START_PANO_ID || null;

const sessions = new Map();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  const logger = new Logger();
  
  const session = {
    agent: null,
    interval: null,
    isExploring: false,
    isStepInProgress: false,  // Add flag for single step synchronization
    logger: logger
  };
  
  sessions.set(socket.id, session);
  
  // Send initial configuration to client
  socket.emit('initial-config', {
    startLocation: START_LOCATION,
    startPanoId: START_PANO_ID
  });

  socket.on('start-exploration', async () => {
    const session = sessions.get(socket.id);
    if (session.isExploring) {
      socket.emit('error', { message: 'Exploration already in progress' });
      return;
    }

    try {
      session.isExploring = true;
      session.agent = new ExplorationAgent(socket, session.logger);
      
      socket.emit('exploration-started', {
        startLocation: START_LOCATION,
        startPanoId: START_PANO_ID,
        timestamp: new Date().toISOString()
      });

      await session.agent.initialize();

      // Use recursive setTimeout for safer sequential execution
      const runExplorationStep = async () => {
        if (!session.isExploring || !session.agent) {
          return;
        }
        
        try {
          await session.agent.exploreStep();
          
          // Schedule next step only after current step completes
          if (session.isExploring) {
            session.interval = setTimeout(runExplorationStep, STEP_INTERVAL);
          }
        } catch (error) {
          console.error('Exploration step error:', error);
          socket.emit('error', { message: error.message });
          
          // Continue exploration even after errors
          if (session.isExploring) {
            session.interval = setTimeout(runExplorationStep, STEP_INTERVAL);
          }
        }
      };
      
      // Start the first step
      session.interval = setTimeout(runExplorationStep, STEP_INTERVAL);

    } catch (error) {
      console.error('Failed to start exploration:', error);
      socket.emit('error', { message: error.message });
      session.isExploring = false;
    }
  });

  socket.on('stop-exploration', () => {
    const session = sessions.get(socket.id);
    if (session.interval) {
      clearTimeout(session.interval);  // Changed to clearTimeout
      session.interval = null;
    }
    session.isExploring = false;
    socket.emit('exploration-stopped');
  });

  socket.on('take-single-step', async () => {
    const session = sessions.get(socket.id);
    
    if (session.isExploring) {
      socket.emit('error', { message: 'Cannot take step while exploration is running' });
      return;
    }
    
    // Check if a step is already in progress
    if (session.isStepInProgress) {
      console.log('Step already in progress, ignoring request');
      socket.emit('error', { message: 'A step is already in progress' });
      return;
    }

    try {
      // Set the flag to prevent concurrent steps
      session.isStepInProgress = true;
      
      if (!session.agent) {
        session.agent = new ExplorationAgent(socket, session.logger);
        await session.agent.initialize();
        
        socket.emit('exploration-started', {
          startLocation: START_LOCATION,
          timestamp: new Date().toISOString()
        });
      }

      await session.agent.exploreStep();
      socket.emit('step-complete');
      
    } catch (error) {
      console.error('Single step error:', error);
      socket.emit('error', { message: error.message });
    } finally {
      // Always clear the flag when done
      session.isStepInProgress = false;
    }
  });

  socket.on('reset-exploration', async () => {
    const session = sessions.get(socket.id);
    if (session.interval) {
      clearTimeout(session.interval);  // Changed to clearTimeout
      session.interval = null;
    }
    
    if (session.agent) {
      await session.agent.reset();
    }
    
    session.isExploring = false;
    socket.emit('exploration-reset');
  });

  socket.on('disconnect', async () => {
    console.log('Client disconnected:', socket.id);
    const session = sessions.get(socket.id);
    
    if (session) {
      if (session.interval) {
        clearTimeout(session.interval);  // Changed to clearTimeout
      }
      if (session.agent && session.agent.streetView) {
        await session.agent.streetView.close();
      }
      sessions.delete(socket.id);
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📍 Starting location: ${START_LOCATION.lat}, ${START_LOCATION.lng}`);
  console.log(`⏱️  Step interval: ${STEP_INTERVAL}ms`);
});
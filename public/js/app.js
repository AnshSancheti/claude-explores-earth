class ExplorationApp {
  constructor() {
    this.socket = null;
    this.mapManager = new MapManager();
    this.streetViewManager = new StreetViewManager();
    this.uiManager = new UIManager();
    this.isExploring = false;
    this.startLocation = null;
  }

  initialize() {
    this.connectSocket();
    this.setupEventListeners();
  }

  connectSocket() {
    // Configure Socket.io connection for production
    const socketOptions = {
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000
    };
    
    // In production, connect to the same origin
    this.socket = io(socketOptions);

    this.socket.on('connect', () => {
      console.log('Connected to server');
    });

    this.socket.on('disconnect', () => {
      console.log('Disconnected from server');
      this.isExploring = false;
      this.uiManager.setExplorationState(false);
    });

    // Receive initial state when connecting (includes current state and recent history)
    this.socket.on('initial-state', (data) => {
      console.log('Initial state received', data);
      console.log(`Connected clients: ${data.connectedClients}`);
      
      this.startLocation = data.startLocation;
      
      if (data.startPanoId) {
        window.START_PANO_ID = data.startPanoId;
      }
      
      // Initialize maps with the start position
      if (this.startLocation) {
        // Set position first, then initialize
        this.mapManager.setStartPosition(this.startLocation);
        this.mapManager.initialize();
        
        // Initialize Street View when Google Maps is ready
        const checkGoogleMaps = setInterval(() => {
          if (window.google && window.google.maps) {
            clearInterval(checkGoogleMaps);
            this.streetViewManager.setStartPosition(this.startLocation);
            this.streetViewManager.initialize();
            
            // If exploration is in progress, update to current position
            if (data.position && data.panoId) {
              this.streetViewManager.updatePosition(data.panoId, 0);
            }
          }
        }, 100);
      }
      
      // Update UI with current state
      if (data.stats) {
        this.uiManager.updateStats(data.stats);
      }
      if (data.stepCount !== undefined) {
        this.uiManager.updateStep(data.stepCount);
      }
      
      // Update exploration state
      this.isExploring = data.isExploring || false;
      this.uiManager.setExplorationState(this.isExploring);
      
      // Load recent history into decision log
      if (data.recentHistory && data.recentHistory.length > 0) {
        console.log(`Loading ${data.recentHistory.length} recent decisions`);
        data.recentHistory.forEach(entry => {
          this.uiManager.addDecisionEntry(entry);
        });
      }
      
      // Update minimap with full path if available
      if (data.fullPath && data.fullPath.length > 0) {
        console.log(`Loading ${data.fullPath.length} path points to minimap (batched)`);
        this.mapManager.loadFullPath(data.fullPath);
      }
      
      // Always update current position if provided (even if we have fullPath)
      if (data.position) {
        this.mapManager.updatePosition(data.position);
      }
    });

    this.socket.on('exploration-started', (data) => {
      console.log('Exploration started', data);
      
      this.isExploring = true;
      this.uiManager.setExplorationState(true);
    });

    this.socket.on('position-update', (data) => {
      console.log('Position update', data);
      this.mapManager.updatePosition(data.position);
      this.uiManager.updateStats(data.stats);
    });

    this.socket.on('move-decision', (data) => {
      console.log('Move decision', data);
      this.mapManager.updatePosition(data.newPosition);
      if (this.streetViewManager.panorama) {
        this.streetViewManager.updatePosition(data.panoId, data.direction);
      }
      this.uiManager.updateStats(data.stats);
      this.uiManager.updateStep(data.stepCount);
      this.uiManager.addDecisionEntry(data);
    });

    this.socket.on('exploration-stopped', () => {
      console.log('Exploration stopped');
      this.isExploring = false;
      this.uiManager.setExplorationState(false);
    });

    this.socket.on('exploration-reset', () => {
      console.log('Exploration reset');
      this.isExploring = false;
      this.uiManager.setExplorationState(false);
      this.mapManager.reset();
      if (this.streetViewManager.panorama) {
        this.streetViewManager.reset();
      }
      this.uiManager.clearDecisionLog();
      this.uiManager.updateStats({ locationsVisited: 0, distanceTraveled: 0 });
      this.uiManager.updateStep(0);
    });

    this.socket.on('step-complete', () => {
      console.log('Single step complete');
      this.uiManager.setStepButtonState(false);
    });

    this.socket.on('error', (data) => {
      console.error('Server error:', data);
      this.uiManager.setStepButtonState(false);
    });

    // Handle client count updates
    this.socket.on('client-count', (data) => {
      console.log(`Connected clients: ${data.count}`);
      // Could display this in the UI if desired
    });
    
    // Handle save file loaded
    this.socket.on('save-loaded', (data) => {
      console.log('Save file loaded:', data);
      alert(`Save loaded successfully!\nStep: ${data.stepCount}\nLocations visited: ${data.locationsVisited}\nGraph size: ${data.graphSize} nodes`);
    });
    
    this.socket.on('save-complete', (data) => {
      console.log('State saved:', data);
      this.uiManager.showSuccess('State saved');
    });
    
    // Handle state restoration broadcast
    this.socket.on('state-loaded', (data) => {
      console.log('State restored:', data);
      
      // Update UI with loaded state
      this.uiManager.updateStats(data.stats);
      this.uiManager.updateStep(data.stepCount);
      
      // Clear and reload decision history
      this.uiManager.clearDecisionLog();
      if (data.decisionHistory && data.decisionHistory.length > 0) {
        data.decisionHistory.forEach(entry => {
          this.uiManager.addDecisionEntry(entry);
        });
      }
      
      // Update map with full path
      if (data.fullPath && data.fullPath.length > 0) {
        this.mapManager.reset();
        this.mapManager.loadFullPath(data.fullPath);
      }
      
      // Update Street View to loaded position
      if (data.panoId && this.streetViewManager.panorama) {
        this.streetViewManager.updatePosition(data.panoId, 0);
      }
    });
  }

  setupEventListeners() {
    this.uiManager.startBtn.addEventListener('click', () => {
      this.startExploration();
    });

    this.uiManager.stepBtn.addEventListener('click', () => {
      this.takeStep();
    });

    this.uiManager.stopBtn.addEventListener('click', () => {
      this.stopExploration();
    });

    this.uiManager.resetBtn.addEventListener('click', () => {
      this.resetExploration();
    });
    
    this.uiManager.loadBtn.addEventListener('click', () => {
      this.loadSave();
    });
    
    if (this.uiManager.saveBtn) {
      this.uiManager.saveBtn.addEventListener('click', () => {
        this.saveNow();
      });
    }
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Ignore if user is typing in an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      
      switch(e.key.toLowerCase()) {
        case ' ':  // Spacebar for step
          e.preventDefault();
          if (!this.isExploring) {
            this.takeStep();
          }
          break;
        case 's':  // S for start/stop
          e.preventDefault();
          if (this.isExploring) {
            this.stopExploration();
          } else {
            this.startExploration();
          }
          break;
        case 'r':  // R for reset
          e.preventDefault();
          if (!this.isExploring) {
            this.resetExploration();
          }
          break;
        case 'f':  // F for fullscreen
          e.preventDefault();
          this.toggleFullscreen();
          break;
      }
    });
    
    // Mobile sidebar toggle with touch support
    const sidebarHeader = document.querySelector('.sidebar-header');
    if (sidebarHeader) {
      const toggleSidebar = () => {
        const sidebar = document.getElementById('sidebar');
        if (window.innerWidth <= 768) {
          sidebar.classList.toggle('expanded');
        }
      };
      
      sidebarHeader.addEventListener('click', toggleSidebar);
      sidebarHeader.addEventListener('touchend', (e) => {
        e.preventDefault();
        toggleSidebar();
      });
    }
    
    // Mobile minimap toggle with touch support and dragging
    const minimapToggle = document.querySelector('.minimap-toggle');
    const minimapContainer = document.getElementById('minimapContainer');
    if (minimapToggle && window.innerWidth <= 768) {
      let isDragging = false;
      let startY = 0;
      let currentY = 0;
      let initialTop = 50; // Start at 50% (center)
      
      // Load saved position if exists
      const savedPosition = localStorage.getItem('minimapPosition');
      if (savedPosition) {
        const topPercent = parseFloat(savedPosition);
        minimapToggle.style.top = `${topPercent}%`;
        minimapContainer.style.top = `${topPercent}%`;
        initialTop = topPercent;
      }
      
      const handleStart = (e) => {
        const touch = e.type.includes('touch') ? e.touches[0] : e;
        startY = touch.clientY;
        isDragging = false;
      };
      
      const handleMove = (e) => {
        const touch = e.type.includes('touch') ? e.touches[0] : e;
        currentY = touch.clientY;
        
        // If moved more than 10px, consider it dragging
        if (Math.abs(currentY - startY) > 10) {
          isDragging = true;
          e.preventDefault();
          
          // Calculate new position as percentage
          const windowHeight = window.innerHeight;
          const newTop = (currentY / windowHeight) * 100;
          
          // Constrain between 10% and 90% of screen height
          const constrainedTop = Math.max(10, Math.min(90, newTop));
          
          // Update positions
          minimapToggle.style.top = `${constrainedTop}%`;
          minimapToggle.style.transform = `translateY(-50%)`;
          minimapContainer.style.top = `${constrainedTop}%`;
          minimapContainer.style.transform = `translateY(-50%)`;
          
          // Save position
          localStorage.setItem('minimapPosition', constrainedTop);
        }
      };
      
      const handleEnd = (e) => {
        if (!isDragging) {
          // It was a tap, not a drag
          window.toggleMinimap();
        }
        isDragging = false;
      };
      
      // Touch events
      minimapToggle.addEventListener('touchstart', handleStart, { passive: false });
      minimapToggle.addEventListener('touchmove', handleMove, { passive: false });
      minimapToggle.addEventListener('touchend', handleEnd, { passive: false });
      
      // Mouse events for testing on desktop
      minimapToggle.addEventListener('mousedown', handleStart);
      minimapToggle.addEventListener('mousemove', (e) => {
        if (e.buttons === 1) handleMove(e);
      });
      minimapToggle.addEventListener('mouseup', handleEnd);
      minimapToggle.addEventListener('click', (e) => {
        if (isDragging) e.preventDefault();
      });
    }
  }

  getAuthToken() {
    // Get auth token from adminAuth module
    if (window.adminAuth && window.adminAuth.authToken) {
      return window.adminAuth.authToken;
    }
    return null;
  }

  startExploration() {
    if (!this.isExploring) {
      const token = this.getAuthToken();
      if (!token) {
        this.uiManager.showError('Admin authentication required');
        return;
      }
      this.socket.emit('start-exploration', { token });
    }
  }

  takeStep() {
    if (!this.isExploring) {
      const token = this.getAuthToken();
      if (!token) {
        this.uiManager.showError('Admin authentication required');
        return;
      }
      this.uiManager.setStepButtonState(true);
      this.socket.emit('take-single-step', { token });
    }
  }

  stopExploration() {
    if (this.isExploring) {
      const token = this.getAuthToken();
      if (!token) {
        this.uiManager.showError('Admin authentication required');
        return;
      }
      this.socket.emit('stop-exploration', { token });
    }
  }

  resetExploration() {
    if (!this.isExploring) {
      const token = this.getAuthToken();
      if (!token) {
        this.uiManager.showError('Admin authentication required');
        return;
      }
      this.socket.emit('reset-exploration', { token });
    }
  }
  
  loadSave() {
    const token = this.getAuthToken();
    if (!token) {
      this.uiManager.showError('Admin authentication required');
      return;
    }
    
    if (confirm('Load saved exploration state? This will reset the current exploration.')) {
      this.socket.emit('load-save', { token });
    }
  }
  
  saveNow() {
    const token = this.getAuthToken();
    if (!token) {
      this.uiManager.showError('Admin authentication required');
      return;
    }
    this.socket.emit('save-now', { token });
  }
  
  toggleFullscreen() {
    const streetViewContainer = document.querySelector('.street-view-container');
    if (!document.fullscreenElement) {
      streetViewContainer.requestFullscreen().catch(err => {
        console.log('Error attempting to enable fullscreen:', err);
      });
    } else {
      document.exitFullscreen();
    }
  }
}

// Global function for minimap toggle on mobile
window.toggleMinimap = function() {
  const minimapContainer = document.getElementById('minimapContainer');
  const minimapToggle = document.querySelector('.minimap-toggle');
  if (window.innerWidth <= 768) {
    minimapContainer.classList.toggle('expanded');
    minimapToggle.classList.toggle('expanded');
    
    // Keep the vertical position synchronized
    const currentTop = minimapToggle.style.top || '50%';
    minimapContainer.style.top = currentTop;
  }
};

document.addEventListener('DOMContentLoaded', () => {
  const app = new ExplorationApp();
  app.initialize();
  
  // Expose mapManager globally for zoom controls
  window.mapManager = app.mapManager;
});

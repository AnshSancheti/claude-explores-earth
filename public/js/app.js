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
    this.socket = io();

    this.socket.on('connect', () => {
      console.log('Connected to server');
    });

    this.socket.on('disconnect', () => {
      console.log('Disconnected from server');
      this.isExploring = false;
      this.uiManager.setExplorationState(false);
    });

    // Receive initial configuration when connecting
    this.socket.on('initial-config', (data) => {
      console.log('Initial config received', data);
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
          }
        }, 100);
      }
    });

    this.socket.on('exploration-started', (data) => {
      console.log('Exploration started', data);
      
      this.isExploring = true;
      this.uiManager.setExplorationState(true);
      this.uiManager.updateStep(0);
    });

    this.socket.on('position-update', (data) => {
      console.log('Position update', data);
      if (this.mapManager.map) {
        this.mapManager.updatePosition(data.position);
      }
      this.uiManager.updateStats(data.stats);
    });

    this.socket.on('move-decision', (data) => {
      console.log('Move decision', data);
      if (this.mapManager.map) {
        this.mapManager.updatePosition(data.newPosition);
      }
      if (this.streetViewManager.panorama) {
        this.streetViewManager.updatePosition(data.panoId, data.decision.direction);
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
      if (this.mapManager.map) {
        this.mapManager.reset();
      }
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

  startExploration() {
    if (!this.isExploring) {
      this.socket.emit('start-exploration');
    }
  }

  takeStep() {
    if (!this.isExploring) {
      this.uiManager.setStepButtonState(true);
      this.socket.emit('take-single-step');
    }
  }

  stopExploration() {
    if (this.isExploring) {
      this.socket.emit('stop-exploration');
    }
  }

  resetExploration() {
    if (!this.isExploring) {
      this.socket.emit('reset-exploration');
    }
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
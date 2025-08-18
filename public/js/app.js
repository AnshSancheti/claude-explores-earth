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
    const checkGoogleMaps = setInterval(() => {
      if (window.google && window.google.maps) {
        clearInterval(checkGoogleMaps);
        this.streetViewManager.initialize();
      }
    }, 100);
    
    // Delay map initialization to ensure DOM is ready
    setTimeout(() => {
      this.mapManager.initialize();
    }, 500);
    
    this.connectSocket();
    this.setupEventListeners();
  }

  connectSocket() {
    this.socket = io();

    this.socket.on('connect', () => {
      console.log('Connected to server');
      this.uiManager.showSuccess('Connected to server');
    });

    this.socket.on('disconnect', () => {
      console.log('Disconnected from server');
      this.uiManager.showError('Disconnected from server');
      this.isExploring = false;
      this.uiManager.setExplorationState(false);
    });

    this.socket.on('exploration-started', (data) => {
      console.log('Exploration started', data);
      this.startLocation = data.startLocation;
      
      // Store pano ID globally for street view
      if (data.startPanoId) {
        window.START_PANO_ID = data.startPanoId;
      }
      
      if (this.startLocation) {
        this.mapManager.setStartPosition(this.startLocation);
        this.streetViewManager.setStartPosition(this.startLocation);
      }
      
      this.isExploring = true;
      this.uiManager.setExplorationState(true);
      this.uiManager.showSuccess('Exploration started!');
      this.uiManager.updateStep(0);
    });

    this.socket.on('position-update', (data) => {
      console.log('Position update', data);
      this.mapManager.updatePosition(data.position);
      this.uiManager.updateStats(data.stats);
    });

    this.socket.on('move-decision', (data) => {
      console.log('Move decision', data);
      this.mapManager.updatePosition(data.newPosition);
      this.streetViewManager.updatePosition(data.panoId, data.decision.direction);
      this.uiManager.updateStats(data.stats);
      this.uiManager.updateStep(data.stepCount);
      this.uiManager.addDecisionEntry(data);
    });

    this.socket.on('exploration-stopped', () => {
      console.log('Exploration stopped');
      this.isExploring = false;
      this.uiManager.setExplorationState(false);
      this.uiManager.showSuccess('Exploration stopped');
    });

    this.socket.on('exploration-reset', () => {
      console.log('Exploration reset');
      this.isExploring = false;
      this.uiManager.setExplorationState(false);
      this.mapManager.reset();
      this.streetViewManager.reset();
      this.uiManager.clearDecisionLog();
      this.uiManager.updateStats({ locationsVisited: 0, distanceTraveled: 0 });
      this.uiManager.updateStep(0);
      this.uiManager.showSuccess('Exploration reset');
    });

    this.socket.on('step-complete', () => {
      console.log('Single step complete');
      this.uiManager.setStepButtonState(false);
      this.uiManager.showSuccess('Step complete');
    });

    this.socket.on('error', (data) => {
      console.error('Server error:', data);
      this.uiManager.showError(data.message);
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
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new ExplorationApp();
  app.initialize();
});
class MapManager {
  constructor() {
    this.map = null;
    this.currentMarker = null;
    this.startMarker = null;
    this.pathLine = null;
    this.pathCoordinates = [];
    // Start position will be set from server via setStartPosition()
    this.startPosition = null;
    this.mapLoaded = false;
    this.pendingUpdates = []; // Queue positions until map is ready
    this.userHasInteracted = false; // Track if user manually adjusted the map
    this.initializeMinimapSize(); // Initialize saved size preferences
  }
  
  initializeMinimapSize() {
    // Only apply on desktop (not mobile)
    if (window.innerWidth > 768) {
      const container = document.getElementById('minimapContainer');
      const resizeHandle = document.getElementById('minimapResizeHandle');
      if (!container || !resizeHandle) return;
      
      // Restore saved size from localStorage
      const savedWidth = localStorage.getItem('minimapWidth');
      const savedHeight = localStorage.getItem('minimapHeight');
      
      if (savedWidth && savedHeight) {
        container.style.width = savedWidth + 'px';
        container.style.height = savedHeight + 'px';
      }
      
      // Custom resize from top-right corner
      let isResizing = false;
      let startX, startY, startWidth, startHeight;
      
      resizeHandle.addEventListener('mousedown', (e) => {
        isResizing = true;
        startX = e.clientX;
        startY = e.clientY;
        startWidth = parseInt(window.getComputedStyle(container).width, 10);
        startHeight = parseInt(window.getComputedStyle(container).height, 10);
        
        // Prevent text selection while resizing
        e.preventDefault();
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'nwse-resize';
      });
      
      document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        
        // Calculate new size (resize from top-right)
        const newWidth = startWidth + (e.clientX - startX);
        const newHeight = startHeight - (e.clientY - startY);
        
        // Apply constraints
        const constrainedWidth = Math.min(Math.max(newWidth, 280), 600);
        const constrainedHeight = Math.min(Math.max(newHeight, 180), 450);
        
        container.style.width = constrainedWidth + 'px';
        container.style.height = constrainedHeight + 'px';
        
        // Trigger map resize
        if (this.map) {
          this.map.resize();
        }
      });
      
      document.addEventListener('mouseup', () => {
        if (isResizing) {
          isResizing = false;
          document.body.style.userSelect = '';
          document.body.style.cursor = '';
          
          // Save new size
          const width = parseInt(container.style.width, 10);
          const height = parseInt(container.style.height, 10);
          localStorage.setItem('minimapWidth', width);
          localStorage.setItem('minimapHeight', height);
        }
      });
    }
  }

  isReady() {
    return this.mapLoaded && this.map !== null;
  }

  initialize() {
    console.log('Initializing minimap...');
    
    // startPosition should already be set via setStartPosition
    if (!this.startPosition) {
      console.error('Cannot initialize map without start position');
      return;
    }
    
    const center = [this.startPosition.lng, this.startPosition.lat];

    try {
      this.map = new maplibregl.Map({
        container: 'minimap',
        style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
        center: center,
        zoom: 14,
        attributionControl: false
      });

      this.map.on('load', () => {
        console.log('Minimap loaded successfully');
        this.addStartMarker();
        this.addCurrentMarker();
        this.initializePath();
        this.addResetButton();
        this.mapLoaded = true;
        
        // Process any pending position updates
        if (this.pendingUpdates.length > 0) {
          console.log(`Processing ${this.pendingUpdates.length} pending position updates`);
          this.pendingUpdates.forEach(position => {
            this.#doUpdatePosition(position);
          });
          this.pendingUpdates = [];
        }
        
        // Track user interactions
        this.setupInteractionTracking();
      });

      this.map.on('error', (e) => {
        console.error('Minimap error:', e);
      });
    } catch (error) {
      console.error('Failed to initialize minimap:', error);
    }
  }

  setStartPosition(position) {
    this.startPosition = position;
    
    // Only update map elements if map is initialized
    if (this.map) {
      if (this.startMarker) {
        this.startMarker.setLngLat([position.lng, position.lat]);
      }
      
      if (this.currentMarker) {
        this.currentMarker.setLngLat([position.lng, position.lat]);
      }
      
      this.map.flyTo({
        center: [position.lng, position.lat],
        zoom: 14
      });
    }
  }

  addStartMarker() {
    if (!this.startPosition) {
      console.warn('Cannot add start marker without start position');
      return;
    }
    
    const el = document.createElement('div');
    el.className = 'marker-start';
    el.style.width = '30px';
    el.style.height = '30px';
    el.style.backgroundImage = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'30\' height=\'30\' viewBox=\'0 0 30 30\'%3E%3Ccircle cx=\'15\' cy=\'15\' r=\'10\' fill=\'%234CAF50\'/%3E%3Ccircle cx=\'15\' cy=\'15\' r=\'5\' fill=\'white\'/%3E%3C/svg%3E")';
    el.style.backgroundSize = 'cover';

    this.startMarker = new maplibregl.Marker({ element: el })
      .setLngLat([this.startPosition.lng, this.startPosition.lat])
      .addTo(this.map);
  }

  addCurrentMarker() {
    const el = document.createElement('div');
    el.className = 'marker-current';
    el.style.width = '20px';
    el.style.height = '20px';
    el.style.backgroundImage = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'20\' height=\'20\' viewBox=\'0 0 20 20\'%3E%3Ccircle cx=\'10\' cy=\'10\' r=\'8\' fill=\'%23f44336\'/%3E%3Ccircle cx=\'10\' cy=\'10\' r=\'4\' fill=\'white\'/%3E%3C/svg%3E")';
    el.style.backgroundSize = 'cover';

    // Initialize at start position
    if (!this.startPosition) {
      console.warn('Cannot add current marker without start position');
      return;
    }
    
    this.currentMarker = new maplibregl.Marker({ element: el })
      .setLngLat([this.startPosition.lng, this.startPosition.lat])
      .addTo(this.map);
  }

  initializePath() {
    this.map.addSource('path', {
      type: 'geojson',
      data: {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: []
        }
      }
    });

    this.map.addLayer({
      id: 'path-layer',
      type: 'line',
      source: 'path',
      layout: {
        'line-join': 'round',
        'line-cap': 'round'
      },
      paint: {
        'line-color': '#f44336',
        'line-width': 3,
        'line-opacity': 0.8
      }
    });
  }

  updatePosition(position) {
    // Queue updates if map isn't ready yet
    if (!this.isReady()) {
      this.pendingUpdates.push(position);
      return;
    }
    
    this.#doUpdatePosition(position);
  }
  
  // Private method for actually updating position
  #doUpdatePosition(position) {
    const lngLat = [position.lng, position.lat];
    
    // Only update marker if it exists
    if (this.currentMarker) {
      this.currentMarker.setLngLat(lngLat);
    }
    
    this.pathCoordinates.push(lngLat);
    
    // Only update path if source exists
    if (this.map.getSource('path')) {
      this.map.getSource('path').setData({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: this.pathCoordinates
        }
      });
    }
    
    // Only auto-fit bounds if user hasn't manually interacted with the map
    if (!this.userHasInteracted) {
      if (this.pathCoordinates.length > 1) {
        const bounds = this.pathCoordinates.reduce((bounds, coord) => {
          return bounds.extend(coord);
        }, new maplibregl.LngLatBounds(this.pathCoordinates[0], this.pathCoordinates[0]));
        
        this.map.fitBounds(bounds, {
          padding: 50,
          maxZoom: 16
        });
      } else {
        this.map.flyTo({
          center: lngLat,
          zoom: 15
        });
      }
    }
  }

  reset() {
    this.pathCoordinates = [];
    this.pendingUpdates = []; // Clear any pending updates
    this.userHasInteracted = false; // Reset interaction tracking
    
    if (this.map && this.map.getSource('path')) {
      this.map.getSource('path').setData({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: []
        }
      });
    }
    
    if (this.currentMarker && this.startPosition) {
      this.currentMarker.setLngLat([this.startPosition.lng, this.startPosition.lat]);
    }
    
    if (this.map && this.startPosition) {
      this.map.flyTo({
        center: [this.startPosition.lng, this.startPosition.lat],
        zoom: 15
      });
    }
  }
  
  setupInteractionTracking() {
    // Track when user manually pans or zooms
    this.map.on('dragstart', () => {
      this.userHasInteracted = true;
      console.log('User manually panned minimap');
    });
    
    this.map.on('zoomstart', (e) => {
      // Check if zoom was triggered by user (not programmatic)
      if (!e.originalEvent) return;
      this.userHasInteracted = true;
      console.log('User manually zoomed minimap');
    });
  }
  
  addResetButton() {
    // Create reset button container
    const resetBtn = document.createElement('button');
    resetBtn.className = 'minimap-reset-btn';
    resetBtn.innerHTML = '⟲';
    resetBtn.title = 'Reset view to show full path';
    resetBtn.onclick = () => this.resetView();
    
    // Add to minimap container
    const minimapContainer = document.getElementById('minimapContainer');
    if (minimapContainer) {
      minimapContainer.appendChild(resetBtn);
    }
  }
  
  resetView() {
    // Reset interaction flag
    this.userHasInteracted = false;
    
    // Recenter map to show full path
    if (this.pathCoordinates.length > 1) {
      const bounds = this.pathCoordinates.reduce((bounds, coord) => {
        return bounds.extend(coord);
      }, new maplibregl.LngLatBounds(this.pathCoordinates[0], this.pathCoordinates[0]));
      
      this.map.fitBounds(bounds, {
        padding: 50,
        maxZoom: 16
      });
    } else if (this.pathCoordinates.length === 1) {
      this.map.flyTo({
        center: this.pathCoordinates[0],
        zoom: 15
      });
    } else if (this.startPosition) {
      // No path yet, center on start position
      this.map.flyTo({
        center: [this.startPosition.lng, this.startPosition.lat],
        zoom: 15
      });
    }
    
    console.log('Minimap view reset to show full path');
  }
}

window.MapManager = MapManager;
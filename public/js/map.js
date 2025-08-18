class MapManager {
  constructor() {
    this.map = null;
    this.currentMarker = null;
    this.startMarker = null;
    this.pathLine = null;
    this.pathCoordinates = [];
    // Start position will be set from server via setStartPosition()
    this.startPosition = null;
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
    const lngLat = [position.lng, position.lat];
    
    this.currentMarker.setLngLat(lngLat);
    
    this.pathCoordinates.push(lngLat);
    
    this.map.getSource('path').setData({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: this.pathCoordinates
      }
    });
    
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

  reset() {
    this.pathCoordinates = [];
    
    if (this.map.getSource('path')) {
      this.map.getSource('path').setData({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: []
        }
      });
    }
    
    this.currentMarker.setLngLat([this.startPosition.lng, this.startPosition.lat]);
    
    this.map.flyTo({
      center: [this.startPosition.lng, this.startPosition.lat],
      zoom: 15
    });
  }
}

window.MapManager = MapManager;
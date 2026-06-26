class MapManager {
  constructor() {
    this.map = null;
    this.currentMarker = null;
    this.startMarker = null;
    this.pathLine = null;
    this.pathState = new MinimapPathState();
    this.pathCoordinates = [];
    // Start position will be set from server via setStartPosition()
    this.startPosition = null;
    this.mapLoaded = false;
    this.pendingFullPathStates = [];
    this.pendingLivePositions = [];
    this.pendingMarkerPosition = null;
    this.userHasInteracted = false; // Track if user manually adjusted the map
    this.updatesSinceFit = 0; // Reduce expensive fit computations
    this.fitEveryNUpdates = 20; // Fit bounds every N incremental updates
    this.recentFitPointLimit = 300;
    this.fullPathBounds = null;
    this.archiveTileVersion = null;
    this.archiveTileRendererRevision = null;
    this.fullVectorPathKey = null;
    this.fullVectorPathLoadingKey = null;
    this.fullVectorAbortController = null;
    this.fullVectorRevealKey = null;
    this.fullVectorRevealPlan = null;
    this.fullVectorRevealFrame = 0;
    this.fullVectorRevealTimer = null;
    this.fullVectorRevealRaf = null;
    this.fullVectorRevealCoordinates = null;
    this.hasInitialPathFit = false;
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
    if (this.map) {
      console.log('Minimap already initialized');
      return;
    }
    
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
        this.addArchiveTiles(this.archiveTileVersion, this.archiveTileRendererRevision);
        this.addResetButton();
        this.mapLoaded = true;
        
        this.#flushPendingUpdates();
        
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

  addArchiveTiles(tileVersion = null, tileRendererRevision = null) {
    try {
      const version = Number(tileVersion);
      if (!Number.isFinite(version) || version <= 0) return;
      const rendererRevision = Number.isFinite(Number(tileRendererRevision)) ? Number(tileRendererRevision) : 0;
      this.archiveTileVersion = version;
      this.archiveTileRendererRevision = rendererRevision;
      const tileUrl = `/tiles/{z}/{x}/{y}.png?v=${encodeURIComponent(version)}&r=${encodeURIComponent(rendererRevision)}`;

      if (!this.map.getSource('archive-overview-tiles')) {
        this.map.addSource('archive-overview-tiles', {
          type: 'raster',
          tiles: [tileUrl],
          tileSize: 256,
          maxzoom: 10
        });
      }
      if (!this.map.getSource('archive-detail-tiles')) {
        this.map.addSource('archive-detail-tiles', {
          type: 'raster',
          tiles: [tileUrl],
          tileSize: 256,
          minzoom: 11
        });
      }

      // Place below hydrated vector and live vector path layers if present.
      const beforeId = this.map.getLayer('full-vector-path-layer')
        ? 'full-vector-path-layer'
        : this.map.getLayer('path-layer')
          ? 'path-layer'
          : undefined;
      if (!this.map.getLayer('archive-overview-tiles-layer')) {
        if (beforeId) {
          this.map.addLayer({
            id: 'archive-overview-tiles-layer',
            type: 'raster',
            source: 'archive-overview-tiles',
            paint: {
              'raster-opacity': [
                'interpolate',
                ['linear'],
                ['zoom'],
                10, 0.8,
                12, 0.6,
                16, 0.35
              ],
              'raster-resampling': 'linear'
            }
          }, beforeId);
        } else {
          this.map.addLayer({
            id: 'archive-overview-tiles-layer',
            type: 'raster',
            source: 'archive-overview-tiles',
            paint: {
              'raster-opacity': [
                'interpolate',
                ['linear'],
                ['zoom'],
                10, 0.8,
                12, 0.6,
                16, 0.35
              ],
              'raster-resampling': 'linear'
            }
          });
        }
      }
      if (!this.map.getLayer('archive-detail-tiles-layer')) {
        this.map.addLayer({
          id: 'archive-detail-tiles-layer',
          type: 'raster',
          source: 'archive-detail-tiles',
          minzoom: 11,
          paint: { 'raster-opacity': 0.65, 'raster-resampling': 'nearest' }
        }, beforeId);
      }
      this.#setArchiveRasterMode(Boolean(this.fullVectorPathKey));
    } catch (e) {
      console.error('Failed to add archive tiles:', e);
    }
  }

  removeArchiveTiles() {
    if (!this.map) return;
    for (const layerId of [
      'archive-detail-tiles-layer',
      'archive-overview-tiles-layer',
      'archive-tiles-layer'
    ]) {
      if (this.map.getLayer(layerId)) {
        this.map.removeLayer(layerId);
      }
    }
    for (const sourceId of [
      'archive-detail-tiles',
      'archive-overview-tiles',
      'archive-tiles'
    ]) {
      if (this.map.getSource(sourceId)) {
        this.map.removeSource(sourceId);
      }
    }
  }

  updateArchiveTiles(meta = {}) {
    const version = Number(meta.tileVersion);
    const rendererRevision = Number(meta.tileRendererRevision);
    if (!Number.isFinite(version) || version <= 0) return;
    const resolvedRendererRevision = Number.isFinite(rendererRevision) ? rendererRevision : 0;
    if (!this.isReady()) {
      this.archiveTileVersion = version;
      this.archiveTileRendererRevision = resolvedRendererRevision;
      return;
    }
    if (
      this.archiveTileVersion === version &&
      this.archiveTileRendererRevision === resolvedRendererRevision &&
      this.map.getSource('archive-overview-tiles') &&
      this.map.getSource('archive-detail-tiles')
    ) {
      return;
    }

    try {
      this.removeArchiveTiles();
      this.addArchiveTiles(version, resolvedRendererRevision);
    } catch (e) {
      console.error('Failed to refresh archive tiles:', e);
    }
  }

  hydrateFullVectorPath(meta = {}) {
    const runId = meta.runId || this.pathState.runId;
    const sequence = Number(meta.pathSequence || meta.sequence);
    const totalPoints = Number(meta.totalPoints);
    if (!runId || !Number.isFinite(sequence) || sequence <= 0) return;
    if (!Number.isFinite(totalPoints) || totalPoints <= this.pathCoordinates.length) return;

    const key = `${runId}:${sequence}:${totalPoints}`;
    if (
      this.fullVectorPathKey === key ||
      this.fullVectorPathLoadingKey === key ||
      this.fullVectorRevealKey === key
    ) {
      return;
    }

    if (this.fullVectorAbortController) {
      this.fullVectorAbortController.abort();
    }
    this.#cancelFullVectorReveal({ clearLine: true });
    const controller = new AbortController();
    this.fullVectorAbortController = controller;
    this.fullVectorPathLoadingKey = key;

    const startFetch = () => {
      this.#fetchFullVectorPath({ runId, sequence, totalPoints, key, controller })
        .catch(error => {
          if (error?.name !== 'AbortError') {
            console.warn('Failed to hydrate full minimap vector path:', error);
          }
        })
        .finally(() => {
          if (this.fullVectorPathLoadingKey === key) {
            this.fullVectorPathLoadingKey = null;
          }
          if (this.fullVectorAbortController === controller) {
            this.fullVectorAbortController = null;
          }
        });
    };

    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(startFetch);
    } else {
      startFetch();
    }
  }

  setRun(runId) {
    const previousRunId = this.pathState.runId;
    this.pathState.setRun(runId);
    if (previousRunId && runId && previousRunId !== runId) {
      this.pathCoordinates = [];
      this.#resetFullVectorPath();
      this.#renderPath();
    }
  }

  // Batch-load a full path in one render pass
  loadFullPath(points, meta = {}) {
    if (!points || points.length === 0) return;

    // If map not ready, queue them for later processing
    if (!this.isReady()) {
      this.pendingFullPathStates.push({ points, meta });
      return;
    }

    const result = this.pathState.applyFullPath(points, meta);
    if (!result.applied) return;
    this.fullPathBounds = this.#normalizeBounds(meta.bounds) || this.fullPathBounds;
    this.updateArchiveTiles(meta);
    this.hydrateFullVectorPath(meta);
    this.pathCoordinates = this.pathState.coordinates;
    this.#renderPath();

    // Fit once on batch load. The historical path is rendered as tiles, so this
    // can show the whole journey without loading every point into GeoJSON.
    if (!this.userHasInteracted && !this.hasInitialPathFit) {
      if (this.fullPathBounds) {
        this.#fitBoundsObject(this.fullPathBounds, { padding: 45, maxZoom: 16 });
      } else if (this.pathCoordinates.length > 1) {
        this.#fitRecentPath();
      }
      this.hasInitialPathFit = true;
      this.updatesSinceFit = 0;
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
    this.map.addSource('full-vector-path', {
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
      id: 'full-vector-path-layer',
      type: 'line',
      source: 'full-vector-path',
      layout: {
        'line-join': 'round',
        'line-cap': 'round'
      },
      paint: {
        'line-color': '#d32f2f',
        'line-width': 2,
        'line-opacity': 0.75
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
        'line-width': 2,
        'line-opacity': 0.8
      }
    });
  }

  setCurrentPosition(position) {
    if (!position) return;
    if (!this.isReady()) {
      this.pendingMarkerPosition = position;
      return;
    }

    const lngLat = [position.lng, position.lat];
    if (this.currentMarker) {
      this.currentMarker.setLngLat(lngLat);
    }
  }

  applyLivePosition(position, meta = {}) {
    // Queue updates if map isn't ready yet
    if (!this.isReady()) {
      this.pendingLivePositions.push({ position, meta });
      return;
    }

    const result = this.pathState.applyLivePosition(position, meta);
    this.setCurrentPosition(position);
    if (!result.applied) return;

    this.pathCoordinates = this.pathState.coordinates;
    this.#renderPath();

    // Only auto-fit bounds if user hasn't manually interacted with the map
    if (!this.userHasInteracted) {
      if (this.pathCoordinates.length > 1) {
        this.updatesSinceFit += 1;
        if (this.updatesSinceFit >= this.fitEveryNUpdates) {
          this.#fitRecentPath(position);
          this.updatesSinceFit = 0;
        }
      } else {
        this.map.flyTo({ center: [position.lng, position.lat], zoom: 15 });
      }
    }
  }

  updatePosition(position) {
    this.applyLivePosition(position);
  }

  #renderPath() {
    if (this.map && this.map.getSource('path')) {
      this.map.getSource('path').setData({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: this.pathCoordinates
        }
      });
    }
  }

  async #fetchFullVectorPath({ runId, sequence, totalPoints, key, controller }) {
    const revealHelper = window.MinimapPathReveal;
    const fallbackPlan = {
      starts: [0],
      ranges: totalPoints > 0 ? [{ start: 0, end: totalPoints, count: totalPoints }] : [],
      prefetchConcurrency: 1,
      frameDelayMs: 0
    };
    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    const plan = prefersReducedMotion
      ? fallbackPlan
      : revealHelper?.makeBackwardRevealPlan
        ? revealHelper.makeBackwardRevealPlan(totalPoints, {
            tailPoints: this.pathCoordinates.length
          })
        : fallbackPlan;
    const ranges = Array.isArray(plan.ranges) && plan.ranges.length > 0
      ? plan.ranges
      : this.#rangesFromRevealStarts(plan.starts, totalPoints);
    if (ranges.length === 0) return;

    this.fullVectorPathKey = null;
    this.fullVectorRevealKey = key;
    this.fullVectorRevealPlan = plan;
    this.fullVectorRevealFrame = 0;
    this.fullVectorRevealCoordinates = [];
    this.#setArchiveRasterMode(false);
    this.#renderFullVectorPath([]);

    try {
      const chunkPromises = new Array(ranges.length);
      let nextRangeIndex = 0;
      let activeFetches = 0;
      const prefetchConcurrency = prefersReducedMotion
        ? 1
        : Math.max(1, Math.min(8, Math.floor(Number(plan.prefetchConcurrency) || 4), ranges.length));
      const fillPrefetchQueue = () => {
        while (
          activeFetches < prefetchConcurrency &&
          nextRangeIndex < ranges.length &&
          this.#isCurrentFullVectorLoad({ runId, key, controller })
        ) {
          const index = nextRangeIndex;
          const range = ranges[index];
          nextRangeIndex += 1;
          activeFetches += 1;
          chunkPromises[index] = this.#fetchFullVectorPathChunk({
            runId,
            sequence,
            totalPoints,
            start: range.start,
            count: range.count,
            controller
          })
            .then(chunk => ({ chunk }))
            .catch(error => ({ error }))
            .finally(() => {
              activeFetches -= 1;
              fillPrefetchQueue();
            });
        }
      };

      fillPrefetchQueue();
      for (let frame = 0; frame < ranges.length; frame += 1) {
        if (!this.#isCurrentFullVectorLoad({ runId, key, controller })) return;
        const range = ranges[frame];
        fillPrefetchQueue();
        const result = await chunkPromises[frame];
        if (result?.error) throw result.error;
        const chunk = result?.chunk;
        if (!chunk || !this.#isCurrentFullVectorLoad({ runId, key, controller })) return;
        if (chunk.totalPoints < totalPoints - 5) return;
        const chunkStart = Number.isFinite(chunk.coordinateStart) ? chunk.coordinateStart : range.start;
        const chunkEnd = Number.isFinite(chunk.coordinateEnd) ? chunk.coordinateEnd : chunkStart + chunk.coordinates.length;
        if (chunkStart !== range.start || chunkEnd > range.end) return;

        if (chunk.coordinates.length > 0) {
          this.fullVectorRevealCoordinates = chunk.coordinates.concat(this.fullVectorRevealCoordinates || []);
          this.#renderFullVectorPath(this.fullVectorRevealCoordinates);
        }

        this.fullVectorRevealFrame = frame + 1;
        if (range.start <= 0 || frame >= ranges.length - 1) break;
        await this.#waitForFullVectorRevealFrame(plan.frameDelayMs, controller);
      }

      if (!this.#isCurrentFullVectorLoad({ runId, key, controller })) return;
      const coordinates = this.fullVectorRevealCoordinates || [];
      if (coordinates.length < 2) return;
      this.#completeFullVectorReveal(key, coordinates.length);
    } finally {
      if (!controller.signal.aborted && this.fullVectorRevealKey === key) {
        controller.abort();
        this.#cancelFullVectorReveal();
      }
    }
  }

  async #fetchFullVectorPathChunk({ runId, sequence, totalPoints, start, count, controller }) {
    const params = new URLSearchParams({
      runId,
      sequence: String(sequence),
      start: String(start),
      count: String(count)
    });
    const response = await fetch(`/api/path-vectors.bin?${params.toString()}`, {
      signal: controller.signal,
      headers: { Accept: 'application/octet-stream' }
    });
    if (!response.ok) {
      throw new Error(`Full path vector chunk request failed (${response.status})`);
    }

    const buffer = await response.arrayBuffer();
    if (controller.signal.aborted) return null;
    if (response.headers.get('x-path-run-id') !== runId) return null;
    const responseTotalPoints = Number(response.headers.get('x-path-total-points'));
    if (responseTotalPoints < totalPoints - 5) return null;

    const precision = Number(response.headers.get('x-path-coordinate-precision')) || 6;
    const scale = Math.pow(10, precision);
    const view = new DataView(buffer);
    const coordinateCount = Math.floor(view.byteLength / 8);
    const coordinates = new Array(coordinateCount);
    for (let i = 0; i < coordinateCount; i += 1) {
      const offset = i * 8;
      coordinates[i] = [
        view.getInt32(offset, true) / scale,
        view.getInt32(offset + 4, true) / scale
      ];
    }

    return {
      totalPoints: Number.isFinite(responseTotalPoints) ? responseTotalPoints : totalPoints,
      coordinateStart: Number(response.headers.get('x-path-coordinate-start')),
      coordinateEnd: Number(response.headers.get('x-path-coordinate-end')),
      coordinates
    };
  }

  #renderFullVectorPath(coordinates) {
    if (this.map && this.map.getSource('full-vector-path')) {
      this.map.getSource('full-vector-path').setData({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates
        }
      });
    }
  }

  #setArchiveRasterMode(fullVectorLoaded) {
    if (!this.map) return;
    if (this.map.getLayer('archive-overview-tiles-layer')) {
      this.map.setLayoutProperty('archive-overview-tiles-layer', 'visibility', fullVectorLoaded ? 'none' : 'visible');
      this.map.setPaintProperty(
        'archive-overview-tiles-layer',
        'raster-opacity',
        fullVectorLoaded
          ? 0
          : [
              'interpolate',
              ['linear'],
              ['zoom'],
              10, 0.8,
              12, 0.6,
              16, 0.35
            ]
      );
    }
    if (this.map.getLayer('archive-detail-tiles-layer')) {
      this.map.setLayoutProperty('archive-detail-tiles-layer', 'visibility', fullVectorLoaded ? 'none' : 'visible');
      this.map.setPaintProperty('archive-detail-tiles-layer', 'raster-opacity', fullVectorLoaded ? 0 : 0.65);
    }
  }

  #resetFullVectorPath() {
    if (this.fullVectorAbortController) {
      this.fullVectorAbortController.abort();
    }
    this.#cancelFullVectorReveal({ clearLine: true });
    this.fullVectorAbortController = null;
    this.fullVectorPathLoadingKey = null;
    this.fullVectorPathKey = null;
    this.#setArchiveRasterMode(false);
  }

  #isCurrentFullVectorLoad({ runId, key, controller }) {
    if (controller.signal.aborted) return false;
    if (this.pathState.runId && this.pathState.runId !== runId) return false;
    return this.fullVectorPathLoadingKey === key && this.fullVectorRevealKey === key;
  }

  #rangesFromRevealStarts(starts, totalPoints) {
    const total = Math.max(0, Math.floor(Number(totalPoints) || 0));
    const ranges = [];
    let end = total;
    for (const rawStart of starts || []) {
      const start = Math.max(0, Math.min(end, Math.floor(Number(rawStart) || 0)));
      if (start < end) {
        ranges.push({ start, end, count: end - start });
      }
      end = start;
    }
    return ranges;
  }

  #waitForFullVectorRevealFrame(delay, controller) {
    const boundedDelay = Math.max(0, Math.min(500, Number(delay) || 0));
    return new Promise(resolve => {
      let timeoutId = null;
      let rafId = null;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (timeoutId != null) {
          window.clearTimeout(timeoutId);
        }
        if (rafId != null) {
          window.cancelAnimationFrame?.(rafId);
        }
        controller.signal.removeEventListener?.('abort', finish);
        resolve();
      };

      const scheduleFrame = () => {
        timeoutId = null;
        if (controller.signal.aborted || typeof window.requestAnimationFrame !== 'function') {
          finish();
          return;
        }
        rafId = window.requestAnimationFrame(() => {
          rafId = null;
          finish();
        });
      };

      if (controller.signal.aborted) {
        finish();
        return;
      }
      controller.signal.addEventListener?.('abort', finish, { once: true });
      if (boundedDelay > 0) {
        timeoutId = window.setTimeout(scheduleFrame, boundedDelay);
      } else {
        scheduleFrame();
      }
    });
  }

  #completeFullVectorReveal(key, pointCount) {
    if (this.fullVectorRevealKey && this.fullVectorRevealKey !== key) return;
    this.fullVectorPathKey = key;
    this.fullVectorRevealKey = null;
    this.fullVectorRevealPlan = null;
    this.fullVectorRevealFrame = 0;
    this.fullVectorRevealCoordinates = null;
    if (this.fullVectorRevealTimer) {
      window.clearTimeout(this.fullVectorRevealTimer);
      this.fullVectorRevealTimer = null;
    }
    if (this.fullVectorRevealRaf) {
      window.cancelAnimationFrame?.(this.fullVectorRevealRaf);
      this.fullVectorRevealRaf = null;
    }
    this.#setArchiveRasterMode(true);
    console.log(`Hydrated ${pointCount} full vector path points`);
  }

  #cancelFullVectorReveal({ clearLine = false } = {}) {
    if (this.fullVectorRevealTimer) {
      window.clearTimeout(this.fullVectorRevealTimer);
    }
    if (this.fullVectorRevealRaf) {
      window.cancelAnimationFrame?.(this.fullVectorRevealRaf);
    }
    this.fullVectorRevealKey = null;
    this.fullVectorRevealPlan = null;
    this.fullVectorRevealFrame = 0;
    this.fullVectorRevealTimer = null;
    this.fullVectorRevealRaf = null;
    this.fullVectorRevealCoordinates = null;
    if (clearLine) {
      this.#renderFullVectorPath([]);
    }
  }

  #fitRecentPath(position = null) {
    const recentCoordinates = this.pathCoordinates.slice(-this.recentFitPointLimit);
    if (position) {
      const current = [position.lng, position.lat];
      const last = recentCoordinates[recentCoordinates.length - 1];
      if (!last || last[0] !== current[0] || last[1] !== current[1]) {
        recentCoordinates.push(current);
      }
    }

    if (recentCoordinates.length > 1) {
      const bounds = recentCoordinates.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(recentCoordinates[0], recentCoordinates[0]));
      this.map.fitBounds(bounds, { padding: 40, maxZoom: 17 });
    } else if (recentCoordinates.length === 1) {
      this.map.flyTo({
        center: recentCoordinates[0],
        zoom: 16
      });
    } else if (position) {
      this.map.flyTo({
        center: [position.lng, position.lat],
        zoom: 16
      });
    }
  }

  #flushPendingUpdates() {
    if (this.pendingFullPathStates.length > 0) {
      const fullPathStates = this.pendingFullPathStates;
      this.pendingFullPathStates = [];
      for (const { points, meta } of fullPathStates) {
        this.loadFullPath(points, meta);
      }
    }

    if (this.pendingLivePositions.length > 0) {
      const livePositions = this.pendingLivePositions;
      this.pendingLivePositions = [];
      for (const { position, meta } of livePositions) {
        this.applyLivePosition(position, meta);
      }
    }

    if (this.pendingMarkerPosition) {
      const markerPosition = this.pendingMarkerPosition;
      this.pendingMarkerPosition = null;
      this.setCurrentPosition(markerPosition);
    }
  }

  reset(runId = null) {
    this.pathState.reset(runId);
    this.pathCoordinates = [];
    this.pendingFullPathStates = [];
    this.pendingLivePositions = [];
    this.pendingMarkerPosition = null;
    this.userHasInteracted = false; // Reset interaction tracking
    this.updatesSinceFit = 0;
    this.fullPathBounds = null;
    this.archiveTileVersion = null;
    this.archiveTileRendererRevision = null;
    this.hasInitialPathFit = false;
    this.#resetFullVectorPath();
    this.removeArchiveTiles();
    
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
    if (this.fullPathBounds) {
      this.#fitBoundsObject(this.fullPathBounds, { padding: 50, maxZoom: 16 });
    } else if (this.pathCoordinates.length > 1) {
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

  #normalizeBounds(bounds) {
    if (!bounds || typeof bounds !== 'object') return null;
    const minLat = Number(bounds.minLat);
    const minLng = Number(bounds.minLng);
    const maxLat = Number(bounds.maxLat);
    const maxLng = Number(bounds.maxLng);
    if (![minLat, minLng, maxLat, maxLng].every(Number.isFinite)) return null;
    return {
      minLat: Math.min(minLat, maxLat),
      minLng: Math.min(minLng, maxLng),
      maxLat: Math.max(minLat, maxLat),
      maxLng: Math.max(minLng, maxLng)
    };
  }

  #fitBoundsObject(bounds, options = {}) {
    const normalized = this.#normalizeBounds(bounds);
    if (!normalized || !this.map) return;

    const sw = [normalized.minLng, normalized.minLat];
    const ne = [normalized.maxLng, normalized.maxLat];
    if (sw[0] === ne[0] && sw[1] === ne[1]) {
      this.map.flyTo({ center: sw, zoom: options.maxZoom || 16 });
      return;
    }

    this.map.fitBounds(new maplibregl.LngLatBounds(sw, ne), {
      padding: options.padding ?? 50,
      maxZoom: options.maxZoom ?? 16
    });
  }
}

window.MapManager = MapManager;

(function() {
  const AGENT_IDS = ['ada', 'theo'];
  const AGENT_COLORS = {
    ada: '#d6a84e',
    theo: '#4e9bb0'
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatDistance(meters) {
    const value = Number(meters);
    if (!Number.isFinite(value)) return '--';
    if (value < 1000) return `${Math.max(0, Math.round(value)).toLocaleString()} m`;
    return `${(value / 1000).toLocaleString(undefined, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    })} km`;
  }

  function formatStatus(status) {
    if (!status) return 'idle';
    return String(status).replace(/_/g, ' ');
  }

  function latestNote(agent) {
    if (agent?.lastThought?.reasoning) return agent.lastThought.reasoning;
    return 'Waiting for the first choice.';
  }

  function svgNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function svgPoint(value) {
    return {
      x: Math.max(0, Math.min(1, svgNumber(value?.x, 0.5))) * 768,
      y: Math.max(0, Math.min(1, svgNumber(value?.y, 0.5))) * 512
    };
  }

  function scratchpadLandmarkSvg(operation, className, color, width) {
    const center = svgPoint(operation.center);
    const radius = Math.max(12, Math.min(78, svgNumber(operation.radius, 0.055) * 768));
    const symbol = operation.symbol || 'dot';
    if (symbol === 'dot') {
      return `<circle class="rv-scratch-stroke${className}" cx="${center.x}" cy="${center.y}" r="${radius * 0.55}" fill="${escapeHtml(color)}" stroke="${escapeHtml(color)}" stroke-width="${width}" />`;
    }
    if (symbol === 'square') {
      const size = radius * 1.25;
      return `<rect class="rv-scratch-stroke${className}" x="${center.x - size / 2}" y="${center.y - size / 2}" width="${size}" height="${size}" stroke="${escapeHtml(color)}" stroke-width="${width}" />`;
    }
    if (symbol === 'park') {
      return [
        `<circle class="rv-scratch-stroke${className}" cx="${center.x}" cy="${center.y - radius * 0.18}" r="${radius * 0.52}" stroke="${escapeHtml(color)}" stroke-width="${width}" />`,
        `<path class="rv-scratch-stroke${className}" pathLength="1" d="M ${center.x} ${center.y + radius * 0.3} L ${center.x} ${center.y + radius * 0.85} M ${center.x - radius * 0.32} ${center.y + radius * 0.85} L ${center.x + radius * 0.32} ${center.y + radius * 0.85}" stroke="${escapeHtml(color)}" stroke-width="${width}" />`
      ].join('');
    }
    if (symbol === 'star') {
      const points = Array.from({ length: 10 }, (_, index) => {
        const angle = -Math.PI / 2 + index * Math.PI / 5;
        const pointRadius = index % 2 === 0 ? radius * 0.72 : radius * 0.32;
        return `${center.x + Math.cos(angle) * pointRadius} ${center.y + Math.sin(angle) * pointRadius}`;
      }).join(' L ');
      return `<path class="rv-scratch-stroke${className}" pathLength="1" d="M ${points} Z" stroke="${escapeHtml(color)}" stroke-width="${width}" />`;
    }
    const points = [
      `${center.x} ${center.y - radius}`,
      `${center.x + radius} ${center.y}`,
      `${center.x} ${center.y + radius}`,
      `${center.x - radius} ${center.y}`
    ].join(' L ');
    return `<path class="rv-scratch-stroke${className}" pathLength="1" d="M ${points} Z" stroke="${escapeHtml(color)}" stroke-width="${width}" />`;
  }

  function scratchpadSketchSvg(operation, isNew) {
    const className = isNew ? ' is-new' : '';
    const color = operation.author === 'theo' ? '#087fa8' : '#24211d';
    const fill = operation.author === 'theo' ? '#cbdde0' : '#d8d0bf';
    const wash = operation.author === 'theo' ? '#8fbcc7' : '#a89c87';
    const details = new Set(Array.isArray(operation.details) ? operation.details : []);
    const label = escapeHtml(operation.label || (operation.scene === 'park' ? 'THE PARK' : 'STREET'));
    const secondary = escapeHtml(operation.secondaryLabel || '');
    const windows = Array.from({ length: 15 }, (_, index) => {
      const left = index < 8;
      const local = left ? index : index - 8;
      const col = local % 2;
      const row = Math.floor(local / 2);
      const x = left ? 92 + col * 74 + row * 10 : 592 + col * 68 - row * 10;
      const y = 112 + row * 58;
      return `<rect x="${x}" y="${y}" width="42" height="28" rx="2" fill="none" stroke="${color}" stroke-width="3" opacity="0.72" />`;
    }).join('');
    const tree = details.has('tree') || operation.scene === 'park'
      ? `<g transform="translate(${operation.scene === 'park' ? 250 : 535} 236)"><path d="M 0 58 C 4 28 2 2 8 -30" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" /><path d="M 8 -24 C -34 -34 -49 -77 -16 -95 C 2 -130 48 -113 48 -80 C 78 -62 55 -24 8 -24 Z" fill="${wash}" fill-opacity="0.3" stroke="${color}" stroke-width="5" /></g>`
      : '';
    const trafficLight = details.has('trafficLight')
      ? `<g transform="translate(493 111)"><path d="M 0 0 L 0 184 M 0 18 L 64 18" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" /><rect x="52" y="4" width="36" height="83" rx="6" fill="${fill}" stroke="${color}" stroke-width="4" /><circle cx="70" cy="23" r="8" fill="#b45a4c" /><circle cx="70" cy="45" r="8" fill="#cfad50" /><circle cx="70" cy="67" r="8" fill="#69936f" /></g>`
      : '';
    const awning = details.has('awning') || details.has('storefront') || operation.scene === 'storefront'
      ? `<g><path d="M 70 314 L 258 314 L 238 350 L 88 350 Z" fill="${wash}" fill-opacity="0.38" stroke="${color}" stroke-width="4" /><path d="M 99 315 L 99 348 M 132 315 L 132 348 M 165 315 L 165 348 M 198 315 L 198 348 M 231 315 L 231 348" stroke="${color}" stroke-width="3" opacity="0.7" /><rect x="105" y="350" width="116" height="80" fill="none" stroke="${color}" stroke-width="4" /></g>`
      : '';
    const station = operation.scene === 'station' || details.has('stairs')
      ? `<g transform="translate(465 340)"><path d="M 0 0 L 145 0 L 117 94 L 25 94 Z" fill="${fill}" fill-opacity="0.72" stroke="${color}" stroke-width="5" /><path d="M 22 18 L 126 18 M 30 36 L 121 36 M 36 54 L 115 54 M 42 72 L 109 72" stroke="${color}" stroke-width="3" /><circle cx="13" cy="-24" r="24" fill="${wash}" fill-opacity="0.28" stroke="${color}" stroke-width="5" /><text x="13" y="-13" text-anchor="middle" fill="${color}" font-family="serif" font-size="31">M</text></g>`
      : '';
    const landmark = details.has('tower') || details.has('church') || details.has('clock') || operation.scene === 'landmark'
      ? `<g transform="translate(324 80)"><path d="M 0 184 L 20 58 L 45 20 L 70 58 L 91 184 Z" fill="${fill}" fill-opacity="0.74" stroke="${color}" stroke-width="5" /><path d="M 45 20 L 45 -18" stroke="${color}" stroke-width="5" /><circle cx="45" cy="82" r="18" fill="none" stroke="${color}" stroke-width="4" /></g>`
      : '';
    const park = operation.scene === 'park'
      ? `<path d="M 52 352 C 154 305 266 316 356 371 C 446 425 562 414 716 346 L 716 486 L 52 486 Z" fill="#aabf9c" fill-opacity="0.28" stroke="${color}" stroke-width="5" />`
      : '';
    const rotation = { north: -90, northeast: -45, east: 0, southeast: 45, south: 90, southwest: 135, west: 180, northwest: 225 }[operation.movement];
    const movement = Number.isFinite(rotation)
      ? `<g transform="translate(384 453) rotate(${rotation})"><path d="M -54 0 C -18 -15 18 -15 54 0 M 38 -16 L 56 0 L 38 16" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" /></g>`
      : '';
    return `<g class="rv-scratch-sketch${className}" filter="url(#rv-pencil)"><path d="M 42 90 L 278 58 L 300 358 L 48 424 Z" fill="${fill}" fill-opacity="0.62" stroke="${color}" stroke-width="5" /><path d="M 726 86 L 490 58 L 468 358 L 720 424 Z" fill="${fill}" fill-opacity="0.62" stroke="${color}" stroke-width="5" />${windows}${awning}${park}${tree}${trafficLight}${station}${landmark}<path d="M 301 358 L 467 358 L 632 512 L 136 512 Z" fill="${wash}" fill-opacity="0.16" stroke="${color}" stroke-width="5" /><path d="M 384 358 L 384 512" stroke="${color}" stroke-width="4" stroke-dasharray="22 18" opacity="0.58" /><g transform="translate(278 44) rotate(-2)"><path d="M 0 0 L 214 0 L 205 56 L 8 56 Z" fill="#eee4cc" stroke="${color}" stroke-width="5" /><text x="107" y="37" text-anchor="middle" fill="${color}" font-family="serif" font-size="27">${label}</text></g>${secondary ? `<g transform="translate(405 96) rotate(3)"><path d="M 0 0 L 185 0 L 178 46 L 8 46 Z" fill="#eee4cc" stroke="${color}" stroke-width="4" /><text x="92" y="31" text-anchor="middle" fill="${color}" font-family="serif" font-size="21">${secondary}</text></g>` : ''}${movement}</g>`;
  }

  function scratchpadOperationSvg(operation, isNew) {
    const className = isNew ? ' is-new' : '';
    const color = operation.author === 'theo' ? '#087fa8' : '#24211d';
    const width = Math.max(1, Math.min(80, svgNumber(operation.width, 4)));
    if (operation.type === 'sketch') return scratchpadSketchSvg(operation, isNew);
    if (operation.type === 'text') {
      const at = svgPoint(operation.at);
      const size = Math.max(14, Math.min(54, svgNumber(operation.size, 28)));
      const rotation = Math.max(-18, Math.min(18, svgNumber(operation.rotation, 0)));
      return `<text class="rv-scratch-text${className}" x="${at.x}" y="${at.y}" fill="${escapeHtml(color)}" font-size="${size}" transform="rotate(${rotation} ${at.x} ${at.y})">${escapeHtml(operation.text || '')}</text>`;
    }
    if (operation.type === 'circle') {
      const center = svgPoint(operation.center);
      const rx = Math.max(4, svgNumber(operation.radiusX, 0.1) * 768);
      const ry = Math.max(4, svgNumber(operation.radiusY, 0.1) * 512);
      return `<ellipse class="rv-scratch-stroke${className}" pathLength="1" cx="${center.x}" cy="${center.y}" rx="${rx}" ry="${ry}" stroke="${escapeHtml(color)}" stroke-width="${width}" />`;
    }
    if (operation.type === 'landmark') {
      const center = svgPoint(operation.center);
      const radius = Math.max(12, Math.min(78, svgNumber(operation.radius, 0.055) * 768));
      const label = operation.label
        ? `<text class="rv-scratch-text${className}" x="${center.x + radius + 8}" y="${center.y + 5}" fill="${escapeHtml(color)}" font-size="22">${escapeHtml(operation.label)}</text>`
        : '';
      return `${scratchpadLandmarkSvg(operation, className, color, width)}${label}`;
    }
    if (operation.type === 'stroke') {
      const points = (operation.points || []).map(svgPoint);
      if (points.length < 2) return '';
      const d = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
      return `<path class="rv-scratch-stroke${className}" pathLength="1" d="${d}" stroke="${escapeHtml(color)}" stroke-width="${width}" />`;
    }
    if (['line', 'arrow', 'erase'].includes(operation.type)) {
      const from = svgPoint(operation.from);
      const to = svgPoint(operation.to);
      const stroke = operation.type === 'erase' ? '#f2ecdd' : color;
      let svg = `<path class="rv-scratch-stroke${className}" pathLength="1" d="M ${from.x} ${from.y} L ${to.x} ${to.y}" stroke="${escapeHtml(stroke)}" stroke-width="${width}" />`;
      if (operation.type === 'arrow') {
        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        const length = Math.max(12, width * 4);
        const left = { x: to.x - Math.cos(angle - Math.PI / 6) * length, y: to.y - Math.sin(angle - Math.PI / 6) * length };
        const right = { x: to.x - Math.cos(angle + Math.PI / 6) * length, y: to.y - Math.sin(angle + Math.PI / 6) * length };
        svg += `<path class="rv-scratch-stroke${className}" pathLength="1" d="M ${left.x} ${left.y} L ${to.x} ${to.y} L ${right.x} ${right.y}" stroke="${escapeHtml(color)}" stroke-width="${width}" />`;
      }
      return svg;
    }
    return '';
  }

  class RendezvousApp {
    constructor() {
      this.socket = null;
      this.state = null;
      this.map = null;
      this.mapLoaded = false;
      this.panoramas = {};
      this.markers = {};
      this.targetMarker = null;
      this.googleReady = false;
      this.pendingStreetState = null;
      this.mobileView = 'ada';
      this.lastScratchpadSequence = 0;
    }

    initialize() {
      this.connectSocket();
      this.setupControls();
      this.initializeMap();
      this.waitForGoogleMaps();
      window.lucide?.createIcons?.();
      window.rendezvousApp = this;
    }

    connectSocket() {
      this.socket = io({
        transports: ['polling', 'websocket'],
        reconnection: true,
        reconnectionAttempts: 8,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000
      });

      this.socket.on('connect', () => {
        this.socket.emit('join-rendezvous');
      });

      this.socket.on('rendezvous-state', (state) => {
        this.applyState(state);
      });

      this.socket.on('rendezvous-step', (step) => {
        this.flashAgent(step.agentId);
        this.pulseDock(step.agentId);
      });

      this.socket.on('rendezvous-scratchpad', () => {
        const paper = document.getElementById('rvPaper');
        paper?.classList.remove('pulse');
        void paper?.offsetWidth;
        paper?.classList.add('pulse');
        window.setTimeout(() => paper?.classList.remove('pulse'), 750);
      });

      this.socket.on('rendezvous-found', (payload) => {
        this.showFound(payload);
      });

      this.socket.on('rendezvous-error', (payload) => {
        this.showToast(payload?.message || 'Rendezvous error', 'error');
      });
    }

    setupControls() {
      document.getElementById('rvStartBtn')?.addEventListener('click', () => {
        this.socket.emit('start-rendezvous', { token: this.getAuthToken() });
      });
      document.getElementById('rvStopBtn')?.addEventListener('click', () => {
        this.socket.emit('stop-rendezvous', { token: this.getAuthToken() });
      });
      document.getElementById('rvResetBtn')?.addEventListener('click', () => {
        if (window.confirm('Start a fresh two-agent rendezvous run?')) {
          this.socket.emit('reset-rendezvous', { token: this.getAuthToken() });
          this.socket.emit('start-rendezvous', { token: this.getAuthToken() });
        }
      });
      document.getElementById('rvFitBtn')?.addEventListener('click', () => this.fitMap());
      this.setupMobileTabs();
    }

    setupMobileTabs() {
      const buttons = Array.from(document.querySelectorAll('button[data-mobile-view]'));
      if (!buttons.length) return;

      const setView = (view) => this.setMobileView(view);
      for (const button of buttons) {
        button.setAttribute('aria-pressed', button.dataset.mobileView === this.mobileView ? 'true' : 'false');
        button.addEventListener('click', () => setView(button.dataset.mobileView || 'ada'));
      }
      this.mobileMedia = window.matchMedia('(max-width: 900px)');
      const syncMobileView = () => {
        if (this.mobileMedia.matches) {
          document.body.dataset.mobileView = this.mobileView;
        } else {
          document.body.removeAttribute('data-mobile-view');
        }
        if (this.mobileMedia.matches && this.mobileView === 'map') {
          this.resizeMapPane();
        }
      };
      if (typeof this.mobileMedia.addEventListener === 'function') {
        this.mobileMedia.addEventListener('change', syncMobileView);
      } else {
        this.mobileMedia.addListener?.(syncMobileView);
      }
      syncMobileView();
    }

    setMobileView(view) {
      const allowed = new Set(['ada', 'theo', 'pad', 'map']);
      this.mobileView = allowed.has(view) ? view : 'ada';
      if (this.mobileMedia?.matches === false) {
        document.body.removeAttribute('data-mobile-view');
      } else {
        document.body.dataset.mobileView = this.mobileView;
      }
      for (const button of document.querySelectorAll('button[data-mobile-view]')) {
        const active = button.dataset.mobileView === this.mobileView;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
      if (this.mobileView === 'map') {
        this.resizeMapPane();
      }
    }

    resizeMapPane() {
      window.setTimeout(() => {
        this.map?.resize();
        this.fitMap();
      }, 80);
    }

    getAuthToken() {
      return window.adminAuth?.authToken || null;
    }

    initializeMap() {
      if (!window.maplibregl) return;
      this.map = new maplibregl.Map({
        container: 'rvMap',
        style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
        center: [-73.985, 40.75],
        zoom: 13,
        attributionControl: false
      });
      this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      this.map.on('load', () => {
        this.mapLoaded = true;
        for (const agentId of AGENT_IDS) {
          this.map.addSource(`rv-path-${agentId}`, {
            type: 'geojson',
            data: this.emptyLine()
          });
          this.map.addLayer({
            id: `rv-path-${agentId}`,
            type: 'line',
            source: `rv-path-${agentId}`,
            layout: {
              'line-join': 'round',
              'line-cap': 'round'
            },
            paint: {
              'line-color': AGENT_COLORS[agentId],
              'line-width': 2.25,
              'line-opacity': 0.78
            }
          });
        }
        this.renderMap();
      });
    }

    emptyLine() {
      return {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: []
        }
      };
    }

    waitForGoogleMaps() {
      const check = () => {
        if (window.google?.maps?.StreetViewPanorama) {
          this.googleReady = true;
          if (this.pendingStreetState) {
            this.renderStreetViews(this.pendingStreetState);
            this.pendingStreetState = null;
          }
          return;
        }
        window.setTimeout(check, 120);
      };
      check();
    }

    applyState(state) {
      this.state = state;
      this.renderHeader();
      this.renderAgents();
      this.renderScratchpad();
      this.renderMap();
      this.renderLiveContext();
      if (this.googleReady) {
        this.renderStreetViews(state);
      } else {
        this.pendingStreetState = state;
      }
    }

    renderHeader() {
      const state = this.state || {};
      document.getElementById('rvStatus').textContent = formatStatus(state.status);
      document.getElementById('rvDistance').textContent = formatDistance(state.meeting?.distanceMeters);
      document.getElementById('rvTurn').textContent = Number(state.turn || 0).toLocaleString();

      const startBtn = document.getElementById('rvStartBtn');
      const stopBtn = document.getElementById('rvStopBtn');
      if (startBtn) startBtn.disabled = state.status === 'running';
      if (stopBtn) stopBtn.disabled = state.status !== 'running';
    }

    renderAgents() {
      for (const agentId of AGENT_IDS) {
        const agent = this.state?.agents?.[agentId];
        if (!agent) continue;
        document.getElementById(`${agentId}Name`).textContent = agent.name || agentId;
        document.getElementById(`${agentId}Step`).textContent = `${Number(agent.stepCount || 0).toLocaleString()} steps`;
        document.getElementById(`${agentId}State`).textContent = formatStatus(agent.status);
        document.getElementById(`${agentId}LastNote`).textContent = latestNote(agent);
        const dockStep = document.getElementById(`${agentId}DockStep`);
        if (dockStep) dockStep.textContent = Number(agent.stepCount || 0).toLocaleString();
      }
    }

    renderLiveContext() {
      // Mobile navigation intentionally stays quiet; live context remains in the header.
    }

    renderStreetViews(state) {
      for (const agentId of AGENT_IDS) {
        const agent = state?.agents?.[agentId];
        if (!agent?.panoId) continue;
        const container = document.getElementById(agentId === 'ada' ? 'streetAda' : 'streetTheo');
        if (!container) continue;

        if (!this.panoramas[agentId]) {
          this.panoramas[agentId] = new google.maps.StreetViewPanorama(container, {
            pano: agent.panoId,
            pov: { heading: Number(agent.heading) || 0, pitch: 0 },
            zoom: 1,
            addressControl: false,
            linksControl: true,
            panControl: false,
            enableCloseButton: false,
            fullscreenControl: false,
            zoomControl: false,
            motionTracking: false,
            motionTrackingControl: false,
            showRoadLabels: true,
            imageDateControl: false
          });
        } else if (this.panoramas[agentId].getPano() !== agent.panoId) {
          this.panoramas[agentId].setPano(agent.panoId);
        }

        if (Number.isFinite(Number(agent.heading))) {
          this.panoramas[agentId].setPov({
            heading: Number(agent.heading),
            pitch: 0
          });
        }
      }
    }

    renderMap() {
      if (!this.mapLoaded || !this.state) return;
      for (const agentId of AGENT_IDS) {
        const agent = this.state.agents?.[agentId];
        const coordinates = (agent?.path || [])
          .filter(point => Number.isFinite(Number(point.lng)) && Number.isFinite(Number(point.lat)))
          .map(point => [Number(point.lng), Number(point.lat)]);
        const source = this.map.getSource(`rv-path-${agentId}`);
        if (source) {
          source.setData({
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'LineString',
              coordinates
            }
          });
        }
        if (agent?.position) {
          this.updateMarker(agentId, agent);
        }
      }

      const target = this.state.meeting?.target;
      if (target?.position) {
        this.updateTargetMarker(target);
      } else if (this.targetMarker) {
        this.targetMarker.remove?.();
        this.targetMarker = null;
      }

      if (!this.hasFitOnce) {
        this.hasFitOnce = true;
        this.fitMap();
      }
      if (this.mobileView === 'map') {
        this.resizeMapPane();
      }
    }

    updateMarker(agentId, agent) {
      const lngLat = [Number(agent.position.lng), Number(agent.position.lat)];
      const foundOffset = this.state?.status === 'found'
        ? [agentId === 'ada' ? -11 : 11, 0]
        : [0, 0];
      if (!this.markers[agentId]) {
        const el = document.createElement('div');
        el.className = `rv-map-marker ${agentId}`;
        el.style.cssText = [
          'width:18px',
          'height:18px',
          `background:${AGENT_COLORS[agentId]}`,
          'border:2px solid #071014',
          'border-radius:50%',
          'box-shadow:0 0 0 3px rgba(255,255,255,0.22)'
        ].join(';');
        this.markers[agentId] = new maplibregl.Marker({ element: el, offset: foundOffset })
          .setLngLat(lngLat)
          .setPopup(new maplibregl.Popup({ offset: 18 }).setText(agent.name || agentId))
          .addTo(this.map);
      } else {
        this.markers[agentId]
          .setLngLat(lngLat)
          .setOffset(foundOffset);
      }
    }

    updateTargetMarker(target) {
      const lngLat = [Number(target.position.lng), Number(target.position.lat)];
      if (!this.targetMarker) {
        const el = document.createElement('div');
        el.className = 'rv-map-target';
        el.style.cssText = [
          'width:22px',
          'height:22px',
          'border:2px solid #f4f5f7',
          'background:#111820',
          'border-radius:8px',
          'box-shadow:0 0 0 4px rgba(110,231,167,0.25)'
        ].join(';');
        this.targetMarker = new maplibregl.Marker({ element: el })
          .setLngLat(lngLat)
          .setPopup(new maplibregl.Popup({ offset: 18 }).setText(`Search near ${target.name}`))
          .addTo(this.map);
      } else {
        this.targetMarker.setLngLat(lngLat);
      }
    }

    fitMap() {
      if (!this.map || !this.state) return;
      const points = [];
      for (const agentId of AGENT_IDS) {
        const agent = this.state.agents?.[agentId];
        for (const point of agent?.path || []) {
          if (Number.isFinite(Number(point.lng)) && Number.isFinite(Number(point.lat))) {
            points.push([Number(point.lng), Number(point.lat)]);
          }
        }
      }
      const target = this.state.meeting?.target?.position;
      if (target) points.push([Number(target.lng), Number(target.lat)]);
      if (points.length === 0) return;
      const bounds = new maplibregl.LngLatBounds(points[0], points[0]);
      for (const point of points) bounds.extend(point);
      this.map.fitBounds(bounds, {
        padding: 48,
        maxZoom: 16,
        duration: 650
      });
    }

    renderScratchpad() {
      const svg = document.getElementById('rvScratchpad');
      const image = document.getElementById('rvScratchpadImage');
      const scratchpad = this.state?.scratchpad || {};
      const rasterMessage = Number(scratchpad.version) >= 5 ? scratchpad.currentMessage : null;
      const operations = Array.isArray(scratchpad.currentOperations)
        ? scratchpad.currentOperations
        : (Array.isArray(scratchpad.operations) ? scratchpad.operations : []);
      const sequence = Number(scratchpad.sequence || 0);
      const previousSequence = this.lastScratchpadSequence;
      const ruledLines = Array.from({ length: 12 }, (_, index) => {
        const y = 52 + index * 38;
        return `<line x1="22" y1="${y}" x2="746" y2="${y}" stroke="rgba(72,103,111,0.10)" stroke-width="1" />`;
      }).join('');
      const margin = '<line x1="58" y1="18" x2="58" y2="494" stroke="rgba(180,77,67,0.16)" stroke-width="1" />';
      const defs = '<defs><filter id="rv-pencil" x="-4%" y="-4%" width="108%" height="108%"><feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="2" seed="7" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="1.35" xChannelSelector="R" yChannelSelector="G"/></filter></defs>';
      const marks = operations.map(operation => scratchpadOperationSvg(
        operation,
        Number(operation.sequence || 0) > previousSequence
      )).join('');
      if (rasterMessage?.imageUrl && image) {
        if (image.src !== new URL(rasterMessage.imageUrl, window.location.origin).href) {
          image.src = rasterMessage.imageUrl;
        }
        image.alt = `Drawing from ${rasterMessage.from === 'theo' ? 'Theo' : 'Ada'} to ${rasterMessage.to === 'ada' ? 'Ada' : 'Theo'}`;
        image.hidden = false;
        if (svg) svg.hidden = true;
      } else if (svg) {
        if (image) image.hidden = true;
        svg.hidden = false;
        const emptyState = Number(scratchpad.version) >= 5
          ? ''
          : '<text class="rv-pad-empty" x="384" y="270" text-anchor="middle">Nothing here yet.</text>';
        svg.innerHTML = `${defs}${ruledLines}${margin}${marks || emptyState}`;
      }

      const sequenceLabel = document.getElementById('rvPadSequence');
      if (sequenceLabel) {
        const from = scratchpad.messageFrom === 'theo' ? 'Theo' : scratchpad.messageFrom === 'ada' ? 'Ada' : null;
        const to = scratchpad.messageTo === 'ada' ? 'Ada' : scratchpad.messageTo === 'theo' ? 'Theo' : null;
        const owner = scratchpad.owner === 'theo' ? 'Theo' : 'Ada';
        sequenceLabel.textContent = from && to ? `${from} → ${to}` : `${owner} holds it`;
      }
      this.lastScratchpadSequence = Math.max(previousSequence, sequence);
    }

    flashAgent(agentId) {
      const panel = document.querySelector(`.rv-agent-panel.${agentId}`);
      if (!panel) return;
      panel.classList.add('is-stepping');
      panel.animate([
        { boxShadow: '0 0 0 rgba(255,255,255,0)' },
        { boxShadow: `0 0 0 3px ${AGENT_COLORS[agentId]}66` },
        { boxShadow: '0 0 0 rgba(255,255,255,0)' }
      ], {
        duration: 650,
        easing: 'ease-out'
      });
      window.setTimeout(() => panel.classList.remove('is-stepping'), 700);
    }

    pulseDock(agentId) {
      const button = document.querySelector(`.rv-mobile-tab[data-mobile-view="${agentId}"]`);
      if (!button) return;
      button.classList.remove('attention');
      void button.offsetWidth;
      button.classList.add('attention');
      window.setTimeout(() => button.classList.remove('attention'), 900);
    }

    showFound(payload) {
      this.showToast(payload?.reason || 'They found each other.', 'success');
    }

    showToast(message, kind = 'success') {
      const toast = document.createElement('div');
      toast.className = `admin-notification ${kind}`;
      toast.textContent = message;
      document.body.appendChild(toast);
      window.setTimeout(() => toast.classList.add('show'), 20);
      window.setTimeout(() => {
        toast.classList.remove('show');
        window.setTimeout(() => toast.remove(), 240);
      }, 4200);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const app = new RendezvousApp();
    app.initialize();
  });
})();

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
    if (agent?.lastDecision?.reasoning) return agent.lastDecision.reasoning;
    if (Array.isArray(agent?.recentNotes) && agent.recentNotes.length > 0) {
      return agent.recentNotes.at(-1);
    }
    return 'Waiting for the first move.';
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

  function scratchpadOperationSvg(operation, isNew) {
    const className = isNew ? ' is-new' : '';
    const color = operation.color || (operation.author === 'theo' ? '#185e78' : '#24211d');
    const width = Math.max(1, Math.min(80, svgNumber(operation.width, 4)));
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
      for (const button of document.querySelectorAll('[data-peek-to]')) {
        button.addEventListener('click', () => this.setMobileView(button.dataset.peekTo || 'ada'));
      }
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
      const state = this.state || {};
      const dockDistance = document.getElementById('rvDockDistance');
      const dockPad = document.getElementById('rvDockPad');
      if (dockDistance) dockDistance.textContent = formatDistance(state.meeting?.distanceMeters);
      if (dockPad) dockPad.textContent = Number(state.scratchpad?.sequence || 0).toLocaleString();
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
        this.markers[agentId] = new maplibregl.Marker({ element: el })
          .setLngLat(lngLat)
          .setPopup(new maplibregl.Popup({ offset: 18 }).setText(agent.name || agentId))
          .addTo(this.map);
      } else {
        this.markers[agentId].setLngLat(lngLat);
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
      const scratchpad = this.state?.scratchpad || {};
      const operations = Array.isArray(scratchpad.operations) ? scratchpad.operations : [];
      const sequence = Number(scratchpad.sequence || 0);
      const previousSequence = this.lastScratchpadSequence;
      const ruledLines = Array.from({ length: 12 }, (_, index) => {
        const y = 52 + index * 38;
        return `<line x1="22" y1="${y}" x2="746" y2="${y}" stroke="rgba(72,103,111,0.10)" stroke-width="1" />`;
      }).join('');
      const margin = '<line x1="58" y1="18" x2="58" y2="494" stroke="rgba(180,77,67,0.16)" stroke-width="1" />';
      const marks = operations.map(operation => scratchpadOperationSvg(
        operation,
        Number(operation.sequence || 0) > previousSequence
      )).join('');
      if (svg) {
        svg.innerHTML = `${ruledLines}${margin}${marks || '<text class="rv-pad-empty" x="384" y="270" text-anchor="middle">Nothing here yet.</text>'}`;
      }

      const status = document.getElementById('rvPadStatus');
      const sequenceLabel = document.getElementById('rvPadSequence');
      const transit = scratchpad.inTransit;
      if (status) {
        if (transit) {
          const from = transit.from === 'theo' ? 'Theo' : 'Ada';
          const to = transit.to === 'ada' ? 'Ada' : 'Theo';
          status.textContent = `on its way from ${from} to ${to}`;
        } else {
          status.textContent = `with ${scratchpad.owner === 'theo' ? 'Theo' : 'Ada'}`;
        }
      }
      if (sequenceLabel) {
        sequenceLabel.textContent = sequence > 0 ? `${sequence.toLocaleString()} marks` : 'blank';
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

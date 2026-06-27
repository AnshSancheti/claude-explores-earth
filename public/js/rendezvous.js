(function() {
  const AGENT_IDS = ['ada', 'theo'];
  const AGENT_COLORS = {
    ada: '#ffcc4d',
    theo: '#55d6ff'
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
    }

    initialize() {
      this.connectSocket();
      this.setupControls();
      this.initializeMap();
      this.waitForGoogleMaps();
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
      });

      this.socket.on('rendezvous-telegram', () => {
        const list = document.getElementById('rvTelegrams');
        if (list) list.classList.add('pulse');
        window.setTimeout(() => list?.classList.remove('pulse'), 450);
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
      const buttons = Array.from(document.querySelectorAll('[data-mobile-view]'));
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
      const allowed = new Set(['ada', 'theo', 'map', 'wires', 'log']);
      this.mobileView = allowed.has(view) ? view : 'ada';
      document.body.dataset.mobileView = this.mobileMedia?.matches === false ? '' : this.mobileView;
      for (const button of document.querySelectorAll('[data-mobile-view]')) {
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
              'line-width': 4,
              'line-opacity': 0.85
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
      this.renderTelegrams();
      this.renderLog();
      this.renderMap();
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
      document.getElementById('rvTarget').textContent = state.meeting?.target?.name || '--';
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
      }
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
            addressControl: true,
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
          .setPopup(new maplibregl.Popup({ offset: 18 }).setText(`Meet at ${target.name}`))
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

    renderTelegrams() {
      const telegrams = [...(this.state?.telegrams || [])].slice(-18).reverse();
      const list = document.getElementById('rvTelegrams');
      document.getElementById('rvTelegramCount').textContent = String(this.state?.telegrams?.length || 0);
      if (!list) return;
      if (telegrams.length === 0) {
        list.innerHTML = '<div class="rv-log-entry"><p class="rv-log-text">No wires yet. The friends are still finding words for the city.</p></div>';
        return;
      }
      list.innerHTML = telegrams.map(telegram => {
        const status = telegram.status === 'delivered' ? 'delivered' : 'in transit';
        const statusClass = String(telegram.status || '').replace(/_/g, '-');
        const clues = telegram.clues || {};
        const clueBits = [
          clues.neighborhood,
          clues.nearestLandmark,
          clues.intention
        ].filter(Boolean);
        return `
          <article class="rv-telegram ${escapeHtml(statusClass)} ${escapeHtml(telegram.from)}">
            <div class="rv-wire-head">
              <span>${escapeHtml(telegram.fromName)} to ${escapeHtml(telegram.toName)}</span>
              <span>${escapeHtml(status)}</span>
            </div>
            <p class="rv-wire-text">${escapeHtml(telegram.text)}</p>
            <div class="rv-wire-clues">
              ${clueBits.map(bit => `<span>${escapeHtml(bit)}</span>`).join('')}
            </div>
          </article>
        `;
      }).join('');
    }

    renderLog() {
      const log = document.getElementById('rvLog');
      if (!log) return;
      const entries = [...(this.state?.eventLog || [])]
        .filter(event => ['agent_step', 'rendezvous_found', 'run_created', 'run_started'].includes(event.type))
        .slice(-18)
        .reverse();
      if (entries.length === 0) {
        log.innerHTML = '<div class="rv-log-entry"><p class="rv-log-text">Waiting for the first field note.</p></div>';
        return;
      }
      log.innerHTML = entries.map(event => {
        const payload = event.payload || {};
        const title = event.type === 'agent_step'
          ? `${payload.agentName || payload.agentId} step ${payload.stepCount || ''}`
          : event.type.replace(/_/g, ' ');
        const text = payload.reasoning || payload.reason || payload.target || 'Run updated.';
        return `
          <article class="rv-log-entry">
            <div class="rv-log-head">
              <span>${escapeHtml(title)}</span>
              <span>turn ${Number(event.turn || 0).toLocaleString()}</span>
            </div>
            <p class="rv-log-text">${escapeHtml(text)}</p>
          </article>
        `;
      }).join('');
    }

    flashAgent(agentId) {
      const panel = document.querySelector(`.rv-agent-panel.${agentId}`);
      if (!panel) return;
      panel.animate([
        { boxShadow: '0 0 0 rgba(255,255,255,0)' },
        { boxShadow: `0 0 0 3px ${AGENT_COLORS[agentId]}66` },
        { boxShadow: '0 0 0 rgba(255,255,255,0)' }
      ], {
        duration: 650,
        easing: 'ease-out'
      });
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

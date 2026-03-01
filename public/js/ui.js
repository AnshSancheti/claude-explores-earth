class UIManager {
  constructor() {
    this.decisionLog = document.getElementById('decisionLog');
    this.locationsVisited = document.getElementById('locationsVisited');
    this.distanceTraveled = document.getElementById('distanceTraveled');
    this.currentStep = document.getElementById('currentStep');
    this.startBtn = document.getElementById('startBtn');
    this.stepBtn = document.getElementById('stepBtn');
    this.stopBtn = document.getElementById('stopBtn');
    this.resetBtn = document.getElementById('resetBtn');
    this.loadBtn = document.getElementById('loadBtn');
    this.saveBtn = document.getElementById('saveBtn');
    
    // Track the last autopilot summary group
    this.lastAutopilotGroup = null;
  }

  updateStats(stats) {
    this.locationsVisited.textContent = stats.locationsVisited || 0;
    this.distanceTraveled.textContent = `${stats.distanceTraveled || 0} m`;
  }

  updateStep(step) {
    this.currentStep.textContent = step;
  }

  addDecisionEntry(data) {
    console.log(`Received decision for step ${data.stepCount}, mode: ${data.mode}`);

    if (this.isAutopilotStep(data)) {
      if (
        this.lastAutopilotGroup &&
        this.lastAutopilotGroup.parentElement === this.decisionLog &&
        this.lastAutopilotGroup === this.decisionLog.firstChild
      ) {
        this.updateAutopilotGroup(this.lastAutopilotGroup, data);
        return;
      }

      const group = this.createAutopilotGroup(data);
      this.decisionLog.insertBefore(group, this.decisionLog.firstChild);
      this.lastAutopilotGroup = group;
    } else {
      this.lastAutopilotGroup = null;

      const entry = document.createElement('div');
      entry.className = 'decision-entry exploration-entry';
      entry.setAttribute('data-step', data.stepCount);
      const time = new Date().toLocaleTimeString();
      const modeIndicator = '<span class="mode-indicator exploring">🔍</span>';
      const diaryLine = data.diaryLine || data.reasoning || '';
      const actionReason = data.actionReason && data.actionReason !== diaryLine
        ? `<div class="decision-action">${escapeHtml(data.actionReason)}</div>`
        : '';
      const screenshots = Array.isArray(data.screenshots) ? data.screenshots : [];

      entry.innerHTML = `
        <div class="decision-header">
          <span class="decision-step">${modeIndicator} Step ${data.stepCount}</span>
          <span class="decision-time">${time}</span>
        </div>
        <div class="decision-reasoning">${escapeHtml(diaryLine)}</div>
        ${actionReason}
        <div class="decision-screenshots">
          ${screenshots.map(s => {
            // Generate Google Maps Street View URL
            const lat = s.position ? s.position.lat : 0;
            const lng = s.position ? s.position.lng : 0;
            const heading = Math.round(s.direction);
            const mapsUrl = `https://www.google.com/maps/@${lat},${lng},3a,75y,${heading}h,90t/data=!3m6!1e1!3m4!1s!2e0!7i16384!8i8192`;
            
            return `
              <div class="screenshot-thumb" style="cursor: pointer;" onclick="window.open('${mapsUrl}', '_blank')" title="Click to view in Google Maps">
                <img src="${s.thumbnail}" alt="Direction ${heading}°" onerror="console.error('Failed to load:', this.src)" style="pointer-events: none;">
                <div class="screenshot-label ${s.visited ? 'visited-badge' : ''}" style="pointer-events: none;">
                  ${heading}° ${s.visited ? '(V)' : ''}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;
      
      this.decisionLog.insertBefore(entry, this.decisionLog.firstChild);
    }
    
    // Clean up old entries
    while (this.decisionLog.children.length > 20) {
      this.decisionLog.removeChild(this.decisionLog.lastChild);
    }
  }

  isAutopilotStep(data) {
    return data.autoMove === true || data.mode === 'pathfinding';
  }

  shouldRecordAutopilotDetail(data) {
    if (data.eventType === 'teleport-frontier' || data.eventType === 'dead-end-recovery') return true;
    if (!data.diaryLine) return false;
    return data.diaryLine !== data.actionReason;
  }

  buildAutopilotSummary(group) {
    const total = parseInt(group.getAttribute('data-total-steps') || '0', 10);
    const single = parseInt(group.getAttribute('data-single-link-count') || '0', 10);
    const path = parseInt(group.getAttribute('data-pathfinding-count') || '0', 10);
    const teleports = parseInt(group.getAttribute('data-teleport-count') || '0', 10);

    const parts = [`${total} auto step${total === 1 ? '' : 's'}`];
    if (single > 0) parts.push(`${single} corridor`);
    if (path > 0) parts.push(`${path} frontier`);
    if (teleports > 0) parts.push(`${teleports} teleport${teleports === 1 ? '' : 's'}`);
    return parts.join(' · ');
  }

  updateAutopilotCounters(group, data) {
    const increment = (name) => {
      const current = parseInt(group.getAttribute(name) || '0', 10);
      group.setAttribute(name, String(current + 1));
    };

    increment('data-total-steps');
    if (data.eventType === 'autopilot-single-link') increment('data-single-link-count');
    if (data.eventType === 'autopilot-pathfinding') increment('data-pathfinding-count');
    if (data.eventType === 'teleport-frontier') increment('data-teleport-count');
  }

  appendAutopilotDetail(group, data) {
    if (!this.shouldRecordAutopilotDetail(data)) return;
    const details = group.querySelector('.pathfinding-details');
    const detail = document.createElement('div');
    detail.className = 'pathfinding-step-detail';
    detail.textContent = `Step ${data.stepCount}: ${data.diaryLine || data.reasoning}`;
    details.appendChild(detail);
  }

  createAutopilotGroup(data) {
    const group = document.createElement('div');
    group.className = 'decision-entry pathfinding-group autopilot-group collapsed';
    group.setAttribute('data-start-step', data.stepCount);
    group.setAttribute('data-end-step', data.stepCount);
    group.setAttribute('data-total-steps', '0');
    group.setAttribute('data-single-link-count', '0');
    group.setAttribute('data-pathfinding-count', '0');
    group.setAttribute('data-teleport-count', '0');

    this.updateAutopilotCounters(group, data);
    const time = new Date().toLocaleTimeString();
    const summary = this.buildAutopilotSummary(group);
    const remaining = Number.isFinite(data.remainingPathSteps) ? data.remainingPathSteps : null;
    const remainingLabel = remaining !== null 
      ? `<span class="pathfinding-count">Frontier: ${remaining} step${remaining === 1 ? '' : 's'} away</span>`
      : '';

    group.innerHTML = `
      <div class="decision-header pathfinding-header" onclick="UIManager.toggleAutopilotGroup(this)">
        <span class="decision-step">
          <span class="mode-indicator pathfinding">🧭</span>
          <span class="step-range">Step ${data.stepCount}</span>
        </span>
        <span class="autopilot-summary">${summary}</span>
        ${remainingLabel}
        <span class="expand-icon">▶</span>
        <span class="decision-time">${time}</span>
      </div>
      <div class="pathfinding-details" style="display: none;"></div>
    `;

    this.appendAutopilotDetail(group, data);
    return group;
  }

  updateAutopilotGroup(group, data) {
    const startStep = parseInt(group.getAttribute('data-start-step'));
    const endStep = data.stepCount;
    const stepCount = endStep - startStep + 1;

    group.setAttribute('data-end-step', endStep);
    this.updateAutopilotCounters(group, data);

    // Update the header
    const stepRange = group.querySelector('.step-range');
    const time = group.querySelector('.decision-time');
    const summary = group.querySelector('.autopilot-summary');
    let count = group.querySelector('.pathfinding-count');

    if (stepCount === 1) {
      stepRange.textContent = `Step ${startStep}`;
    } else {
      stepRange.textContent = `Steps ${startStep}-${endStep}`;
    }
    time.textContent = new Date().toLocaleTimeString();
    summary.textContent = this.buildAutopilotSummary(group);

    // Update or create the remaining steps label
    const remaining = Number.isFinite(data.remainingPathSteps) ? data.remainingPathSteps : null;
    if (remaining !== null) {
      const text = `Frontier: ${remaining} step${remaining === 1 ? '' : 's'} away`;
      if (!count) {
        count = document.createElement('span');
        count.className = 'pathfinding-count';
        // Insert after step-range
        const stepSpan = group.querySelector('.decision-step');
        stepSpan.insertAdjacentElement('afterend', count);
      }
      count.textContent = text;
    } else if (count) {
      // Remove label if not applicable
      count.remove();
    }

    this.appendAutopilotDetail(group, data);
  }

  static toggleAutopilotGroup(header) {
    const group = header.parentElement;
    const details = group.querySelector('.pathfinding-details');
    const icon = header.querySelector('.expand-icon');

    if (group.classList.contains('collapsed')) {
      group.classList.remove('collapsed');
      group.classList.add('expanded');
      details.style.display = 'block';
      icon.textContent = '▼';
    } else {
      group.classList.add('collapsed');
      group.classList.remove('expanded');
      details.style.display = 'none';
      icon.textContent = '▶';
    }
  }

  static togglePathfindingGroup(header) {
    UIManager.toggleAutopilotGroup(header);
  }

  setExplorationState(isExploring) {
    this.startBtn.disabled = isExploring;
    this.stepBtn.disabled = isExploring;
    this.stopBtn.disabled = !isExploring;
    this.resetBtn.disabled = isExploring;
    // Save is allowed in either state
  }
  
  setStepButtonState(disabled) {
    this.stepBtn.disabled = disabled;
  }

  clearDecisionLog() {
    this.decisionLog.innerHTML = '';
    this.lastAutopilotGroup = null;
  }

  showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #f44336;
      color: white;
      padding: 15px 20px;
      border-radius: 8px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      z-index: 1000;
      animation: slideIn 0.3s ease;
    `;
    errorDiv.textContent = `Error: ${message}`;
    
    document.body.appendChild(errorDiv);
    
    setTimeout(() => {
      errorDiv.remove();
    }, 5000);
  }

  showSuccess(message) {
    const successDiv = document.createElement('div');
    successDiv.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #4CAF50;
      color: white;
      padding: 15px 20px;
      border-radius: 8px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      z-index: 1000;
      animation: slideIn 0.3s ease;
    `;
    successDiv.textContent = message;
    
    document.body.appendChild(successDiv);
    
    setTimeout(() => {
      successDiv.remove();
    }, 3000);
  }
}

window.UIManager = UIManager;

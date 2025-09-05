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
    
    // Track the last pathfinding group
    this.lastPathfindingGroup = null;
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
    
    // Check if this is a pathfinding step
    if (data.mode === 'pathfinding') {
      // Check if we can group with the last pathfinding group
      if (this.lastPathfindingGroup && 
          this.lastPathfindingGroup.parentElement === this.decisionLog &&
          this.lastPathfindingGroup === this.decisionLog.firstChild) {
        // Update the existing pathfinding group
        this.updatePathfindingGroup(this.lastPathfindingGroup, data);
        return;
      } else {
        // Create a new pathfinding group
        const group = this.createPathfindingGroup(data);
        this.decisionLog.insertBefore(group, this.decisionLog.firstChild);
        this.lastPathfindingGroup = group;
      }
    } else {
      // This is an exploration step - show full details
      this.lastPathfindingGroup = null; // Reset pathfinding group tracking
      
      const entry = document.createElement('div');
      entry.className = 'decision-entry exploration-entry';
      entry.setAttribute('data-step', data.stepCount);
      
      const time = new Date().toLocaleTimeString();
      const modeIndicator = '<span class="mode-indicator exploring">🔍</span>';
      
      entry.innerHTML = `
        <div class="decision-header">
          <span class="decision-step">${modeIndicator} Step ${data.stepCount}</span>
          <span class="decision-time">${time}</span>
        </div>
        <div class="decision-reasoning">${escapeHtml(data.reasoning)}</div>
        <div class="decision-screenshots">
          ${data.screenshots.map(s => {
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

  createPathfindingGroup(data) {
    const group = document.createElement('div');
    group.className = 'decision-entry pathfinding-group collapsed';
    group.setAttribute('data-start-step', data.stepCount);
    group.setAttribute('data-end-step', data.stepCount);
    
    const time = new Date().toLocaleTimeString();
    
    const remaining = Number.isFinite(data.remainingPathSteps) ? data.remainingPathSteps : null;
    const remainingLabel = remaining !== null 
      ? `<span class="pathfinding-count">Frontier: ${remaining} step${remaining === 1 ? '' : 's'} away</span>`
      : '';

    group.innerHTML = `
      <div class="decision-header pathfinding-header" onclick="UIManager.togglePathfindingGroup(this)">
        <span class="decision-step">
          <span class="mode-indicator pathfinding">🧭</span>
          <span class="step-range">Step ${data.stepCount}</span>
        </span>
        ${remainingLabel}
        <span class="expand-icon">▶</span>
        <span class="decision-time">${time}</span>
      </div>
      <div class="pathfinding-details" style="display: none;">
        <div class="pathfinding-step-detail">
          Step ${data.stepCount}: ${escapeHtml(data.reasoning)}
        </div>
      </div>
    `;
    
    return group;
  }

  updatePathfindingGroup(group, data) {
    const startStep = parseInt(group.getAttribute('data-start-step'));
    const endStep = data.stepCount;
    const stepCount = endStep - startStep + 1;
    
    group.setAttribute('data-end-step', endStep);
    
    // Update the header
    const stepRange = group.querySelector('.step-range');
    const time = group.querySelector('.decision-time');
    let count = group.querySelector('.pathfinding-count');
    
    if (stepCount === 1) {
      stepRange.textContent = `Step ${startStep}`;
    } else {
      stepRange.textContent = `Steps ${startStep}-${endStep}`;
    }
    time.textContent = new Date().toLocaleTimeString();
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
    
    // Add the new step to the details
    const details = group.querySelector('.pathfinding-details');
    const newDetail = document.createElement('div');
    newDetail.className = 'pathfinding-step-detail';
    newDetail.textContent = `Step ${data.stepCount}: ${data.reasoning}`;
    details.appendChild(newDetail);
  }

  static togglePathfindingGroup(header) {
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

  setExplorationState(isExploring) {
    this.startBtn.disabled = isExploring;
    this.stepBtn.disabled = isExploring;
    this.stopBtn.disabled = !isExploring;
    this.resetBtn.disabled = isExploring;
  }
  
  setStepButtonState(disabled) {
    this.stepBtn.disabled = disabled;
  }

  clearDecisionLog() {
    this.decisionLog.innerHTML = '';
    this.lastPathfindingGroup = null;
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

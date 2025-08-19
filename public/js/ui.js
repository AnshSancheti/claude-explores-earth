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
  }

  updateStats(stats) {
    this.locationsVisited.textContent = stats.locationsVisited || 0;
    this.distanceTraveled.textContent = `${stats.distanceTraveled || 0} m`;
  }

  updateStep(step) {
    this.currentStep.textContent = step;
  }

  addDecisionEntry(data) {
    console.log(`Received decision for step ${data.stepCount}, thumbnails:`, data.screenshots.map(s => s.thumbnail));
    
    const entry = document.createElement('div');
    entry.className = 'decision-entry';
    entry.setAttribute('data-step', data.stepCount); // Add step tracking
    
    const time = new Date().toLocaleTimeString();
    const modeIndicator = data.mode === 'pathfinding' ? 
      '<span class="mode-indicator pathfinding">🧭</span>' : 
      '<span class="mode-indicator exploring">🔍</span>';
    
    entry.innerHTML = `
      <div class="decision-header">
        <span class="decision-step">${modeIndicator} Step ${data.stepCount}</span>
        <span class="decision-time">${time}</span>
      </div>
      <div class="decision-reasoning">${data.decision.reasoning}</div>
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
    
    while (this.decisionLog.children.length > 20) {
      this.decisionLog.removeChild(this.decisionLog.lastChild);
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
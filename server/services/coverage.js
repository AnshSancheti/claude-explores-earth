export class CoverageTracker {
  constructor() {
    this.visitedPanos = new Set();
    this.path = [];
    this.totalDistance = 0;
    this.lastPosition = null;
    
    // Frontier tracking
    this.frontier = new Map(); // panoId -> { discoveredFrom: panoId, links: Array }
    this.visitCounts = new Map(); // panoId -> number of visits
    this.recentHistory = []; // Last N panoramas visited (for loop detection)
    this.maxHistorySize = 10;
    
    // Graph for pathfinding
    this.graph = new Map(); // panoId -> Set of connected panoIds
  }

  addVisited(panoId, position, links = []) {
    this.visitedPanos.add(panoId);
    this.path.push({ ...position, panoId, timestamp: Date.now() });
    
    // Update visit count
    this.visitCounts.set(panoId, (this.visitCounts.get(panoId) || 0) + 1);
    
    // Update recent history for loop detection
    this.recentHistory.push(panoId);
    if (this.recentHistory.length > this.maxHistorySize) {
      this.recentHistory.shift();
    }
    
    // Remove from frontier since we've now visited it
    this.frontier.delete(panoId);
    
    // Add unvisited links to frontier
    links.forEach(link => {
      if (!this.visitedPanos.has(link.pano) && !this.frontier.has(link.pano)) {
        this.frontier.set(link.pano, {
          discoveredFrom: panoId,
          heading: link.heading,
          description: link.description
        });
      }
      
      // Build graph for pathfinding
      if (!this.graph.has(panoId)) {
        this.graph.set(panoId, new Set());
      }
      this.graph.get(panoId).add(link.pano);
    });
    
    if (this.lastPosition) {
      const distance = this.calculateDistance(this.lastPosition, position);
      this.totalDistance += distance;
    }
    
    this.lastPosition = position;
  }

  hasVisited(panoId) {
    return this.visitedPanos.has(panoId);
  }

  getVisitedList() {
    return Array.from(this.visitedPanos);
  }

  getStats() {
    return {
      locationsVisited: this.visitedPanos.size,
      distanceTraveled: Math.round(this.totalDistance),
      pathLength: this.path.length
    };
  }

  getPath() {
    return this.path;
  }

  calculateDistance(pos1, pos2) {
    const R = 6371e3;
    const φ1 = pos1.lat * Math.PI / 180;
    const φ2 = pos2.lat * Math.PI / 180;
    const Δφ = (pos2.lat - pos1.lat) * Math.PI / 180;
    const Δλ = (pos2.lng - pos1.lng) * Math.PI / 180;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c;
  }

  isInLoop(panoId) {
    // Check if we've been to this pano multiple times recently
    const recentOccurrences = this.recentHistory.filter(id => id === panoId).length;
    return recentOccurrences >= 1;
  }
  
  getVisitCount(panoId) {
    return this.visitCounts.get(panoId) || 0;
  }
  
  getFrontierSize() {
    return this.frontier.size;
  }
  
  hasFrontier() {
    return this.frontier.size > 0;
  }
  
  reset() {
    this.visitedPanos.clear();
    this.path = [];
    this.totalDistance = 0;
    this.lastPosition = null;
    this.frontier.clear();
    this.visitCounts.clear();
    this.recentHistory = [];
    this.graph.clear();
  }
}
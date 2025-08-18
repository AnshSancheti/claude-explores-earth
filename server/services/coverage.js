export class CoverageTracker {
  constructor() {
    this.visitedPanos = new Set();
    this.path = [];
    this.totalDistance = 0;
    this.lastPosition = null;
  }

  addVisited(panoId, position) {
    this.visitedPanos.add(panoId);
    this.path.push({ ...position, panoId, timestamp: Date.now() });
    
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

  reset() {
    this.visitedPanos.clear();
    this.path = [];
    this.totalDistance = 0;
    this.lastPosition = null;
  }
}
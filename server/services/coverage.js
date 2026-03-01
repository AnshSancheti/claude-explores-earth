export class CoverageTracker {
  constructor() {
    this.visitedPanos = new Set();
    this.visitedCells = new Set();
    this.path = [];
    this.totalDistance = 0;
    this.lastPosition = null;
    
    // Frontier tracking
    this.frontier = new Map(); // panoId -> { discoveredFrom: panoId, links: Array }
    this.visitCounts = new Map(); // panoId -> number of visits
    this.recentHistory = []; // Last N panoramas visited (for loop detection)
    this.maxHistorySize = 10;
    
    // Graph structure with full node information
    // panoId -> { lat, lng, visited, neighbors: Set, timestamp }
    this.graph = new Map();

    // Spatial de-duplication to detect alias loops (different pano IDs, same spot)
    this.cellSizeMeters = parseFloat(process.env.LOOP_CELL_SIZE_M || '3');
  }

  addVisited(panoId, position, links = []) {
    const isNewPano = !this.visitedPanos.has(panoId);
    this.visitedPanos.add(panoId);

    const cellKey = this.positionToCell(position);
    const isNewCell = !this.visitedCells.has(cellKey);
    this.visitedCells.add(cellKey);

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
    
    // Only store visited nodes in the graph
    let node = this.graph.get(panoId);
    if (!node) {
      node = {
        lat: position.lat,
        lng: position.lng,
        neighbors: new Set(),
        timestamp: Date.now()
      };
      this.graph.set(panoId, node);
    } else {
      // Update position and timestamp if revisiting
      node.lat = position.lat;
      node.lng = position.lng;
      node.timestamp = Date.now();
    }
    
    // Process all links - add ALL neighbors (visited and unvisited)
    links.forEach(link => {
      // Add to current node's neighbors
      node.neighbors.add(link.pano);

      // Intentionally mirror to treat Street View pano graph as logically bidirectional.
      // Google's link metadata is not always reciprocal (A->B may exist while B->A is missing).
      // This helps pathfinding reason over local pano splits/aliases.
      const neighborNode = this.graph.get(link.pano);
      if (neighborNode) {
        neighborNode.neighbors.add(panoId);
      }
      
      // Update frontier (unvisited neighbors)
      if (!this.visitedPanos.has(link.pano) && !this.frontier.has(link.pano)) {
        this.frontier.set(link.pano, {
          discoveredFrom: panoId,
          heading: link.heading,
          description: link.description
        });
      }
    });
    
    if (this.lastPosition) {
      const distance = this.calculateDistance(this.lastPosition, position);
      this.totalDistance += distance;
    }
    
    this.lastPosition = position;
    return { isNewPano, isNewCell, cellKey };
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

  positionToCell(position) {
    if (!position || typeof position.lat !== 'number' || typeof position.lng !== 'number') {
      return 'unknown';
    }

    const metersPerDegLat = 111320;
    const metersPerDegLng = metersPerDegLat * Math.cos((position.lat * Math.PI) / 180);
    const x = position.lng * metersPerDegLng;
    const y = position.lat * metersPerDegLat;
    const cellX = Math.floor(x / this.cellSizeMeters);
    const cellY = Math.floor(y / this.cellSizeMeters);
    return `${cellX}:${cellY}`;
  }

  /**
   * Detect short alternating oscillation patterns like A->B->A->B->A
   * and whether taking nextPanoId would continue that pattern.
   * @param {string} nextPanoId
   * @param {number} minNodes - minimum alternating tail length including next node
   * @returns {boolean}
   */
  isAlternatingLoop(nextPanoId, minNodes = 6) {
    if (!nextPanoId) return false;
    const nodes = [...this.recentHistory, nextPanoId];
    if (nodes.length < minNodes) return false;

    const n = nodes.length;
    const a = nodes[n - 2]; // current pano
    const b = nodes[n - 1]; // candidate next pano
    if (!a || !b || a === b) return false;

    // Walk backwards from [..., a, b] and ensure strict alternation.
    let alternatingCount = 2;
    for (let i = n - 3; i >= 0; i--) {
      const expected = (alternatingCount % 2 === 0) ? b : a;
      if (nodes[i] !== expected) break;
      alternatingCount++;
    }

    return alternatingCount >= minNodes;
  }

  /**
   * Detect whether appending nextPanoId would continue a periodic loop tail.
   * Covers patterns beyond A<->B, such as A->B->C->A->B->C.
   * @param {string} nextPanoId
   * @param {object} options
   * @param {number} options.minPeriod
   * @param {number} options.maxPeriod
   * @param {number} options.minRepeats
   * @returns {boolean}
   */
  wouldExtendRepeatingCycle(nextPanoId, options = {}) {
    if (!nextPanoId) return false;

    const parseOr = (value, fallback) => {
      const parsed = parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    const minPeriod = Math.max(2, parseOr(options.minPeriod ?? 2, 2));
    const maxPeriod = Math.max(minPeriod, parseOr(options.maxPeriod ?? 6, 6));
    const minRepeats = Math.max(2, parseOr(options.minRepeats ?? 3, 3));

    const nodes = [...this.recentHistory, nextPanoId];
    const n = nodes.length;
    if (n < minPeriod * minRepeats) return false;

    const cappedMaxPeriod = Math.min(maxPeriod, Math.floor(n / minRepeats));

    for (let period = minPeriod; period <= cappedMaxPeriod; period++) {
      const maxRepeats = Math.floor(n / period);

      for (let repeats = minRepeats; repeats <= maxRepeats; repeats++) {
        const tailLength = period * repeats;
        const start = n - tailLength;
        let periodic = true;

        for (let i = start + period; i < n; i++) {
          if (nodes[i] !== nodes[i - period]) {
            periodic = false;
            break;
          }
        }

        if (!periodic) continue;

        // Ignore degenerate same-node "cycles" like A->A->A.
        const periodTail = nodes.slice(n - period);
        if (new Set(periodTail).size < 2) continue;

        return true;
      }
    }

    return false;
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

  getFrontiers() {
    return Array.from(this.frontier.entries()).map(([panoId, data]) => ({
      panoId,
      ...data
    }));
  }

  reset() {
    this.visitedPanos.clear();
    this.visitedCells.clear();
    this.path = [];
    this.totalDistance = 0;
    this.lastPosition = null;
    this.frontier.clear();
    this.visitCounts.clear();
    this.recentHistory = [];
    this.graph.clear();
  }
  
  // Serialize the graph for saving (converts Sets to Arrays, rounds coordinates)
  serializeGraph() {
    const serialized = {};
    for (const [panoId, node] of this.graph.entries()) {
      // Only include visited nodes (all nodes in graph are visited now)
      serialized[panoId] = {
        lat: parseFloat(node.lat.toFixed(6)),  // Round to 6 decimal places
        lng: parseFloat(node.lng.toFixed(6)),  // ~11cm precision
        neighbors: Array.from(node.neighbors),
        timestamp: node.timestamp
      };
    }
    return serialized;
  }
  
  // Restore graph from saved data
  restoreFromSave(saveData) {
    // Clear current state
    this.reset();
    
    // Restore graph (all nodes in saved graph are visited)
    if (saveData.graph) {
      for (const [panoId, node] of Object.entries(saveData.graph)) {
        this.graph.set(panoId, {
          lat: node.lat,
          lng: node.lng,
          neighbors: new Set(node.neighbors),
          timestamp: node.timestamp
        });
        
        // All nodes in graph are visited
        this.visitedPanos.add(panoId);
        this.visitedCells.add(this.positionToCell({ lat: node.lat, lng: node.lng }));
      }
      
      // Rebuild frontier by finding neighbors not in graph
      for (const [panoId, node] of this.graph.entries()) {
        for (const neighborId of node.neighbors) {
          if (!this.graph.has(neighborId)) {
            // This neighbor is unvisited (frontier)
            if (!this.frontier.has(neighborId)) {
              this.frontier.set(neighborId, {
                discoveredFrom: panoId,
                heading: null,  // We don't have this info anymore
                description: null
              });
            }
          }
        }
      }
    }
    
    // Rebuild path from visited nodes sorted by timestamp
    const visitedNodes = [];
    for (const [panoId, node] of this.graph.entries()) {
      if (node.timestamp) {
        visitedNodes.push({
          panoId,
          lat: node.lat,
          lng: node.lng,
          timestamp: node.timestamp
        });
      }
    }
    this.path = visitedNodes.sort((a, b) => a.timestamp - b.timestamp);
    
    // Restore stats
    if (saveData.stats) {
      this.totalDistance = saveData.stats.distanceTraveled || 0;
    }
    
    // Restore recent history if provided
    if (saveData.recentHistory) {
      this.recentHistory = saveData.recentHistory;
    }
    
    // Set last position
    if (this.path.length > 0) {
      const lastNode = this.path[this.path.length - 1];
      this.lastPosition = { lat: lastNode.lat, lng: lastNode.lng };
    }
  }
  
  // Find frontier nodes using BFS from current position
  findFrontierNodes(currentPanoId, maxNodes = 50) {
    const frontier = [];
    const visited = new Set();
    const queue = [{ panoId: currentPanoId, distance: 0 }];
    
    while (queue.length > 0 && frontier.length < maxNodes) {
      const { panoId, distance } = queue.shift();
      if (visited.has(panoId)) continue;
      visited.add(panoId);
      
      const node = this.graph.get(panoId);
      if (!node) {
        // This panoId is not in graph, so it's unvisited (frontier)
        frontier.push({ 
          panoId, 
          distance,
          lat: null,  // We don't have position for unvisited nodes
          lng: null
        });
        continue;  // Can't explore neighbors of unvisited node
      }
      
      // Check neighbors for frontier nodes
      for (const neighborId of node.neighbors) {
        if (!this.graph.has(neighborId) && !visited.has(neighborId)) {
          // Neighbor is not in graph = unvisited = frontier
          frontier.push({
            panoId: neighborId,
            distance: distance + 1,
            lat: null,
            lng: null
          });
          visited.add(neighborId);  // Mark as seen to avoid duplicates
        } else if (this.graph.has(neighborId) && !visited.has(neighborId)) {
          // Neighbor is visited, continue BFS
          queue.push({ panoId: neighborId, distance: distance + 1 });
        }
      }
    }
    
    return frontier;
  }
}

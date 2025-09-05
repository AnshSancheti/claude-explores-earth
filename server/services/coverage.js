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
    
    // Graph structure with full node information
    // panoId -> { lat, lng, visited, neighbors: Set, timestamp }
    this.graph = new Map();
  }

  // Ensure a directed edge exists in the visited graph from one pano to another.
  // Useful to record the actual traversal even if Google resolved the target panoId differently (A → A').
  ensureDirectedEdge(fromPanoId, toPanoId) {
    if (!fromPanoId || !toPanoId) return;
    const fromNode = this.graph.get(fromPanoId);
    if (!fromNode) return; // Only record if source is already in graph (visited)
    fromNode.neighbors.add(toPanoId);
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
      
      // If neighbor is already visited, add reverse connection
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

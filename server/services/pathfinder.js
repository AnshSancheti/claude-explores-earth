export class Pathfinder {
  constructor(coverage) {
    this.coverage = coverage;
    this.clusterRadiusMeters = parseFloat(process.env.PATHFINDER_CLUSTER_RADIUS_M || '0');
  }
  
  /**
   * Find the shortest path to the nearest frontier panorama using BFS
   * @param {string} startPanoId - Current panorama ID
   * @returns {object|null} - Next step info or null if no path exists
   */
  findPathToNearestFrontier(startPanoId) {
    if (!this.coverage.hasFrontier()) {
      console.log('No frontier panoramas available');
      return null;
    }
    
    // BFS to find shortest path to any frontier panorama
    const queue = [{ panoId: startPanoId, path: [], distance: 0 }];
    const visited = new Set([startPanoId]);
    let expanded = 0;
    
    while (queue.length > 0) {
      const { panoId, path, distance } = queue.shift();
      expanded++;
      
      // Get connected panoramas from graph (new structure)
      const node = this.coverage.graph.get(panoId);
      const connections = node ? node.neighbors : new Set();
      
      for (const nextPanoId of connections) {
        if (visited.has(nextPanoId)) continue;
        visited.add(nextPanoId);
        
        const newPath = [...path, nextPanoId];
        
        // Check if this panorama is in the frontier
        if (this.coverage.frontier.has(nextPanoId)) {
          console.log(`Found path to frontier: ${newPath.length} steps to ${nextPanoId}`);
          return {
            targetPanoId: nextPanoId,
            nextStep: path.length > 0 ? path[0] : nextPanoId,
            pathLength: newPath.length,
            fullPath: newPath,
            expanded
          };
        }
        
        // Only continue through visited panoramas (we can't go through unvisited ones)
        if (this.coverage.hasVisited(nextPanoId)) {
          queue.push({
            panoId: nextPanoId,
            path: newPath,
            distance: distance + 1
          });
        }
      }
    }
    
    console.log('No path to frontier found');
    return null;
  }
  
  /**
   * Find the direction that leads to the most unexplored areas
   * @param {string} currentPanoId - Current panorama ID
   * @param {Array} links - Available links from current position
   * @returns {object|null} - Best link to take or null
   */
  findBestEscapeDirection(currentPanoId, links) {
    let bestLink = null;
    let bestScore = -1;
    
    for (const link of links) {
      let score = 0;
      
      // Penalize recently visited
      const visitCount = this.coverage.getVisitCount(link.pano);
      score -= visitCount * 10;
      
      // Bonus for links that lead to frontier
      if (this.coverage.frontier.has(link.pano)) {
        score += 100;
      }
      
      // Check how many frontier nodes are reachable from this link
      const reachableFrontier = this.countReachableFrontier(link.pano, 3); // Look 3 steps ahead
      score += reachableFrontier * 5;
      
      // Penalize if in recent history
      const recentIndex = this.coverage.recentHistory.lastIndexOf(link.pano);
      if (recentIndex !== -1) {
        score -= (10 - recentIndex) * 2; // More recent = bigger penalty
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestLink = link;
      }
    }
    
    return bestLink;
  }
  
  /**
   * Count how many frontier nodes are reachable within N steps
   * @param {string} startPanoId - Starting panorama ID
   * @param {number} maxDepth - Maximum steps to look ahead
   * @returns {number} - Count of reachable frontier nodes
   */
  countReachableFrontier(startPanoId, maxDepth) {
    const visited = new Set([startPanoId]);
    const queue = [{ panoId: startPanoId, depth: 0 }];
    let frontierCount = 0;
    
    while (queue.length > 0) {
      const { panoId, depth } = queue.shift();
      
      if (depth >= maxDepth) continue;
      
      const node = this.coverage.graph.get(panoId);
      const connections = node ? node.neighbors : new Set();
      
      for (const nextPanoId of connections) {
        if (visited.has(nextPanoId)) continue;
        visited.add(nextPanoId);
        
        if (this.coverage.frontier.has(nextPanoId)) {
          frontierCount++;
        }
        
        if (this.coverage.hasVisited(nextPanoId)) {
          queue.push({ panoId: nextPanoId, depth: depth + 1 });
        }
      }
    }
    
    return frontierCount;
  }

  /**
   * Build clusters of visited pano nodes within clusterRadiusMeters
   * Returns { clusterOf: Map<panoId,string>, clusters: Map<string,{members:Set<string>, hasBoundary:boolean}> , adjacency: Map<string,Set<string>> }
   */
  buildClusters() {
    const radius = this.clusterRadiusMeters;
    if (!radius || radius <= 0) return null;

    const nodes = Array.from(this.coverage.graph.entries()).map(([panoId, node]) => ({ panoId, lat: node.lat, lng: node.lng }));
    if (nodes.length === 0) return null;

    const clusterOf = new Map();
    const clusters = new Map();

    let clusterIndex = 0;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (clusterOf.has(n.panoId)) continue;
      const clusterId = `c${clusterIndex++}`;
      const members = new Set();
      // BFS over proximity
      const queue = [n];
      clusterOf.set(n.panoId, clusterId);
      members.add(n.panoId);
      while (queue.length > 0) {
        const cur = queue.shift();
        for (let j = 0; j < nodes.length; j++) {
          const m = nodes[j];
          if (clusterOf.has(m.panoId)) continue;
          const dist = this.coverage.calculateDistance({ lat: cur.lat, lng: cur.lng }, { lat: m.lat, lng: m.lng });
          if (dist <= radius) {
            clusterOf.set(m.panoId, clusterId);
            members.add(m.panoId);
            queue.push(m);
          }
        }
      }
      clusters.set(clusterId, { members, hasBoundary: false });
    }

    // Determine boundary clusters
    for (const [clusterId, data] of clusters.entries()) {
      for (const panoId of data.members) {
        const node = this.coverage.graph.get(panoId);
        if (!node) continue;
        for (const nei of node.neighbors) {
          if (!this.coverage.graph.has(nei)) {
            data.hasBoundary = true;
            break;
          }
        }
        if (data.hasBoundary) break;
      }
    }

    // Build adjacency between clusters via visited edges
    const adjacency = new Map();
    for (const cid of clusters.keys()) adjacency.set(cid, new Set());
    for (const [panoId, node] of this.coverage.graph.entries()) {
      const c1 = clusterOf.get(panoId);
      for (const nei of node.neighbors) {
        if (!this.coverage.graph.has(nei)) continue; // only through visited
        const c2 = clusterOf.get(nei);
        if (c1 && c2 && c1 !== c2) {
          adjacency.get(c1).add(c2);
          adjacency.get(c2).add(c1);
        }
      }
    }

    return { clusterOf, clusters, adjacency };
  }

  /**
   * Cluster-aware pathfinding to nearest boundary cluster.
   * Returns object with next cluster step and candidate from/to panoIds for exit.
   */
  findClusteredPathToFrontier(startPanoId) {
    const built = this.buildClusters();
    if (!built) return null;
    const { clusterOf, clusters, adjacency } = built;
    const startCluster = clusterOf.get(startPanoId);
    if (!startCluster) return null;

    // BFS across clusters
    const visited = new Set([startCluster]);
    const queue = [{ cid: startCluster, path: [startCluster] }];
    let targetPath = null;
    let expanded = 0;
    while (queue.length > 0) {
      const { cid, path } = queue.shift();
      expanded++;
      const cdata = clusters.get(cid);
      if (cdata && cdata.hasBoundary) {
        targetPath = path;
        break;
      }
      for (const next of adjacency.get(cid) || []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push({ cid: next, path: [...path, next] });
      }
    }
    if (!targetPath) return null;

    const nextCluster = targetPath.length > 1 ? targetPath[1] : targetPath[0];

    // Determine exit candidates from current cluster
    const fromCandidates = new Set();
    const toCandidates = new Set();

    if (nextCluster === startCluster) {
      // Find members in start cluster that have unvisited neighbors
      for (const panoId of clusters.get(startCluster).members) {
        const node = this.coverage.graph.get(panoId);
        if (!node) continue;
        for (const nei of node.neighbors) {
          if (!this.coverage.graph.has(nei)) {
            fromCandidates.add(panoId);
            break;
          }
        }
      }
    } else {
      // Find members that connect to nextCluster via visited edge
      for (const panoId of clusters.get(startCluster).members) {
        const node = this.coverage.graph.get(panoId);
        if (!node) continue;
        for (const nei of node.neighbors) {
          if (!this.coverage.graph.has(nei)) continue;
          const neiCluster = clusterOf.get(nei);
          if (neiCluster === nextCluster) {
            fromCandidates.add(panoId);
            toCandidates.add(nei);
          }
        }
      }
    }

    return {
      startCluster,
      nextCluster,
      clusterPathLength: targetPath.length,
      fromCandidates: Array.from(fromCandidates),
      toCandidates: Array.from(toCandidates),
      expanded
    };
  }
}

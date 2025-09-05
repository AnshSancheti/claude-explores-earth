export class Pathfinder {
  constructor(coverage) {
    this.coverage = coverage;
  }
  
  /**
   * Find the shortest path to the nearest frontier panorama using BFS
   * @param {string} startPanoId - Current panorama ID
   * @returns {object|null} - Next step info or null if no path exists
   */
  findPathToNearestFrontier(startPanoId) {
    // We derive frontier implicitly from the graph: any neighbor not in graph is unvisited (frontier candidate).
    // Relying solely on coverage.frontier can be stale after saves/edge cases.
    
    // BFS to find shortest path to any frontier panorama
    const queue = [{ panoId: startPanoId, path: [], distance: 0 }];
    const visited = new Set([startPanoId]);
    
    while (queue.length > 0) {
      const { panoId, path, distance } = queue.shift();
      
      // Get connected panoramas from graph (new structure)
      const node = this.coverage.graph.get(panoId);
      const connections = node ? node.neighbors : new Set();
      
      for (const nextPanoId of connections) {
        if (visited.has(nextPanoId)) continue;
        visited.add(nextPanoId);
        
        const newPath = [...path, nextPanoId];
        
        // Treat any neighbor not in the visited graph as a frontier boundary
        if (!this.coverage.graph.has(nextPanoId)) {
          console.log(`Found path to frontier: ${newPath.length} steps to ${nextPanoId}`);
          return {
            targetPanoId: nextPanoId,
            nextStep: path.length > 0 ? path[0] : nextPanoId,
            pathLength: newPath.length,
            fullPath: newPath
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
   * Clustered pathfinding with intra-cluster repositioning.
   * - Build a cluster graph of visited nodes.
   * - Identify boundary clusters (any member links to an unvisited pano).
   * - Score current links to pick a valid next hop:
   *   - Prefer links that jump to a different cluster with minimal distance to a boundary.
   *   - If none, allow same-cluster repositioning by choosing a link whose node has an exit to another cluster,
   *     or that minimizes the downstream cluster distance to a boundary.
   * @param {string} currentPanoId
   * @param {Array} currentLinks - links from current pano (objects with .pano)
   * @param {object} clusterIndex - PanoClusterIndex instance
   * @returns {object|null} - { nextStep, pathLength, reposition } or null
   */
  findPathToNearestFrontierClustered(currentPanoId, currentLinks, clusterIndex) {
    if (!clusterIndex || !this.coverage.hasFrontier()) return null;

    const currentCluster = clusterIndex.getClusterIdFor(currentPanoId);
    if (!currentCluster) return null;

    const clusterBordersFrontier = (clusterId) => {
      const members = clusterIndex.getMembers(clusterId);
      for (const pid of members) {
        const node = this.coverage.graph.get(pid);
        if (!node) continue;
        for (const nbr of node.neighbors) {
          if (!this.coverage.graph.has(nbr)) {
            return true;
          }
        }
      }
      return false;
    };

    const clusterNeighbors = (clusterId) => {
      const out = new Set();
      const members = clusterIndex.getMembers(clusterId);
      for (const pid of members) {
        const node = this.coverage.graph.get(pid);
        if (!node) continue;
        for (const nbr of node.neighbors) {
          if (!this.coverage.graph.has(nbr)) continue;
          const cid = clusterIndex.getClusterIdFor(nbr);
          if (cid && cid !== clusterId) out.add(cid);
        }
      }
      return out;
    };

    // BFS from a cluster to nearest boundary cluster (directed)
    const distToBoundaryFrom = (startCluster) => {
      const visited = new Set([startCluster]);
      const queue = [{ c: startCluster, d: 0 }];
      while (queue.length > 0) {
        const { c, d } = queue.shift();
        if (clusterBordersFrontier(c)) return d; // distance in clusters
        for (const nc of clusterNeighbors(c)) {
          if (visited.has(nc)) continue;
          visited.add(nc);
          queue.push({ c: nc, d: d + 1 });
        }
      }
      return Infinity;
    };

    // If no boundary is reachable from the current cluster, bail out
    const baseDist = distToBoundaryFrom(currentCluster);
    if (!Number.isFinite(baseDist)) {
      console.log(`[ClusterPathfinding] No reachable boundary from current cluster ${currentCluster}. Frontier size=${this.coverage.getFrontierSize()}, visited=${this.coverage.graph.size}`);
      return null;
    }

    // Score current links
    let best = null;
    for (const link of currentLinks || []) {
      const linkCluster = clusterIndex.getClusterIdFor(link.pano);
      if (!linkCluster) continue; // should not happen if all links visited

      if (linkCluster !== currentCluster) {
        const d = distToBoundaryFrom(linkCluster);
        // Enforce monotonic progress: only consider moves that strictly reduce distance
        if (Number.isFinite(d) && (d + 1) < baseDist) {
          if (!best || (d + 1) < best.dist || ((d + 1) === best.dist && this.coverage.getVisitCount(link.pano) < this.coverage.getVisitCount(best.link.pano))) {
            best = { link, dist: d + 1, reposition: false };
          }
        }
      } else {
        // Same-cluster reposition: prefer nodes with an exit to other clusters, then minimal downstream distance
        const node = this.coverage.graph.get(link.pano);
        let exitBest = Infinity;
        if (node) {
          for (const nbr of node.neighbors) {
            if (!this.coverage.graph.has(nbr)) continue;
            const nbrCluster = clusterIndex.getClusterIdFor(nbr);
            if (!nbrCluster || nbrCluster === currentCluster) continue;
            const d = distToBoundaryFrom(nbrCluster);
            if (d < exitBest) exitBest = d;
          }
        }
        const repositionDist = Number.isFinite(exitBest) ? (1 + 1 + exitBest) : Infinity; // reposition + exit + remainder
        // Require strict improvement over base distance as well
        if (Number.isFinite(repositionDist) && repositionDist < baseDist) {
          if (!best || repositionDist < best.dist || (repositionDist === best.dist && this.coverage.getVisitCount(link.pano) < this.coverage.getVisitCount(best.link?.pano))) {
            best = { link, dist: repositionDist, reposition: true };
          }
        }
      }
    }

    if (!best || !Number.isFinite(best.dist)) {
      console.log(`[ClusterPathfinding] No valid next hop from pano ${currentPanoId} (links=${(currentLinks||[]).length}). Current cluster=${currentCluster}`);
      return null;
    }
    if (best.reposition) {
      console.log(`[ClusterPathfinding] Reposition within cluster ${currentCluster}: next=${best.link.pano}, est remaining steps=${best.dist}`);
    } else {
      const nextCluster = clusterIndex.getClusterIdFor(best.link.pano);
      console.log(`[ClusterPathfinding] Cross-cluster move: ${currentCluster} -> ${nextCluster} via ${best.link.pano}, est remaining steps=${best.dist}`);
    }
    return { nextStep: best.link.pano, pathLength: best.dist, reposition: best.reposition };
  }
}

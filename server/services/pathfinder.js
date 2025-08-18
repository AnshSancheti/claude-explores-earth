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
    if (!this.coverage.hasFrontier()) {
      console.log('No frontier panoramas available');
      return null;
    }
    
    // BFS to find shortest path to any frontier panorama
    const queue = [{ panoId: startPanoId, path: [], distance: 0 }];
    const visited = new Set([startPanoId]);
    
    while (queue.length > 0) {
      const { panoId, path, distance } = queue.shift();
      
      // Get connected panoramas from graph
      const connections = this.coverage.graph.get(panoId) || new Set();
      
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
      
      const connections = this.coverage.graph.get(panoId) || new Set();
      
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
}
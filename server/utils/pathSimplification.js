/**
 * Path simplification utilities using Douglas-Peucker algorithm
 * Reduces path points while maintaining visual accuracy
 */

/**
 * Calculate perpendicular distance from point to line
 */
function perpendicularDistance(point, lineStart, lineEnd) {
  const dx = lineEnd.lng - lineStart.lng;
  const dy = lineEnd.lat - lineStart.lat;
  
  // Normalize
  const mag = Math.sqrt(dx * dx + dy * dy);
  if (mag > 0) {
    const normalizedDx = dx / mag;
    const normalizedDy = dy / mag;
    
    const pvx = point.lng - lineStart.lng;
    const pvy = point.lat - lineStart.lat;
    
    // Get dot product (projection length)
    const dotProduct = pvx * normalizedDx + pvy * normalizedDy;
    
    // Scale line direction vector
    const dsx = dotProduct * normalizedDx;
    const dsy = dotProduct * normalizedDy;
    
    // Subtract from pv to get perpendicular vector
    const ax = pvx - dsx;
    const ay = pvy - dsy;
    
    return Math.sqrt(ax * ax + ay * ay);
  }
  
  return Math.sqrt(
    Math.pow(point.lng - lineStart.lng, 2) + 
    Math.pow(point.lat - lineStart.lat, 2)
  );
}

/**
 * Douglas-Peucker path simplification algorithm
 * @param {Array} points - Array of {lat, lng} points
 * @param {number} epsilon - Maximum distance threshold in degrees (roughly 111km per degree)
 * @returns {Array} Simplified array of points
 */
function douglasPeucker(points, epsilon) {
  if (points.length <= 2) return points;
  
  // Find the point with maximum distance from line between start and end
  let maxDistance = 0;
  let maxIndex = 0;
  const end = points.length - 1;
  
  for (let i = 1; i < end; i++) {
    const distance = perpendicularDistance(points[i], points[0], points[end]);
    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = i;
    }
  }
  
  // If max distance is greater than epsilon, recursively simplify
  if (maxDistance > epsilon) {
    // Recursive call
    const leftPoints = douglasPeucker(points.slice(0, maxIndex + 1), epsilon);
    const rightPoints = douglasPeucker(points.slice(maxIndex), epsilon);
    
    // Combine results (remove duplicate point at index)
    return leftPoints.slice(0, -1).concat(rightPoints);
  } else {
    // All points between start and end can be removed
    return [points[0], points[end]];
  }
}

/**
 * Remove perfectly collinear points (zero tolerance)
 * This is a fast first pass before Douglas-Peucker
 */
function removeCollinearPoints(points) {
  if (points.length <= 2) return points;
  
  const result = [points[0]];
  
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];
    
    // Check if current point is on the line between prev and next
    const distance = perpendicularDistance(curr, prev, next);
    
    // Keep point if it's not perfectly collinear (using very small threshold)
    if (distance > 0.000001) { // ~0.1 meter threshold
      result.push(curr);
    }
  }
  
  result.push(points[points.length - 1]);
  return result;
}

/**
 * Apply tiered simplification based on point age
 * Recent points get less simplification, older points get more
 */
export function simplifyPathWithTiers(points, options = {}) {
  if (!points || points.length <= 2) return points;
  
  const {
    // Thresholds in milliseconds
    recentThreshold = 60 * 60 * 1000,        // 1 hour
    mediumThreshold = 6 * 60 * 60 * 1000,    // 6 hours
    
    // Epsilon values in degrees (1 degree ≈ 111km at equator)
    // In NYC: 1 degree lat ≈ 111km, 1 degree lng ≈ 85km
    // So 0.00001 ≈ 1.1m lat, 0.85m lng
    recentEpsilon = 0.000005,   // ~0.5m accuracy for recent path
    mediumEpsilon = 0.00002,    // ~2m accuracy for medium age
    oldEpsilon = 0.00005,        // ~5m accuracy for old path
    
    preserveTimestamps = true
  } = options;
  
  const now = Date.now();
  const result = [];
  
  // Group points by age if they have timestamps
  if (points[0].timestamp) {
    let currentGroup = [];
    let currentEpsilon = recentEpsilon;
    
    for (const point of points) {
      const age = now - point.timestamp;
      
      // Determine epsilon for this point based on age
      let targetEpsilon;
      if (age < recentThreshold) {
        targetEpsilon = recentEpsilon;
      } else if (age < mediumThreshold) {
        targetEpsilon = mediumEpsilon;
      } else {
        targetEpsilon = oldEpsilon;
      }
      
      // If epsilon changed, process current group
      if (targetEpsilon !== currentEpsilon && currentGroup.length > 0) {
        const simplified = douglasPeucker(
          removeCollinearPoints(currentGroup), 
          currentEpsilon
        );
        result.push(...simplified.slice(0, -1)); // Remove last point to avoid duplicates
        currentGroup = [currentGroup[currentGroup.length - 1]]; // Start new group with last point
        currentEpsilon = targetEpsilon;
      }
      
      currentGroup.push(point);
    }
    
    // Process final group
    if (currentGroup.length > 0) {
      const simplified = douglasPeucker(
        removeCollinearPoints(currentGroup), 
        currentEpsilon
      );
      result.push(...simplified);
    }
  } else {
    // No timestamps, use uniform simplification
    const cleaned = removeCollinearPoints(points);
    return douglasPeucker(cleaned, mediumEpsilon);
  }
  
  return result;
}

/**
 * Simple uniform simplification without tiers
 */
export function simplifyPath(points, epsilon = 0.00002) {
  if (!points || points.length <= 2) return points;
  
  // First pass: remove collinear points
  const cleaned = removeCollinearPoints(points);
  
  // Second pass: Douglas-Peucker
  return douglasPeucker(cleaned, epsilon);
}

/**
 * Calculate reduction statistics
 */
export function getSimplificationStats(original, simplified) {
  const originalCount = original.length;
  const simplifiedCount = simplified.length;
  const reduction = originalCount - simplifiedCount;
  const reductionPercent = (reduction / originalCount * 100).toFixed(1);
  
  // Estimate size (rough JSON size)
  const originalSize = JSON.stringify(original).length;
  const simplifiedSize = JSON.stringify(simplified).length;
  const sizeSaved = originalSize - simplifiedSize;
  const sizeSavedPercent = (sizeSaved / originalSize * 100).toFixed(1);
  
  return {
    originalCount,
    simplifiedCount,
    reduction,
    reductionPercent: parseFloat(reductionPercent),
    originalSize,
    simplifiedSize,
    sizeSaved,
    sizeSavedPercent: parseFloat(sizeSavedPercent)
  };
}

/**
 * Adaptive simplification based on point density
 * Areas with many turns get less simplification
 */
export function adaptiveSimplifyPath(points, options = {}) {
  if (!points || points.length <= 2) return points;
  
  const {
    minEpsilon = 0.000005,    // Minimum simplification for dense areas
    maxEpsilon = 0.00005,     // Maximum simplification for sparse areas
    windowSize = 10,          // Points to consider for density calculation
    densityThreshold = 0.0001 // Threshold for considering area "dense"
  } = options;
  
  const result = [];
  const cleaned = removeCollinearPoints(points);
  
  // Process in windows
  for (let i = 0; i < cleaned.length; i += windowSize) {
    const window = cleaned.slice(i, Math.min(i + windowSize + 1, cleaned.length));
    
    if (window.length <= 2) {
      result.push(...window.slice(0, -1));
      continue;
    }
    
    // Calculate path complexity in this window
    let totalDeviation = 0;
    for (let j = 1; j < window.length - 1; j++) {
      const deviation = perpendicularDistance(window[j], window[0], window[window.length - 1]);
      totalDeviation += deviation;
    }
    
    const avgDeviation = totalDeviation / (window.length - 2);
    
    // Adjust epsilon based on complexity
    let epsilon;
    if (avgDeviation > densityThreshold) {
      // Complex area with turns - use less simplification
      epsilon = minEpsilon;
    } else {
      // Straight area - use more simplification
      const ratio = avgDeviation / densityThreshold;
      epsilon = maxEpsilon - (maxEpsilon - minEpsilon) * ratio;
    }
    
    const simplified = douglasPeucker(window, epsilon);
    result.push(...simplified.slice(0, -1));
  }
  
  // Add the last point
  result.push(cleaned[cleaned.length - 1]);
  
  // Remove any duplicates that might have been created
  return result.filter((point, index) => {
    if (index === 0) return true;
    const prev = result[index - 1];
    return point.lat !== prev.lat || point.lng !== prev.lng;
  });
}
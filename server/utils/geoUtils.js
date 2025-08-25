/**
 * Geographic utility functions for position calculations
 */

/**
 * Project a position forward by a given distance and heading
 * @param {Object} position - Starting position with lat and lng
 * @param {number} heading - Direction in degrees (0-360)
 * @param {number} distanceMeters - Distance to project in meters
 * @returns {Object} New position with lat and lng
 */
export function projectPosition(position, heading, distanceMeters) {
  const R = 6371000; // Earth radius in meters
  const d = distanceMeters / R; // Angular distance in radians
  const bearing = (heading * Math.PI) / 180; // Convert heading to radians
  const lat1 = (position.lat * Math.PI) / 180;
  const lng1 = (position.lng * Math.PI) / 180;
  
  // Calculate new latitude
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + 
    Math.cos(lat1) * Math.sin(d) * Math.cos(bearing)
  );
  
  // Calculate new longitude
  const lng2 = lng1 + Math.atan2(
    Math.sin(bearing) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
  );
  
  return {
    lat: (lat2 * 180) / Math.PI,
    lng: (lng2 * 180) / Math.PI
  };
}

/**
 * Calculate bearing between two positions
 * @param {Object} from - Starting position
 * @param {Object} to - Ending position
 * @returns {number} Bearing in degrees (0-360)
 */
export function calculateBearing(from, to) {
  const dLng = ((to.lng - from.lng) * Math.PI) / 180;
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - 
            Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  
  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  return (bearing + 360) % 360;
}
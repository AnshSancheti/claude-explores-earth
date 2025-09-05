// Groups nearby panoIds into clusters to mitigate A/A' splits
// Simple centroid-based clustering with a configurable distance threshold.

export class PanoClusterIndex {
  constructor(distanceMeters = null) {
    const envVal = parseFloat(process.env.CLUSTER_DISTANCE_M || '');
    this.distanceMeters = Number.isFinite(envVal) ? envVal : (distanceMeters || 5.0);
    this.panoToCluster = new Map(); // panoId -> clusterId
    this.clusters = new Map(); // clusterId -> { members: Set<panoId>, centroid: {lat,lng} }
    this._idCounter = 0;
  }

  reset() {
    this.panoToCluster.clear();
    this.clusters.clear();
    this._idCounter = 0;
  }

  getClusterIdFor(panoId) {
    return this.panoToCluster.get(panoId) || null;
  }

  getMembers(clusterId) {
    const c = this.clusters.get(clusterId);
    if (!c) return [];
    return Array.from(c.members);
  }

  rebuildFromGraph(graph) {
    this.reset();
    for (const [panoId, node] of graph.entries()) {
      this._assignToCluster(panoId, node.lat, node.lng);
    }
  }

  updatePano(panoId, position) {
    // If already clustered, nothing to do
    if (this.panoToCluster.has(panoId)) return;
    if (!position || typeof position.lat !== 'number' || typeof position.lng !== 'number') return;
    this._assignToCluster(panoId, position.lat, position.lng);
  }

  _assignToCluster(panoId, lat, lng) {
    // Find an existing cluster whose centroid is within threshold
    let bestClusterId = null;
    for (const [cid, c] of this.clusters.entries()) {
      const d = this._haversineMeters(lat, lng, c.centroid.lat, c.centroid.lng);
      if (d <= this.distanceMeters) {
        bestClusterId = cid;
        break; // first match is fine; keeps code simple
      }
    }
    if (!bestClusterId) {
      bestClusterId = this._newClusterId();
      this.clusters.set(bestClusterId, {
        members: new Set(),
        centroid: { lat, lng }
      });
    }
    const cluster = this.clusters.get(bestClusterId);
    cluster.members.add(panoId);
    // Update centroid (simple running average)
    const n = cluster.members.size;
    cluster.centroid.lat = ((cluster.centroid.lat * (n - 1)) + lat) / n;
    cluster.centroid.lng = ((cluster.centroid.lng * (n - 1)) + lng) / n;
    this.panoToCluster.set(panoId, bestClusterId);
  }

  _newClusterId() {
    this._idCounter += 1;
    return `c${this._idCounter}`;
  }

  _haversineMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat/2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }
}


import * as fsp from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { TILE_RENDERER_REVISION } from './archiveTileRenderer.js';

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function clonePathPoint(point) {
  return point == null ? point : { ...point };
}

function numberOr(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseIntOr(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const DEFAULT_VECTOR_TAIL_POINTS = parseIntOr(
  process.env.MINIMAP_VECTOR_TAIL_POINTS || process.env.TILE_RECENT_TAIL_POINTS,
  1500
);
function validPosition(position) {
  if (!position || typeof position !== 'object') return null;
  const lat = Number(position.lat);
  const lng = Number(position.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function extendBounds(bounds, position) {
  const valid = validPosition(position);
  if (!valid) return bounds || null;
  if (!bounds) {
    return {
      minLat: valid.lat,
      minLng: valid.lng,
      maxLat: valid.lat,
      maxLng: valid.lng
    };
  }
  return {
    minLat: Math.min(bounds.minLat, valid.lat),
    minLng: Math.min(bounds.minLng, valid.lng),
    maxLat: Math.max(bounds.maxLat, valid.lat),
    maxLng: Math.max(bounds.maxLng, valid.lng)
  };
}

function buildBounds(points) {
  let bounds = null;
  for (const point of points || []) {
    bounds = extendBounds(bounds, point);
  }
  return bounds;
}

function cloneBounds(bounds) {
  return bounds ? { ...bounds } : null;
}

async function atomicWriteJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const contents = `${JSON.stringify(value)}\n`;

  let handle = null;
  try {
    handle = await fsp.open(tempPath, 'w');
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function extractPathPointFromStepEvent(event) {
  if (!event || event.type !== 'step_completed') return null;

  const stepData = event.payload?.stepData;
  if (stepData) {
    const position = validPosition(stepData.newPosition || stepData.coverageDelta?.position);
    if (!position) return null;
    return {
      ...position,
      panoId: stepData.panoId || stepData.coverageDelta?.panoId || null,
      stepCount: numberOr(stepData.stepCount, numberOr(event.stepCount, 0)),
      sequence: numberOr(event.sequence, 0),
      timestamp: event.timestamp || null
    };
  }

  const snapshot = event.payload?.snapshot;
  const position = validPosition(snapshot?.currentState?.position);
  if (!position) return null;
  return {
    ...position,
    panoId: snapshot.currentState?.panoId || null,
    stepCount: numberOr(snapshot.stepCount, numberOr(event.stepCount, 0)),
    sequence: numberOr(event.sequence, 0),
    timestamp: event.timestamp || snapshot.lastUpdated || null
  };
}

export function extractPathPointFromMove(data) {
  if (!data || data.intermediate) return null;
  const position = validPosition(data.newPosition || data.position);
  if (!position) return null;
  const sequence = numberOr(data.sequence, 0);
  if (sequence <= 0) return null;
  return {
    ...position,
    panoId: data.panoId || null,
    stepCount: numberOr(data.stepCount, 0),
    sequence,
    timestamp: data.timestamp || new Date().toISOString()
  };
}

export class PathProjection {
  constructor({
    runStore,
    logger = console,
    writeDebounceMs = 10000,
    vectorTailPoints = DEFAULT_VECTOR_TAIL_POINTS,
  } = {}) {
    if (!runStore) {
      throw new Error('PathProjection requires runStore');
    }

    this.runStore = runStore;
    this.logger = logger;
    this.writeDebounceMs = writeDebounceMs;
    this.vectorTailPoints = Math.max(0, parseIntOr(vectorTailPoints, DEFAULT_VECTOR_TAIL_POINTS));
    this.cacheByRun = new Map();
    this.queues = new Map();
    this.writeTimers = new Map();
    this.metrics = {
      pathProjectionSequence: 0,
      pathProjectionPathSequence: 0,
      pathProjectionPoints: 0,
      pathProjectionBuildMs: 0,
      pathProjectionCacheHit: false
    };
  }

  getCachePath(runId) {
    return path.join(this.runStore.getRunDir(runId), 'path-cache.json');
  }

  getMetrics() {
    return { ...this.metrics };
  }

  invalidateRun(runId) {
    if (!runId) return;
    this.cacheByRun.delete(runId);
    const timer = this.writeTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.writeTimers.delete(runId);
    }
  }

  async getPathState(runId, {
    expectedSequence = 0,
    maxStaleEvents = 5,
    vectorTailPoints = this.vectorTailPoints
  } = {}) {
    if (!runId) return this.#emptyState(null);
    return this.#enqueue(runId, async () => {
      const start = Date.now();
      const { cache, cacheHit } = await this.#loadCache(runId);
      if (this.#cacheFreshEnough(cache, { expectedSequence, maxStaleEvents })) {
        cache.hydrated = true;
        this.cacheByRun.set(runId, cache);
        this.#updateMetrics(cache, {
          buildMs: Date.now() - start,
          cacheHit
        });
        return this.#toState(cache, { vectorTailPoints });
      }

      const { events, warnings } = await this.runStore.readEvents(runId, {
        afterSequence: cache.eventSequence
      });
      for (const warning of warnings || []) {
        this.logger.warn?.(warning);
      }

      let changed = false;
      for (const event of events) {
        if (this.#applyEvent(cache, event)) {
          changed = true;
        }
      }
      cache.hydrated = true;
      this.cacheByRun.set(runId, cache);

      if (changed && this.writeDebounceMs <= 0) {
        await this.#writeCache(runId, cache);
      } else if (changed) {
        this.#scheduleWrite(runId);
      }

      this.#updateMetrics(cache, {
        buildMs: Date.now() - start,
        cacheHit
      });
      return this.#toState(cache, { vectorTailPoints });
    });
  }

  async recordLiveMove(data) {
    const runId = data?.runId;
    if (!runId || data?.intermediate) return null;

    const cache = this.cacheByRun.get(runId);
    const hydrationQueued = this.queues.has(runId);
    if (!cache?.hydrated && !hydrationQueued) {
      return null;
    }

    return this.#enqueue(runId, async () => {
      const current = this.cacheByRun.get(runId);
      if (!current?.hydrated) return null;
      const point = extractPathPointFromMove(data);
      if (!point || !this.#appendPoint(current, point)) {
        return this.#toState(current, { includeFullPath: false });
      }

      this.#updateMetrics(current, {
        buildMs: this.metrics.pathProjectionBuildMs,
        cacheHit: true
      });

      if (this.writeDebounceMs <= 0) {
        await this.#writeCache(runId, current);
      } else {
        this.#scheduleWrite(runId);
      }

      return this.#toState(current, { includeFullPath: false });
    });
  }

  async getRenderPath(runId, {
    expectedSequence = 0,
    maxStaleEvents = 5,
    clonePoints = true
  } = {}) {
    if (!runId) {
      return {
        runId: null,
        sequence: 0,
        pathSequence: 0,
        stepCount: 0,
        points: []
      };
    }

    await this.getPathState(runId, { expectedSequence, maxStaleEvents, vectorTailPoints: 0 });
    const cache = this.cacheByRun.get(runId);
    if (!cache) {
      return {
        runId,
        sequence: 0,
        pathSequence: 0,
        stepCount: 0,
        points: []
      };
    }

    return {
      runId: cache.runId,
      sequence: cache.eventSequence,
      pathSequence: cache.pathSequence,
      stepCount: cache.stepCount,
      points: clonePoints ? cache.points.slice() : cache.points
    };
  }

  async flushWrites() {
    const pendingRunIds = Array.from(this.writeTimers.keys());
    for (const runId of pendingRunIds) {
      const timer = this.writeTimers.get(runId);
      if (timer) clearTimeout(timer);
      this.writeTimers.delete(runId);
      const cache = this.cacheByRun.get(runId);
      if (cache) {
        await this.#writeCache(runId, cache);
      }
    }
  }

  async #enqueue(runId, fn) {
    const previous = this.queues.get(runId) || Promise.resolve();
    const next = previous.then(fn, fn).finally(() => {
      if (this.queues.get(runId) === next) {
        this.queues.delete(runId);
      }
    });
    this.queues.set(runId, next.catch(() => {}));
    return next;
  }

  async #loadCache(runId) {
    const existing = this.cacheByRun.get(runId);
    if (existing) {
      return { cache: existing, cacheHit: true };
    }

    try {
      const raw = JSON.parse(await fsp.readFile(this.getCachePath(runId), 'utf8'));
      const cache = this.#normalizeCache(runId, raw);
      this.cacheByRun.set(runId, cache);
      return { cache, cacheHit: true };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn?.(`Failed to read minimap path cache for run ${runId}: ${error.message}`);
      }
      const cache = await this.#seedCacheFromSnapshot(runId) || this.#emptyCache(runId);
      this.cacheByRun.set(runId, cache);
      return { cache, cacheHit: false };
    }
  }

  async #seedCacheFromSnapshot(runId) {
    let snapshot = await this.runStore.readCurrentSnapshot().catch(error => {
      this.logger.warn?.(`Failed to read current snapshot for minimap path seed: ${error.message}`);
      return null;
    });
    if (snapshot?.runId !== runId) {
      snapshot = await this.runStore.readSnapshot(runId).catch(error => {
        this.logger.warn?.(`Failed to read snapshot for minimap path seed ${runId}: ${error.message}`);
        return null;
      });
    }
    if (!snapshot || snapshot.runId !== runId) return null;

    const graphEntries = snapshot.graph instanceof Map
      ? Array.from(snapshot.graph.entries())
      : Object.entries(snapshot.graph || {});
    const points = graphEntries
      .filter(([, node]) => node && Number.isFinite(Number(node.timestamp)))
      .sort((a, b) => Number(a[1].timestamp) - Number(b[1].timestamp))
      .map(([panoId, node]) => {
        const position = validPosition(node);
        if (!position) return null;
        return {
          ...position,
          panoId,
          stepCount: 0,
          sequence: 0,
          timestamp: Number(node.timestamp) || null
        };
      })
      .filter(Boolean);
    const sequence = numberOr(snapshot.eventLog?.lastSequence, 0);
    return {
      runId,
      eventSequence: sequence,
      pathSequence: sequence,
      stepCount: numberOr(snapshot.stepCount, 0),
      points,
      bounds: buildBounds(points),
      hydrated: false
    };
  }

  #normalizeCache(runId, raw) {
    const points = Array.isArray(raw?.points)
      ? raw.points
          .map(point => {
            const position = validPosition(point);
            if (!position) return null;
            return {
              ...position,
              panoId: point.panoId || null,
              stepCount: numberOr(point.stepCount, 0),
              sequence: numberOr(point.sequence, 0),
              timestamp: point.timestamp || null
            };
          })
          .filter(Boolean)
      : [];
    const maxPointSequence = points.reduce(
      (max, point) => Math.max(max, numberOr(point.sequence, 0)),
      0
    );
    return {
      runId,
      eventSequence: Math.max(numberOr(raw?.eventSequence, numberOr(raw?.sequence, 0)), maxPointSequence),
      pathSequence: Math.max(numberOr(raw?.pathSequence, 0), maxPointSequence),
      stepCount: Math.max(numberOr(raw?.stepCount, 0), ...points.map(point => numberOr(point.stepCount, 0))),
      points,
      bounds: raw?.bounds || buildBounds(points),
      hydrated: false
    };
  }

  #emptyCache(runId) {
    return {
      runId,
      eventSequence: 0,
      pathSequence: 0,
      stepCount: 0,
      points: [],
      bounds: null,
      hydrated: false
    };
  }

  #emptyState(runId) {
    return {
      runId,
      sequence: 0,
      pathSequence: 0,
      stepCount: 0,
      totalPoints: 0,
      vectorTailPoints: 0,
      archivedPoints: 0,
      tileVersion: 0,
      tileRendererRevision: TILE_RENDERER_REVISION,
      bounds: null,
      fullPath: []
    };
  }

  #cacheFreshEnough(cache, { expectedSequence, maxStaleEvents }) {
    if (!cache) return false;
    const expected = numberOr(expectedSequence, 0);
    if (expected <= 0) return cache.hydrated === true;
    const allowedLag = Math.max(0, numberOr(maxStaleEvents, 0));
    return cache.eventSequence >= expected - allowedLag;
  }

  #applyEvent(cache, event) {
    const sequence = numberOr(event.sequence, 0);
    if (sequence <= cache.eventSequence) return false;

    const point = extractPathPointFromStepEvent(event);
    if (point) {
      this.#appendPoint(cache, point);
    }

    cache.eventSequence = sequence;
    return true;
  }

  #appendPoint(cache, point) {
    if (!point || point.sequence <= cache.pathSequence) return false;

    cache.points.push(clonePathPoint(point));
    cache.bounds = extendBounds(cache.bounds, point);
    cache.pathSequence = point.sequence;
    cache.stepCount = Math.max(cache.stepCount, numberOr(point.stepCount, 0));
    cache.eventSequence = Math.max(cache.eventSequence, point.sequence);
    return true;
  }

  #toState(cache, { includeFullPath = true, vectorTailPoints = this.vectorTailPoints } = {}) {
    const pointCount = cache.points.length;
    const tailCount = Math.max(0, Math.min(parseIntOr(vectorTailPoints, this.vectorTailPoints), pointCount));
    const archivedPoints = Math.max(0, pointCount - tailCount);
    const fullPath = includeFullPath && tailCount > 0
      ? cache.points.slice(pointCount - tailCount).map(clonePathPoint)
      : [];
    return {
      runId: cache.runId,
      sequence: cache.eventSequence,
      pathSequence: cache.pathSequence,
      stepCount: cache.stepCount,
      totalPoints: pointCount,
      vectorTailPoints: tailCount,
      archivedPoints,
      // Exact archived cutover. Coarse buckets can create path gaps because the
      // client vector tail moves every step while immutable raster URLs do not.
      tileVersion: archivedPoints,
      tileRendererRevision: TILE_RENDERER_REVISION,
      bounds: cloneBounds(cache.bounds),
      fullPath
    };
  }

  #updateMetrics(cache, { buildMs, cacheHit }) {
    this.metrics = {
      pathProjectionSequence: cache.eventSequence,
      pathProjectionPathSequence: cache.pathSequence,
      pathProjectionPoints: cache.points.length,
      pathProjectionBuildMs: buildMs,
      pathProjectionCacheHit: cacheHit
    };
  }

  #scheduleWrite(runId) {
    if (this.writeTimers.has(runId)) return;
    const timer = setTimeout(() => {
      this.writeTimers.delete(runId);
      const cache = this.cacheByRun.get(runId);
      if (!cache) return;
      this.#writeCache(runId, cache).catch(error => {
        this.logger.warn?.(`Failed to write minimap path cache for run ${runId}: ${error.message}`);
      });
    }, this.writeDebounceMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.writeTimers.set(runId, timer);
  }

  async #writeCache(runId, cache) {
    await atomicWriteJson(this.getCachePath(runId), {
      version: 1,
      runId,
      eventSequence: cache.eventSequence,
      pathSequence: cache.pathSequence,
      stepCount: cache.stepCount,
      bounds: cache.bounds,
      points: cache.points
    });
  }
}

(function(global) {
  function numberOr(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function normalizePosition(position) {
    if (!position || typeof position !== 'object') return null;
    const lat = Number(position.lat);
    const lng = Number(position.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  }

  function normalizePathPoint(point, fallback = {}) {
    const position = normalizePosition(point);
    if (!position) return null;
    return {
      ...position,
      panoId: point.panoId || fallback.panoId || null,
      stepCount: numberOr(point.stepCount, numberOr(fallback.stepCount, 0)),
      sequence: numberOr(point.sequence, numberOr(fallback.sequence, 0)),
      timestamp: point.timestamp || fallback.timestamp || null
    };
  }

  class MinimapPathState {
    constructor({ maxBufferedMoves = 5000 } = {}) {
      this.maxBufferedMoves = maxBufferedMoves;
      this.reset();
    }

    reset(runId = null) {
      this.runId = runId;
      this.baseSequence = 0;
      this.lastAppliedSequence = 0;
      this.pathSequence = 0;
      this.stepCount = 0;
      this.points = [];
      this.liveMoves = [];
    }

    setRun(runId) {
      if (!runId) return;
      if (this.runId && this.runId !== runId) {
        this.reset(runId);
        return;
      }
      this.runId = runId;
    }

    get coordinates() {
      return this.points.map(point => [point.lng, point.lat]);
    }

    applyFullPath(points, meta = {}) {
      const runId = meta.runId || this.runId || null;
      this.setRun(runId);

      const normalizedPoints = Array.isArray(points)
        ? points.map(point => normalizePathPoint(point)).filter(Boolean)
        : [];
      const maxPointSequence = normalizedPoints.reduce(
        (max, point) => Math.max(max, point.sequence),
        0
      );
      const sequence = numberOr(meta.sequence, maxPointSequence);
      if (sequence < this.baseSequence) {
        return { applied: false, reason: 'stale-full-path' };
      }

      const replayMoves = this.liveMoves
        .filter(move => move.sequence > sequence)
        .sort((a, b) => a.sequence - b.sequence);

      this.points = normalizedPoints;
      this.baseSequence = sequence;
      this.lastAppliedSequence = sequence;
      this.pathSequence = Math.max(numberOr(meta.pathSequence, maxPointSequence), maxPointSequence);
      this.stepCount = Math.max(
        numberOr(meta.stepCount, 0),
        ...normalizedPoints.map(point => numberOr(point.stepCount, 0))
      );

      for (const move of replayMoves) {
        this.#appendLiveMove(move);
      }

      this.liveMoves = this.liveMoves
        .filter(move => move.sequence > this.baseSequence)
        .slice(-this.maxBufferedMoves);

      return { applied: true, replayed: replayMoves.length };
    }

    applyLivePosition(position, meta = {}) {
      const runId = meta.runId || this.runId || null;
      this.setRun(runId);

      const normalizedPosition = normalizePosition(position);
      if (!normalizedPosition) {
        return { applied: false, reason: 'invalid-position' };
      }

      if (meta.intermediate) {
        return { applied: false, markerOnly: true, position: normalizedPosition };
      }

      const sequence = numberOr(meta.sequence, 0);
      if (sequence > 0 && sequence <= this.lastAppliedSequence) {
        return { applied: false, reason: 'stale-live-move' };
      }

      const point = normalizePathPoint({
        ...normalizedPosition,
        panoId: meta.panoId,
        stepCount: meta.stepCount,
        sequence,
        timestamp: meta.timestamp
      });
      if (!point) {
        return { applied: false, reason: 'invalid-point' };
      }

      this.#appendLiveMove(point);
      if (sequence > 0) {
        this.liveMoves.push(point);
        this.liveMoves = this.liveMoves.slice(-this.maxBufferedMoves);
      }

      return { applied: true, point };
    }

    #appendLiveMove(point) {
      this.points.push(point);
      this.stepCount = Math.max(this.stepCount, numberOr(point.stepCount, 0));
      if (point.sequence > 0) {
        this.lastAppliedSequence = Math.max(this.lastAppliedSequence, point.sequence);
        this.pathSequence = Math.max(this.pathSequence, point.sequence);
      }
    }
  }

  global.MinimapPathState = MinimapPathState;
})(typeof window !== 'undefined' ? window : globalThis);

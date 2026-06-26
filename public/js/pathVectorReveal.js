(function(global) {
  const DEFAULT_REVEAL_OPTIONS = Object.freeze({
    initialPoints: 6000,
    minChunkPoints: 12000,
    maxFrames: 18,
    prefetchConcurrency: 4,
    frameDelayMs: 0
  });

  function integerOr(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function rangesFromStarts(starts, totalPoints) {
    const total = Math.max(0, integerOr(totalPoints, 0));
    const ranges = [];
    let end = total;
    for (const rawStart of starts || []) {
      const start = clamp(integerOr(rawStart, 0), 0, end);
      if (start < end) {
        ranges.push({
          start,
          end,
          count: end - start
        });
      }
      end = start;
    }
    return ranges;
  }

  function makeBackwardRevealPlan(totalPoints, options = {}) {
    const total = Math.max(0, integerOr(totalPoints, 0));
    const frameDelayMs = clamp(
      integerOr(options.frameDelayMs, DEFAULT_REVEAL_OPTIONS.frameDelayMs),
      0,
      500
    );
    const prefetchConcurrency = clamp(
      integerOr(options.prefetchConcurrency, DEFAULT_REVEAL_OPTIONS.prefetchConcurrency),
      1,
      8
    );

    if (total < 2) {
      return {
        totalPoints: total,
        initialStartIndex: 0,
        chunkPoints: 0,
        prefetchConcurrency,
        frameDelayMs,
        starts: total > 0 ? [0] : [],
        ranges: total > 0 ? [{ start: 0, end: total, count: total }] : []
      };
    }

    const tailPoints = Math.max(0, integerOr(options.tailPoints, 0));
    const initialPoints = clamp(
      Math.max(
        integerOr(options.initialPoints, DEFAULT_REVEAL_OPTIONS.initialPoints),
        tailPoints,
        2
      ),
      2,
      total
    );
    const initialStartIndex = total - initialPoints;
    if (initialStartIndex <= 0) {
      return {
        totalPoints: total,
        initialStartIndex: 0,
        chunkPoints: 0,
        prefetchConcurrency,
        frameDelayMs,
        starts: [0],
        ranges: [{ start: 0, end: total, count: total }]
      };
    }

    const maxFrames = clamp(
      integerOr(options.maxFrames, DEFAULT_REVEAL_OPTIONS.maxFrames),
      1,
      120
    );
    const minChunkPoints = clamp(
      integerOr(options.minChunkPoints, DEFAULT_REVEAL_OPTIONS.minChunkPoints),
      1,
      total
    );
    const chunkPoints = Math.max(
      minChunkPoints,
      Math.ceil(initialStartIndex / maxFrames)
    );
    const starts = [initialStartIndex];
    let start = initialStartIndex;
    while (start > 0) {
      start = Math.max(0, start - chunkPoints);
      starts.push(start);
    }

    return {
      totalPoints: total,
      initialStartIndex,
      chunkPoints,
      prefetchConcurrency,
      frameDelayMs,
      starts,
      ranges: rangesFromStarts(starts, total)
    };
  }

  global.MinimapPathReveal = {
    DEFAULT_REVEAL_OPTIONS,
    rangesFromStarts,
    makeBackwardRevealPlan
  };
})(typeof window !== 'undefined' ? window : globalThis);

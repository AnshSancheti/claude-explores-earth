import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { RunStore } from '../server/services/runStore.js';
import { PathProjection } from '../server/services/pathProjection.js';

async function makeProjection(options = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'path-projection-'));
  const logger = { warn: () => {}, error: () => {}, log: () => {} };
  const runStore = new RunStore({ dataDir, logger });
  const projection = new PathProjection({
    runStore,
    logger,
    writeDebounceMs: 0,
    ...options
  });
  return { dataDir, runStore, projection };
}

test('PathProjection replays compact and legacy completed steps in event order', async () => {
  const { runStore, projection } = await makeProjection();

  await runStore.appendEvent('run-path', { type: 'run_started' });
  await runStore.appendEvent('run-path', {
    type: 'step_completed',
    stepCount: 1,
    payload: {
      stepData: {
        stepCount: 1,
        panoId: 'A',
        newPosition: { lat: 1, lng: 2 }
      }
    }
  });
  await runStore.appendEvent('run-path', {
    type: 'state_loaded',
    payload: { restoreSource: 'v2-snapshot' }
  });
  await runStore.appendEvent('run-path', {
    type: 'step_completed',
    stepCount: 2,
    payload: {
      snapshot: {
        stepCount: 2,
        currentState: {
          panoId: 'B',
          position: { lat: 3, lng: 4 }
        }
      }
    }
  });

  const state = await projection.getPathState('run-path');
  assert.equal(state.runId, 'run-path');
  assert.equal(state.sequence, 4);
  assert.equal(state.pathSequence, 4);
  assert.equal(state.stepCount, 2);
  assert.deepEqual(
    state.fullPath.map(point => [point.panoId, point.stepCount, point.lat, point.lng, point.sequence]),
    [
      ['A', 1, 1, 2, 2],
      ['B', 2, 3, 4, 4]
    ]
  );
});

test('PathProjection catches up from a persisted cache sequence', async () => {
  const { dataDir, runStore, projection } = await makeProjection();

  await runStore.appendEvent('run-catchup', {
    type: 'step_completed',
    stepCount: 1,
    payload: {
      stepData: {
        stepCount: 1,
        panoId: 'A',
        newPosition: { lat: 1, lng: 1 }
      }
    }
  });

  const first = await projection.getPathState('run-catchup');
  assert.equal(first.fullPath.length, 1);

  await runStore.appendEvent('run-catchup', {
    type: 'step_completed',
    stepCount: 2,
    payload: {
      stepData: {
        stepCount: 2,
        panoId: 'B',
        newPosition: { lat: 2, lng: 2 }
      }
    }
  });

  const restartedProjection = new PathProjection({
    runStore: new RunStore({ dataDir, logger: { warn: () => {}, error: () => {} } }),
    logger: { warn: () => {}, error: () => {} },
    writeDebounceMs: 0
  });
  const caughtUp = await restartedProjection.getPathState('run-catchup');
  assert.equal(caughtUp.sequence, 2);
  assert.deepEqual(caughtUp.fullPath.map(point => point.panoId), ['A', 'B']);
});

test('PathProjection seeds first hydration from snapshot before replaying catch-up events', async () => {
  const { runStore, projection } = await makeProjection();

  for (let i = 1; i <= 5; i += 1) {
    await runStore.appendEvent('run-snapshot-seed', { type: 'run_started' });
  }
  await runStore.writeSnapshot('run-snapshot-seed', {
    runId: 'run-snapshot-seed',
    stepCount: 2,
    currentState: { panoId: 'B', position: { lat: 2, lng: 2 } },
    stats: { locationsVisited: 2 },
    graph: {
      A: { lat: 1, lng: 1, timestamp: 100 },
      B: { lat: 2, lng: 2, timestamp: 200 }
    },
    recentHistory: ['A', 'B'],
    decisionHistory: [],
    eventLog: { lastSequence: 5, lastEventId: 'event-5' }
  });
  await runStore.appendEvent('run-snapshot-seed', {
    type: 'step_completed',
    stepCount: 3,
    payload: {
      stepData: {
        stepCount: 3,
        panoId: 'C',
        newPosition: { lat: 3, lng: 3 }
      }
    }
  });

  const state = await projection.getPathState('run-snapshot-seed');
  assert.equal(state.sequence, 6);
  assert.equal(state.pathSequence, 6);
  assert.deepEqual(state.fullPath.map(point => point.panoId), ['A', 'B', 'C']);
});

test('PathProjection applies only final live moves after hydration', async () => {
  const { runStore, projection } = await makeProjection();

  await runStore.appendEvent('run-live', {
    type: 'step_completed',
    stepCount: 1,
    payload: {
      stepData: {
        stepCount: 1,
        panoId: 'A',
        newPosition: { lat: 1, lng: 1 }
      }
    }
  });
  await projection.getPathState('run-live');

  await projection.recordLiveMove({
    runId: 'run-live',
    sequence: 2,
    stepCount: 2,
    panoId: 'B-intermediate',
    newPosition: { lat: 9, lng: 9 },
    intermediate: true
  });
  const liveState = await projection.recordLiveMove({
    runId: 'run-live',
    sequence: 2,
    stepCount: 2,
    panoId: 'B',
    newPosition: { lat: 2, lng: 2 }
  });
  assert.deepEqual(liveState.fullPath, []);
  await projection.recordLiveMove({
    runId: 'run-live',
    sequence: 2,
    stepCount: 2,
    panoId: 'B-duplicate',
    newPosition: { lat: 3, lng: 3 }
  });

  const state = await projection.getPathState('run-live');
  assert.deepEqual(state.fullPath.map(point => point.panoId), ['A', 'B']);
  assert.equal(state.sequence, 2);
});

test('PathProjection returns defensive full-path point copies', async () => {
  const { runStore, projection } = await makeProjection();

  await runStore.appendEvent('run-copy', {
    type: 'step_completed',
    stepCount: 1,
    payload: {
      stepData: {
        stepCount: 1,
        panoId: 'A',
        newPosition: { lat: 1, lng: 1 }
      }
    }
  });

  const first = await projection.getPathState('run-copy');
  first.fullPath[0].panoId = 'mutated';
  first.fullPath.push({ panoId: 'extra', lat: 9, lng: 9 });

  const second = await projection.getPathState('run-copy');
  assert.deepEqual(second.fullPath.map(point => point.panoId), ['A']);
});

test('PathProjection skips event replay when hydrated cache is fresh enough', async () => {
  const { runStore, projection } = await makeProjection();

  await runStore.appendEvent('run-fresh-cache', {
    type: 'step_completed',
    stepCount: 1,
    payload: {
      stepData: {
        stepCount: 1,
        panoId: 'A',
        newPosition: { lat: 1, lng: 1 }
      }
    }
  });
  await projection.getPathState('run-fresh-cache');

  let readEventsCount = 0;
  const originalReadEvents = runStore.readEvents.bind(runStore);
  runStore.readEvents = async (...args) => {
    readEventsCount += 1;
    return originalReadEvents(...args);
  };

  const state = await projection.getPathState('run-fresh-cache', {
    expectedSequence: 1
  });

  assert.equal(readEventsCount, 0);
  assert.deepEqual(state.fullPath.map(point => point.panoId), ['A']);
});

test('PathProjection normalizes production-sized path caches without spreading point arrays', async () => {
  const { projection } = await makeProjection();
  const runId = 'run-large-cache';
  const pointCount = 130000;
  const cachePath = projection.getCachePath(runId);

  await fsp.mkdir(path.dirname(cachePath), { recursive: true });
  await fsp.writeFile(cachePath, `${JSON.stringify({
    version: 1,
    runId,
    eventSequence: 1,
    pathSequence: 1,
    stepCount: pointCount,
    bounds: {
      minLat: 35,
      minLng: 139,
      maxLat: 36,
      maxLng: 140
    },
    points: Array.from({ length: pointCount }, (_, i) => ({
      lat: 35 + i * 0.000001,
      lng: 139 + i * 0.000001,
      panoId: `P${i}`,
      stepCount: i,
      sequence: i,
      timestamp: null
    }))
  })}\n`);

  const state = await projection.getPathState(runId);

  assert.equal(state.totalPoints, pointCount);
  assert.equal(state.stepCount, pointCount);
  assert.equal(state.fullPath.length > 0, true);
});

test('PathProjection limits client vector payload while preserving full-path metadata', async () => {
  const { runStore, projection } = await makeProjection({
    vectorTailPoints: 2,
    tileVersionBucketPoints: 0
  });

  for (let i = 1; i <= 5; i += 1) {
    await runStore.appendEvent('run-tail', {
      type: 'step_completed',
      stepCount: i,
      payload: {
        stepData: {
          stepCount: i,
          panoId: `P${i}`,
          newPosition: { lat: i, lng: -i }
        }
      }
    });
  }

  const state = await projection.getPathState('run-tail');

  assert.equal(state.totalPoints, 5);
  assert.equal(state.vectorTailPoints, 3);
  assert.equal(state.archivedPoints, 3);
  assert.equal(state.tileVersion, 3);
  assert.equal(state.tileRendererRevision, 2);
  assert.deepEqual(state.fullPath.map(point => point.panoId), ['P3', 'P4', 'P5']);
  assert.deepEqual(state.bounds, {
    minLat: 1,
    minLng: -5,
    maxLat: 5,
    maxLng: -1
  });
});

test('PathProjection overlaps vector tail to archive tile bucket boundary', async () => {
  const { runStore, projection } = await makeProjection({
    vectorTailPoints: 2,
    tileVersionBucketPoints: 3
  });

  for (let i = 1; i <= 8; i += 1) {
    await runStore.appendEvent('run-bucket-tail', {
      type: 'step_completed',
      stepCount: i,
      payload: {
        stepData: {
          stepCount: i,
          panoId: `P${i}`,
          newPosition: { lat: i, lng: -i }
        }
      }
    });
  }

  const state = await projection.getPathState('run-bucket-tail');

  assert.equal(state.totalPoints, 8);
  assert.equal(state.tileVersion, 6);
  assert.equal(state.archivedPoints, 6);
  assert.equal(state.vectorTailPoints, 3);
  assert.deepEqual(state.fullPath.map(point => point.panoId), ['P6', 'P7', 'P8']);

  await runStore.appendEvent('run-bucket-tail', {
    type: 'step_completed',
    stepCount: 9,
    payload: {
      stepData: {
        stepCount: 9,
        panoId: 'P9',
        newPosition: { lat: 9, lng: -9 }
      }
    }
  });

  const overlapped = await projection.getPathState('run-bucket-tail', {
    expectedSequence: 9,
    maxStaleEvents: 0
  });

  assert.equal(overlapped.totalPoints, 9);
  assert.equal(overlapped.tileVersion, 6);
  assert.equal(overlapped.archivedPoints, 6);
  assert.equal(overlapped.vectorTailPoints, 4);
  assert.deepEqual(overlapped.fullPath.map(point => point.panoId), ['P6', 'P7', 'P8', 'P9']);
});

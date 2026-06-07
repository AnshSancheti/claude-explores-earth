import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { RunStore, reduceSnapshotWithEvents } from '../server/services/runStore.js';

async function makeStore() {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'run-store-'));
  return {
    dataDir,
    store: new RunStore({ dataDir, logger: { warn: () => {}, error: () => {} } })
  };
}

test('RunStore appends events with durable monotonically increasing sequence numbers', async () => {
  const { store } = await makeStore();

  const first = await store.appendEvent('run-1', {
    type: 'run_started',
    epoch: 1,
    payload: { currentState: { panoId: 'A' } }
  });
  const second = await store.appendEvent('run-1', {
    type: 'step_completed',
    epoch: 1,
    stepId: 'step-1',
    stepCount: 1,
    payload: { currentState: { panoId: 'B' } }
  });

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);

  const { events } = await store.readEvents('run-1');
  assert.deepEqual(events.map(event => event.sequence), [1, 2]);
  assert.equal(events[1].stepId, 'step-1');
});

test('RunStore writes run snapshots and the compatibility current-run pointer', async () => {
  const { store } = await makeStore();
  const snapshot = await store.writeSnapshot('run-2', {
    stepCount: 4,
    currentState: { panoId: 'P4' },
    stats: { locationsVisited: 4 },
    graph: {},
    recentHistory: [],
    decisionHistory: [],
    eventLog: { lastSequence: 9, lastEventId: 'event-9' }
  });

  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.runId, 'run-2');
  assert.equal(snapshot.eventLog.lastSequence, 9);

  const runSnapshot = await store.readSnapshot('run-2');
  const currentSnapshot = await store.readCurrentSnapshot();
  assert.equal(runSnapshot.stepCount, 4);
  assert.equal(currentSnapshot.currentState.panoId, 'P4');
});

test('RunStore reads only events after a known sequence', async () => {
  const { store } = await makeStore();

  for (let i = 1; i <= 5; i += 1) {
    await store.appendEvent('run-tail', {
      type: 'step_completed',
      stepCount: i,
      payload: { stepData: { stepCount: i, panoId: `P${i}` } }
    });
  }

  const { events } = await store.readEvents('run-tail', { afterSequence: 3 });
  assert.deepEqual(events.map(event => event.sequence), [4, 5]);

  const none = await store.readEvents('run-tail', { afterSequence: 99 });
  assert.deepEqual(none.events, []);
});

test('RunStore tail reader ignores one corrupt trailing JSONL line', async () => {
  const { store } = await makeStore();
  await store.appendEvent('run-tail-corrupt', { type: 'run_started' });
  await store.appendEvent('run-tail-corrupt', { type: 'step_completed', stepCount: 1 });
  await fsp.appendFile(store.getEventLogPath('run-tail-corrupt'), '{"partial":');

  const { events, warnings } = await store.readEvents('run-tail-corrupt', { afterSequence: 1 });
  assert.deepEqual(events.map(event => event.sequence), [2]);
  assert.equal(warnings.length, 1);
});

test('RunStore restoreCurrent recovers the highest-step snapshot if current pointer regresses', async () => {
  const { store } = await makeStore();
  await store.writeSnapshot('old-good-run', {
    stepCount: 1000,
    currentState: { panoId: 'OLD' },
    stats: { locationsVisited: 1000 },
    graph: { OLD: { lat: 1, lng: 2, timestamp: 1 } },
    recentHistory: [],
    decisionHistory: [],
    eventLog: { lastSequence: 2000, lastEventId: 'old-event' }
  });
  await store.writeSnapshot('bad-new-run', {
    stepCount: 3,
    currentState: { panoId: 'NEW' },
    stats: { locationsVisited: 3 },
    graph: { NEW: { lat: 3, lng: 4, timestamp: 2 } },
    recentHistory: [],
    decisionHistory: [],
    eventLog: { lastSequence: 6, lastEventId: 'new-event' }
  });

  const restored = await store.restoreCurrent();
  assert.equal(restored.snapshot.runId, 'old-good-run');
  assert.equal(restored.snapshot.stepCount, 1000);
});

test('RunStore ignores one corrupt trailing JSONL line during restore reads', async () => {
  const { store } = await makeStore();
  await store.appendEvent('run-3', { type: 'run_started' });
  await fsp.appendFile(store.getEventLogPath('run-3'), '{"partial":');

  const { events, warnings } = await store.readEvents('run-3');
  assert.equal(events.length, 1);
  assert.equal(warnings.length, 1);
});

test('RunStore repairs a corrupt trailing JSONL line before the next append', async () => {
  const { store } = await makeStore();
  await store.appendEvent('run-repair', { type: 'run_started' });
  await fsp.appendFile(store.getEventLogPath('run-repair'), '{"partial":');

  const next = await store.appendEvent('run-repair', {
    type: 'step_completed',
    stepCount: 1
  });

  assert.equal(next.sequence, 2);
  const { events, warnings } = await store.readEvents('run-repair');
  assert.equal(warnings.length, 0);
  assert.deepEqual(events.map(event => event.type), ['run_started', 'step_completed']);
});

test('reduceSnapshotWithEvents replays completed step snapshots in event order', () => {
  const base = {
    schemaVersion: 2,
    runId: 'run-4',
    stepCount: 1,
    currentState: { panoId: 'A' },
    eventLog: { lastSequence: 1, lastEventId: 'event-1' }
  };
  const events = [
    {
      eventId: 'event-3',
      runId: 'run-4',
      epoch: 2,
      sequence: 3,
      type: 'step_completed',
      timestamp: '2026-06-06T00:00:03.000Z',
      payload: {
        snapshot: {
          schemaVersion: 2,
          runId: 'run-4',
          stepCount: 3,
          currentState: { panoId: 'C' },
          eventLog: { lastSequence: 3, lastEventId: 'event-3' }
        }
      }
    },
    {
      eventId: 'event-2',
      runId: 'run-4',
      epoch: 2,
      sequence: 2,
      type: 'step_completed',
      timestamp: '2026-06-06T00:00:02.000Z',
      payload: {
        snapshot: {
          schemaVersion: 2,
          runId: 'run-4',
          stepCount: 2,
          currentState: { panoId: 'B' },
          eventLog: { lastSequence: 2, lastEventId: 'event-2' }
        }
      }
    }
  ];

  const restored = reduceSnapshotWithEvents(base, events);
  assert.equal(restored.stepCount, 3);
  assert.equal(restored.currentState.panoId, 'C');
  assert.equal(restored.eventLog.lastSequence, 3);
});

test('reduceSnapshotWithEvents replays compact completed step deltas', () => {
  const base = {
    schemaVersion: 2,
    runId: 'run-compact',
    stepCount: 1,
    currentState: {
      panoId: 'A',
      position: { lat: 1, lng: 2 },
      heading: 0,
      mode: 'exploration'
    },
    stats: { locationsVisited: 1, distanceTraveled: 0, pathLength: 1 },
    graph: {
      A: { lat: 1, lng: 2, neighbors: ['B'], timestamp: 1000 }
    },
    recentHistory: ['A'],
    decisionHistory: [],
    eventLog: { lastSequence: 1, lastEventId: 'event-1' }
  };

  const events = [
    {
      eventId: 'event-2',
      runId: 'run-compact',
      epoch: 3,
      sequence: 2,
      type: 'step_completed',
      timestamp: '2026-06-06T00:00:02.000Z',
      stepId: 'step-2',
      stepCount: 2,
      payload: {
        stepData: {
          stepCount: 2,
          panoId: 'B',
          previousPanoId: 'A',
          newPosition: { lat: 1.1, lng: 2.2 },
          direction: 90,
          mode: 'pathfinding',
          eventType: 'autopilot-single-link',
          autoMove: true,
          stats: { locationsVisited: 2, distanceTraveled: 12, pathLength: 2 },
          coverageDelta: {
            panoId: 'B',
            position: { lat: 1.1, lng: 2.2 },
            traversedFrom: 'A',
            links: [{ pano: 'C', heading: 90, description: 'ahead' }],
            timestamp: 2000,
            recentHistory: ['A', 'B']
          }
        }
      }
    }
  ];

  const restored = reduceSnapshotWithEvents(base, events);
  assert.equal(restored.stepCount, 2);
  assert.equal(restored.currentState.panoId, 'B');
  assert.deepEqual(restored.currentState.position, { lat: 1.1, lng: 2.2 });
  assert.equal(restored.stats.locationsVisited, 2);
  assert.deepEqual(restored.graph.B.neighbors.sort(), ['A', 'C']);
  assert.deepEqual(restored.graph.A.neighbors, ['B']);
  assert.deepEqual(restored.recentHistory, ['A', 'B']);
  assert.equal(restored.decisionHistory.length, 1);
  assert.equal(restored.decisionHistory[0].coverageDelta, undefined);
  assert.equal(restored.eventLog.lastSequence, 2);
});

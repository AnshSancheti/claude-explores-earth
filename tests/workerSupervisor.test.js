import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import * as fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { WorkerSupervisor } from '../server/worker/workerSupervisor.js';

class FakeWorker extends EventEmitter {
  constructor({ autoRespond = true } = {}) {
    super();
    this.pid = 4242;
    this.connected = true;
    this.killed = false;
    this.sent = [];
    this.autoRespond = autoRespond;
    this.responses = new Map();
  }

  send(message, callback) {
    this.sent.push(message);
    callback?.();
    if (!this.autoRespond || message.kind !== 'request') return;

    const result = this.responses.get(message.command) || { success: true, command: message.command };
    setImmediate(() => {
      this.emit('message', {
        kind: 'response',
        requestId: message.requestId,
        ok: true,
        result
      });
    });
  }

  kill(signal) {
    this.killed = true;
    this.connected = false;
    setImmediate(() => this.emit('exit', null, signal));
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function makeSupervisor(fakeWorker, options = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'worker-supervisor-'));
  return new WorkerSupervisor({
    dataDir,
    forkFn: () => fakeWorker,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    commandTimeoutMs: 50,
    heartbeatStaleMs: 10000,
    ...options
  });
}

test('WorkerSupervisor boots worker and sends control commands over IPC', async (t) => {
  const fakeWorker = new FakeWorker();
  const supervisor = await makeSupervisor(fakeWorker);
  t.after(() => supervisor.dispose());

  const boot = await supervisor.start({ autoRestore: false, autoStart: false });
  assert.equal(boot.success, true);
  assert.equal(fakeWorker.sent[0].command, 'boot');
  assert.deepEqual(fakeWorker.sent[0].payload, { autoRestore: false, autoStart: false });

  const started = await supervisor.startExploration();
  assert.equal(started.command, 'start');
  assert.equal(supervisor.getMetrics().workerDesiredExploring, true);
});

test('WorkerSupervisor seeds boot metrics from current save', async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'worker-supervisor-'));
  await fsp.mkdir(path.join(dataDir, 'saves'), { recursive: true });
  await fsp.writeFile(path.join(dataDir, 'saves', 'current-run.json'), JSON.stringify({
    runId: 'saved-run',
    activeEpoch: 7,
    stepCount: 123,
    stats: {
      locationsVisited: 120,
      distanceTraveled: 4567,
      pathLength: 121
    }
  }));

  const fakeWorker = new FakeWorker({ autoRespond: false });
  const supervisor = new WorkerSupervisor({
    dataDir,
    forkFn: () => fakeWorker,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    commandTimeoutMs: 5000,
    heartbeatStaleMs: 10000
  });
  t.after(() => supervisor.dispose());

  const booting = supervisor.start({ autoRestore: true, autoStart: true });
  const metrics = supervisor.getMetrics();
  assert.equal(metrics.runId, 'saved-run');
  assert.equal(metrics.lastCompletedStep, 123);
  assert.equal(metrics.stepCount, 123);
  assert.equal(metrics.stepStatus, 'worker-booting');
  assert.equal(metrics.workerDesiredExploring, true);

  fakeWorker.emit('message', {
    kind: 'response',
    requestId: fakeWorker.sent[0].requestId,
    ok: true,
    result: { success: true }
  });
  await booting;
});

test('WorkerSupervisor records heartbeat metrics and forwards broadcasts', async (t) => {
  const broadcasts = [];
  const fakeWorker = new FakeWorker();
  const supervisor = await makeSupervisor(fakeWorker, {
    onBroadcast: (name, data) => broadcasts.push({ name, data })
  });
  t.after(() => supervisor.dispose());
  await supervisor.start({ autoRestore: false, autoStart: false });

  fakeWorker.emit('message', {
    kind: 'heartbeat',
    metrics: { isExploring: true, stepCount: 9 }
  });
  fakeWorker.emit('message', {
    kind: 'broadcast',
    name: 'move-decision',
    data: {
      stepCount: 9,
      panoId: 'P9',
      newPosition: { lat: 1, lng: 2 },
      stats: { locationsVisited: 9 }
    }
  });

  const metrics = supervisor.getMetrics();
  assert.equal(metrics.workerReady, true);
  assert.equal(metrics.stepCount, 9);
  assert.equal(broadcasts[0].name, 'move-decision');

  const state = await supervisor.getCurrentState({ includeFullPath: false });
  assert.equal(state.stepCount, 9);
  assert.equal(state.panoId, 'P9');
});

test('WorkerSupervisor advances cached metrics from move broadcasts', async (t) => {
  const fakeWorker = new FakeWorker();
  const supervisor = await makeSupervisor(fakeWorker);
  t.after(() => supervisor.dispose());
  await supervisor.start({ autoRestore: false, autoStart: false });

  fakeWorker.emit('message', {
    kind: 'heartbeat',
    metrics: {
      isExploring: true,
      runId: 'run-broadcast-metrics',
      stepCount: 10,
      lastCompletedStep: 10,
      locationsVisited: 9,
      stepStatus: 'running'
    }
  });
  fakeWorker.emit('message', {
    kind: 'broadcast',
    name: 'move-decision',
    data: {
      runId: 'run-broadcast-metrics',
      stepCount: 11,
      panoId: 'P11',
      newPosition: { lat: 3, lng: 4 },
      stats: {
        locationsVisited: 10,
        distanceTraveled: 1234,
        pathLength: 11
      },
      sequence: 77
    }
  });

  const metrics = supervisor.getMetrics();
  assert.equal(metrics.runId, 'run-broadcast-metrics');
  assert.equal(metrics.stepCount, 11);
  assert.equal(metrics.lastCompletedStep, 11);
  assert.equal(metrics.locationsVisited, 10);
  assert.equal(metrics.distanceTraveled, 1234);
  assert.equal(metrics.pathLength, 11);
  assert.equal(metrics.lastEventSequence, 77);
});

test('WorkerSupervisor rejects timed-out worker commands', async (t) => {
  const fakeWorker = new FakeWorker();
  const supervisor = await makeSupervisor(fakeWorker);
  t.after(() => supervisor.dispose());
  await supervisor.start({ autoRestore: false, autoStart: false });

  fakeWorker.autoRespond = false;
  await assert.rejects(
    supervisor.takeSingleStep(),
    /Exploration worker command timed out: step/
  );
});

test('WorkerSupervisor preserves high-water metrics during restart boot', async (t) => {
  const firstWorker = new FakeWorker();
  const secondWorker = new FakeWorker({ autoRespond: false });
  const workers = [firstWorker, secondWorker];
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'worker-supervisor-'));
  const supervisor = new WorkerSupervisor({
    dataDir,
    forkFn: () => workers.shift(),
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    commandTimeoutMs: 5000,
    heartbeatStaleMs: 10000
  });
  t.after(() => supervisor.dispose());

  await supervisor.start({ autoRestore: false, autoStart: false });
  firstWorker.emit('message', {
    kind: 'heartbeat',
    metrics: {
      isExploring: true,
      runId: 'run-1',
      stepCount: 100,
      lastCompletedStep: 100,
      stepStatus: 'running'
    }
  });
  await supervisor.startExploration();

  firstWorker.emit('exit', 1, null);
  await wait(1100);
  assert.equal(secondWorker.sent[0].command, 'boot');
  assert.deepEqual(secondWorker.sent[0].payload, { autoRestore: true, autoStart: true });

  secondWorker.emit('message', {
    kind: 'heartbeat',
    metrics: {
      isExploring: false,
      runId: 'empty-boot-run',
      stepCount: 0,
      lastCompletedStep: 0,
      stepStatus: 'idle'
    }
  });

  const metrics = supervisor.getMetrics();
  assert.equal(metrics.runId, 'run-1');
  assert.equal(metrics.lastCompletedStep, 100);
  assert.equal(metrics.stepStatus, 'worker-booting');
  assert.equal(metrics.workerBooting, true);

  secondWorker.emit('message', {
    kind: 'response',
    requestId: secondWorker.sent[0].requestId,
    ok: true,
    result: { success: true }
  });
  await wait(10);
});

test('WorkerSupervisor serves client path state without worker full-path command', async (t) => {
  const fakeWorker = new FakeWorker();
  fakeWorker.responses.set('getState', {
    runId: 'run-path-client',
    isExploring: true,
    position: { lat: 2, lng: 2 },
    panoId: 'B',
    stats: { locationsVisited: 2 },
    stepCount: 2,
    recentHistory: []
  });

  const supervisor = await makeSupervisor(fakeWorker);
  t.after(() => supervisor.dispose());
  await supervisor.start({ autoRestore: false, autoStart: false });
  await supervisor.runStore.appendEvent('run-path-client', {
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
  await supervisor.runStore.appendEvent('run-path-client', {
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

  const emitted = [];
  const socket = {
    id: 'socket-1',
    connected: true,
    emit: (name, data) => emitted.push({ name, data })
  };
  supervisor.addClient(socket);
  await wait(160);

  assert.equal(fakeWorker.sent.some(message => message.command === 'getFullPath'), false);
  assert.equal(fakeWorker.sent.some(message => message.command === 'getState'), true);
  const pathState = emitted.find(event => event.name === 'path-state')?.data;
  assert.ok(pathState);
  assert.equal(pathState.runId, 'run-path-client');
  assert.equal(pathState.sequence, 2);
  assert.deepEqual(pathState.fullPath.map(point => point.panoId), ['A', 'B']);
});

test('WorkerSupervisor returns compact full vector path snapshots for the current run', async (t) => {
  const fakeWorker = new FakeWorker();
  const supervisor = await makeSupervisor(fakeWorker);
  t.after(() => supervisor.dispose());

  for (let i = 1; i <= 3; i += 1) {
    await supervisor.runStore.appendEvent('run-vector-snapshot', {
      type: 'step_completed',
      stepCount: i,
      payload: {
        stepData: {
          stepCount: i,
          panoId: `P${i}`,
          newPosition: {
            lat: 35.123456789 + i,
            lng: 139.987654321 + i
          }
        }
      }
    });
  }
  supervisor.lastState = {
    ...supervisor.lastState,
    runId: 'run-vector-snapshot',
    lastEventSequence: 3
  };

  const snapshot = await supervisor.getFullPathVectorSnapshot({
    runId: 'run-vector-snapshot',
    expectedSequence: 3
  });

  assert.equal(snapshot.runId, 'run-vector-snapshot');
  assert.equal(snapshot.sequence, 3);
  assert.equal(snapshot.totalPoints, 3);
  assert.equal(snapshot.coordinatePrecision, 6);
  assert.deepEqual(snapshot.coordinates, [
    [140.987654, 36.123457],
    [141.987654, 37.123457],
    [142.987654, 38.123457]
  ]);

  const binary = await supervisor.getFullPathVectorBinarySnapshot({
    runId: 'run-vector-snapshot',
    expectedSequence: 3
  });
  assert.equal(binary.runId, 'run-vector-snapshot');
  assert.equal(binary.sequence, 3);
  assert.equal(binary.totalPoints, 3);
  assert.equal(binary.coordinateCount, 3);
  assert.equal(binary.body.length, 24);
  assert.equal(binary.body.readInt32LE(0), 140987654);
  assert.equal(binary.body.readInt32LE(4), 36123457);

  await assert.rejects(
    () => supervisor.getFullPathVectorSnapshot({ runId: 'other-run' }),
    /Requested path run is not current/
  );
});

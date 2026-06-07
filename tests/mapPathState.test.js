import test from 'node:test';
import assert from 'node:assert/strict';

await import('../public/js/mapPathState.js');

const { MinimapPathState } = globalThis;

test('MinimapPathState replays live moves that arrive before full path state', () => {
  const state = new MinimapPathState();

  state.applyLivePosition(
    { lat: 2, lng: 2 },
    { runId: 'run-map', sequence: 11, stepCount: 11, panoId: 'live-11' }
  );
  state.applyFullPath(
    [{ lat: 1, lng: 1, sequence: 10, stepCount: 10, panoId: 'base-10' }],
    { runId: 'run-map', sequence: 10, pathSequence: 10, stepCount: 10 }
  );

  assert.deepEqual(
    state.points.map(point => [point.panoId, point.sequence]),
    [['base-10', 10], ['live-11', 11]]
  );
  assert.deepEqual(state.coordinates, [[1, 1], [2, 2]]);
});

test('MinimapPathState ignores stale full path payloads', () => {
  const state = new MinimapPathState();

  state.applyFullPath(
    [{ lat: 1, lng: 1, sequence: 10, stepCount: 10, panoId: 'base-10' }],
    { runId: 'run-map', sequence: 10 }
  );
  state.applyLivePosition(
    { lat: 2, lng: 2 },
    { runId: 'run-map', sequence: 11, stepCount: 11, panoId: 'live-11' }
  );
  const result = state.applyFullPath(
    [{ lat: 9, lng: 9, sequence: 9, stepCount: 9, panoId: 'old-9' }],
    { runId: 'run-map', sequence: 9 }
  );

  assert.equal(result.applied, false);
  assert.deepEqual(
    state.points.map(point => point.panoId),
    ['base-10', 'live-11']
  );
});

test('MinimapPathState skips intermediate moves and stale duplicate live moves', () => {
  const state = new MinimapPathState();

  const intermediate = state.applyLivePosition(
    { lat: 9, lng: 9 },
    { runId: 'run-map', sequence: 12, stepCount: 12, panoId: 'intermediate', intermediate: true }
  );
  state.applyLivePosition(
    { lat: 1, lng: 1 },
    { runId: 'run-map', sequence: 12, stepCount: 12, panoId: 'final-12' }
  );
  const duplicate = state.applyLivePosition(
    { lat: 2, lng: 2 },
    { runId: 'run-map', sequence: 12, stepCount: 12, panoId: 'duplicate-12' }
  );

  assert.equal(intermediate.markerOnly, true);
  assert.equal(duplicate.applied, false);
  assert.deepEqual(state.points.map(point => point.panoId), ['final-12']);
});

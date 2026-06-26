import test from 'node:test';
import assert from 'node:assert/strict';

await import('../public/js/pathVectorReveal.js');

const { MinimapPathReveal } = globalThis;

test('path vector reveal starts with the requested visible tail', () => {
  const plan = MinimapPathReveal.makeBackwardRevealPlan(1000, {
    initialPoints: 100,
    tailPoints: 250,
    minChunkPoints: 100,
    maxFrames: 10
  });

  assert.equal(plan.initialStartIndex, 750);
  assert.equal(plan.starts[0], 750);
  assert.equal(plan.starts.at(-1), 0);
});

test('path vector reveal stays within bounded chunks for long paths', () => {
  const plan = MinimapPathReveal.makeBackwardRevealPlan(300000, {
    initialPoints: 2400,
    minChunkPoints: 6000,
    maxFrames: 40,
    frameDelayMs: 55
  });

  assert.equal(plan.starts[0], 297600);
  assert.equal(plan.starts.at(-1), 0);
  assert.ok(plan.starts.length <= 41);
  assert.ok(plan.chunkPoints >= 6000);

  for (let i = 1; i < plan.starts.length; i += 1) {
    assert.ok(plan.starts[i] < plan.starts[i - 1]);
  }
});

test('path vector reveal default completes large paths quickly', () => {
  const plan = MinimapPathReveal.makeBackwardRevealPlan(300000);

  assert.equal(plan.starts[0], 294000);
  assert.equal(plan.starts.at(-1), 0);
  assert.ok(plan.starts.length <= 11);
  assert.equal(plan.frameDelayMs, 0);
});

test('path vector reveal renders short paths immediately', () => {
  const plan = MinimapPathReveal.makeBackwardRevealPlan(12, {
    initialPoints: 100,
    tailPoints: 0
  });

  assert.deepEqual(plan.starts, [0]);
  assert.equal(plan.chunkPoints, 0);
});

test('path vector reveal clamps invalid totals to an empty plan', () => {
  const plan = MinimapPathReveal.makeBackwardRevealPlan('nope');

  assert.deepEqual(plan.starts, []);
  assert.equal(plan.totalPoints, 0);
});

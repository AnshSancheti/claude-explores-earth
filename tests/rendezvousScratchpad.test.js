import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendScratchpadOperations,
  createScratchpad,
  normalizeScratchpad,
  renderScratchpad,
  SCRATCHPAD_MAX_OPS_PER_TURN
} from '../server/rendezvous/scratchpad.js';

test('scratchpad accepts a bounded drawing grammar and assigns authorship', async () => {
  const rawOperations = Array.from({ length: SCRATCHPAD_MAX_OPS_PER_TURN + 5 }, (_, index) => ({
    type: index === 0 ? 'text' : 'arrow',
    text: index === 0 ? 'Broadway?\u0000' : undefined,
    at: { x: -4, y: 3 },
    from: { x: -1, y: 0.2 },
    to: { x: 2, y: 0.8 },
    width: 999
  }));

  const { scratchpad, accepted } = appendScratchpadOperations(createScratchpad(), rawOperations, {
    agentId: 'theo',
    turn: 7
  });

  assert.equal(accepted.length, SCRATCHPAD_MAX_OPS_PER_TURN);
  assert.equal(scratchpad.sequence, SCRATCHPAD_MAX_OPS_PER_TURN);
  assert.equal(accepted.every(operation => operation.author === 'theo'), true);
  assert.equal(accepted[0].text, 'Broadway?');
  assert.deepEqual(accepted[0].at, { x: 0, y: 1 });
  assert.deepEqual(accepted[1].from, { x: 0, y: 0.2 });
  assert.deepEqual(accepted[1].to, { x: 1, y: 0.8 });

  const image = await renderScratchpad(scratchpad);
  assert.equal(image.subarray(1, 4).toString(), 'PNG');
});

test('legacy notebook state normalizes to a blank versioned sheet', () => {
  const scratchpad = normalizeScratchpad({
    version: 1,
    lastReliableClue: 'Meet at Bryant Park',
    revisions: [{ answer: 'exact coordinates' }]
  });

  assert.equal(scratchpad.version, 2);
  assert.equal(scratchpad.owner, 'ada');
  assert.equal(scratchpad.sequence, 0);
  assert.deepEqual(scratchpad.operations, []);
});

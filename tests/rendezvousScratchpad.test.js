import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendScratchpadOperations,
  createScratchpad,
  currentScratchpadOperations,
  landmarkSymbolSvg,
  normalizeScratchpad,
  renderScratchpad,
  SCRATCHPAD_MAX_OPERATIONS,
  SCRATCHPAD_MAX_CURRENT_OPS_PER_AUTHOR,
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
  assert.equal(accepted.every(operation => operation.color === '#087fa8'), true);
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

  assert.equal(scratchpad.version, 3);
  assert.equal(scratchpad.owner, 'ada');
  assert.equal(scratchpad.sequence, 0);
  assert.deepEqual(scratchpad.operations, []);
});

test('v2 migration preserves legacy route text in audit while marking it non-current', () => {
  const scratchpad = normalizeScratchpad({
    version: 2,
    owner: 'theo',
    sequence: 2,
    operations: [
      {
        id: 'legacy-route-text',
        type: 'text',
        author: 'ada',
        text: 'GO NW TOWARD UNIV PL',
        at: { x: 0.2, y: 0.2 },
        size: 28,
        sequence: 1,
        turn: 12
      },
      {
        id: 'legacy-place-text',
        type: 'text',
        author: 'theo',
        text: 'W HOUSTON',
        at: { x: 0.5, y: 0.5 },
        size: 28,
        sequence: 2,
        turn: 13
      }
    ]
  });

  const routeText = scratchpad.operations.find(operation => operation.id === 'legacy-route-text');
  assert.equal(routeText.text, 'GO NW TOWARD UNIV PL');
  assert.equal(routeText.supersededReason, 'legacy_directive_text');
  assert.equal(currentScratchpadOperations(scratchpad).some(operation => operation.text === 'GO NW TOWARD UNIV PL'), false);
  assert.equal(currentScratchpadOperations(scratchpad).some(operation => operation.text === 'W HOUSTON'), true);
});

test('replaceMine revises only the current holder author while preserving friend ink and audit history', () => {
  let scratchpad = createScratchpad({ owner: 'ada' });
  scratchpad = appendScratchpadOperations(scratchpad, [
    { type: 'text', text: 'BROADWAY', at: { x: 0.2, y: 0.2 } },
    { type: 'arrow', from: { x: 0.2, y: 0.3 }, to: { x: 0.7, y: 0.3 } }
  ], { agentId: 'ada', turn: 1 }).scratchpad;
  scratchpad.owner = 'theo';
  scratchpad = appendScratchpadOperations(scratchpad, [
    { type: 'text', text: 'PARK', at: { x: 0.25, y: 0.6 } }
  ], { agentId: 'theo', turn: 2 }).scratchpad;
  scratchpad.owner = 'ada';

  const result = appendScratchpadOperations(scratchpad, [
    { type: 'replaceMine' },
    { type: 'landmark', center: { x: 0.52, y: 0.4 }, symbol: 'station', label: 'TIMES SQ' }
  ], { agentId: 'ada', turn: 3 });

  const current = currentScratchpadOperations(result.scratchpad);
  assert.equal(result.scratchpad.operations.length, 5);
  assert.equal(current.some(operation => operation.author === 'theo' && operation.text === 'PARK'), true);
  assert.equal(current.some(operation => operation.author === 'ada' && operation.label === 'TIMES SQ'), true);
  assert.equal(current.some(operation => operation.author === 'ada' && operation.text === 'BROADWAY'), false);
  assert.equal(
    result.scratchpad.operations.filter(operation => operation.author === 'ada' && operation.supersededReason === 'replaced_by_author').length,
    2
  );
});

test('current view deduplicates repeated labels and geometry without deleting audit operations', () => {
  const repeated = [
    { type: 'text', text: 'BROADWAY', at: { x: 0.2, y: 0.2 } },
    { type: 'text', text: 'Broadway', at: { x: 0.21, y: 0.22 } },
    { type: 'arrow', from: { x: 0.1, y: 0.5 }, to: { x: 0.8, y: 0.5 } },
    { type: 'arrow', from: { x: 0.11, y: 0.51 }, to: { x: 0.79, y: 0.49 } }
  ];
  const { scratchpad } = appendScratchpadOperations(createScratchpad(), repeated, {
    agentId: 'ada',
    turn: 1
  });

  const current = currentScratchpadOperations(scratchpad);
  assert.equal(scratchpad.operations.length, 4);
  assert.equal(current.filter(operation => operation.type === 'text').length, 1);
  assert.equal(current.filter(operation => operation.type === 'arrow').length, 1);
  assert.equal(scratchpad.operations.filter(operation => operation.supersededReason === 'deduplicated').length, 2);
});

test('crowded legacy sheets normalize to a bounded current composition at each sequence', async () => {
  const crowdedOperations = Array.from({ length: SCRATCHPAD_MAX_CURRENT_OPS_PER_AUTHOR + 8 }, (_, index) => ({
    id: `legacy-line-${index}`,
    type: 'line',
    author: 'ada',
    from: { x: 0.08, y: 0.08 + index * 0.045 },
    to: { x: 0.88, y: 0.12 + index * 0.045 },
    width: 4,
    sequence: index + 1,
    turn: index
  }));
  crowdedOperations.push({
    id: 'theo-landmark',
    type: 'landmark',
    author: 'theo',
    center: { x: 0.4, y: 0.55 },
    symbol: 'park',
    label: 'PARK',
    sequence: crowdedOperations.length + 1,
    turn: 20
  });

  const scratchpad = normalizeScratchpad({
    version: 2,
    owner: 'ada',
    sequence: crowdedOperations.length,
    operations: crowdedOperations
  });

  assert.equal(scratchpad.operations.length, crowdedOperations.length);
  assert.equal(currentScratchpadOperations(scratchpad).filter(operation => operation.author === 'ada').length, SCRATCHPAD_MAX_CURRENT_OPS_PER_AUTHOR);
  assert.equal(currentScratchpadOperations(scratchpad).some(operation => operation.author === 'theo' && operation.label === 'PARK'), true);
  assert.equal(currentScratchpadOperations(scratchpad, { throughSequence: 4 }).filter(operation => operation.author === 'ada').length, 4);

  const image = await renderScratchpad(scratchpad);
  assert.equal(image.subarray(1, 4).toString(), 'PNG');
});

test('scratchpad audit retention keeps a bounded sequence suffix with archive metadata', () => {
  const rawOperations = Array.from({ length: SCRATCHPAD_MAX_OPERATIONS + 15 }, (_, index) => ({
    id: `audit-${index + 1}`,
    type: 'line',
    author: index % 2 === 0 ? 'ada' : 'theo',
    from: { x: 0.05, y: (index % 20) / 25 },
    to: { x: 0.95, y: (index % 20) / 25 + 0.02 },
    width: 3,
    sequence: index + 1,
    turn: index + 1
  }));

  const scratchpad = normalizeScratchpad({
    version: 2,
    owner: 'ada',
    sequence: rawOperations.length,
    operations: rawOperations
  });

  assert.equal(scratchpad.operations.length, SCRATCHPAD_MAX_OPERATIONS);
  assert.equal(scratchpad.sequence, SCRATCHPAD_MAX_OPERATIONS + 15);
  assert.equal(scratchpad.archivedOperationCount, 15);
  assert.equal(scratchpad.archivedThroughSequence, 15);
  assert.equal(scratchpad.earliestRetainedSequence, 16);
  assert.equal(scratchpad.operations[0].sequence, 16);
  assert.equal(scratchpad.operations.at(-1).sequence, SCRATCHPAD_MAX_OPERATIONS + 15);
  assert.deepEqual(currentScratchpadOperations(scratchpad, { throughSequence: 10 }), []);
});

test('landmark symbol renderer emits distinct glyphs for symbol variants', () => {
  const base = {
    type: 'landmark',
    author: 'ada',
    color: '#24211d',
    center: { x: 0.5, y: 0.5 },
    radius: 0.055,
    width: 4
  };
  const variants = Object.fromEntries(['dot', 'star', 'park', 'station', 'square'].map(symbol => [
    symbol,
    landmarkSymbolSvg({ ...base, symbol })
  ]));

  assert.match(variants.dot, /<circle/);
  assert.match(variants.star, /<path/);
  assert.match(variants.park, /<circle[\s\S]*<path/);
  assert.match(variants.station, /<path/);
  assert.match(variants.square, /<rect/);
  assert.equal(new Set(Object.values(variants)).size, 5);
});

test('frontend scratchpad renderer includes distinct landmark symbol branches', async () => {
  const source = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../public/js/rendezvous.js', import.meta.url), 'utf8')
  );
  for (const symbol of ['dot', 'star', 'park', 'square']) {
    assert.match(source, new RegExp(`symbol === '${symbol}'`));
  }
  assert.match(source, /scratchpadLandmarkSvg/);
});

test('scratchpad text rejects coordinate-like and hidden-distance labels', () => {
  const { scratchpad, accepted } = appendScratchpadOperations(createScratchpad(), [
    { type: 'text', text: '40.753596,-73.983233', at: { x: 0.2, y: 0.2 } },
    { type: 'text', text: 'Theo 83m away', at: { x: 0.3, y: 0.3 } },
    { type: 'text', text: 'GO NW TOWARD UNIV PL', at: { x: 0.3, y: 0.5 } },
    { type: 'landmark', label: 'MEET UNIV PL', center: { x: 0.5, y: 0.5 } },
    { type: 'text', text: 'UNIV PL', at: { x: 0.35, y: 0.35 } },
    { type: 'text', text: 'BRYANT PARK', at: { x: 0.4, y: 0.4 } }
  ], { agentId: 'ada', turn: 1 });

  assert.equal(accepted.length, 3);
  assert.deepEqual(
    currentScratchpadOperations(scratchpad)
      .filter(operation => operation.type === 'text')
      .map(operation => operation.text),
    ['UNIV PL', 'BRYANT PARK']
  );
  assert.equal(currentScratchpadOperations(scratchpad).some(operation => /GO|TOWARD|MEET/i.test(operation.text || operation.label || '')), false);
});

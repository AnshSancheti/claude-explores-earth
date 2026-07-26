import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendScratchpadOperations,
  commitRasterScratchpadMessage,
  createRasterScratchpad,
  createScratchpad,
  currentScratchpadOperations,
  normalizeScratchpad,
  publicRasterScratchpad,
  publicRasterScratchpadHistory,
  queueRasterScratchpadMessage,
  renderScratchpad,
  sketchOperationSvg,
  SCRATCHPAD_MAX_OPERATIONS
} from '../server/rendezvous/scratchpad.js';

test('raster sheet changes and transfers only after a durable image commit', () => {
  const queued = queueRasterScratchpadMessage(createRasterScratchpad({ owner: 'ada' }), {
    id: 'message-one',
    agentId: 'ada',
    turn: 4,
    drawingIntent: 'Tell Theo to converge near the arches.',
    informationDelta: 'The lamp is newly visible between the two arches.',
    continuityReason: 'The arches repeat Theo’s motif so the new lamp has context.',
    drawingPrompt: 'Draw two arches and a yellow circle.',
    groundedFeatures: ['two stone arches', 'a round lamp between them'],
    referenceViewIndices: [0],
    sourcePanoId: 'ada-branch',
    snapshot: {
      turn: 4,
      status: 'running',
      distanceMeters: 820,
      capturedAt: '2026-07-16T12:00:00.000Z',
      agents: {
        ada: {
          name: 'Ada',
          panoId: 'ada-branch',
          position: { lat: 40.74, lng: -73.99 },
          heading: 90,
          stepCount: 3,
          pathLength: 4,
          status: 'searching',
          lastThought: { reasoning: 'I will mark the arches.', turn: 4, stepCount: 3 }
        },
        theo: {
          name: 'Theo',
          panoId: 'theo-road',
          position: { lat: 40.75, lng: -73.98 },
          heading: 180,
          stepCount: 2,
          pathLength: 3,
          status: 'searching'
        }
      }
    }
  });
  assert.equal(queued.owner, 'ada');
  assert.equal(queued.currentMessage, null);
  assert.equal(queued.pendingMessage.status, 'generating');

  const committed = commitRasterScratchpadMessage(queued, {
    pendingId: 'message-one',
    imageFile: 'message-one.webp',
    imageSha256: 'hash',
    imageModel: 'gpt-image-2'
  });
  assert.equal(committed.owner, 'theo');
  assert.equal(committed.pendingMessage, null);
  assert.equal(committed.currentMessage.from, 'ada');
  assert.equal(committed.currentMessage.to, 'theo');
  assert.equal(committed.sequence, 1);
  assert.match(committed.messageAudit[0].drawingIntent, /converge/);
  assert.match(committed.messageAudit[0].informationDelta, /newly visible/);
  assert.match(committed.messageAudit[0].continuityReason, /repeat Theo/);
  assert.deepEqual(committed.messageAudit[0].groundedFeatures, ['two stone arches', 'a round lamp between them']);

  const publicSheet = publicRasterScratchpad(committed, {
    imageUrlFor: message => `/drawings/${message.id}`
  });
  assert.equal(publicSheet.currentMessage.imageUrl, '/drawings/message-one');
  assert.equal(Object.hasOwn(publicSheet, 'messageAudit'), false);
  assert.equal(Object.hasOwn(publicSheet, 'pendingMessage'), false);
  assert.equal(Object.hasOwn(publicSheet.currentMessage, 'imageFile'), false);
  assert.equal(Object.hasOwn(publicSheet.currentMessage, 'imageSha256'), false);
  assert.doesNotMatch(JSON.stringify(publicSheet), /arches|converge|drawingPrompt|drawingIntent|informationDelta|continuityReason|groundedFeatures|sourcePanoId/);

  const history = publicRasterScratchpadHistory(committed, {
    imageUrlFor: message => `/drawings/${message.id}`
  });
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].snapshot.agents.ada.panoId, 'ada-branch');
  assert.equal(history.items[0].snapshot.agents.ada.pathLength, 4);
  assert.equal(history.items[0].snapshot.agents.ada.lastThought.reasoning, 'I will mark the arches.');
  assert.doesNotMatch(JSON.stringify(history), /drawingPrompt|drawingIntent|informationDelta|continuityReason|groundedFeatures/);
});

test('primitive model output is composed into one authored street sketch', async () => {
  const { scratchpad, accepted } = appendScratchpadOperations(createScratchpad(), [
    { type: 'text', text: 'BROADWAY', at: { x: 0.1, y: 0.2 } },
    { type: 'arrow', from: { x: 0.2, y: 0.7 }, to: { x: 0.8, y: 0.2 } },
    { type: 'landmark', center: { x: 0.5, y: 0.4 }, symbol: 'station', label: 'W 14TH ST' }
  ], { agentId: 'theo', turn: 7 });

  assert.deepEqual(accepted.map(operation => operation.type), ['replaceSheet', 'sketch']);
  assert.equal(scratchpad.version, 4);
  assert.equal(scratchpad.messageFrom, 'theo');
  assert.equal(scratchpad.messageTo, 'ada');
  assert.equal(scratchpad.sequence, 2);
  assert.deepEqual(currentScratchpadOperations(scratchpad).map(operation => operation.type), ['sketch']);
  assert.equal(currentScratchpadOperations(scratchpad)[0].scene, 'station');
  assert.equal(currentScratchpadOperations(scratchpad)[0].label, 'W 14TH ST');

  const image = await renderScratchpad(scratchpad);
  assert.equal(image.subarray(1, 4).toString(), 'PNG');
});

test('each new sketch replaces the entire previous one-way message while preserving audit', () => {
  let scratchpad = appendScratchpadOperations(createScratchpad({ owner: 'ada' }), [{
    type: 'sketch', scene: 'storefront', label: 'PRINCE ST', details: ['awning', 'brick']
  }], { agentId: 'ada', turn: 1 }).scratchpad;
  scratchpad.owner = 'theo';
  scratchpad = appendScratchpadOperations(scratchpad, [{
    type: 'sketch', scene: 'park', label: 'WASHINGTON SQ', details: ['tree']
  }], { agentId: 'theo', turn: 2 }).scratchpad;

  const current = currentScratchpadOperations(scratchpad);
  assert.equal(current.length, 1);
  assert.equal(current[0].author, 'theo');
  assert.equal(current[0].label, 'WASHINGTON SQ');
  assert.equal(scratchpad.messageFrom, 'theo');
  assert.equal(scratchpad.messageTo, 'ada');
  assert.equal(scratchpad.operations.length, 4);
  assert.equal(
    scratchpad.operations.some(operation => operation.author === 'ada' && operation.supersededReason === 'replaced_by_message'),
    true
  );
});

test('v3 overlapping ink migrates to a single sketch from the most recent author', () => {
  const scratchpad = normalizeScratchpad({
    version: 3,
    owner: 'ada',
    sequence: 3,
    operations: [
      { id: 'ada-label', type: 'text', author: 'ada', text: 'BROADWAY', at: { x: 0.2, y: 0.2 }, sequence: 1, turn: 1 },
      { id: 'ada-line', type: 'line', author: 'ada', from: { x: 0.2, y: 0.4 }, to: { x: 0.8, y: 0.4 }, sequence: 2, turn: 1 },
      { id: 'theo-label', type: 'text', author: 'theo', text: 'PRINCE ST', at: { x: 0.3, y: 0.5 }, sequence: 3, turn: 2 }
    ]
  }, { turn: 9 });

  assert.equal(scratchpad.version, 4);
  assert.equal(scratchpad.sequence, 5);
  assert.equal(scratchpad.operations.length, 5);
  assert.deepEqual(currentScratchpadOperations(scratchpad).map(operation => operation.type), ['sketch']);
  assert.equal(currentScratchpadOperations(scratchpad)[0].author, 'theo');
  assert.equal(currentScratchpadOperations(scratchpad)[0].label, 'PRINCE ST');
});

test('legacy notebook state still normalizes to a blank versioned sheet', () => {
  const scratchpad = normalizeScratchpad({ version: 1, lastReliableClue: 'Meet at Bryant Park' });
  assert.equal(scratchpad.version, 4);
  assert.equal(scratchpad.owner, 'ada');
  assert.deepEqual(scratchpad.operations, []);
});

test('scratchpad audit retention keeps a bounded suffix and historical sequence', () => {
  const operations = [];
  for (let sequence = 1; sequence <= SCRATCHPAD_MAX_OPERATIONS + 20; sequence += 1) {
    const author = sequence % 2 ? 'ada' : 'theo';
    operations.push(sequence % 2
      ? { id: `replace-${sequence}`, type: 'replaceSheet', author, sequence, turn: sequence }
      : { id: `sketch-${sequence}`, type: 'sketch', author, scene: 'intersection', label: `${sequence}TH ST`, details: ['brick'], sequence, turn: sequence });
  }
  const scratchpad = normalizeScratchpad({
    version: 4,
    owner: 'ada',
    sequence: operations.length,
    operations
  });

  assert.equal(scratchpad.operations.length, SCRATCHPAD_MAX_OPERATIONS);
  assert.equal(scratchpad.sequence, SCRATCHPAD_MAX_OPERATIONS + 20);
  assert.equal(scratchpad.archivedOperationCount, 20);
  assert.equal(scratchpad.archivedThroughSequence, 20);
  assert.equal(scratchpad.earliestRetainedSequence, 21);
});

test('sketch labels reject coordinates, hidden distance, and route commands', () => {
  const cases = [
    ['40.753596,-73.983233', ''],
    ['Theo 83m away', ''],
    ['GO NW TOWARD UNIV PL', ''],
    ['W WASHINGTON PL', 'W WASHINGTON PL']
  ];
  for (const [label, expected] of cases) {
    const { scratchpad } = appendScratchpadOperations(createScratchpad(), [{
      type: 'sketch', scene: 'intersection', label, details: ['trafficLight']
    }], { agentId: 'ada', turn: 1 });
    assert.equal(currentScratchpadOperations(scratchpad)[0].label, expected);
  }
});

test('server sketch renderer emits a pictorial street scene', () => {
  const svg = sketchOperationSvg({
    type: 'sketch', author: 'ada', color: '#24211d', scene: 'station',
    label: 'W 14TH ST', secondaryLabel: '7TH AVE',
    details: ['awning', 'trafficLight', 'tree', 'stairs'], movement: 'south'
  });
  assert.match(svg, /<rect/);
  assert.match(svg, /<circle/);
  assert.match(svg, /W 14TH ST/);
  assert.match(svg, />M</);
  assert.match(svg, /rotate\(90\)/);
});

test('frontend scratchpad renderer includes the scene composer and pencil treatment', async () => {
  const source = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../public/js/rendezvous.js', import.meta.url), 'utf8')
  );
  assert.match(source, /scratchpadSketchSvg/);
  assert.match(source, /rv-pencil/);
  assert.match(source, /trafficLight/);
  assert.match(source, /rvScratchpadImage/);
  assert.match(source, /currentMessage/);
  assert.match(source, /agent\?\.lastThought\?\.reasoning/);
  assert.doesNotMatch(source, /agent\?\.lastDecision\?\.reasoning/);
  assert.doesNotMatch(source, /latest note/);
});

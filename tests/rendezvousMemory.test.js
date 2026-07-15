import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMemoryRevision,
  createAgentMemory,
  createMovementMemory,
  normalizeAgentMemory,
  normalizeMovementMemory,
  recordMovement,
  recordSentMessage
} from '../server/rendezvous/rendezvousMemory.js';

test('legacy agents gain a private memory grounded in their own recent notes', () => {
  const memory = normalizeAgentMemory(null, {
    recentNotes: ['I passed brick arches.', 'I kept north along a broad avenue.']
  });
  assert.equal(memory.version, 1);
  assert.match(memory.journeySummary, /brick arches/);
  assert.match(memory.journeySummary, /broad avenue/);
  assert.equal(memory.receivedSheets.length, 0);
  assert.equal(memory.sentMessages.length, 0);
});

test('memory revision retains beliefs and upserts one interpretation per received sheet', () => {
  let memory = createAgentMemory();
  memory = applyMemoryRevision(memory, {
    journeySummary: 'I walked north past three matching arches.',
    partnerBelief: 'Theo may be approaching a shared landmark.',
    visualVocabulary: 'A yellow circle probably means converge.',
    jointPlan: 'Repeat the circle while holding near the arches.'
  }, {
    turn: 12,
    sheetMessage: { sequence: 4, from: 'theo' },
    sheetInterpretation: 'A yellow circle between two paths may mean converge.',
    observation: 'Three stone arches stand beside a broad northbound street.',
    updatedAt: '2026-07-15T12:00:00.000Z'
  });
  memory = applyMemoryRevision(memory, {}, {
    turn: 14,
    sheetMessage: { sequence: 4, from: 'theo' },
    sheetInterpretation: 'On reflection, the circle may identify a place to wait.',
    updatedAt: '2026-07-15T12:01:00.000Z'
  });

  assert.equal(memory.receivedSheets.length, 1);
  assert.equal(memory.receivedSheets[0].sequence, 4);
  assert.match(memory.receivedSheets[0].interpretation, /place to wait/);
  assert.match(memory.visualVocabulary, /yellow circle/);
  assert.equal(memory.recentObservations.length, 1);
});

test('sent intentions are recorded only as bounded durable episodes', () => {
  let memory = createAgentMemory();
  for (let sequence = 1; sequence <= 20; sequence += 1) {
    memory = recordSentMessage(memory, {
      turn: sequence * 2,
      sequence,
      to: 'theo',
      intent: `Intent ${sequence}`,
      createdAt: `2026-07-15T12:${String(sequence).padStart(2, '0')}:00.000Z`
    });
  }
  assert.equal(memory.sentMessages.length, 8);
  assert.equal(memory.sentMessages[0].sequence, 13);
  assert.equal(memory.sentMessages.at(-1).intent, 'Intent 20');
});

test('movement memory preserves compact dead reckoning without coordinates', () => {
  let movement = createMovementMemory();
  for (let index = 0; index < 24; index += 1) {
    movement = recordMovement(movement, {
      distanceMeters: 11.4,
      heading: index * 20,
      label: index % 2 === 0 ? 'public avenue' : ''
    });
  }
  movement = normalizeMovementMemory(movement);
  assert.equal(movement.steps, 24);
  assert.equal(movement.distanceMeters, 264);
  assert.equal(movement.headings.length, 16);
  assert.deepEqual(movement.routeLabels, ['public avenue']);
  assert.equal(Object.hasOwn(movement, 'lat'), false);
  assert.equal(Object.hasOwn(movement, 'lng'), false);
});

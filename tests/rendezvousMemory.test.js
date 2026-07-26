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

test('legacy agents gain a provenance memory grounded in low-confidence recollection', () => {
  const memory = normalizeAgentMemory({
    version: 1,
    journeySummary: 'I once believed I was following stone arches.',
    jointPlan: 'Test the old arch belief against fresh evidence.'
  }, {
    recentNotes: ['I passed brick arches.', 'I kept north along a broad avenue.']
  });
  assert.equal(memory.version, 3);
  assert.match(memory.ownObservations.at(-1).description, /Legacy recollection/);
  assert.match(memory.ownObservations.at(-1).description, /brick arches/);
  assert.match(memory.currentPlan, /local evidence/);
  assert.doesNotMatch(memory.currentPlan, /arch belief/);
  assert.equal(memory.receivedSheets.length, 0);
  assert.equal(memory.sentMessages.length, 0);
});

test('memory revision records sourced evidence and caps unsupported confidence', () => {
  let memory = createAgentMemory();
  memory = applyMemoryRevision(memory, {
    currentPlan: 'Test the circle hypothesis against the next drawing.',
    conventionUpdate: {
      key: 'yellow-circle',
      description: 'A yellow circle may indicate convergence.',
      confidence: 0.95,
      basisSequences: [4, 999]
    },
    partnerHypothesis: {
      key: 'possible-union-square',
      description: 'The sender may be near Union Square and may intend to wait.',
      confidence: 0.8,
      basisSequences: [4]
    }
  }, {
    turn: 12,
    sheetMessage: { sequence: 4, from: 'theo' },
    sheetInterpretation: 'A yellow circle between two paths may mean converge.',
    sheetConfidence: 0.6,
    sheetPerception: {
      literalContents: ['a yellow circle between two paths'],
      possiblePlaces: ['possibly Union Square'],
      possibleIntentions: ['possibly asking me to converge'],
      frameOfReference: 'sender',
      requestedResponse: 'Show whether I see the same circle.',
      informationNovelty: 'mixed'
    },
    reconciliation: {
      newEvidence: ['the circle now sits between paths'],
      unresolvedQuestions: ['whether it means a place or a plan'],
      informationWorthSending: ['my own nearest distinctive landmark'],
      planAssessment: 'supporting'
    },
    observation: 'Three stone arches stand beside a broad northbound street.',
    sourcePanoId: 'pano-12',
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
  assert.match(memory.currentPlan, /Test the circle/);
  assert.equal(memory.visualConventions[0].confidence, 0.7);
  assert.deepEqual(memory.visualConventions[0].basisSequences, [4]);
  assert.equal(memory.partnerHypotheses[0].confidence, 0.75);
  assert.deepEqual(memory.receivedSheets[0].possiblePlaces, ['possibly Union Square']);
  assert.equal(memory.receivedSheets[0].frameOfReference, 'sender');
  assert.match(memory.receivedSheets[0].requestedResponse, /same circle/);
  assert.equal(memory.receivedSheets[0].informationNovelty, 'mixed');
  assert.equal(memory.reconciliations[0].planAssessment, 'supporting');
  assert.equal(memory.ownObservations.length, 1);
  assert.equal(memory.ownObservations[0].sourcePanoId, 'pano-12');
});

test('repetition preserves provenance without converting ambiguous sheets into certainty', () => {
  let memory = createAgentMemory();
  for (let sequence = 1; sequence <= 4; sequence += 1) {
    memory = applyMemoryRevision(memory, {
      conventionUpdate: {
        key: 'vertical-bars-circle',
        description: 'Dark vertical bars recur beneath a pale circle.',
        confidence: 0.99,
        basisSequences: Array.from({ length: sequence }, (_, index) => index + 1)
      },
      partnerHypothesis: {
        key: 'patterned-facade',
        description: 'The sender may repeatedly encounter a strongly patterned facade.',
        confidence: 0.99,
        basisSequences: Array.from({ length: sequence }, (_, index) => index + 1)
      }
    }, {
      turn: sequence,
      sheetMessage: { sequence, from: 'theo' },
      sheetInterpretation: 'Dark vertical bars sit beneath a pale circle.',
      sheetConfidence: 0.99
    });
  }

  assert.equal(memory.receivedSheets.at(-1).confidence, 0.8);
  assert.equal(memory.visualConventions[0].confidence, 0.7);
  assert.equal(memory.partnerHypotheses[0].confidence, 0.75);
  assert.deepEqual(memory.visualConventions[0].basisSequences, [1, 2, 3, 4]);
});

test('sent intentions are recorded only as bounded durable episodes', () => {
  let memory = createAgentMemory();
  for (let sequence = 1; sequence <= 20; sequence += 1) {
    memory = recordSentMessage(memory, {
      turn: sequence * 2,
      sequence,
      to: 'theo',
      intent: `Intent ${sequence}`,
      contributionKind: 'local_observation',
      contributionEvidenceId: 'local:0',
      contributionSummary: `I can show facade ${sequence}.`,
      informationDelta: `New evidence ${sequence}`,
      continuityReason: 'Keep the shared arch motif.',
      groundedFeatures: [`Facade ${sequence}`, 'traffic light'],
      createdAt: `2026-07-15T12:${String(sequence).padStart(2, '0')}:00.000Z`
    });
  }
  assert.equal(memory.sentMessages.length, 10);
  assert.equal(memory.sentMessages[0].sequence, 11);
  assert.equal(memory.sentMessages.at(-1).intent, 'Intent 20');
  assert.equal(memory.sentMessages.at(-1).contributionKind, 'local_observation');
  assert.equal(memory.sentMessages.at(-1).contributionEvidenceId, 'local:0');
  assert.equal(memory.sentMessages.at(-1).contributionSummary, 'I can show facade 20.');
  assert.equal(memory.sentMessages.at(-1).informationDelta, 'New evidence 20');
  assert.match(memory.sentMessages.at(-1).continuityReason, /shared arch/);
  assert.deepEqual(memory.sentMessages.at(-1).groundedFeatures, ['Facade 20', 'traffic light']);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  containsUnsupportedSheetGeography,
  RendezvousModelService,
  sanitizeRendezvousDecision
} from '../server/rendezvous/rendezvousModel.js';

function input(overrides = {}) {
  return {
    agent: {
      id: 'ada',
      name: 'Ada',
      visitedPanos: ['old'],
      recentNotes: ['I passed a stone facade.']
    },
    partnerName: 'Theo',
    options: [
      { panoId: 'west', heading: 270, label: 'west route' },
      { panoId: 'north', heading: 0, label: 'north route' }
    ],
    screenshots: [Buffer.from('west'), Buffer.from('north')],
    scratchpadBuffer: Buffer.from('sheet'),
    sheetMessage: { sequence: 7, from: 'theo', to: 'ada' },
    visualHistory: [{
      sequence: 5,
      direction: 'sent',
      mimeType: 'image/webp',
      buffer: Buffer.from('older-sheet')
    }],
    privateMemory: {
      version: 2,
      currentPlan: 'Test the circle convention at the next branch.',
      ownObservations: [{ description: 'I followed a row of stone arches.' }],
      visualConventions: [{ key: 'yellow-circle', description: 'A yellow circle may mean wait or converge.', confidence: 0.35, basisSequences: [5] }]
    },
    movementSinceDecision: { steps: 4, distanceMeters: 90, headings: [0, 10], routeLabels: [] },
    ...overrides
  };
}

test('branch decision revises private memory and authors a grounded visual message without transcript channels', async () => {
  let request;
  const client = {
    chat: {
      completions: {
        async create(value) {
          request = value;
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  action: 'move',
                  selectedIndex: 1,
                  intendedHeading: 0,
                  reasoning: 'The northern opening feels useful.',
                  observation: 'Repeated stone arches line the northern opening.',
                  observedFeatures: ['three repeated stone arches', 'a suspended traffic light beside them'],
                  sheetInterpretation: 'Theo may be asking me to converge on a bright circular landmark.',
                  sheetConfidence: 0.4,
                  memoryUpdate: {
                    currentPlan: 'Move through the arch-lined opening while testing the circle hypothesis.',
                    conventionUpdate: {
                      key: 'yellow-circle',
                      description: 'A yellow circle may suggest convergence.',
                      confidence: 0.5,
                      basisSequences: [5, 7]
                    },
                    partnerHypothesis: {
                      key: 'seeking-landmark',
                      description: 'Theo may be looking for a visually memorable public place.',
                      confidence: 0.35,
                      basisSequences: [7]
                    }
                  },
                  drawingIntent: 'Show Theo the repeated arches beside the suspended traffic light.',
                  drawingPrompt: 'Sketch the repeated arches as a fading rhythm with a lone yellow circle.'
                })
              }
            }]
          };
        }
      }
    }
  };
  const service = new RendezvousModelService({ client, logger: { warn() {} } });
  const decision = await service.decide(input());

  assert.equal(decision.selectedIndex, 1);
  assert.equal(decision.action, 'move');
  assert.match(decision.drawingPrompt, /repeated arches/);
  assert.match(decision.sheetInterpretation, /converge/);
  assert.match(decision.memoryUpdate.conventionUpdate.description, /yellow circle/);
  assert.equal(decision.observedFeatures.length, 2);
  const serialized = JSON.stringify(request.messages);
  assert.match(serialized, /only information that crosses/);
  assert.match(serialized, /no readable text/);
  assert.match(serialized, /Symbols may support the observation, but they must not dominate it/);
  assert.match(serialized, /not a passive target/);
  assert.match(serialized, /evidence about the world around its sender/);
  assert.match(serialized, /row of stone arches/);
  assert.match(request.messages[1].content[0].text, /History image 1: sheet sequence 5/);
  assert.equal(request.messages[1].content.length, 5);
  assert.match(request.messages[1].content[0].text, /"distanceMeters": 90/);
  assert.doesNotMatch(serialized, /referenceViewIndices/);
  assert.doesNotMatch(serialized, /partnerPadText|ownPadText|distanceToFriend|-?\d+\.\d{4,}/);
});

test('decision sanitizer reconciles an unambiguous intended heading', () => {
  const decision = sanitizeRendezvousDecision({
    selectedIndex: 0,
    intendedHeading: 2,
    drawingPrompt: 'draw a doorway'
  }, input().options);
  assert.equal(decision.selectedIndex, 1);
});

test('visual-channel geography guard rejects names and compass projection but permits literal features', () => {
  assert.equal(containsUnsupportedSheetGeography('the E 13th St corridor'), true);
  assert.equal(containsUnsupportedSheetGeography('Prince St beside Manhattan'), true);
  assert.equal(containsUnsupportedSheetGeography('continue southeast'), true);
  assert.equal(containsUnsupportedSheetGeography('three iron arches beside a suspended globe lamp'), false);
});

test('decision sanitizer bounds deliberate waiting and private memory fields', () => {
  const decision = sanitizeRendezvousDecision({
    action: 'wait',
    waitTurns: 99,
    selectedIndex: 0,
    sheetInterpretation: 'The blue line may mean Theo is approaching.',
    observedFeatures: ['one stone arch', 'a traffic light beside the arch'],
    drawingIntent: 'I will stay beside the arch.',
    memoryUpdate: {
      currentPlan: 'Wait here.',
      conventionUpdate: {
        key: 'blue-line',
        description: 'A blue line may mean approach.',
        confidence: 0.4,
        basisSequences: [7]
      }
    },
    drawingPrompt: 'A still figure beneath one arch and an approaching blue line.'
  }, input().options);
  assert.equal(decision.action, 'wait');
  assert.equal(decision.waitTurns, 6);
  assert.equal(decision.memoryUpdate.currentPlan, 'Wait here.');
  assert.match(decision.drawingIntent, /stay/);
});

test('expired local patience removes waiting from the model decision', async () => {
  let request;
  let calls = 0;
  const client = {
    chat: {
      completions: {
        async create(value) {
          request = value;
          calls += 1;
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  action: 'move',
                  selectedIndex: 1,
                  reasoning: 'Holding this corner has taught me nothing new, so I will move.',
                  observation: 'The northern public route remains open.',
                  observedFeatures: ['a broad road opening', 'a stone facade on its corner'],
                  sheetInterpretation: 'The sheet may preserve our last shared convergence idea.',
                  memoryUpdate: {
                    currentPlan: 'Break a mutual pause by moving and showing the chosen route.'
                  },
                  drawingIntent: 'Show that I am leaving the anchor through the opening beside the stone facade.',
                  drawingPrompt: 'A hand sketch of a still circle opening into one path beside a stone facade.'
                })
              }
            }]
          };
        }
      }
    }
  };
  const service = new RendezvousModelService({ client, logger: { warn() {} } });
  const decision = await service.decide(input({
    allowWait: false,
    consecutiveWaitDecisions: 2
  }));

  assert.equal(calls, 1);
  assert.equal(decision.action, 'move');
  const systemPrompt = request.messages[0].content;
  assert.match(systemPrompt, /same branch 2 consecutive times/);
  assert.match(systemPrompt, /Remaining here again is not available/);
  assert.match(systemPrompt, /"action": "move" \| "retrace"/);
  assert.doesNotMatch(systemPrompt, /"action": "move" \| "retrace" \| "wait"/);
});

test('decision sanitizer rejects waiting when local patience has expired', () => {
  const decision = sanitizeRendezvousDecision({
    action: 'wait',
    waitTurns: 4
  }, input().options, { allowWait: false });
  assert.equal(decision.action, 'move');
  assert.equal(decision.waitTurns, 0);
});

test('model is rejected outside a genuine branch', async () => {
  const service = new RendezvousModelService({ client: {}, logger: { warn() {} } });
  await assert.rejects(
    service.decide(input({ options: [{ panoId: 'only', heading: 90 }], screenshots: [Buffer.from('only')] })),
    /genuine route branch/
  );
});

test('model outage falls back to movement without fabricating a drawing', async () => {
  const client = {
    chat: { completions: { async create() { throw Object.assign(new Error('offline'), { status: 503 }); } } }
  };
  const service = new RendezvousModelService({ client, logger: { warn() {} } });
  service.maxAttempts = 1;
  const decision = await service.decide(input());
  assert.equal(decision.drawingPrompt, '');
  assert.equal(decision.fallbackCause, 'api_error_503');
});

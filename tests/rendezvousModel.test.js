import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contaminatesRouteReasoning,
  containsUnsupportedSheetGeography,
  containsUnsupportedSheetInstruction,
  projectsActionFromSheet,
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
      visualConventions: [{ key: 'yellow-circle', description: 'A yellow circle recurs beside stone arches.', confidence: 0.35, basisSequences: [5] }]
    },
    movementSinceDecision: { steps: 4, distanceMeters: 90, headings: [0, 10], routeLabels: [] },
    ...overrides
  };
}

test('branch decision revises private memory and authors a grounded visual message without transcript channels', async () => {
  let request;
  const requests = [];
  const client = {
    chat: {
      completions: {
        async create(value) {
          request = value;
          requests.push(value);
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
                  sheetInterpretation: 'A bright circle appears between two repeated arch forms; Theo may be near similar masonry.',
                  sheetConfidence: 0.4,
                  memoryUpdate: {
                    currentPlan: 'Move through the arch-lined opening while testing the circle hypothesis.',
                    conventionUpdate: {
                      key: 'yellow-circle',
                      description: 'A yellow circle recurs between repeated arch forms.',
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
  assert.match(decision.sheetInterpretation, /bright circle/);
  assert.match(decision.memoryUpdate.conventionUpdate.description, /yellow circle/);
  assert.equal(decision.observedFeatures.length, 2);
  const serialized = JSON.stringify(requests);
  assert.equal(requests.length, 2);
  assert.match(serialized, /route-independent visual reading/);
  assert.match(serialized, /no readable text/);
  assert.match(serialized, /Symbols may support the observation, but they must not dominate it/);
  assert.match(serialized, /not a passive target/);
  assert.match(serialized, /evidence about the sender's surroundings and memory/);
  assert.match(serialized, /wordless observational postcard/);
  assert.match(serialized, /absence of a mark is not evidence/);
  assert.match(serialized, /row of stone arches/);
  assert.match(requests[0].messages[1].content[0].text, /History image 1: sheet sequence 5/);
  assert.equal(requests[0].messages[1].content.length, 3);
  assert.equal(request.messages[1].content.length, 3);
  assert.doesNotMatch(JSON.stringify(request.messages[1].content), /c2hlZXQ=|b2xkZXItc2hlZXQ=/);
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

test('visual-channel instruction guard separates observation from motion commands', () => {
  assert.equal(containsUnsupportedSheetInstruction('continue along the same forward axis'), true);
  assert.equal(containsUnsupportedSheetInstruction('show a meetup corridor with motion toward its vanishing point'), true);
  assert.equal(containsUnsupportedSheetInstruction('three iron arches beside a suspended globe lamp'), false);
  assert.equal(containsUnsupportedSheetInstruction('a cyclist moving beside three parked taxis'), false);
  assert.equal(projectsActionFromSheet('Theo\'s sheet reinforces that I should keep moving forward.'), true);
  assert.equal(projectsActionFromSheet('I choose the open street because its facade is visually distinctive.'), false);
  assert.equal(contaminatesRouteReasoning('The sheet suggests a continuation along a similar corridor.'), true);
  assert.equal(contaminatesRouteReasoning('I will wait here to stay synchronized.'), true);
  assert.equal(contaminatesRouteReasoning('I will wait while comparing local cues with the received visual memory.'), true);
  assert.equal(contaminatesRouteReasoning('I will retrace to consolidate our joint plan.'), true);
  assert.equal(contaminatesRouteReasoning('The unfamiliar opening has the most distinctive facade.'), false);
});

test('model retries when an ambiguous sheet is projected into a route instruction', async () => {
  let calls = 0;
  const baseDecision = {
    action: 'move',
    selectedIndex: 1,
    intendedHeading: 0,
    observation: 'Three iron arches sit beside one suspended globe lamp.',
    observedFeatures: ['three iron arches', 'one suspended globe lamp beside them'],
    sheetConfidence: 0.35,
    memoryUpdate: {
      currentPlan: 'Search for uncommon arrangements while avoiding immediate loops.',
      conventionUpdate: {},
      partnerHypothesis: {}
    },
    drawingIntent: 'Preserve the uncommon arch-and-lamp arrangement.',
    drawingPrompt: 'Sketch three iron arches with one suspended globe lamp beside them.'
  };
  const client = {
    chat: {
      completions: {
        async create() {
          calls += 1;
          const content = calls === 1
            ? {
                ...baseDecision,
                reasoning: 'Theo\'s sheet signals me to continue forward.',
                sheetInterpretation: 'Theo wants me to continue along the same forward axis.'
              }
            : {
                ...baseDecision,
                reasoning: 'The unfamiliar opening has the most distinctive facade.',
                sheetInterpretation: 'A row of dark vertical marks sits beneath a pale circular form; Theo may be near a strongly patterned facade.'
              };
          return { choices: [{ message: { content: JSON.stringify(content) } }] };
        }
      }
    }
  };
  const service = new RendezvousModelService({ client, logger: { warn() {} } });
  const decision = await service.decide(input());

  assert.equal(calls, 3);
  assert.match(decision.sheetInterpretation, /vertical marks/);
  assert.doesNotMatch(decision.reasoning, /sheet signals/);
});

test('model retries when route reasoning merely associates motion with sheet context', async () => {
  let calls = 0;
  let actionCalls = 0;
  const client = {
    chat: {
      completions: {
        async create(request) {
          calls += 1;
          const isPerception = /route-independent visual reading/.test(request.messages[0].content);
          if (!isPerception) actionCalls += 1;
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  action: 'move',
                  selectedIndex: 1,
                  reasoning: !isPerception && actionCalls === 1
                    ? 'Choosing a promising public route while interpreting the sheet context for alignment.'
                    : 'The unfamiliar opening has a distinctive row of repeated arches.',
                  observation: 'Three iron arches sit beside one suspended globe lamp.',
                  observedFeatures: ['three iron arches', 'one suspended globe lamp beside them'],
                  sheetInterpretation: 'Dark vertical marks sit beneath a pale circle; the sender may be near a strongly patterned facade.',
                  sheetConfidence: 0.35,
                  memoryUpdate: {
                    currentPlan: 'Compare uncommon visual arrangements and avoid immediate loops.'
                  },
                  drawingIntent: 'Preserve the uncommon arch-and-lamp arrangement.',
                  drawingPrompt: 'Sketch three iron arches with one suspended globe lamp beside them.'
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

  assert.equal(calls, 3);
  assert.equal(actionCalls, 2);
  assert.match(decision.reasoning, /repeated arches/);
});

test('a blank first sheet cannot become invented partner evidence', async () => {
  const client = {
    chat: {
      completions: {
        async create() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  action: 'move',
                  selectedIndex: 1,
                  reasoning: 'I choose the opening with the most distinctive facade.',
                  observation: 'Three iron arches sit beside one suspended globe lamp.',
                  observedFeatures: ['three iron arches', 'one suspended globe lamp beside them'],
                  sheetInterpretation: 'The blank sheet tells me Theo is on Prince St heading southeast.',
                  sheetConfidence: 0.9,
                  memoryUpdate: {
                    currentPlan: 'Keep comparing uncommon facade arrangements.',
                    partnerHypothesis: {
                      key: 'invented-location',
                      description: 'Theo is on Prince St.',
                      confidence: 0.9,
                      basisSequences: []
                    }
                  },
                  drawingIntent: 'Show the uncommon arch-and-lamp arrangement.',
                  drawingPrompt: 'Sketch three iron arches with one suspended globe lamp beside them.'
                })
              }
            }]
          };
        }
      }
    }
  };
  const service = new RendezvousModelService({ client, logger: { warn() {} } });
  const decision = await service.decide(input({ sheetMessage: null, visualHistory: [] }));

  assert.equal(decision.sheetInterpretation, '');
  assert.equal(decision.sheetConfidence, 0);
  assert.equal(decision.memoryUpdate.partnerHypothesis.description, '');
});

test('decision sanitizer bounds deliberate waiting and private memory fields', () => {
  const decision = sanitizeRendezvousDecision({
    action: 'wait',
    waitTurns: 99,
    selectedIndex: 0,
    sheetInterpretation: 'A blue line sits beside a stone arch.',
    observedFeatures: ['one stone arch', 'a traffic light beside the arch'],
    drawingIntent: 'I will stay beside the arch.',
    memoryUpdate: {
      currentPlan: 'Wait here.',
      conventionUpdate: {
        key: 'blue-line',
        description: 'A blue line recurs beside a stone arch.',
        confidence: 0.4,
        basisSequences: [7]
      }
    },
    drawingPrompt: 'A still figure beneath one arch with a blue line beside it.'
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
                  sheetInterpretation: 'Two dark forms flank a pale circle; the sender may be near a symmetrical facade.',
                  memoryUpdate: {
                    currentPlan: 'Break a mutual pause by moving and showing the chosen route.'
                  },
                  drawingIntent: 'Preserve the broad opening beside the stone facade.',
                  drawingPrompt: 'A hand sketch of a broad street opening beside a stone facade.'
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

  assert.equal(calls, 2);
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

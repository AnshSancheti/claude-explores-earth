import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
    privateMemory: {
      journeySummary: 'I followed a row of stone arches.',
      partnerBelief: 'Theo may be using circles for meeting points.',
      visualVocabulary: 'A yellow circle may mean wait or converge.',
      jointPlan: 'Test the circle convention at the next branch.'
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
                  sheetInterpretation: 'Theo may be asking me to converge on a bright circular landmark.',
                  memoryUpdate: {
                    journeySummary: 'I followed stone arches and then moved roughly north.',
                    partnerBelief: 'Theo is also trying to converge on a memorable public place.',
                    visualVocabulary: 'A yellow circle probably means converge; arches identify my route.',
                    jointPlan: 'Move north while repeating the circle and arch convention.'
                  },
                  drawingIntent: 'Show Theo that I am following arches north toward convergence.',
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
  assert.match(decision.memoryUpdate.visualVocabulary, /yellow circle/);
  const serialized = JSON.stringify(request.messages);
  assert.match(serialized, /only information that crosses/);
  assert.match(serialized, /no readable text/);
  assert.match(serialized, /not merely look evocative/);
  assert.match(serialized, /not a passive target/);
  assert.match(serialized, /row of stone arches/);
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

test('decision sanitizer bounds deliberate waiting and private memory fields', () => {
  const decision = sanitizeRendezvousDecision({
    action: 'wait',
    waitTurns: 99,
    selectedIndex: 0,
    sheetInterpretation: 'The blue line may mean Theo is approaching.',
    drawingIntent: 'I will stay beside the arch.',
    memoryUpdate: {
      journeySummary: 'I reached an arch after a long northbound walk.',
      partnerBelief: 'Theo is moving too.',
      visualVocabulary: 'Blue line means approach.',
      jointPlan: 'Wait here.'
    },
    drawingPrompt: 'A still figure beneath one arch and an approaching blue line.'
  }, input().options);
  assert.equal(decision.action, 'wait');
  assert.equal(decision.waitTurns, 6);
  assert.equal(decision.memoryUpdate.jointPlan, 'Wait here.');
  assert.match(decision.drawingIntent, /stay/);
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

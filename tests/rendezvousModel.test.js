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
    ...overrides
  };
}

test('branch decision authors an unconstrained visual prompt without transcript channels', async () => {
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
                  selectedIndex: 1,
                  intendedHeading: 0,
                  reasoning: 'The northern opening feels useful.',
                  drawingPrompt: 'Sketch the repeated arches as a fading rhythm with a lone yellow circle.',
                  referenceViewIndices: [1]
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
  assert.match(decision.drawingPrompt, /repeated arches/);
  assert.deepEqual(decision.referenceViewIndices, [1]);
  const serialized = JSON.stringify(request.messages);
  assert.match(serialized, /only information that crosses/);
  assert.match(serialized, /no readable text/);
  assert.doesNotMatch(serialized, /partnerPadText|ownPadText|distanceToFriend|-?\d+\.\d{4,}/);
});

test('decision sanitizer reconciles an unambiguous intended heading', () => {
  const decision = sanitizeRendezvousDecision({
    selectedIndex: 0,
    intendedHeading: 2,
    drawingPrompt: 'draw a doorway',
    referenceViewIndices: [1, 1, 8]
  }, input().options);
  assert.equal(decision.selectedIndex, 1);
  assert.deepEqual(decision.referenceViewIndices, [1]);
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

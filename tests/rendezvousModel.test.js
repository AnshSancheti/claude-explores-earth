import test from 'node:test';
import assert from 'node:assert/strict';
import { RendezvousModelService } from '../server/rendezvous/rendezvousModel.js';

test('rendezvous model prompt is scoped to personal memory, visible options, and the sheet', async () => {
  const requests = [];
  const client = {
    chat: {
      completions: {
        async create(request) {
          requests.push(request);
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  selectedIndex: 1,
                  reasoning: 'I can read a broad avenue and the blue circle suggests checking it.',
                  padOperations: [{
                    type: 'text',
                    text: 'broad avenue',
                    at: { x: 0.2, y: 0.4 },
                    size: 28
                  }],
                  passPad: true
                })
              }
            }]
          };
        }
      }
    }
  };
  const service = new RendezvousModelService({ client, logger: { warn() {} } });
  const result = await service.decide({
    agent: {
      id: 'ada',
      name: 'Ada',
      style: 'landmark-first',
      visitedPanos: ['pano-a'],
      recentNotes: ['I saw a broad public crossing.']
    },
    partnerName: 'Theo',
    options: [
      { panoId: 'pano-a', heading: 90, label: 'east' },
      { panoId: 'pano-b', heading: 180, label: 'south' }
    ],
    screenshots: [Buffer.from('one'), Buffer.from('two')],
    scratchpadBuffer: Buffer.from('pad'),
    canEditPad: true,
    padStatus: 'in your hands',
    forcePass: false
  });

  assert.equal(result.selectedIndex, 1);
  assert.equal(result.passPad, true);
  assert.equal(result.padOperations.length, 1);
  const serializedRequest = JSON.stringify(requests[0]);
  assert.match(serializedRequest, /only information that ever crosses/);
  assert.match(serializedRequest, /heading 180 degrees/);
  assert.match(serializedRequest, /heading 180 degrees \(south\)/);
  assert.match(serializedRequest, /0° is north, 90° east, 180° south, and 270° west/);
  assert.match(serializedRequest, /concrete place your friend marked outranks generic exploration/);
  assert.match(serializedRequest, /Your ink is charcoal black\. Theo's ink is blue/);
  assert.match(serializedRequest, /Treat only Theo's ink as a clue/);
  assert.doesNotMatch(serializedRequest, /pano-a|pano-b/);
  assert.doesNotMatch(serializedRequest, /distanceToFriend|partnerPath|roughPosition|latitude|longitude/);
});

test('rendezvous model cannot edit or pass a sheet it does not hold', async () => {
  const client = {
    chat: {
      completions: {
        async create() {
          return {
            choices: [{ message: { content: JSON.stringify({
              selectedIndex: 0,
              reasoning: 'Continue along the visible street.',
              padOperations: [{ type: 'text', text: 'cheat', at: { x: 0.5, y: 0.5 } }],
              passPad: true
            }) } }]
          };
        }
      }
    }
  };
  const service = new RendezvousModelService({ client, logger: { warn() {} } });
  const result = await service.decide({
    agent: { id: 'theo', name: 'Theo', visitedPanos: [], recentNotes: [] },
    partnerName: 'Ada',
    options: [{ panoId: 'pano-a', heading: 0, label: '' }],
    screenshots: [Buffer.from('one')],
    scratchpadBuffer: Buffer.from('pad'),
    canEditPad: false,
    padStatus: 'held by Ada'
  });

  assert.deepEqual(result.padOperations, []);
  assert.equal(result.passPad, false);
});

test('model failure still honors a forced handoff', async () => {
  const client = {
    chat: { completions: { async create() { throw new Error('offline'); } } }
  };
  const service = new RendezvousModelService({ client, logger: { warn() {} } });
  const result = await service.decide({
    agent: { id: 'ada', name: 'Ada', visitedPanos: [], recentNotes: [] },
    partnerName: 'Theo',
    options: [{ panoId: 'pano-a', heading: 0, label: '' }],
    screenshots: [Buffer.from('one')],
    scratchpadBuffer: Buffer.from('pad'),
    canEditPad: true,
    forcePass: true,
    padStatus: 'in your hands'
  });

  assert.equal(result.passPad, true);
  assert.deepEqual(result.padOperations, []);
  assert.equal(result.fallbackCause, 'model_error');
  assert.doesNotMatch(result.reasoning, /model|unavailable/i);
});

test('blank-content retry raises the output budget and uses low reasoning effort', async () => {
  const requests = [];
  const client = {
    chat: { completions: { async create(request) {
      requests.push(request);
      if (requests.length === 1) {
        return {
          usage: { completion_tokens: request.max_completion_tokens },
          choices: [{ finish_reason: 'length', message: { content: '' } }]
        };
      }
      return {
        choices: [{ message: { content: JSON.stringify({
          selectedIndex: 0,
          reasoning: 'I follow the named avenue toward the mark on the sheet.',
          padOperations: [],
          passPad: false
        }) } }]
      };
    } } }
  };
  const service = new RendezvousModelService({ client, logger: { warn() {} } });
  const result = await service.decide({
    agent: { id: 'ada', name: 'Ada', visitedPanos: [], recentNotes: [] },
    partnerName: 'Theo',
    options: [{ panoId: 'pano-a', heading: 0, label: 'Broadway' }],
    screenshots: [Buffer.from('one')],
    scratchpadBuffer: Buffer.from('pad'),
    canEditPad: false,
    padStatus: 'held by Theo'
  });

  assert.equal(result.fallbackCause, null);
  assert.equal(requests[0].reasoning_effort, 'low');
  assert.ok(requests[1].max_completion_tokens > requests[0].max_completion_tokens);
});

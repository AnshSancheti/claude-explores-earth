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
});

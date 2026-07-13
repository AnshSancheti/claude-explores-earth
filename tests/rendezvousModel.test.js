import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RendezvousModelService,
  selectConvergencePolicyOption
} from '../server/rendezvous/rendezvousModel.js';

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
      recentNotes: ['I saw a broad public crossing.'],
      recentMovement: 'You most recently moved south into this panorama.'
    },
    partnerName: 'Theo',
    options: [
      { panoId: 'pano-a', heading: 90, label: 'east' },
      { panoId: 'pano-b', heading: 180, label: 'south' }
    ],
    screenshots: [Buffer.from('one'), Buffer.from('two')],
    scratchpadBuffer: Buffer.from('pad'),
    canEditPad: true,
    partnerPadText: ['PRINCE ST', 'toward W BROADWAY'],
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
  assert.match(serializedRequest, /sharing one real piece of paper/);
  assert.match(serializedRequest, /replaceMine/);
  assert.match(serializedRequest, /removes only your visible marks/);
  assert.match(serializedRequest, /landmark/);
  assert.match(serializedRequest, /Text is annotation, not the main message/);
  assert.match(serializedRequest, /currently observed intersection, street, or landmark/);
  assert.match(serializedRequest, /recent movement into this view/);
  assert.match(serializedRequest, /You most recently moved south into this panorama/);
  assert.match(serializedRequest, /Do not use the sheet to tell Theo where to go/);
  assert.match(serializedRequest, /friend's ink is evidence of their own observed place or movement, never a route command/);
  assert.match(serializedRequest, /stop generic exploration and take an available connecting avenue or cross-street/);
  assert.match(serializedRequest, /Numbered Manhattan streets increase as you go north/);
  assert.match(serializedRequest, /from W 14th toward a friend's W Houston mark, choose a southbound connection/);
  assert.match(serializedRequest, /from W Houston or Carmine toward a friend's W 14th mark, choose a northbound connection/);
  assert.doesNotMatch(serializedRequest, /clearly mark where you are headed so they can intercept you/);
  assert.match(serializedRequest, /Your ink is charcoal black\. Theo's ink is blue/);
  assert.match(serializedRequest, /Treat only Theo's ink as a clue/);
  assert.match(serializedRequest, /exact text visibly written in Theo's ink/);
  assert.match(serializedRequest, /PRINCE ST|toward W BROADWAY/);
  assert.doesNotMatch(serializedRequest, /pano-a|pano-b/);
  assert.doesNotMatch(serializedRequest, /distanceToFriend|partnerPath|roughPosition|latitude|longitude/);
});

test('convergence policy sends Ada south from W 14th toward partner W Houston ink without hidden state', () => {
  const policy = selectConvergencePolicyOption({
    agent: {
      id: 'ada',
      name: 'Ada',
      recentNotes: ['I am reading W 14th St storefronts from this block.'],
      recentMovement: 'You most recently moved west into this W 14th St panorama.'
    },
    partnerPadText: ['W HOUSTON ST'],
    options: [
      { panoId: 'north-option', heading: 350, label: '9th Ave north' },
      { panoId: 'south-option', heading: 178, label: '9th Ave south' },
      { panoId: 'west-option', heading: 270, label: 'W 14th St west' }
    ]
  });

  assert.equal(policy.selectedIndex, 1);
  assert.equal(policy.desiredDirection, 'south');
});

test('convergence policy sends Theo north from W Houston toward partner W 14th ink without hidden state', () => {
  const policy = selectConvergencePolicyOption({
    agent: {
      id: 'theo',
      name: 'Theo',
      recentNotes: ['I can see W Houston St and Carmine St signs from here.'],
      recentMovement: 'You most recently moved east into this W Houston St panorama.'
    },
    partnerPadText: ['W 14TH ST'],
    options: [
      { panoId: 'east-option', heading: 80, label: 'W Houston St east' },
      { panoId: 'south-option', heading: 185, label: 'Carmine St south' },
      { panoId: 'north-option', heading: 5, label: '7th Ave S north' }
    ]
  });

  assert.equal(policy.selectedIndex, 2);
  assert.equal(policy.desiredDirection, 'north');
});

test('convergence policy sends Ada south from own W 14th selected route label toward partner W 3rd ink', () => {
  const policy = selectConvergencePolicyOption({
    agent: {
      id: 'ada',
      name: 'Ada',
      currentRouteLabel: 'W 14th St',
      recentNotes: [
        "I treat my friend's W 3rd ink as their own observed place, not a route command, so from W 14th I choose the available south connection."
      ],
      recentMovement: 'You most recently moved west into this panorama.'
    },
    partnerPadText: ['W 3rd St'],
    options: [
      { panoId: 'north-option', heading: 350, label: 'public way north' },
      { panoId: 'south-option', heading: 178, label: '9th Ave south' },
      { panoId: 'west-option', heading: 270, label: 'public way west' }
    ]
  });

  assert.equal(policy.selectedIndex, 1);
  assert.equal(policy.desiredDirection, 'south');
  assert.equal(policy.local, '14TH ST');
  assert.equal(policy.target, '3RD ST');
});

test('convergence policy sends Theo north from own W 3rd selected route label toward partner W 14th ink', () => {
  const policy = selectConvergencePolicyOption({
    agent: {
      id: 'theo',
      name: 'Theo',
      currentRouteLabel: 'W 3rd St',
      recentMovement: 'You most recently moved east into this panorama.'
    },
    partnerPadText: ['W 14th St'],
    options: [
      { panoId: 'east-option', heading: 85, label: 'public way east' },
      { panoId: 'south-option', heading: 185, label: 'public way south' },
      { panoId: 'north-option', heading: 5, label: '9th Ave north' }
    ]
  });

  assert.equal(policy.selectedIndex, 2);
  assert.equal(policy.desiredDirection, 'north');
  assert.equal(policy.local, '3RD ST');
  assert.equal(policy.target, '14TH ST');
});

test('convergence policy ignores stale policy-authored notes when reading local corridor', () => {
  const policy = selectConvergencePolicyOption({
    agent: {
      id: 'theo',
      name: 'Theo',
      visitedPanos: [],
      recentNotes: [
        "I treat my friend's 14TH ST ink as their own observed place, not a route command, so from HOUSTON I choose the available north connection."
      ],
      recentMovement: 'You most recently moved east into this W Houston St panorama.'
    },
    partnerPadText: ['W 14TH ST'],
    options: [
      { panoId: 'east-option', heading: 80, label: 'W Houston St east' },
      { panoId: 'north-option', heading: 5, label: '7th Ave S north' }
    ]
  });

  assert.equal(policy.selectedIndex, 1);
  assert.equal(policy.local, 'HOUSTON');
  assert.equal(policy.target, '14TH ST');
});

test('convergence policy returns null for same corridor ink', () => {
  const policy = selectConvergencePolicyOption({
    agent: {
      recentMovement: 'You most recently moved east into this W Houston St panorama.'
    },
    partnerPadText: ['W HOUSTON ST'],
    options: [
      { panoId: 'east-option', heading: 80, label: 'W Houston St east' },
      { panoId: 'north-option', heading: 5, label: '7th Ave S north' }
    ]
  });

  assert.equal(policy, null);
});

test('convergence policy returns null for unknown or outside-Manhattan partner text', () => {
  const base = {
    agent: {
      recentMovement: 'You most recently moved west into this W 14th St panorama.'
    },
    options: [
      { panoId: 'south-option', heading: 180, label: '9th Ave south' }
    ]
  };

  assert.equal(selectConvergencePolicyOption({ ...base, partnerPadText: ['BIG CLOCK'] }), null);
  assert.equal(selectConvergencePolicyOption({ ...base, partnerPadText: ['BROOKLYN 14TH ST'] }), null);
});

test('convergence policy returns null when no available connector matches the needed direction', () => {
  const policy = selectConvergencePolicyOption({
    agent: {
      recentMovement: 'You most recently moved west into this W 14th St panorama.'
    },
    partnerPadText: ['W HOUSTON ST'],
    options: [
      { panoId: 'west-option', heading: 270, label: 'W 14th St west' },
      { panoId: 'east-option', heading: 90, label: 'W 14th St east' }
    ]
  });

  assert.equal(policy, null);
});

test('convergence policy uses own rendered W12 text to send Theo north toward partner W14 on 7th Ave', () => {
  const policy = selectConvergencePolicyOption({
    agent: {
      id: 'theo',
      name: 'Theo',
      currentRouteLabel: '7th Ave',
      recentMovement: 'You most recently moved northeast into this panorama.'
    },
    ownPadText: ['W12TH ST'],
    partnerPadText: ['W14th'],
    options: [
      { panoId: 'south-option', heading: 208.51862, label: '7th Ave' },
      { panoId: 'north-option', heading: 28.549927, label: '7th Ave' }
    ]
  });

  assert.equal(policy.selectedIndex, 1);
  assert.equal(policy.desiredDirection, 'north');
  assert.equal(policy.local, '12TH ST');
  assert.equal(policy.target, '14TH ST');
});

test('convergence policy rejects same-corridor W14 labels as connectors toward partner W12', () => {
  const policy = selectConvergencePolicyOption({
    agent: {
      id: 'ada',
      name: 'Ada',
      currentRouteLabel: 'W 14th St',
      recentMovement: 'You most recently moved southeast into this panorama.'
    },
    ownPadText: ['W14th'],
    partnerPadText: ['W12TH ST'],
    options: [
      { panoId: 'east-option', heading: 118.32929, label: 'W 14th St' },
      { panoId: 'west-option', heading: 299.1351, label: 'W 14th St' }
    ]
  });

  assert.equal(policy, null);
});

test('convergence policy still allows unlabeled and avenue connectors toward another corridor', () => {
  const policy = selectConvergencePolicyOption({
    agent: {
      currentRouteLabel: 'W 14th St'
    },
    partnerPadText: ['W12TH ST'],
    options: [
      { panoId: 'street-option', heading: 118, label: 'W 14th St' },
      { panoId: 'avenue-option', heading: 182, label: '7th Ave' },
      { panoId: 'unlabeled-option', heading: 190, label: '' }
    ]
  });

  assert.equal(policy.selectedIndex, 1);
});

test('convergence policy makes a geometrically better visited connector lose to a valid unvisited one', () => {
  const policy = selectConvergencePolicyOption({
    agent: {
      visitedPanos: ['visited-south'],
      recentMovement: 'You most recently moved west into this W 14th St panorama.'
    },
    partnerPadText: ['W HOUSTON ST'],
    options: [
      { panoId: 'visited-south', heading: 178, label: '9th Ave south' },
      { panoId: 'fresh-southwest', heading: 235, label: 'public street southwest' },
      { panoId: 'north-option', heading: 0, label: '9th Ave north' }
    ]
  });

  assert.equal(policy.selectedIndex, 1);
});

test('convergence policy allows a visited matching connector when it is the only convergence route', () => {
  const policy = selectConvergencePolicyOption({
    agent: {
      visitedPanos: ['visited-south'],
      recentMovement: 'You most recently moved west into this W 14th St panorama.'
    },
    partnerPadText: ['W HOUSTON ST'],
    options: [
      { panoId: 'visited-south', heading: 178, label: '9th Ave south' },
      { panoId: 'west-option', heading: 270, label: 'W 14th St west' }
    ]
  });

  assert.equal(policy.selectedIndex, 0);
});

test('model decision applies corridor convergence over generic exploration while preserving no-leak request shape', async () => {
  const requests = [];
  const client = {
    chat: {
      completions: {
        async create(request) {
          requests.push(request);
          return {
            choices: [{ message: { content: JSON.stringify({
              selectedIndex: 0,
              reasoning: 'I try the more novel avenue lights first.',
              padOperations: [],
              passPad: false
            }) } }]
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
      visitedPanos: [],
      recentNotes: ['I am on W 14th St.'],
      recentMovement: 'You most recently moved west into this W 14th St panorama.',
      currentRouteLabel: 'W 14th St',
      distanceToFriend: 50,
      partnerPath: ['hidden-partner-pano'],
      roughPosition: { lat: 40.735, lng: -74.001 }
    },
    partnerName: 'Theo',
    options: [
      { panoId: 'north-option', heading: 350, label: '9th Ave north' },
      { panoId: 'south-option', heading: 178, label: '9th Ave south' },
      { panoId: 'west-option', heading: 270, label: 'W 14th St west' }
    ],
    screenshots: [Buffer.from('north'), Buffer.from('south'), Buffer.from('west')],
    scratchpadBuffer: Buffer.from('pad'),
    canEditPad: false,
    padStatus: 'held by Theo',
    ownPadText: ['W 14th St'],
    partnerPadText: ['W HOUSTON ST']
  });

  assert.equal(result.selectedIndex, 1);
  assert.match(result.reasoning, /own observed place, not a route command/);
  const serializedRequest = JSON.stringify(requests[0]);
  assert.doesNotMatch(serializedRequest, /north-option|south-option|west-option/);
  assert.match(serializedRequest, /Your own last selected visible route label/);
  assert.match(serializedRequest, /current place text visibly written in your own ink/);
  assert.match(serializedRequest, /W 14th St/);
  assert.doesNotMatch(serializedRequest, /distanceToFriend|partnerPath|roughPosition|hidden-partner-pano|latitude|longitude|-?\d+\.\d{3,}/);
});

test('model decision sends Theo north from W Houston toward partner W 14th even if model picks east', async () => {
  const client = {
    chat: {
      completions: {
        async create() {
          return {
            choices: [{ message: { content: JSON.stringify({
              selectedIndex: 0,
              reasoning: 'I continue east because it looks open.',
              padOperations: [],
              passPad: false
            }) } }]
          };
        }
      }
    }
  };
  const service = new RendezvousModelService({ client, logger: { warn() {} } });
  const result = await service.decide({
    agent: {
      id: 'theo',
      name: 'Theo',
      visitedPanos: [],
      recentNotes: ['I can see W Houston St.'],
      recentMovement: 'You most recently moved east into this W Houston St panorama.'
    },
    partnerName: 'Ada',
    options: [
      { panoId: 'east-option', heading: 80, label: 'W Houston St east' },
      { panoId: 'south-option', heading: 185, label: 'Carmine St south' },
      { panoId: 'north-option', heading: 5, label: '7th Ave S north' }
    ],
    screenshots: [Buffer.from('east'), Buffer.from('south'), Buffer.from('north')],
    scratchpadBuffer: Buffer.from('pad'),
    canEditPad: false,
    padStatus: 'held by Ada',
    partnerPadText: ['W 14TH ST']
  });

  assert.equal(result.selectedIndex, 2);
  assert.match(result.reasoning, /available north connection/);
});

test('rendezvous model response parsing allows an author replacement operation', async () => {
  const client = {
    chat: {
      completions: {
        async create() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  selectedIndex: 0,
                  reasoning: 'I redraw my side as a compact intersection clue.',
                  padOperations: [
                    { type: 'replaceMine' },
                    { type: 'line', from: { x: 0.2, y: 0.4 }, to: { x: 0.8, y: 0.4 } },
                    { type: 'landmark', center: { x: 0.6, y: 0.4 }, symbol: 'station', label: 'PENN' }
                  ],
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
    agent: { id: 'theo', name: 'Theo', visitedPanos: [], recentNotes: [] },
    partnerName: 'Ada',
    options: [{ panoId: 'pano-a', heading: 90, label: 'avenue' }],
    screenshots: [Buffer.from('one')],
    scratchpadBuffer: Buffer.from('pad'),
    canEditPad: true,
    padStatus: 'in your hands'
  });

  assert.equal(result.padOperations[0].type, 'replaceMine');
  assert.equal(result.padOperations[2].type, 'landmark');
  assert.equal(result.passPad, true);
});

test('model decision rejects partner label echo while preserving geometry and supported own labels', async () => {
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
                  selectedIndex: 0,
                  reasoning: 'Ada points toward W 15th St; I can see Ave of the Americas here.',
                  padOperations: [
                    { type: 'line', from: { x: 0.2, y: 0.4 }, to: { x: 0.8, y: 0.4 } },
                    { type: 'text', text: 'W 15th St', at: { x: 0.3, y: 0.3 } },
                    { type: 'landmark', center: { x: 0.5, y: 0.5 }, label: 'W 15TH ST' },
                    { type: 'text', text: 'Ave of the Americas', at: { x: 0.4, y: 0.6 } }
                  ],
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
      id: 'theo',
      name: 'Theo',
      visitedPanos: [],
      currentRouteLabel: 'Ave of the Americas',
      recentMovement: 'You most recently moved northeast into this panorama.',
      recentNotes: [
        "I treat my friend's W 15th St ink as their own observed place, not a route command, so from W Washington Pl I choose the available north connection.",
        "Ada points toward W 15th St from her ink."
      ],
      distanceToFriend: 50,
      partnerPath: ['hidden-partner-pano'],
      roughPosition: { lat: 40.732, lng: -74.000 }
    },
    partnerName: 'Ada',
    options: [
      { panoId: 'sixth-option', heading: 30, label: '6th Ave' },
      { panoId: 'washington-option', heading: 90, label: 'W Washington Pl' }
    ],
    screenshots: [Buffer.from('sixth'), Buffer.from('washington')],
    scratchpadBuffer: Buffer.from('pad'),
    canEditPad: true,
    padStatus: 'in your hands',
    partnerPadText: ['W 15th St']
  });

  assert.deepEqual(result.padOperations.map(operation => operation.type), ['line', 'text']);
  assert.equal(result.padOperations[1].text, 'Ave of the Americas');
  const serializedRequest = JSON.stringify(requests[0]);
  assert.doesNotMatch(serializedRequest, /distanceToFriend|partnerPath|roughPosition|hidden-partner-pano|latitude|longitude|-?\d+\.\d{3,}/);
});

test('model decision rejects canonical numbered partner echoes in partial text and landmark labels', async () => {
  const client = {
    chat: {
      completions: {
        async create() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  selectedIndex: 0,
                  reasoning: 'I keep my geometry and avoid copying the partner label.',
                  padOperations: [
                    { type: 'line', from: { x: 0.2, y: 0.3 }, to: { x: 0.7, y: 0.4 } },
                    { type: 'text', text: 'W15', at: { x: 0.3, y: 0.3 } },
                    { type: 'landmark', center: { x: 0.5, y: 0.5 }, label: '15th' },
                    { type: 'text', text: 'W 15', at: { x: 0.6, y: 0.6 } }
                  ],
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
      id: 'theo',
      name: 'Theo',
      visitedPanos: [],
      currentRouteLabel: 'Ave of the Americas',
      recentMovement: 'You most recently moved northeast into this panorama.'
    },
    partnerName: 'Ada',
    options: [{ panoId: 'sixth-option', heading: 30, label: '6th Ave' }],
    screenshots: [Buffer.from('sixth')],
    scratchpadBuffer: Buffer.from('pad'),
    canEditPad: true,
    padStatus: 'in your hands',
    partnerPadText: ['W 15th St']
  });

  assert.deepEqual(result.padOperations.map(operation => operation.type), ['line']);
});

test('model decision treats 6th Ave and Avenue of the Americas as the same echo key', async () => {
  const client = {
    chat: {
      completions: {
        async create() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  selectedIndex: 0,
                  reasoning: 'I should only write my own current label.',
                  padOperations: [
                    { type: 'text', text: 'Ave of the Americas', at: { x: 0.4, y: 0.4 } },
                    { type: 'text', text: 'W Washington Pl', at: { x: 0.4, y: 0.6 } }
                  ],
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
      id: 'theo',
      name: 'Theo',
      visitedPanos: [],
      currentRouteLabel: 'W Washington Pl',
      recentMovement: 'You most recently moved north into this panorama.'
    },
    partnerName: 'Ada',
    options: [{ panoId: 'washington-option', heading: 90, label: 'W Washington Pl' }],
    screenshots: [Buffer.from('washington')],
    scratchpadBuffer: Buffer.from('pad'),
    canEditPad: true,
    padStatus: 'in your hands',
    partnerPadText: ['6th Ave']
  });

  assert.equal(result.padOperations.length, 1);
  assert.equal(result.padOperations[0].text, 'W Washington Pl');
});

test('model decision allows Avenue of the Americas echo when own visible evidence supports 6th Ave alias', async () => {
  const client = {
    chat: {
      completions: {
        async create() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  selectedIndex: 0,
                  reasoning: 'I see this avenue in the current route label.',
                  padOperations: [
                    { type: 'text', text: 'Avenue of the Americas', at: { x: 0.4, y: 0.4 } }
                  ],
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
      visitedPanos: [],
      currentRouteLabel: '6th Ave',
      recentMovement: 'You most recently moved east into this panorama.'
    },
    partnerName: 'Theo',
    options: [{ panoId: 'sixth-option', heading: 30, label: '6th Ave' }],
    screenshots: [Buffer.from('sixth')],
    scratchpadBuffer: Buffer.from('pad'),
    canEditPad: true,
    padStatus: 'in your hands',
    partnerPadText: ['Ave of the Americas']
  });

  assert.equal(result.padOperations.length, 1);
  assert.equal(result.padOperations[0].text, 'Avenue of the Americas');
});

test('model decision does not use stale recent notes as echo support', async () => {
  const client = {
    chat: {
      completions: {
        async create() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  selectedIndex: 0,
                  reasoning: 'I write the partner label from memory.',
                  padOperations: [
                    { type: 'text', text: 'W 15th St', at: { x: 0.4, y: 0.4 } },
                    { type: 'text', text: 'W Washington Pl', at: { x: 0.4, y: 0.6 } }
                  ],
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
      id: 'theo',
      name: 'Theo',
      visitedPanos: [],
      currentRouteLabel: 'W Washington Pl',
      recentMovement: 'You most recently moved north into this panorama.',
      recentNotes: [
        'I see W 15th St in my current view.',
        "I treat my friend's W 15th St ink as their own observed place, not a route command, so from W Washington Pl I choose the available north connection."
      ]
    },
    partnerName: 'Ada',
    options: [{ panoId: 'washington-option', heading: 90, label: 'W Washington Pl' }],
    screenshots: [Buffer.from('washington')],
    scratchpadBuffer: Buffer.from('pad'),
    canEditPad: true,
    padStatus: 'in your hands',
    partnerPadText: ['W15']
  });

  assert.equal(result.padOperations.length, 1);
  assert.equal(result.padOperations[0].text, 'W Washington Pl');
});

test('model decision drops lone replaceMine when every rendered replacement is a partner echo', async () => {
  const client = {
    chat: {
      completions: {
        async create() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  selectedIndex: 0,
                  reasoning: 'I should not erase my prior ink with only copied text.',
                  padOperations: [
                    { type: 'replaceMine' },
                    { type: 'text', text: '15th', at: { x: 0.4, y: 0.4 } }
                  ],
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
      id: 'theo',
      name: 'Theo',
      visitedPanos: [],
      currentRouteLabel: 'W Washington Pl',
      recentMovement: 'You most recently moved north into this panorama.'
    },
    partnerName: 'Ada',
    options: [{ panoId: 'washington-option', heading: 90, label: 'W Washington Pl' }],
    screenshots: [Buffer.from('washington')],
    scratchpadBuffer: Buffer.from('pad'),
    canEditPad: true,
    padStatus: 'in your hands',
    partnerPadText: ['W 15th St']
  });

  assert.deepEqual(result.padOperations, []);
});

test('model decision retains replaceMine when a genuine rendered replacement survives', async () => {
  const client = {
    chat: {
      completions: {
        async create() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  selectedIndex: 0,
                  reasoning: 'I replace stale ink with a line I can stand behind.',
                  padOperations: [
                    { type: 'replaceMine' },
                    { type: 'text', text: 'W 15th St', at: { x: 0.4, y: 0.4 } },
                    { type: 'line', from: { x: 0.2, y: 0.3 }, to: { x: 0.7, y: 0.4 } }
                  ],
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
      id: 'theo',
      name: 'Theo',
      visitedPanos: [],
      currentRouteLabel: 'W Washington Pl',
      recentMovement: 'You most recently moved north into this panorama.'
    },
    partnerName: 'Ada',
    options: [{ panoId: 'washington-option', heading: 90, label: 'W Washington Pl' }],
    screenshots: [Buffer.from('washington')],
    scratchpadBuffer: Buffer.from('pad'),
    canEditPad: true,
    padStatus: 'in your hands',
    partnerPadText: ['W 15th St']
  });

  assert.deepEqual(result.padOperations.map(operation => operation.type), ['replaceMine', 'line']);
});

test('model decision allows echoed partner label when own visible evidence supports the same corridor', async () => {
  const client = {
    chat: {
      completions: {
        async create() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  selectedIndex: 0,
                  reasoning: 'I see W 15th St in my current view.',
                  padOperations: [
                    { type: 'text', text: 'W 15th St', at: { x: 0.3, y: 0.3 } }
                  ],
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
      visitedPanos: [],
      currentRouteLabel: 'W 15th St',
      recentMovement: 'You most recently moved southeast into this panorama.'
    },
    partnerName: 'Theo',
    options: [
      { panoId: 'fifteenth-option', heading: 120, label: 'W 15th St southeast' },
      { panoId: 'avenue-option', heading: 20, label: '9th Ave' }
    ],
    screenshots: [Buffer.from('fifteenth'), Buffer.from('avenue')],
    scratchpadBuffer: Buffer.from('pad'),
    canEditPad: true,
    padStatus: 'in your hands',
    partnerPadText: ['W 15TH ST']
  });

  assert.equal(result.padOperations.length, 1);
  assert.equal(result.padOperations[0].text, 'W 15th St');
});

test('model decision allows non-echo own labels even when partner ink names another place', async () => {
  const client = {
    chat: {
      completions: {
        async create() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  selectedIndex: 0,
                  reasoning: 'I mark the avenue I can read.',
                  padOperations: [
                    { type: 'text', text: 'Ave of the Americas', at: { x: 0.4, y: 0.5 } }
                  ],
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
      id: 'theo',
      name: 'Theo',
      visitedPanos: [],
      currentRouteLabel: 'W Washington Pl',
      recentMovement: 'You most recently moved north into this panorama.'
    },
    partnerName: 'Ada',
    options: [
      { panoId: 'avenue-option', heading: 30, label: 'Ave of the Americas' }
    ],
    screenshots: [Buffer.from('avenue')],
    scratchpadBuffer: Buffer.from('pad'),
    canEditPad: true,
    padStatus: 'in your hands',
    partnerPadText: ['W 15th St']
  });

  assert.equal(result.padOperations.length, 1);
  assert.equal(result.padOperations[0].text, 'Ave of the Americas');
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

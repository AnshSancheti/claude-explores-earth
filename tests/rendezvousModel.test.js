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
    visualHistory: [{
      sequence: 5,
      direction: 'sent',
      mimeType: 'image/webp',
      buffer: Buffer.from('older-sheet')
    }],
    privateMemory: {
      version: 3,
      currentPlan: 'Test the circle convention at the next branch.',
      ownObservations: [{ description: 'I followed a row of stone arches.' }],
      receivedSheets: [],
      sentMessages: [],
      reconciliations: [],
      visualConventions: [{
        key: 'yellow-circle',
        description: 'A yellow circle recurs beside stone arches.',
        confidence: 0.35,
        basisSequences: [5]
      }],
      partnerHypotheses: []
    },
    movementSinceDecision: { steps: 4, distanceMeters: 90, headings: [0, 10], routeLabels: [] },
    ...overrides
  };
}

function perceptionResponse() {
  return {
    literalContents: ['a bright circle between two repeated arch forms'],
    possiblePlaces: ['possibly an arcade near Washington Square, with low confidence'],
    possibleIntentions: ['Theo may be asking Ada to compare or approach similar arches'],
    frameOfReference: 'sender',
    requestedResponse: 'Compare the arches with Ada’s surroundings.',
    informationNovelty: 'mixed',
    sheetInterpretation: 'Theo may be near a recognizable arcade and may want me to answer with comparable evidence.',
    sheetConfidence: 0.58,
    evidenceDelta: {
      newEvidence: ['the circle is now placed between arches'],
      repeatedEvidence: ['the arch motif appeared before'],
      contradictions: [],
      unresolvedQuestions: ['whether the circle represents a lamp or destination'],
      informationWorthSending: ['whether I also see repeated arches'],
      planAssessment: 'supporting'
    },
    conventionUpdate: {
      key: 'circle-between-arches',
      description: 'A circle between arches may identify a shared visual target.',
      confidence: 0.55,
      basisSequences: [5, 7]
    },
    partnerHypothesis: {
      key: 'possible-washington-square-arcade',
      description: 'Theo may be near an arcade around Washington Square.',
      confidence: 0.45,
      basisSequences: [7]
    }
  };
}

function routeResponse(overrides = {}) {
  return {
    action: 'move',
    selectedIndex: 1,
    intendedHeading: 0,
    reasoning: 'Theo may be describing an arcade, and the northern opening has the closest matching repeated masonry.',
    observation: 'Repeated stone arches line the northern opening.',
    observedFeatures: ['three repeated stone arches', 'a suspended traffic light beside them'],
    sheetReconciliation: {
      informationNovelty: 'mixed',
      newEvidence: ['the circle is now placed between arches'],
      repeatedEvidence: ['the arch motif appeared before'],
      contradictions: [],
      unresolvedQuestions: ['whether the circle represents a lamp or destination'],
      informationWorthSending: ['whether I also see repeated arches'],
      planAssessment: 'supporting',
      conventionUpdate: perceptionResponse().conventionUpdate,
      partnerHypothesis: perceptionResponse().partnerHypothesis
    },
    memoryUpdate: {
      currentPlan: 'Test the possible arcade hypothesis while looking for stronger geographic evidence.'
    },
    ...overrides
  };
}

function drawingResponse(overrides = {}) {
  return {
    drawingIntent: 'Tell Theo that I see matching arches and intend to investigate them.',
    informationDelta: 'I now see three matching arches beside a suspended traffic light.',
    continuityReason: 'Repeating the arches links this observation to Theo’s earlier motif.',
    messageAction: 'movement',
    drawingPrompt: 'Draw two groups of arches echoing each other, with one small figure moving toward the nearer group and a large uncertain circle above the distant group.',
    groundedFeatures: ['three repeated stone arches', 'a suspended traffic light beside them'],
    ...overrides
  };
}

function stagedClient(requests, overrides = {}) {
  return {
    chat: {
      completions: {
        async create(request) {
          requests.push(request);
          const prompt = request.messages[0].content;
          let payload;
          if (/privately inspecting the newest wordless drawing/.test(prompt)) {
            payload = overrides.perception || perceptionResponse();
          } else if (/without any knowledge of what its sender intended/.test(prompt)) {
            payload = overrides.blindRead || {
              literalContents: ['two separated arch groups and a moving figure'],
              likelyMessage: 'The sender sees matching arches and is moving toward one group.',
              dominantAction: 'movement',
              movementCues: ['a small figure approaches the nearer arches'],
              stillnessCues: [],
              readableText: false
            };
          } else if (/inspecting the actual wordless drawing/.test(prompt)) {
            payload = overrides.review || {
              accepted: true,
              assessment: 'The paired arches and intended movement are visually clear.',
              revisionPrompt: ''
            };
          } else if (/currently hold the one physical sheet/.test(prompt)) {
            payload = overrides.drawing || drawingResponse();
          } else {
            payload = overrides.route || routeResponse();
          }
          return { choices: [{ message: { content: JSON.stringify(payload) } }] };
        }
      }
    }
  };
}

test('a branch separates interpretation, route choice, and visual communication', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests),
    logger: { warn() {} }
  });
  const decision = await service.decide(input());

  assert.equal(requests.length, 3);
  assert.equal(decision.action, 'move');
  assert.equal(decision.selectedIndex, 1);
  assert.match(decision.sheetInterpretation, /recognizable arcade/);
  assert.equal(decision.sheetPerception.frameOfReference, 'sender');
  assert.equal(decision.sheetPerception.informationNovelty, 'mixed');
  assert.deepEqual(decision.reconciliation.newEvidence, ['the circle is now placed between arches']);
  assert.match(decision.memoryUpdate.partnerHypothesis.description, /Washington Square/);
  assert.match(decision.reasoning, /Theo may be describing/);
  assert.match(decision.drawingIntent, /intend to investigate/);
  assert.match(decision.informationDelta, /three matching arches/);
  assert.equal(decision.messageAction, 'movement');
  assert.match(decision.drawingPrompt, /figure moving/);

  const serialized = JSON.stringify(requests);
  assert.match(serialized, /privately name possible landmarks/);
  assert.match(serialized, /intended movement/);
  assert.match(serialized, /frame of reference/);
  assert.match(serialized, /information delta/);
  assert.match(serialized, /strongest visual cue.*messageAction/);
  assert.match(serialized, /wordless drawing/);
  assert.match(serialized, /no readable text/);
  assert.match(requests[0].messages[1].content[0].text, /Inspect this image on its own/);
  assert.doesNotMatch(requests[0].messages[1].content[0].text, /private evidence ledger|History image/);
  assert.equal(requests[0].messages[1].content.length, 2);
  assert.doesNotMatch(serialized, /partnerPadText|ownPadText|distanceToFriend|-?\d+\.\d{4,}/);
});

test('an already interpreted sheet reuses durable memory without another perception call', async () => {
  const requests = [];
  const remembered = {
    ...input().privateMemory,
    receivedSheets: [{
      sequence: 7,
      from: 'theo',
      interpretation: 'Theo may be near a recognizable arcade.',
      confidence: 0.5,
      literalContents: ['two arches and one circle'],
      possiblePlaces: ['possibly Washington Square'],
      possibleIntentions: ['possibly asking me to compare arches']
    }],
    reconciliations: [{
      sheetSequence: 7,
      newEvidence: ['an arch motif'],
      planAssessment: 'supporting'
    }]
  };
  const service = new RendezvousModelService({
    client: stagedClient(requests),
    logger: { warn() {} }
  });
  const decision = await service.decide(input({ privateMemory: remembered }));

  assert.equal(requests.length, 2);
  assert.equal(requests.some(request =>
    /privately inspecting the newest wordless drawing/.test(request.messages[0].content)
  ), false);
  assert.match(decision.sheetInterpretation, /recognizable arcade/);
});

test('a blank first sheet cannot create partner evidence', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests),
    logger: { warn() {} }
  });
  const decision = await service.decide(input({ sheetMessage: null, visualHistory: [] }));

  assert.equal(requests.length, 2);
  assert.equal(decision.sheetInterpretation, '');
  assert.equal(decision.sheetConfidence, 0);
  assert.equal(decision.memoryUpdate.partnerHypothesis.description, '');
});

test('expired local patience removes waiting from route choice while preserving a drawing', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, { route: routeResponse({ action: 'move' }) }),
    logger: { warn() {} }
  });
  const decision = await service.decide(input({
    allowWait: false,
    consecutiveWaitDecisions: 2
  }));

  assert.equal(decision.action, 'move');
  assert.ok(decision.drawingPrompt);
  const routeRequest = requests.find(request =>
    !/privately inspecting|currently hold/.test(request.messages[0].content)
  );
  assert.match(routeRequest.messages[0].content, /same branch 2 consecutive times/);
  assert.match(routeRequest.messages[0].content, /Remaining here again is not available/);
});

test('model outage keeps the holder at the branch for a later retry', async () => {
  const client = {
    chat: {
      completions: {
        async create() {
          throw Object.assign(new Error('offline'), { status: 503 });
        }
      }
    }
  };
  const service = new RendezvousModelService({ client, logger: { warn() {} } });
  service.maxAttempts = 1;
  const decision = await service.decide(input());
  assert.equal(decision.action, 'wait');
  assert.equal(decision.waitTurns, 1);
  assert.equal(decision.drawingPrompt, '');
  assert.equal(decision.fallbackCause, 'sheet_perception_error');
});

test('sender reviews the actual generated image and can request a visual revision', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      review: {
        accepted: false,
        assessment: 'The two arch groups collapsed into one.',
        revisionPrompt: 'Separate the arch groups clearly and retain the moving figure.'
      }
    }),
    logger: { warn() {} }
  });
  const review = await service.reviewDrawing({
    agentName: 'Ada',
    partnerName: 'Theo',
    drawingIntent: 'Show two matching places and my intended movement.',
    informationDelta: 'The nearer arches now match the earlier distant arches.',
    continuityReason: 'The paired arches deliberately continue the shared motif.',
    drawingPrompt: 'Draw two arch groups and a moving figure.',
    groundedFeatures: ['three repeated arches'],
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, false);
  assert.match(review.revisionPrompt, /Separate the arch groups/);
  assert.equal(requests.length, 2);
  assert.match(requests[0].messages[0].content, /without any knowledge/);
  assert.equal(requests[0].messages[1].content[0].type, 'image_url');
  assert.match(requests[1].messages[0].content, /independent recipient/);
  assert.match(requests[1].messages[1].content[0].text, /nearer arches now match/);
  assert.match(requests[1].messages[1].content[0].text, /deliberately continue/);
  assert.match(requests[1].messages[1].content[0].text, /context-free reading/);
});

test('blind recipient action overrides a sender review biased by intent', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      blindRead: {
        literalContents: ['a large arrow crosses an open road'],
        likelyMessage: 'Proceed along the road in the arrow direction.',
        dominantAction: 'movement',
        movementCues: ['large forward arrow'],
        stillnessCues: [],
        readableText: false
      },
      review: {
        accepted: true,
        assessment: 'The figures appear to be waiting.',
        revisionPrompt: ''
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Theo',
    partnerName: 'Ada',
    drawingIntent: 'Tell Ada that I am holding this corner.',
    informationDelta: 'I am deliberately waiting rather than advancing.',
    continuityReason: '',
    messageAction: 'stillness',
    drawingPrompt: 'Draw a still figure beside a busy road.',
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, false);
  assert.match(review.assessment, /movement.*stillness/);
  assert.match(review.revisionPrompt, /Remove arrows, directional lines/);
  assert.match(review.revisionPrompt, /stable anchor/);
  assert.equal(requests.length, 1);
});

test('decision sanitizer reconciles heading and bounds deliberate waiting', () => {
  const headingDecision = sanitizeRendezvousDecision({
    selectedIndex: 0,
    intendedHeading: 2
  }, input().options);
  assert.equal(headingDecision.selectedIndex, 1);

  const waitDecision = sanitizeRendezvousDecision({
    action: 'wait',
    waitTurns: 99,
    memoryUpdate: { currentPlan: 'Wait here.' }
  }, input().options);
  assert.equal(waitDecision.waitTurns, 6);
  assert.equal(waitDecision.memoryUpdate.currentPlan, 'Wait here.');

  const expired = sanitizeRendezvousDecision({
    action: 'wait',
    waitTurns: 4
  }, input().options, { allowWait: false });
  assert.equal(expired.action, 'move');
  assert.equal(expired.waitTurns, 0);
});

test('model is rejected outside a genuine branch', async () => {
  const service = new RendezvousModelService({ client: {}, logger: { warn() {} } });
  await assert.rejects(
    service.decide(input({
      options: [{ panoId: 'only', heading: 90 }],
      screenshots: [Buffer.from('only')]
    })),
    /genuine route branch/
  );
});

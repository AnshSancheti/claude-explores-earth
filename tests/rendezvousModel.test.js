import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acknowledgementInventsRouteProposal,
  deliberateRepetitionHasPurpose,
  isConcreteLocalEvidence,
  isCueDependentSearchPlan,
  localObservationMatchesBlindRead,
  localQuestionPreservesCitedSubject,
  questionAlternativesVisible,
  RendezvousModelService,
  reconcileRendezvousContributionAction,
  reconcileRendezvousMessageAction,
  repeatsRecentOutboundProposition,
  responseDrawingContradictsRouteUncertainty,
  responseInventsRouteCoordination,
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
    primarySubject: 'a bright circle held between two stone arches',
    possiblePlaces: ['possibly an arcade near Washington Square, with low confidence'],
    possibleIntentions: ['Theo may be asking Ada to compare or approach similar arches'],
    communicationFunction: 'request',
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
      basisSequences: [5, 7],
      evidenceStatus: 'new_corroboration'
    },
    partnerHypothesis: {
      key: 'possible-washington-square-arcade',
      description: 'Theo may be near an arcade around Washington Square.',
      confidence: 0.45,
      basisSequences: [7],
      evidenceStatus: 'new_corroboration'
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
    observedFeatureViewIndices: [1, 1],
    sheetReconciliation: {
      currentSenderAction: 'movement',
      currentSenderActionBasis: 'A small figure visibly approaches the nearer arches.',
      propositionNovelty: 'new',
      informationNovelty: 'mixed',
      newEvidenceIds: ['visible:0'],
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
    contributionKind: 'local_observation',
    contributionEvidenceId: 'local:0',
    contributionSummary: 'Ada can tell Theo that she currently sees three matching stone arches.',
    drawingIntent: 'Tell Theo that I see matching arches.',
    informationDelta: 'I now see three matching arches beside a suspended traffic light.',
    continuityReason: 'Repeating the arches links this observation to Theo’s earlier motif.',
    messageAction: 'stillness',
    drawingPrompt: 'Draw two groups of arches echoing each other, with a suspended traffic light beside the nearer group and a large uncertain circle above the distant group.',
    groundedFeatureEvidenceIds: ['local:0', 'local:1'],
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
          } else if (/reconsidering only the drawing/.test(prompt)) {
            payload = typeof overrides.replan === 'function'
              ? overrides.replan(request)
              : (overrides.replan || {
                  contributionEvidenceId: 'local:0',
                  drawingIntent: 'Show the stone arches I can actually see.',
                  messageAction: 'stillness',
                  drawingPrompt: 'Draw three stone arches as the dominant observation.',
                  groundedFeatureEvidenceIds: ['local:0']
                });
          } else if (/without any knowledge of what its sender intended/.test(prompt)) {
            payload = overrides.blindRead || {
              literalContents: ['two separated arch groups and a moving figure'],
              primarySubject: 'three repeated stone arches',
              likelyMessage: 'The sender sees matching arches and is moving toward one group.',
              dominantAction: 'movement',
              frameOfReference: 'sender',
              frameBasis: 'A moving figure is embedded in the observed scene.',
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
            payload = typeof overrides.drawing === 'function'
              ? overrides.drawing(request)
              : (overrides.drawing || drawingResponse());
          } else {
            payload = typeof overrides.route === 'function'
              ? overrides.route(request)
              : (overrides.route || routeResponse());
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
  assert.equal(decision.sheetPerception.currentSenderAction, 'movement');
  assert.match(decision.sheetPerception.currentSenderActionBasis, /approaches/);
  assert.equal(decision.sheetPerception.informationNovelty, 'mixed');
  assert.deepEqual(decision.reconciliation.newEvidence, [
    'a bright circle between two repeated arch forms'
  ]);
  assert.match(decision.memoryUpdate.partnerHypothesis.description, /Washington Square/);
  assert.equal(decision.memoryUpdate.partnerHypothesis.evidenceStatus, 'new_corroboration');
  assert.match(decision.reasoning, /Theo may be describing/);
  assert.match(decision.drawingIntent, /see matching arches/);
  assert.equal(decision.contributionKind, 'local_observation');
  assert.equal(decision.contributionEvidenceId, 'local:0');
  assert.equal(decision.contributionSummary, 'New local observation: three repeated stone arches');
  assert.equal(decision.informationDelta, decision.contributionSummary);
  assert.deepEqual(decision.observedFeatures, [
    'three repeated stone arches',
    'a suspended traffic light beside them'
  ]);
  assert.deepEqual(decision.drawingGroundedFeatures, [
    'three repeated stone arches',
    'a suspended traffic light beside them'
  ]);
  assert.deepEqual(decision.referenceViewIndices, [1]);
  assert.equal(decision.messageAction, 'stillness');
  assert.match(decision.drawingPrompt, /suspended traffic light/);

  const serialized = JSON.stringify(requests);
  assert.match(serialized, /privately name possible landmarks/);
  assert.match(serialized, /intended movement/);
  assert.match(serialized, /frame of reference/);
  assert.match(serialized, /information delta/);
  assert.match(serialized, /Available outbound evidence catalog/);
  assert.match(serialized, /Newest-sheet visible evidence catalog/);
  assert.match(serialized, /never relabel it as a new local observation/);
  assert.match(serialized, /highest-priority evidence.*current visible action/);
  assert.match(serialized, /Neither friend leads or grants the other permission/);
  assert.match(serialized, /drawings? supplies evidence, questions, and hypotheses, never permission/i);
  assert.match(serialized, /Place names may exist in your private reasoning/);
  assert.match(serialized, /conceptually blank page/);
  assert.match(serialized, /continuity alone does not justify copying a multi-panel itinerary/);
  assert.match(serialized, /strongest visual cue.*messageAction/);
  assert.match(serialized, /wordless drawing/);
  assert.match(serialized, /no readable text/);
  assert.match(serialized, /zero to four distinctive, drawable facts/);
  assert.ok(requests[1].messages[1].content
    .filter(item => item.type === 'image_url')
    .every(item => item.image_url.detail === 'high'));
  assert.match(requests[0].messages[1].content[0].text, /Inspect this image on its own/);
  assert.doesNotMatch(requests[0].messages[1].content[0].text, /private evidence ledger|History image/);
  assert.equal(requests[0].messages[1].content.length, 2);
  const drawingContent = requests[2].messages[1].content;
  assert.match(drawingContent[1].text, /CURRENT RECEIVED SHEET.*sequence 7/);
  assert.match(drawingContent[3].text, /PRIOR PASSED SHEET.*sequence 5.*sent by you/);
  assert.equal(drawingContent.filter(item => item.type === 'image_url').length, 2);
  assert.ok(drawingContent
    .filter(item => item.type === 'image_url')
    .every(item => !item.image_url.url.startsWith('data:image/jpeg')));
  assert.doesNotMatch(serialized, /partnerPadText|ownPadText|distanceToFriend|-?\d+\.\d{4,}/);
});

test('renderer failure memory stays out of the model-facing route ledger', async () => {
  const requests = [];
  const baseInput = input();
  const service = new RendezvousModelService({
    client: stagedClient(requests),
    logger: { warn() {} }
  });

  await service.decide(input({
    privateMemory: {
      ...baseInput.privateMemory,
      failedMessages: [{
        draftId: 'private-failed-draft',
        sheetSequence: 6,
        contributionKind: 'question',
        contributionSummary: 'A private failed proposition marker.',
        failureReason: 'A private renderer rejection marker.'
      }]
    }
  }));

  const routeRequest = requests.find(request =>
    /Your descriptive private evidence ledger/.test(
      request.messages?.[1]?.content?.[0]?.text || ''
    )
  );
  assert.ok(routeRequest);
  const serializedRouteRequest = JSON.stringify(routeRequest);
  assert.doesNotMatch(serializedRouteRequest, /private-failed-draft/);
  assert.doesNotMatch(serializedRouteRequest, /private renderer rejection marker/i);
  const serializedRequests = JSON.stringify(requests);
  assert.doesNotMatch(serializedRequests, /private-failed-draft/);
  assert.doesNotMatch(serializedRequests, /private renderer rejection marker/i);
});

test('same-sheet failed propositions are omitted from the outbound evidence catalog', async () => {
  const requests = [];
  const baseInput = input();
  const service = new RendezvousModelService({
    client: stagedClient(requests),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({
    privateMemory: {
      ...baseInput.privateMemory,
      receivedSheets: [{
        sequence: 7,
        interpretation: 'A circle appears between arches.'
      }],
      failedMessages: [{
        draftId: 'failed-circle-question',
        sheetSequence: 7,
        contributionKind: 'question',
        contributionSummary: 'Question I am sending: whether the circle represents a lamp or destination',
        informationDelta: 'Question I am sending: whether the circle represents a lamp or destination',
        intent: 'Ask whether the circle represents a lamp or destination.'
      }]
    }
  }));

  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.contributionEvidenceId, 'local:0');
  const drawingRequest = requests.find(request =>
    /currently hold the one physical sheet/.test(request.messages[0].content)
  );
  assert.ok(drawingRequest);
  const drawingText = drawingRequest.messages[1].content
    .find(item => item.type === 'text')?.text || '';
  const catalogText = drawingText.split('Available outbound evidence catalog:\n')[1] || '';
  assert.doesNotMatch(catalogText, /"id": "question:0"/);
  assert.match(catalogText, /"id": "local:0"/);
});

test('a failed same-sheet acknowledgement is not offered again', async () => {
  const requests = [];
  const baseInput = input();
  const literal = 'a bright circle between two repeated arch forms';
  const service = new RendezvousModelService({
    client: stagedClient(requests),
    logger: { warn() {} }
  });

  await service.decide(input({
    privateMemory: {
      ...baseInput.privateMemory,
      receivedSheets: [{
        sequence: 7,
        interpretation: 'A circle appears between arches.'
      }],
      failedMessages: [{
        draftId: 'failed-circle-acknowledgement',
        sheetSequence: 7,
        contributionKind: 'acknowledgement',
        contributionSummary:
          `Acknowledging received visual evidence without claiming it as my own: ${literal}`,
        informationDelta:
          `Acknowledging received visual evidence without claiming it as my own: ${literal}`,
        intent: 'Acknowledge the circle between arches.'
      }]
    }
  }));

  const drawingRequest = requests.find(request =>
    /currently hold the one physical sheet/.test(request.messages[0].content)
  );
  const drawingText = drawingRequest.messages[1].content
    .find(item => item.type === 'text')?.text || '';
  const catalogText = drawingText.split('Available outbound evidence catalog:\n')[1] || '';
  assert.doesNotMatch(catalogText, /"id": "received:0"/);
  assert.match(catalogText, /"id": "local:0"/);
});

test('an agent can turn concrete local evidence into its own visual question', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      drawing: drawingResponse({
        contributionKind: 'question',
        contributionEvidenceId: 'question_local:0',
        drawingIntent: 'Ask whether Theo recognizes the relationship among these repeated arches.',
        messageAction: 'unclear',
        drawingPrompt: 'Draw three stone arches with two equally weighted possible visual relationships and unresolved uncertainty between them.',
        groundedFeatureEvidenceIds: ['question_local:0']
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.contributionKind, 'question');
  assert.equal(decision.contributionEvidenceId, 'question_local:0');
  assert.equal(
    decision.contributionSummary,
    'Question I am sending about this local evidence: three repeated stone arches'
  );
  assert.match(decision.drawingIntent, /whether Theo recognizes/);
  const drawingRequest = requests.find(request =>
    /currently hold the one physical sheet/.test(request.messages[0].content)
  );
  assert.match(drawingRequest.messages[1].content[0].text, /"id": "question_local:0"/);
  assert.match(drawingRequest.messages[1].content[0].text, /"kind": "question"/);
});

test('a local question cannot hide a question about the received cue', async () => {
  let drawingAttempts = 0;
  const service = new RendezvousModelService({
    client: stagedClient([], {
      drawing(request) {
        drawingAttempts += 1;
        if (drawingAttempts === 1) {
          return drawingResponse({
            contributionKind: 'question',
            contributionEvidenceId: 'question_local:0',
            drawingIntent: 'Ask Theo whether his forward cue means literal movement or a symbolic axis.',
            messageAction: 'unclear',
            drawingPrompt: 'Draw a street fork with the local arches in the background.',
            groundedFeatureEvidenceIds: ['question_local:0']
          });
        }
        assert.match(
          request.messages[1].content[0].text,
          /Keep that feature inside the actual whether-or-if clause/
        );
        const retryPrompt = request.messages[1].content.map(item => item.text || '').join('\n');
        assert.doesNotMatch(retryPrompt, /"id": "question_local:0"/);
        return drawingResponse({
          contributionKind: 'question',
          contributionEvidenceId: 'question:0',
          drawingIntent: 'Ask whether the recurring circle represents a lamp or a destination.',
          messageAction: 'unclear',
          drawingPrompt: 'Draw one uncertain circle balanced equally between a lamp and a destination.',
          groundedFeatureEvidenceIds: ['question:0']
        });
      }
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(drawingAttempts, 2);
  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.contributionEvidenceId, 'question:0');
  assert.match(decision.drawingIntent, /lamp or a destination/);
});

test('a local question may compare its cited subject with a received drawing', () => {
  assert.equal(localQuestionPreservesCitedSubject({
    contributionKind: 'question',
    contributionEvidenceId: 'question_local:0',
    contributionSummary: 'Question I am sending about this local evidence: three repeated stone arches',
    drawingIntent: 'Ask whether Theo’s drawing shows the same repeated arches that I see here.',
    drawingPrompt: 'Draw these three arches beside a faint echo of the received forms.'
  }), true);
});

test('a local axis cannot launder a repeated literal-versus-symbolic route question', () => {
  const candidate = {
    contributionKind: 'question',
    contributionEvidenceId: 'question_local:0',
    contributionSummary:
      'Question I am sending about this local evidence: Distant city core along a central axis',
    drawingIntent:
      'Invite Ada to clarify whether the forward cue is literal movement or a symbolic axis.',
    drawingPrompt:
      'Draw a central fork with divergent paths, a distant city, and an unresolved cue.'
  };

  assert.equal(localQuestionPreservesCitedSubject(candidate), false);
  assert.equal(repeatsRecentOutboundProposition(candidate, {
    receivedSheets: [{ sequence: 43 }],
    sentMessages: [],
    failedMessages: [{
      sheetSequence: 43,
      contributionKind: 'question',
      contributionSummary:
        'Question I am sending: Is Ada signaling a literal path or a symbolic broad-axis cue without a fixed destination?',
      informationDelta:
        'Question I am sending: Is Ada signaling a literal path or a symbolic broad-axis cue without a fixed destination?',
      intent:
        'Depict a literal fork versus a symbolic broad-axis cue and ask whether the forward cue is a real route.'
    }]
  }), true);
});

test('drawing planner derives contribution kind from the selected evidence ID', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      drawing: drawingResponse({
        contributionKind: 'response',
        contributionEvidenceId: 'local:0',
        drawingIntent: 'Show the three repeated stone arches I can currently see.',
        messageAction: 'stillness',
        drawingPrompt: 'Draw three repeated stone arches as the dominant observed feature.',
        groundedFeatureEvidenceIds: ['local:0']
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.contributionKind, 'local_observation');
  assert.equal(decision.contributionEvidenceId, 'local:0');
  assert.match(decision.contributionSummary, /New local observation/);
  assert.equal(decision.informationDelta, decision.contributionSummary);
  assert.match(decision.drawingPrompt, /three repeated stone arches/);
  assert.equal(requests.filter(request =>
    /currently hold the one physical sheet/.test(request.messages[0].content)
  ).length, 1);
  assert.doesNotMatch(
    requests.find(request =>
      /currently hold the one physical sheet/.test(request.messages[0].content)
    ).messages[0].content,
    /"contributionKind"/
  );
});

test('a static local observation cannot add an uncited movement scene', async () => {
  const requests = [];
  let drawingAttempts = 0;
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      drawing(request) {
        drawingAttempts += 1;
        if (drawingAttempts === 1) {
          return drawingResponse({
            drawingIntent: 'Show a tree-lined street splitting around an obstacle.',
            messageAction: 'movement',
            drawingPrompt: 'Draw footprints tracing two routes toward a vanishing point.'
          });
        }
        assert.match(
          request.messages[1].content[0].text,
          /AUTHORITATIVE PLANNING CORRECTION.*static evidence.*Remove uncited routes/
        );
        return drawingResponse({
          drawingIntent: 'Show the repeated stone arches I can see.',
          messageAction: 'stillness',
          drawingPrompt: 'Draw three repeated stone arches beside a suspended traffic light.'
        });
      }
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(drawingAttempts, 2);
  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.contributionKind, 'local_observation');
  assert.equal(decision.messageAction, 'stillness');
  assert.doesNotMatch(decision.drawingPrompt, /footprints|route|vanishing point/i);
});

test('an acknowledgement cannot enlarge received evidence into a route proposal', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      drawing: drawingResponse({
        contributionEvidenceId: 'received:0',
        drawingIntent:
          'Acknowledge the received arches and propose moving along a shared axis toward a meeting point.',
        continuityReason: 'The shared route proposal is the reason to repeat the arches.',
        messageAction: 'movement',
        drawingPrompt:
          'Draw the received arches opening onto a forward path toward a circular meeting point.',
        groundedFeatureEvidenceIds: ['received:0']
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.contributionKind, 'acknowledgement');
  assert.equal(decision.messageAction, 'unclear');
  assert.match(decision.drawingIntent, /Acknowledge this received visual evidence/);
  assert.match(decision.drawingPrompt, /reception, reflection, or transformation/);
  assert.doesNotMatch(decision.drawingPrompt, /circular meeting point|forward path/i);
  assert.equal(acknowledgementInventsRouteProposal(decision), false);
});

test('an acknowledgement does not force a scene action over its communicative function', () => {
  assert.equal(
    reconcileRendezvousContributionAction(
      'acknowledgement',
      'Acknowledging received visual evidence without claiming it as my own: long pedestrian plaza',
      'movement',
      'Recognize the received plaza.',
      'Draw a figure moving through the plaza.'
    ),
    'unclear'
  );
});

test('a local observation records only its cited evidence as the intended message', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      drawing: drawingResponse({
        contributionEvidenceId: 'local:0',
        drawingIntent:
          'Continue toward a shared axis while using the arches to coordinate with Theo.',
        messageAction: 'stillness',
        drawingPrompt: 'Draw the three repeated stone arches as one dark landmark.'
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.contributionKind, 'local_observation');
  assert.equal(
    decision.drawingIntent,
    'Show the cited local observation as the complete message: New local observation: three repeated stone arches.'
  );
  assert.doesNotMatch(decision.drawingIntent, /shared axis|coordinate|continue/i);
  assert.match(decision.drawingPrompt, /three repeated stone arches/);
});

test('stubborn route imagery is stripped without changing the chosen local contribution', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      drawing: drawingResponse({
        contributionKind: 'local_observation',
        contributionEvidenceId: 'local:0',
        drawingIntent: 'Show the arches leading along a route.',
        messageAction: 'movement',
        drawingPrompt: 'Draw footprints following an arrow through the arches.'
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.contributionKind, 'local_observation');
  assert.equal(decision.contributionEvidenceId, 'local:0');
  assert.equal(decision.messageAction, 'unclear');
  assert.match(decision.drawingPrompt, /three repeated stone arches/);
  assert.doesNotMatch(decision.drawingPrompt, /footprints|arrow|route/i);
});

test('repeated sheet imagery cannot become new evidence or leak into local observation', async () => {
  const repeatedLiteral = 'a backpacked figure follows a diagonal arrow beside parked vans and a sidewalk bench';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        literalContents: [repeatedLiteral],
        sheetInterpretation: 'The same walking figure and arrow appear again.'
      },
      route: routeResponse({
        observation: 'I see storefronts and trees, while a bold diagonal arrow reinforces the newest sheet.',
        observedFeatures: [
          'storefronts beside mature sidewalk trees',
          'a bold diagonal arrow from the newest sheet'
        ],
        sheetReconciliation: {
          ...routeResponse().sheetReconciliation,
          informationNovelty: 'new',
          newEvidenceIds: ['visible:0'],
          repeatedEvidence: [],
          planAssessment: 'supporting'
        }
      }),
      drawing: drawingResponse({
        contributionKind: 'local_observation',
        contributionEvidenceId: 'local:0',
        groundedFeatureEvidenceIds: ['local:0']
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({
    sheetMessage: { sequence: 7, from: 'theo', to: 'ada' },
    privateMemory: {
      version: 5,
      currentPlan: 'Keep comparing grounded evidence.',
      ownObservations: [],
      receivedSheets: [{
        sequence: 5,
        from: 'theo',
        interpretation: 'A walking figure follows an arrow.',
        literalContents: [repeatedLiteral],
        informationNovelty: 'new'
      }],
      sentMessages: [],
      reconciliations: [],
      visualConventions: [],
      partnerHypotheses: []
    }
  }));

  assert.equal(decision.sheetPerception.informationNovelty, 'repeated');
  assert.deepEqual(decision.reconciliation.newEvidence, []);
  assert.deepEqual(decision.reconciliation.repeatedEvidence, [repeatedLiteral]);
  assert.equal(decision.reconciliation.planAssessment, 'inconclusive');
  assert.equal(decision.observation, 'storefronts beside mature sidewalk trees');
  assert.deepEqual(decision.observedFeatures, ['storefronts beside mature sidewalk trees']);
});

test('a local observation drawing cannot use received-sheet imagery as local context', async () => {
  const receivedLiteral = 'rectangular tiled pavement converging to a vanishing point';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        literalContents: [receivedLiteral]
      },
      drawing: drawingResponse({
        contributionKind: 'local_observation',
        contributionEvidenceId: 'local:0',
        groundedFeatureEvidenceIds: ['local:0', 'received:0']
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.deepEqual(decision.drawingGroundedFeatures, ['three repeated stone arches']);
  assert.doesNotMatch(decision.drawingPrompt, /tiled pavement|vanishing point/i);
});

test('incidental scenery cannot make a repeated movement proposition support the route', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        literalContents: [
          'a hooded runner moves away down a long sidewalk toward a distant figure',
          'parked vans and large planters line the sidewalk'
        ],
        primarySubject: 'a hooded runner moving away along a sidewalk toward a distant figure',
        communicationFunction: 'report',
        sheetInterpretation: 'The sender appears to report moving forward down a city sidewalk.'
      },
      route: routeResponse({
        reasoning: 'I choose the northern opening because its visible arches offer the strongest local landmark.',
        sheetReconciliation: {
          ...routeResponse().sheetReconciliation,
          propositionNovelty: 'new',
          informationNovelty: 'mixed',
          newEvidenceIds: ['visible:0', 'visible:1'],
          planAssessment: 'supporting'
        },
        memoryUpdate: {
          currentPlan: 'Use the visible arches as a local landmark while continuing the search.'
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({
    privateMemory: {
      ...input().privateMemory,
      receivedSheets: [{
        sequence: 5,
        from: 'theo',
        interpretation: 'The sender reports walking forward down a sidewalk.',
        primarySubject: 'a lone walking figure moving away along a sidewalk beside an arrow',
        literalContents: ['a walking figure moves away along a sidewalk beside an arrow']
      }]
    }
  }));

  assert.equal(decision.sheetPerception.propositionNovelty, 'repeated');
  assert.equal(decision.sheetPerception.informationNovelty, 'mixed');
  assert.deepEqual(decision.reconciliation.newEvidence, [
    'a hooded runner moves away down a long sidewalk toward a distant figure',
    'parked vans and large planters line the sidewalk'
  ]);
  assert.equal(decision.reconciliation.planAssessment, 'inconclusive');
});

test('a repeated sheet route cannot remain the stated cause of the recipient action', async () => {
  let routeAttempts = 0;
  const warnings = [];
  const repeatedLiteral = 'a walking figure moves away along a sidewalk beside an arrow';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        literalContents: [repeatedLiteral],
        primarySubject: repeatedLiteral,
        communicationFunction: 'report',
        sheetInterpretation: 'The sender again appears to move forward.'
      },
      route() {
        routeAttempts += 1;
        return routeResponse({
          reasoning: 'The newest sheet suggests I should continue along the implied route.',
          sheetReconciliation: {
            ...routeResponse().sheetReconciliation,
            propositionNovelty: 'new',
            informationNovelty: 'new',
            newEvidenceIds: ['visible:0'],
            planAssessment: 'supporting'
          },
          memoryUpdate: {
            currentPlan: 'Follow the indicated forward path from the newest drawing.'
          }
        });
      }
    }),
    logger: { warn(message) { warnings.push(message); } }
  });

  const decision = await service.decide(input({
    privateMemory: {
      ...input().privateMemory,
      receivedSheets: [{
        sequence: 5,
        from: 'theo',
        interpretation: 'The sender reports walking forward.',
        primarySubject: repeatedLiteral,
        literalContents: [repeatedLiteral]
      }]
    }
  }));

  assert.equal(routeAttempts, 2);
  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/);
  assert.match(decision.reasoning, /not route guidance/);
  assert.doesNotMatch(decision.reasoning, /continue along the implied route/);
  assert.equal(decision.reconciliation.planAssessment, 'inconclusive');
  assert.ok(warnings.some(message => /normalized copied non-supporting sheet route/.test(message)));
});

test('a question about a path cannot silently become route guidance', async () => {
  let routeAttempts = 0;
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        literalContents: [
          'footprints lead toward a large question-mark shape on a city sidewalk'
        ],
        primarySubject: 'footprints converging toward a prominent question-mark shape',
        communicationFunction: 'question',
        frameOfReference: 'shared',
        requestedResponse: 'Interpret whether the footprints indicate a pause or movement.',
        sheetInterpretation: 'The sender is asking what the recurring footprint path means.'
      },
      route() {
        routeAttempts += 1;
        return routeAttempts === 1
          ? routeResponse({
              reasoning: 'The latest sheet asks about the footprints, so I will preserve the forward-movement frame by following the visible path.',
              sheetReconciliation: {
                ...routeResponse().sheetReconciliation,
                propositionNovelty: 'new',
                informationNovelty: 'mixed',
                newEvidenceIds: ['visible:0'],
                planAssessment: 'supporting'
              },
              memoryUpdate: {
                currentPlan: 'Follow the footprint path while staying open to the unresolved question.'
              }
            })
          : routeResponse({
              reasoning: 'I choose the northern opening because its visible arches are my strongest local landmark.',
              sheetReconciliation: {
                ...routeResponse().sheetReconciliation,
                propositionNovelty: 'new',
                informationNovelty: 'mixed',
                newEvidenceIds: ['visible:0'],
                planAssessment: 'supporting'
              },
              memoryUpdate: {
                currentPlan: 'Use the local arches to choose my route while remembering that the footprint question remains unresolved.'
              }
            });
      },
      drawing: drawingResponse({
        contributionKind: 'response',
        contributionEvidenceId: 'response:0',
        drawingIntent: 'Answer that the footprints remain ambiguous rather than treating them as a route.',
        messageAction: 'unclear',
        drawingPrompt: 'Draw fading footprints ending beneath an unresolved question mark.',
        groundedFeatureEvidenceIds: ['response:0']
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(routeAttempts, 2);
  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /visible arches/);
  assert.doesNotMatch(decision.reasoning, /following the visible path/);
});

test('a route cannot copy the latest sheet through a local-evidence disclaimer', async () => {
  const copiedReasoning = 'The latest sheet and my local evidence both point to continuing southeast. Treating the drawing as an unresolved cue, I keep advancing along the same public street.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'report',
        frameOfReference: 'shared',
        sheetInterpretation: 'A tree-lined sidewalk recedes into the distance.'
      },
      route: routeResponse({
        reasoning: copiedReasoning,
        memoryUpdate: {
          currentPlan: copiedReasoning
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /both point to continuing/i);
});

test('plural newest-sheets language cannot align the recipient route', async () => {
  let routeAttempts = 0;
  const copiedReasoning = 'The newest sheets show an urban street corridor with a vanishing point, which aligns with continuing along a straight public street. My current local evidence also supports moving forward.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'report',
        frameOfReference: 'sender',
        sheetInterpretation: 'A generic urban corridor recedes toward a vanishing point.'
      },
      route() {
        routeAttempts += 1;
        return routeResponse({
          reasoning: copiedReasoning,
          memoryUpdate: { currentPlan: copiedReasoning }
        });
      }
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(routeAttempts, 2);
  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /newest sheets|aligns with continuing/i);
});

test('a route cannot treat an unresolved sheet cue as a prompt to keep moving', async () => {
  const copiedReasoning = 'My local options favor the northern opening with stone arches. Ada’s latest sheet remains an unresolved cue; I treat it as a prompt to keep moving along the northern public route.';
  const requests = [];
  const warnings = [];
  let routeAttempts = 0;
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'report',
        frameOfReference: 'sender',
        sheetInterpretation: 'The sender reports moving along an unknown route.'
      },
      route() {
        routeAttempts += 1;
        if (routeAttempts === 1) {
          return routeResponse({
            reasoning: copiedReasoning,
            memoryUpdate: {
              currentPlan: 'Use the locally visible stone arches and suspended traffic light to choose this route, then reassess.'
            }
          });
        }
        return routeResponse({
          reasoning: 'I choose the northern opening because its three repeated stone arches and suspended traffic light are my strongest local evidence.',
          memoryUpdate: {
            currentPlan: 'Use the locally visible stone arches and suspended traffic light to choose this route, then reassess.'
          }
        });
      }
    }),
    logger: { warn(message) { warnings.push(message); } }
  });

  const decision = await service.decide(input());

  assert.equal(routeAttempts, 2);
  assert.equal(decision.fallbackCause, null);
  assert.ok(
    warnings.some(message => /copied a non-supporting sheet route/i.test(message)),
    warnings.join('\n')
  );
  assert.match(decision.reasoning, /stone arches and suspended traffic light/i);
  assert.doesNotMatch(decision.reasoning, /prompt to keep moving/i);
});

test('a route cannot move in line with a partner prompt', async () => {
  let routeAttempts = 0;
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'question',
        frameOfReference: 'shared',
        sheetInterpretation: 'The sender asks whether a fork is meaningful.'
      },
      route() {
        routeAttempts += 1;
        return routeResponse({
          reasoning: 'In line with Ada’s open-ended prompts, I move along the northern public route while preserving options.',
          memoryUpdate: {
            currentPlan: 'Use the locally visible arches and traffic light, then reassess.'
          }
        });
      },
      drawing: drawingResponse({
        contributionKind: 'response',
        contributionEvidenceId: 'response:0',
        drawingIntent: 'Answer the open question without turning it into route guidance.',
        messageAction: 'unclear',
        drawingPrompt: 'Draw an unresolved fork beside a stationary observing figure.',
        groundedFeatureEvidenceIds: ['response:0']
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({
    sheetMessage: {
      sequence: 7,
      from: 'theo',
      to: 'ada',
      contributionKind: 'question'
    }
  }));

  assert.equal(routeAttempts, 2);
  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.doesNotMatch(decision.reasoning, /in line with|prompts/i);
  assert.equal(decision.reconciliation.planAssessment, 'inconclusive');
});

test('a route cannot align its movement with surrounding sheet sketches', async () => {
  let routeAttempts = 0;
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'report',
        frameOfReference: 'sender',
        sheetInterpretation: 'A broad, tree-lined street recedes toward a distant crossing.'
      },
      route() {
        routeAttempts += 1;
        return routeResponse({
          reasoning: 'Private evidence favors continuing north rather than retracing. Heading north aligns with advancing along a continuing corridor seen in the surrounding street-scene sketches.',
          memoryUpdate: {
            currentPlan: 'Continue north using the visible local arches, then reassess.'
          }
        });
      }
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({
    sheetMessage: {
      sequence: 7,
      from: 'theo',
      to: 'ada',
      contributionKind: 'local_observation'
    }
  }));

  assert.equal(routeAttempts, 2);
  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.doesNotMatch(decision.reasoning, /aligns with|sketches/i);
  assert.equal(decision.reconciliation.planAssessment, 'inconclusive');
});

test('a sheet-emphasized navigation axis cannot justify proceeding', async () => {
  const copiedReasoning = 'The latest local evidence favors moving along a broad public street with open navigation and forward progression toward a distant point. The newest sheet emphasizes navigation along a central axis without prescribing a rendezvous, so proceeding keeps options open and maintains momentum.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'report',
        frameOfReference: 'sender',
        sheetInterpretation: 'A centered crosswalk divides an otherwise static street.'
      },
      route: routeResponse({
        reasoning: copiedReasoning,
        memoryUpdate: {
          currentPlan: copiedReasoning
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({
    sheetMessage: {
      sequence: 7,
      from: 'theo',
      to: 'ada',
      contributionKind: 'local_observation'
    }
  }));

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.doesNotMatch(decision.reasoning, /emphasizes navigation|so proceeding/i);
  assert.equal(decision.reconciliation.planAssessment, 'inconclusive');
});

test('a sheet coordination disclaimer cannot justify movement after a semicolon', async () => {
  const copiedReasoning = 'Current local evidence supports the public corridor. The newest sheet emphasizes coordinating near the crosswalk, not a fixed route; moving northwest preserves momentum.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'shared_proposal',
        frameOfReference: 'shared',
        sheetInterpretation: 'A crosswalk may invite coordinated movement.'
      },
      route: routeResponse({
        reasoning: copiedReasoning,
        memoryUpdate: {
          currentPlan: copiedReasoning
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({
    sheetMessage: {
      sequence: 7,
      from: 'theo',
      to: 'ada',
      contributionKind: 'local_observation'
    }
  }));

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.doesNotMatch(decision.reasoning, /coordinating near|moving northwest/i);
});

test('a response cannot turn an inferred crossing meaning into route coordination', () => {
  assert.equal(responseInventsRouteCoordination({
    contributionKind: 'response',
    contributionSummary: 'My response to the received drawing: Crosswalk-focused urban movement cue; supports continuing along a public corridor rather than copying a specific drawn route.',
    drawingIntent: 'Crosswalk-focused urban movement cue'
  }), true);
  assert.equal(responseInventsRouteCoordination({
    contributionKind: 'own_action',
    contributionSummary: 'My current chosen action: I chose to continue along the public corridor.'
  }), false);
  assert.equal(responseInventsRouteCoordination({
    contributionKind: 'response',
    contributionSummary: 'My response to the received drawing: It does not support continuing along a shared route.'
  }), false);
  assert.equal(responseInventsRouteCoordination({
    contributionKind: 'deliberate_repetition',
    contributionSummary: 'Deliberately repeating existing visual evidence without treating it as new: My response to the received drawing supports continuing along a public corridor.'
  }), true);
  assert.equal(responseInventsRouteCoordination({
    contributionKind: 'response',
    contributionSummary: 'My response to the received drawing: continue along a broad urban axis aligns with ongoing forward motion.'
  }), true);
  assert.equal(responseInventsRouteCoordination({
    contributionKind: 'response',
    contributionSummary: 'My response to the received drawing: continue along a broad urban axis maintains forward progress without locking to a specific route.'
  }), true);
  assert.equal(responseInventsRouteCoordination({
    contributionKind: 'response',
    contributionSummary: 'My response to the received drawing: the broad axis remains ambiguous and does not indicate a route.'
  }), false);
});

test('a response cannot endorse an unshared route frame as plausible coordination', () => {
  assert.equal(responseInventsRouteCoordination({
    contributionKind: 'response',
    contributionSummary:
      'My response to the received drawing: Continuation along a public axis is plausible; no fixed destination yet.'
  }), true);
  assert.equal(responseInventsRouteCoordination({
    contributionKind: 'response',
    contributionSummary:
      'My response to the received drawing: I cannot tell whether the depicted axis is a physical route.'
  }), false);
});

test('a binary visual question must show both authored alternatives', () => {
  const question =
    'Question I am sending: Is the implied movement toward a specific cross-street or a continuing axis along local street?';
  assert.equal(questionAlternativesVisible(question, {
    primarySubject: 'a diagonal line rising from a flat baseline',
    likelyMessage: 'A path or ascent suggests forward movement toward an unknown destination.',
    literalContents: ['one horizontal line', 'one diagonal line'],
    movementCues: ['diagonal progression'],
    stillnessCues: []
  }), false);
  assert.equal(questionAlternativesVisible(question, {
    primarySubject: 'a cross street beside a straight avenue axis',
    likelyMessage: 'An unresolved comparison between turning onto the cross street and continuing along the avenue axis.',
    literalContents: ['one route branches across', 'one route continues straight'],
    movementCues: [],
    stillnessCues: []
  }), true);
});

test('a binary question plan cannot replace its alternatives with generic progression', async () => {
  let drawingAttempts = 0;
  const perception = perceptionResponse();
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perception,
        evidenceDelta: {
          ...perception.evidenceDelta,
          unresolvedQuestions: [
            'Whether the implied endpoint is a cross-street or a continuing axis'
          ]
        }
      },
      drawing() {
        drawingAttempts += 1;
        return drawingResponse({
          contributionKind: 'question',
          contributionEvidenceId: 'question:0',
          drawingIntent: 'Depict ongoing movement through a generic corridor.',
          messageAction: 'movement',
          drawingPrompt: 'Draw one line progressing through a corridor.',
          groundedFeatureEvidenceIds: ['question:0']
        });
      }
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(drawingAttempts, 2);
  assert.equal(decision.fallbackCause, 'drawing_plan_error');
});

test('a local observation cannot become route guidance through an inferred proposal', async () => {
  let routeAttempts = 0;
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'shared_proposal',
        frameOfReference: 'shared',
        sheetInterpretation: 'A calm avenue recedes forward and feels like an invitation to proceed.'
      },
      route() {
        routeAttempts += 1;
        return routeResponse({
          reasoning: 'The newest sheet invites forward movement, so I will continue along the implied avenue.',
          memoryUpdate: {
            currentPlan: 'Follow the forward corridor proposed by the newest sheet.'
          }
        });
      }
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({
    sheetMessage: {
      sequence: 7,
      from: 'theo',
      to: 'ada',
      contributionKind: 'local_observation'
    }
  }));

  assert.equal(routeAttempts, 2);
  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /invites forward movement/i);
  assert.equal(decision.reconciliation.planAssessment, 'inconclusive');
});

test('an inferred shared proposal cannot direct movement when authored intent is unavailable', async () => {
  let routeAttempts = 0;
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'shared_proposal',
        frameOfReference: 'shared',
        sheetInterpretation: 'A crosswalk recedes toward a distant point as if offering a route.'
      },
      route() {
        routeAttempts += 1;
        return routeResponse({
          reasoning: 'Ada’s latest crosswalk drawing suggests continuing along a receding path toward a distant point. I proceed along the crosswalk-like route because it aligns with that new evidence.',
          memoryUpdate: {
            currentPlan: 'Follow the crosswalk route inferred from Ada’s latest drawing.'
          }
        });
      }
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({
    sheetMessage: {
      sequence: 7,
      from: 'theo',
      to: 'ada'
    }
  }));

  assert.equal(routeAttempts, 2);
  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /crosswalk drawing suggests|aligns with that new evidence/i);
  assert.equal(decision.reconciliation.planAssessment, 'inconclusive');
});

test('a new-sheet hint cannot causally justify continuing a route', async () => {
  const copiedReasoning = 'New sheet hints at a continuing forward progression along a tree-lined urban corridor. The visible local route options favor the eastward street, so I choose the direct continuation.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'report',
        frameOfReference: 'sender',
        sheetInterpretation: 'The sender reports moving through a tree-lined corridor.'
      },
      route: routeResponse({
        reasoning: copiedReasoning,
        memoryUpdate: {
          currentPlan: copiedReasoning
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /sheet hints/i);
});

test('a sheet report cannot softly align the recipient with a generic route', async () => {
  const copiedReasoning = 'Current local plan prioritizes continuing along a known public corridor to preserve momentum. The newest sheet emphasizes a solitary tree motif, which aligns with a broad, tree-lined urban stretch rather than a fixed endpoint. Moving keeps us oriented in a shared, generic forward path.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'report',
        frameOfReference: 'sender',
        sheetInterpretation: 'The sender reports a solitary tree beside a broad avenue.'
      },
      route: routeResponse({
        reasoning: copiedReasoning,
        memoryUpdate: {
          currentPlan: copiedReasoning
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /aligns with/i);
});

test('a latest partner scene cannot reinforce continuing along an axis', async () => {
  const copiedReasoning = 'Ada’s latest crosswalk-focused urban scene reinforces continuing along a broad urban axis rather than locking to a specific street. The safest move is to push northeast along the visible public corridor, using crosswalks and storefronts as landmarks for coordination, while treating the drawing as a report rather than a fixed destination.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'report',
        frameOfReference: 'shared',
        sheetInterpretation: 'A busy crosswalk scene with taxis and pedestrians.'
      },
      route: routeResponse({
        reasoning: copiedReasoning,
        memoryUpdate: {
          currentPlan: copiedReasoning
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /scene reinforces|landmarks for coordination/i);
});

test('a latest partner sketch cannot emphasize a shared movement axis', async () => {
  const copiedReasoning = 'Ada’s latest sketch emphasizes movement along a broad urban axis and I am already proceeding northeast along that shared, unobstructed axis. The new image suggests evaluating spatial relationships in a public plaza, but does not fix a destination; continuing along the northeast axis keeps us coordinated via common landmarks without locking to a specific Ada route.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'report',
        frameOfReference: 'sender',
        sheetInterpretation: 'A plaza with curved seating and modern buildings.'
      },
      route: routeResponse({
        reasoning: copiedReasoning,
        memoryUpdate: {
          currentPlan: copiedReasoning
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /sketch emphasizes|shared, unobstructed axis/i);
});

test('latest partner drawings cannot push the recipient toward an axis', async () => {
  const copiedReasoning = 'Ada’s latest drawings push toward a broad urban axis; my private plan is to continue along the northeast-forward city axis using crosswalks and storefronts as landmarks. The current environment matches a dense urban corridor heading toward a distant core, so advancing along the northeast route maintains momentum without committing to a fixed Ada-directed destination.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'report',
        frameOfReference: 'shared',
        sheetInterpretation: 'A generic dense urban core with taxis and a foreground crosswalk.'
      },
      route: routeResponse({
        reasoning: copiedReasoning,
        memoryUpdate: {
          currentPlan: copiedReasoning
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /drawings push|landmarks for coordination/i);
});

test('a described latest drawing cannot imply forward motion', async () => {
  const copiedReasoning = 'Ada’s latest urban-axis drawings imply forward motion along a broad northeast city axis. My private notes describe a dense urban corridor with crosswalks and storefront landmarks, so continuing northeast aligns with the observed environment and preserves forward momentum without locking to a specific Ada route. Route-option 0 visually matches a northeast progression through a dense street canyon with taxis and a crosswalk ahead, consistent with my local surroundings.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'report',
        frameOfReference: 'shared',
        sheetInterpretation: 'A generic dense urban core with taxis and a foreground crosswalk.'
      },
      route: routeResponse({
        reasoning: copiedReasoning,
        memoryUpdate: {
          currentPlan: copiedReasoning
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /drawings imply|Ada route/i);
});

test('a matching corridor cannot turn a sheet report into the partner route', async () => {
  const copiedReasoning = 'The newest sheet emphasizes a left-side line of vans and a brick wall on the right with a strong diagonal perspective toward an alley. My immediate surroundings match a narrow urban street with parked vans on the left and a brick facade on the right, suggesting a potential corridor toward a vanishing point. Moving along heading 123 southeast follows the visible street alignment and keeps me in a corridor that could lead toward my partner’s likely route or stopping points, without retracing into known dead ends.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'report',
        frameOfReference: 'recipient',
        sheetInterpretation: 'A row of vans beside a brick wall recedes into an alley.'
      },
      route: routeResponse({
        reasoning: copiedReasoning,
        memoryUpdate: {
          currentPlan: copiedReasoning
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /could lead toward my partner/i);
});

test('a depicted sheet axis cannot align with movement in the next clause', async () => {
  const copiedReasoning = 'The newest sheet depicts a crowded city crosswalk and a broad public axis; moving east along the main street aligns with continuing along the visible public corridor without copying a drawn route as a fixed destination. The local surroundings show a busy crosswalk and urban street activity, supporting progression along the established axis toward a distant focal point rather than detouring into a drawn path.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'unclear',
        frameOfReference: 'shared',
        sheetInterpretation: 'A generic crowded crossing with a central vanishing point.'
      },
      route: routeResponse({
        reasoning: copiedReasoning,
        memoryUpdate: {
          currentPlan: copiedReasoning
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /sheet depicts|aligns with continuing/i);
});

test('newest evidence and an ambiguous motif cannot jointly justify movement', async () => {
  const copiedReasoning = 'Following the newest evidence, I continue along the public corridor toward the vanishing point while keeping the fork coordinated. This aligns with the still-ambiguous fork motif, which may mark a generic continuation. Moving preserves forward movement without fixing a meeting point.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'report',
        frameOfReference: 'sender',
        sheetInterpretation: 'The sender reports a tree-lined sidewalk.'
      },
      route: routeResponse({
        reasoning: copiedReasoning,
        memoryUpdate: {
          currentPlan: copiedReasoning
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /following the newest evidence|aligns with/i);
});

test('newest evidence cannot softly point to following a depicted urban axis', async () => {
  const copiedReasoning = 'The newest evidence points to following a broad, straight urban axis rather than copying a specific drawn route. My recent heading history aligns with northwest movement toward a distant vanishing point.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'report',
        frameOfReference: 'shared',
        sheetInterpretation: 'A broad street recedes toward a distant vanishing point.'
      },
      route: routeResponse({
        reasoning: copiedReasoning,
        memoryUpdate: {
          currentPlan: copiedReasoning
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /newest evidence points|vanishing point/i);
});

test('newest private evidence cannot quietly direct movement along an axis', async () => {
  const copiedReasoning = 'Ada has been following the unseen public continuation and should avoid copying a drawn route as destination. The newest private evidence points to continuing along a broad urban axis that remains unexplored, and option 1 offers a fresh, plausible northeast progression consistent with a wide city street canyon and ongoing pedestrian/vehicular activity.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'report',
        frameOfReference: 'sender',
        sheetInterpretation: 'A broad street canyon with traffic and pedestrians.'
      },
      route: routeResponse({
        reasoning: copiedReasoning,
        memoryUpdate: {
          currentPlan: copiedReasoning
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /newest private evidence|unseen public continuation/i);
});

test('a newest private reading cannot carry a route across sentences', async () => {
  const copiedReasoning = 'The newest private reading portrays a broad, orderly urban axis with a distant core. My current physical path is already veering northeast through a dense street canyon; continuing along the broad axis (Option 0) keeps forward momentum without locking Ada to a single fixed route, and aligns with the observed canyon-like streets in my environment.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'report',
        frameOfReference: 'sender',
        sheetInterpretation: 'A broad street recedes toward a distant core.'
      },
      route: routeResponse({
        reasoning: copiedReasoning,
        memoryUpdate: {
          currentPlan: copiedReasoning
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /newest private reading|broad axis/i);
});

test('latest sheets cannot carry a shared axis across two sentences', async () => {
  const copiedReasoning = 'Ada’s latest sheets express a shared forward axis toward a distant city core, but without locking to a fixed endpoint. My current local evidence shows a broad northeast urban axis with crosswalks and storefront landmarks. Proceeding along this axis keeps forward motion, uses visible coordination cues, and avoids committing to a specific destination.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'report',
        frameOfReference: 'shared',
        sheetInterpretation: 'A broad street recedes toward a distant core.'
      },
      route: routeResponse({
        reasoning: copiedReasoning,
        memoryUpdate: {
          currentPlan: copiedReasoning
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /latest sheets|shared forward axis/i);
});

test('a route cannot align a chosen axis with newest evidence in reverse word order', async () => {
  const copiedReasoning = 'Theo’s latest sheet proposes moving along a public axis toward a distant goal, not copying a literal drawn path. My on-ground evidence shows a straight, busy urban corridor with crosswalks and a clear forward axis. Following the public axis with a northeast heading aligns with the newest evidence and keeps us moving toward potential shared space without duplicating Theo’s drawn route.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'report',
        frameOfReference: 'sender',
        sheetInterpretation: 'The sender reports their own movement along a public street.'
      },
      route: routeResponse({
        reasoning: copiedReasoning,
        memoryUpdate: {
          currentPlan: copiedReasoning
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /proposes moving|aligns with the newest evidence/i);
});

test('a route disclaimer cannot hide later movement along an indicated route', async () => {
  let routeAttempts = 0;
  const copiedReasoning = 'Ada’s latest sheet presents a crossroads but does not fix a destination; locally I can proceed along the unexplored public continuation toward the northeast. I treat the newest drawing as a report of a choice point, not a command to reproduce a specific path, so continuing along the indicated public route increases chances of meeting Ada while keeping options open.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      route() {
        routeAttempts += 1;
        return routeResponse({
          reasoning: copiedReasoning,
          memoryUpdate: {
            currentPlan: copiedReasoning
          }
        });
      }
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(routeAttempts, 2);
  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.doesNotMatch(decision.reasoning, /indicated public route/i);
});

test('a sheet cannot frame forward motion as the locally justified path', async () => {
  const copiedReasoning = 'The newest sheet presents a calm, tree-lined street with a clear central corridor and a distant vanishing point, suggesting forward motion along the public avenue as the most locally justified path. Previous local notes indicate an unexplored continuation, and the current surroundings visually align with moving northeast.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'report',
        frameOfReference: 'sender',
        sheetInterpretation: 'The sender reports a calm tree-lined sidewalk.'
      },
      route: routeResponse({
        reasoning: copiedReasoning,
        memoryUpdate: {
          currentPlan: copiedReasoning
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /suggesting forward motion/i);
});

test('plural sheet cues cannot suggest pressing ahead', async () => {
  const copiedReasoning = 'The forward, central-axis cues in Ada’s drawings suggest we should press ahead rather than circle back. I treat Ada’s arrows as symbolic guidance at a crossroads rather than a literal route I must duplicate.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'request',
        frameOfReference: 'shared',
        sheetInterpretation: 'Ada asks for a direction at a crossroads.'
      },
      route: routeResponse({
        reasoning: copiedReasoning,
        memoryUpdate: {
          currentPlan: copiedReasoning
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /suggest we should press ahead/i);
});

test('a sheet cannot become a shared push to proceed', async () => {
  const copiedReasoning = 'Ada’s latest street-forward cues depict moving along a broad urban axis and a shared push to proceed. Choosing the northeastern public continuation keeps us advancing along the street environment without locking to a fixed Ada route, balancing forward progress with open interpretation of Ada’s signals.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'report',
        frameOfReference: 'sender',
        sheetInterpretation: 'Ada reports a broad urban street.'
      },
      route: routeResponse({
        reasoning: copiedReasoning,
        memoryUpdate: {
          currentPlan: copiedReasoning
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /shared push to proceed/i);
});

test('a remembered motif cannot be attributed to a sheet that does not contain it', async () => {
  let routeAttempts = 0;
  const staleAttribution = 'New sheet evidence treats the fork as a coordination prompt, not a rendezvous. I choose the only unexplored local continuation.';
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        literalContents: ['a tree-lined street with parked cars and storefronts'],
        primarySubject: 'a quiet tree-lined street',
        communicationFunction: 'report',
        frameOfReference: 'sender',
        sheetInterpretation: 'The sender reports a quiet tree-lined street.'
      },
      route() {
        routeAttempts += 1;
        return routeResponse({
          reasoning: staleAttribution,
          memoryUpdate: {
            currentPlan: staleAttribution
          }
        });
      }
    }),
    logger: { warn() {} }
  });
  const privateMemory = {
    ...input().privateMemory,
    partnerHypotheses: [{
      key: 'fork-coordination',
      description: 'The fork may be a coordination prompt.',
      confidence: 0.2,
      basisSequences: [32, 40],
      evidenceStatus: 'unclear'
    }]
  };

  const decision = await service.decide(input({ privateMemory }));

  assert.equal(routeAttempts, 2);
  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /new sheet evidence treats the fork/i);
});

test('a sender report can still support an explicit interception inference', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'report',
        frameOfReference: 'sender',
        sheetInterpretation: 'Theo appears to report moving north past an arcade.'
      },
      route: routeResponse({
        reasoning: 'Theo appears to be moving north, so I choose the western opening to intercept his likely path rather than follow his route.',
        memoryUpdate: {
          currentPlan: 'Use my local western opening to cross Theo’s reported trajectory.'
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.reasoning, /intercept/);
});

test('an unrenderable action can be replanned into a grounded contribution', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      replan: {
        contributionEvidenceId: 'local:0',
        drawingIntent: 'Show the stone arcade beside me instead of another route cue.',
        messageAction: 'stillness',
        drawingPrompt: 'Draw one quiet stone arcade with three repeated arches and no route markings.',
        groundedFeatureEvidenceIds: ['local:0', 'local:1']
      }
    }),
    logger: { warn() {} }
  });

  const replan = await service.replanUnrenderableDrawing({
    agentName: 'Theo',
    partnerName: 'Ada',
    pending: {
      contributionKind: 'own_action',
      contributionSummary: 'My current chosen action: move northeast.',
      drawingIntent: 'Show my northeast movement.',
      groundedFeatures: [
        'I chose to move northeast along the selected public route.',
        'three repeated stone arches',
        'a suspended traffic light'
      ]
    },
    privateMemory: {
      reconciliations: [{
        unresolvedQuestions: ['whether the circle represents a lamp or destination']
      }]
    }
  });

  assert.equal(replan.contributionKind, 'local_observation');
  assert.equal(replan.contributionEvidenceId, 'local:0');
  assert.equal(replan.contributionSummary, 'New local observation: three repeated stone arches');
  assert.deepEqual(replan.groundedFeatures, [
    'three repeated stone arches',
    'a suspended traffic light'
  ]);
  assert.match(replan.drawingPrompt, /stone arcade/);
  assert.equal(requests.length, 1);
});

test('an acknowledgement replan does not relabel received imagery as a local observation', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      replan: {
        contributionEvidenceId: 'question:0',
        drawingIntent: 'Ask whether the repeated arch is still useful.',
        messageAction: 'unclear',
        drawingPrompt: 'Draw one solid arch beside a faint uncertain echo, with no words.',
        groundedFeatureEvidenceIds: ['question:0']
      }
    }),
    logger: { warn() {} }
  });

  const replan = await service.replanUnrenderableDrawing({
    agentName: 'Ada',
    partnerName: 'Theo',
    pending: {
      contributionKind: 'acknowledgement',
      contributionSummary: 'Acknowledging Theo’s long sidewalk and footprints.',
      drawingIntent: 'Acknowledge Theo’s path.',
      groundedFeatures: ['a long sidewalk, footprints, and a large tree']
    },
    privateMemory: {
      ownObservations: [{
        description: 'three dark arches beside a public plaza',
        sourcePanoId: 'ada-current'
      }],
      reconciliations: [{
        unresolvedQuestions: ['whether the repeated arch is still useful']
      }]
    }
  });

  assert.equal(replan.contributionKind, 'question');
  assert.equal(replan.contributionEvidenceId, 'question:0');
  const requestText = requests[0].messages.at(-1).content;
  assert.match(requestText, /three dark arches beside a public plaza/);
  assert.doesNotMatch(requestText, /long sidewalk, footprints, and a large tree/);
});

test('a failed response cannot be replanned into an unrelated local postcard', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      replan: {
        contributionEvidenceId: 'response:1',
        drawingIntent: 'Answer that movement is continuing while the depicted place remains uncertain.',
        messageAction: 'movement',
        drawingPrompt: 'Draw completed motion through a crossing beside an unresolved place symbol.',
        groundedFeatureEvidenceIds: ['response:1']
      }
    }),
    logger: { warn() {} }
  });

  const replan = await service.replanUnrenderableDrawing({
    agentName: 'Ada',
    partnerName: 'Theo',
    pending: {
      contributionKind: 'response',
      contributionSummary: 'My response to the received drawing: the crossing remains ambiguous',
      informationDelta: 'My response to the received drawing: the crossing remains ambiguous'
    },
    privateMemory: {
      ownObservations: [{ description: 'three stone arches beside the road' }],
      reconciliations: [{
        informationWorthSending: [
          'the crossing remains ambiguous',
          'movement is continuing while the depicted place remains uncertain'
        ],
        unresolvedQuestions: ['whether the place symbol refers to a real landmark'],
        contradictions: []
      }],
      sentMessages: [],
      receivedSheets: []
    }
  });

  assert.equal(replan.contributionKind, 'response');
  assert.equal(replan.contributionEvidenceId, 'response:1');
  assert.doesNotMatch(requests[0].messages.at(-1).content, /three stone arches/);
});

test('a drawing replan offers composite streetscapes as separate visual facts', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      replan: {
        contributionEvidenceId: 'local:1',
        drawingIntent: 'Show the row of parked vans.',
        messageAction: 'stillness',
        drawingPrompt: 'Draw one row of parked vans as the sole dominant subject.',
        groundedFeatureEvidenceIds: ['local:1']
      }
    }),
    logger: { warn() {} }
  });

  const replan = await service.replanUnrenderableDrawing({
    agentName: 'Ada',
    partnerName: 'Theo',
    pending: {
      contributionKind: 'acknowledgement',
      groundedFeatures: ['Theo’s received footprints']
    },
    privateMemory: {
      ownObservations: [{
        description: 'tree-lined sidewalk; row of parked vans; crosswalk markings ahead',
        sourcePanoId: 'ada-current'
      }]
    }
  });

  assert.equal(replan.contributionSummary, 'New local observation: row of parked vans');
  const requestText = requests[0].messages.at(-1).content;
  assert.match(requestText, /"description": "tree-lined sidewalk"/);
  assert.match(requestText, /"description": "row of parked vans"/);
  assert.doesNotMatch(requestText, /tree-lined sidewalk; row of parked vans/);
});

test('a drawing replan atomizes long streetscapes and drops generic fragments', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      replan: {
        contributionEvidenceId: 'local:0',
        drawingIntent: 'Show the tree-lined sidewalk as a local visual fact.',
        messageAction: 'stillness',
        drawingPrompt: 'Draw the tree canopy lining one sidewalk as the sole dominant subject.',
        groundedFeatureEvidenceIds: ['local:0']
      }
    }),
    logger: { warn() {} }
  });

  const replan = await service.replanUnrenderableDrawing({
    agentName: 'Ada',
    partnerName: 'Theo',
    pending: { contributionKind: 'acknowledgement' },
    privateMemory: {
      ownObservations: [{
        description: 'Standing at a tree-lined urban sidewalk with parked vehicles along the left and storefronts to the right',
        sourcePanoId: 'ada-current'
      }]
    }
  });

  assert.equal(
    replan.contributionSummary,
    'New local observation: Standing at a tree-lined urban sidewalk'
  );
  const requestText = requests[0].messages.at(-1).content;
  assert.match(requestText, /"description": "Standing at a tree-lined urban sidewalk"/);
  assert.doesNotMatch(requestText, /"description": "parked vehicles along the left"/);
  assert.doesNotMatch(requestText, /"description": "storefronts to the right"/);
});

test('a drawing replan separates sentence-level observations into drawable facts', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      replan: {
        contributionEvidenceId: 'local:1',
        drawingIntent: 'Show the pedestrians gathered along the sidewalk.',
        messageAction: 'stillness',
        drawingPrompt: 'Draw a small group of pedestrians along one sidewalk.',
        groundedFeatureEvidenceIds: ['local:1']
      }
    }),
    logger: { warn() {} }
  });

  const replan = await service.replanUnrenderableDrawing({
    agentName: 'Theo',
    partnerName: 'Ada',
    pending: {
      contributionKind: 'local_observation',
      contributionSummary: 'New local observation: crosswalk markings ahead'
    },
    privateMemory: {
      ownObservations: [{
        description: 'A distant vanishing point. Pedestrians gather along one sidewalk',
        sourcePanoId: 'theo-current'
      }]
    }
  });

  assert.equal(replan.contributionEvidenceId, 'local:1');
  assert.equal(
    replan.contributionSummary,
    'New local observation: Pedestrians gather along one sidewalk'
  );
  const requestText = requests[0].messages.at(-1).content;
  assert.match(requestText, /"description": "A distant vanishing point."/);
  assert.match(requestText, /"description": "Pedestrians gather along one sidewalk"/);
  assert.doesNotMatch(requestText, /vanishing point\. Pedestrians/);
});

test('a drawing replan removes uncited perspective that competes with a landmark', async () => {
  let attempts = 0;
  const service = new RendezvousModelService({
    client: stagedClient([], {
      replan(request) {
        attempts += 1;
        if (attempts === 1) {
          return {
            contributionEvidenceId: 'local:0',
            drawingIntent: 'Show striped storefront awnings on both sides around a deep central perspective.',
            messageAction: 'unclear',
            drawingPrompt: 'Draw two rows of striped awnings receding toward a distant vanishing point.',
            groundedFeatureEvidenceIds: ['local:0']
          };
        }
        assert.match(
          request.messages[1].content,
          /AUTHORITATIVE REPLAN CORRECTION.*different cited fact and visual proposition/s
        );
        return {
          contributionEvidenceId: 'local:0',
            drawingIntent: 'Show the facing striped awnings as the entire local fact.',
            messageAction: 'stillness',
            drawingPrompt: 'Draw two large rows of striped awnings filling the page edges.',
          groundedFeatureEvidenceIds: ['local:0']
        };
      }
    }),
    logger: { warn() {} }
  });

  const replan = await service.replanUnrenderableDrawing({
    agentName: 'Theo',
    partnerName: 'Ada',
    pending: {
      contributionKind: 'local_observation',
      contributionSummary: 'New local observation: crosswalk markings ahead'
    },
    privateMemory: {
      ownObservations: [{
        description: 'striped storefront awnings on both sides',
        sourcePanoId: 'theo-current'
      }]
    }
  });

  assert.equal(attempts, 2);
  assert.equal(
    replan.contributionSummary,
    'New local observation: striped storefront awnings on both sides'
  );
  assert.doesNotMatch(
    `${replan.drawingIntent} ${replan.drawingPrompt}`,
    /perspective|receding|vanishing/i
  );
});

test('a drawing replan cannot reintroduce an exhausted outbound proposition', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      replan: {
        contributionEvidenceId: 'local:1',
        drawingIntent: 'Show the row of parked vans as the new local fact.',
        messageAction: 'stillness',
        drawingPrompt: 'Draw one quiet row of parked vans.',
        groundedFeatureEvidenceIds: ['local:1']
      }
    }),
    logger: { warn() {} }
  });
  const repeatedObservation = {
    contributionKind: 'local_observation',
    contributionSummary: 'New local observation: tree-lined urban street',
    informationDelta: 'New local observation: tree-lined urban street',
    intent: 'Show the tree-lined urban street.'
  };

  const replan = await service.replanUnrenderableDrawing({
    agentName: 'Ada',
    partnerName: 'Theo',
    pending: {
      contributionKind: 'local_observation',
      contributionSummary: 'New local observation: crosswalk markings ahead',
      groundedFeatures: ['crosswalk markings ahead']
    },
    privateMemory: {
      ownObservations: [{
        description: 'tree-lined urban street; row of parked vans',
        sourcePanoId: 'ada-current'
      }],
      sentMessages: [
        { sequence: 5, ...repeatedObservation },
        { sequence: 7, ...repeatedObservation }
      ]
    }
  });

  assert.equal(replan.contributionEvidenceId, 'local:1');
  assert.equal(replan.contributionSummary, 'New local observation: row of parked vans');
  const requestText = requests[0].messages.at(-1).content;
  assert.doesNotMatch(requestText, /tree-lined urban street/);
  assert.match(requestText, /row of parked vans/);
});

test('a drawing replan retries a placeholder intent and contradictory action', async () => {
  let attempts = 0;
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      replan() {
        attempts += 1;
        return attempts === 1
          ? {
              contributionEvidenceId: 'local:0',
              drawingIntent: 'stillness',
              messageAction: 'movement',
              drawingPrompt: 'Draw a quiet tree standing motionless.',
              groundedFeatureEvidenceIds: ['local:0']
            }
          : {
              contributionEvidenceId: 'local:0',
              drawingIntent: 'Show the dense tree canopy I can see here.',
              messageAction: 'stillness',
              drawingPrompt: 'Draw one dense, motionless tree canopy as the sole subject.',
              groundedFeatureEvidenceIds: ['local:0']
            };
      }
    }),
    logger: { warn() {} }
  });

  const replan = await service.replanUnrenderableDrawing({
    agentName: 'Ada',
    partnerName: 'Theo',
    pending: {
      contributionKind: 'local_observation',
      groundedFeatures: ['dense tree canopy']
    }
  });

  assert.equal(attempts, 2);
  assert.match(requests[1].messages.at(-1).content, /AUTHORITATIVE REPLAN CORRECTION/);
  assert.match(replan.drawingIntent, /dense tree canopy/);
  assert.equal(replan.messageAction, 'stillness');
});

test('a later drawing replan excludes the proposition that already failed', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      replan: {
        contributionEvidenceId: 'local:0',
        drawingIntent: 'Show the elevated footbridge as a new local fact.',
        messageAction: 'stillness',
        drawingPrompt: 'Draw one elevated footbridge as the sole dominant subject.',
        groundedFeatureEvidenceIds: ['local:0']
      }
    }),
    logger: { warn() {} }
  });

  const replan = await service.replanUnrenderableDrawing({
    agentName: 'Ada',
    partnerName: 'Theo',
    pending: {
      contributionKind: 'local_observation',
      contributionSummary: 'New local observation: broad urban street with multiple lanes',
      groundedFeatures: ['broad urban street with multiple lanes']
    },
    privateMemory: {
      ownObservations: [
        { description: 'broad urban street with multiple lanes', sourcePanoId: 'old' },
        { description: 'elevated pedestrian footbridge', sourcePanoId: 'current' }
      ]
    }
  });

  assert.equal(replan.contributionSummary, 'New local observation: elevated pedestrian footbridge');
  const requestText = requests[0].messages.at(-1).content;
  assert.doesNotMatch(requestText, /"description": "broad urban street with multiple lanes"/);
  assert.match(requestText, /"description": "elevated pedestrian footbridge"/);
});

test('own-action evidence uses the executed option bearing without leaking its route label', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      drawing: drawingResponse({
        contributionKind: 'own_action',
        contributionEvidenceId: 'action:0',
        drawingIntent: 'Show my chosen movement as the primary message.',
        drawingPrompt: 'Draw one figure moving north from a fixed tree.',
        groundedFeatureEvidenceIds: ['action:0']
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());
  const drawingRequest = requests.find(request =>
    /currently hold the one physical sheet/.test(request.messages[0].content)
  );
  const catalogText = drawingRequest.messages[1].content[0].text
    .split('Available outbound evidence catalog:\n')[1];

  assert.equal(decision.contributionKind, 'own_action');
  assert.equal(
    decision.contributionSummary,
    'My current chosen action: I chose to move north along the selected public route.'
  );
  assert.match(catalogText, /move north/);
  assert.doesNotMatch(catalogText, /north route/);
});

test('own-action drawing cannot reverse the cited compass direction', async () => {
  let drawingAttempts = 0;
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      route: routeResponse({
        selectedIndex: 0,
        intendedHeading: 225
      }),
      drawing(request) {
        drawingAttempts += 1;
        if (drawingAttempts === 1) {
          return drawingResponse({
            contributionKind: 'own_action',
            contributionEvidenceId: 'action:0',
            drawingIntent: 'Report my movement southeast along the public route.',
            messageAction: 'movement',
            drawingPrompt: 'Draw me moving southeast toward the lower-right.',
            groundedFeatureEvidenceIds: ['action:0']
          });
        }
        assert.match(
          request.messages[1].content[0].text,
          /AUTHORITATIVE PLANNING CORRECTION.*cited own action authoritative/s
        );
        return drawingResponse({
          contributionKind: 'own_action',
          contributionEvidenceId: 'action:0',
          drawingIntent: 'Report my southwest movement as my own completed action.',
          messageAction: 'movement',
          drawingPrompt: 'Draw me moving southwest with a completed trail behind me.',
          groundedFeatureEvidenceIds: ['action:0']
        });
      }
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({
    options: [
      { panoId: 'southwest', heading: 225, label: 'local street' },
      { panoId: 'north', heading: 0, label: 'other street' }
    ]
  }));

  assert.equal(drawingAttempts, 2);
  assert.equal(decision.fallbackCause, null);
  assert.match(decision.contributionSummary, /move southwest/);
  assert.match(decision.drawingIntent, /southwest/);
  assert.doesNotMatch(decision.drawingIntent, /southeast/);
});

test('a recent movement proposition is offered only as deliberate repetition', async () => {
  let drawingAttempts = 0;
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      drawing(request) {
        drawingAttempts += 1;
        const prompt = request.messages[1].content.map(item => item.text || '').join('\n');
        assert.doesNotMatch(prompt, /"id": "action:0"/);
        assert.match(prompt, /"id": "prior_sent:0"/);
        return drawingResponse({
          contributionKind: 'question',
          contributionEvidenceId: 'question:0',
          drawingIntent: 'Ask whether the recurring circle represents a lamp or a destination.',
          messageAction: 'unclear',
          drawingPrompt: 'Draw a large uncertain circle suspended between a lamp and a destination symbol.',
          groundedFeatureEvidenceIds: ['question:0']
        });
      }
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({
    privateMemory: {
      ...input().privateMemory,
      sentMessages: [{
        sequence: 5,
        contributionKind: 'own_action',
        contributionSummary: 'My current chosen action: I chose to move northeast along the selected public route.',
        intent: 'Show a person walking away along a tree-lined public route with footprints behind.'
      }]
    }
  }));

  assert.equal(drawingAttempts, 1);
  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.contributionKind, 'question');
  assert.equal(decision.contributionEvidenceId, 'question:0');
  assert.match(decision.drawingPrompt, /uncertain circle/);
});

test('one repeated local observation remains available as fresh corroboration', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      route: routeResponse({
        observation: 'A tree-lined urban street.',
        observedFeatures: ['tree-lined urban street']
      }),
      drawing: drawingResponse({
        contributionKind: 'local_observation',
        contributionEvidenceId: 'local:0',
        drawingIntent: 'Show the same tree canopy appearing again at this new choice.',
        messageAction: 'stillness',
        drawingPrompt: 'Draw one dense tree canopy above the locally observed sidewalk.',
        groundedFeatureEvidenceIds: ['local:0']
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({
    privateMemory: {
      ...input().privateMemory,
      sentMessages: [{
        sequence: 5,
        contributionKind: 'local_observation',
        contributionSummary: 'New local observation: tree-lined urban street',
        informationDelta: 'New local observation: tree-lined urban street',
        intent: 'Show the tree-lined urban street.'
      }]
    }
  }));

  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.contributionKind, 'local_observation');
  assert.match(decision.drawingPrompt, /tree canopy/);
});

test('a third copy of the same local observation must adapt or repeat deliberately', async () => {
  let drawingAttempts = 0;
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      route: routeResponse({
        observation: 'A tree-lined urban street.',
        observedFeatures: ['tree-lined urban street']
      }),
      drawing(request) {
        drawingAttempts += 1;
        const prompt = request.messages[1].content.map(item => item.text || '').join('\n');
        assert.doesNotMatch(prompt, /"id": "local:0"/);
        assert.match(prompt, /"id": "prior_sent:/);
        return drawingResponse({
          contributionKind: 'question',
          contributionEvidenceId: 'question:0',
          drawingIntent: 'Ask whether the recurring circle represents a lamp or a destination.',
          messageAction: 'unclear',
          drawingPrompt: 'Draw one uncertain circle balanced between a lamp and a destination symbol.',
          groundedFeatureEvidenceIds: ['question:0']
        });
      }
    }),
    logger: { warn() {} }
  });
  const repeatedObservation = {
    contributionKind: 'local_observation',
    contributionSummary: 'New local observation: tree-lined urban street',
    informationDelta: 'New local observation: tree-lined urban street',
    intent: 'Show the tree-lined urban street.'
  };

  const decision = await service.decide(input({
    privateMemory: {
      ...input().privateMemory,
      sentMessages: [
        { sequence: 5, ...repeatedObservation },
        { sequence: 7, ...repeatedObservation }
      ]
    }
  }));

  assert.equal(drawingAttempts, 1);
  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.contributionKind, 'question');
  assert.match(decision.drawingPrompt, /uncertain/);
});

test('renderer scaffolding cannot make a statue repeat an unrelated taxi report', () => {
  const candidate = {
    contributionKind: 'local_observation',
    contributionSummary:
      'New local observation: statue on a pedestal at a plaza-leaning corner',
    informationDelta:
      'New local observation: statue on a pedestal at a plaza-leaning corner',
    drawingIntent:
      'Show the cited local observation as the complete message: New local observation: statue on a pedestal at a plaza-leaning corner.',
    drawingPrompt:
      'Create one coherent handmade, wordless drawing that makes this contribution unmistakably primary: New local observation: statue on a pedestal at a plaza-leaning corner.'
  };
  const memory = {
    sentMessages: [{
      contributionKind: 'local_observation',
      contributionSummary:
        'New local observation: Active traffic including taxis and pedestrians',
      informationDelta:
        'New local observation: Active traffic including taxis and pedestrians',
      intent:
        'Show the cited local observation as the complete message: New local observation: Active traffic including taxis and pedestrians.'
    }]
  };

  assert.equal(repeatsRecentOutboundProposition(candidate, memory), false);
  const priorStatue = {
    contributionKind: 'local_observation',
    contributionSummary:
      'New local observation: statue on a pedestal at a plaza-leaning corner',
    informationDelta:
      'New local observation: statue on a pedestal at a plaza-leaning corner',
    intent:
      'Show the cited local observation as the complete message: New local observation: statue on a pedestal at a plaza-leaning corner.'
  };
  memory.sentMessages = [priorStatue, { ...priorStatue }];
  assert.equal(repeatsRecentOutboundProposition(candidate, memory), true);
});

test('an echoed partner observation counts toward shared channel repetition', async () => {
  let drawingAttempts = 0;
  const service = new RendezvousModelService({
    client: stagedClient([], {
      drawing() {
        drawingAttempts += 1;
        if (drawingAttempts === 1) {
          return drawingResponse({
            contributionKind: 'local_observation',
            contributionEvidenceId: 'local:0',
            drawingIntent: 'Show the three repeated stone arches.',
            messageAction: 'unclear',
            drawingPrompt: 'Sketch three repeated stone arches.',
            groundedFeatureEvidenceIds: ['local:0']
          });
        }
        return drawingResponse({
          contributionKind: 'question',
          contributionEvidenceId: 'question:0',
          drawingIntent: 'Ask whether the recurring circle is a lamp or destination.',
          messageAction: 'unclear',
          drawingPrompt: 'Draw one uncertain circle between a lamp and a distant place.',
          groundedFeatureEvidenceIds: ['question:0']
        });
      }
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({
    privateMemory: {
      ...input().privateMemory,
      sentMessages: [{
        sequence: 7,
        contributionKind: 'local_observation',
        contributionSummary: 'New local observation: three repeated stone arches',
        informationDelta: 'New local observation: three repeated stone arches',
        intent: 'Show three repeated stone arches.'
      }],
      receivedSheets: [{
        sequence: 8,
        communicationFunction: 'report',
        primarySubject: 'Three repeated stone arches',
        literalContents: ['three masonry arches in a row'],
        interpretation: 'A recognizable stone arcade'
      }]
    }
  }));

  assert.equal(drawingAttempts, 2);
  assert.equal(decision.contributionKind, 'question');
});

test('a partner observation misread as a shared proposal still counts toward repetition', async () => {
  let drawingAttempts = 0;
  const service = new RendezvousModelService({
    client: stagedClient([], {
      route: routeResponse({
        observation: 'A zebra crosswalk recedes toward a vanishing point.',
        observedFeatures: ['zebra crosswalk receding toward vanishing point']
      }),
      drawing() {
        drawingAttempts += 1;
        if (drawingAttempts === 1) {
          return drawingResponse({
            contributionKind: 'local_observation',
            contributionEvidenceId: 'local:0',
            drawingIntent: 'Show the zebra crosswalk receding toward a vanishing point.',
            messageAction: 'unclear',
            drawingPrompt: 'Sketch the zebra crosswalk receding toward a vanishing point.',
            groundedFeatureEvidenceIds: ['local:0']
          });
        }
        return drawingResponse({
          contributionKind: 'question',
          contributionEvidenceId: 'question:0',
          drawingIntent: 'Ask whether the recurring circle represents a lamp or a destination.',
          messageAction: 'unclear',
          drawingPrompt: 'Draw one uncertain circle balanced between a lamp and a destination symbol.',
          groundedFeatureEvidenceIds: ['question:0']
        });
      }
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({
    privateMemory: {
      ...input().privateMemory,
      sentMessages: [{
        sequence: 4,
        contributionKind: 'local_observation',
        contributionSummary: 'New local observation: zebra crosswalk visible ahead',
        informationDelta: 'New local observation: zebra crosswalk visible ahead',
        intent: 'Show the zebra crosswalk visible ahead.'
      }],
      receivedSheets: [{
        sequence: 5,
        communicationFunction: 'shared_proposal',
        primarySubject: 'the zebra crossing pattern extending into the distance',
        literalContents: ['a zebra crosswalk receding toward a vanishing point'],
        interpretation: 'A long crosswalk may propose a route forward.'
      }]
    }
  }));

  assert.equal(drawingAttempts, 2);
  assert.equal(decision.contributionKind, 'question');
});

test('an explicit received question cannot be evaded with an unrelated local postcard', async () => {
  let drawingAttempts = 0;
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'question',
        requestedResponse: 'Show whether Ada is moving through the crossing or only observing it.',
        evidenceDelta: {
          ...perceptionResponse().evidenceDelta,
          informationWorthSending: [
            'I am continuing through a busy public crossing, but it is not a known meeting place.'
          ]
        }
      },
      route: routeResponse({
        sheetReconciliation: {
          ...routeResponse().sheetReconciliation,
          informationWorthSending: [
            'I am continuing through a busy public crossing, but it is not a known meeting place.'
          ]
        }
      }),
      drawing(request) {
        drawingAttempts += 1;
        if (drawingAttempts === 1) {
          return drawingResponse({
            contributionKind: 'local_observation',
            contributionEvidenceId: 'local:0',
            drawingIntent: 'Show the arches beside me.',
            drawingPrompt: 'Draw three stone arches.',
            groundedFeatureEvidenceIds: ['local:0']
          });
        }
        assert.match(
          request.messages[1].content[0].text,
          /current sheet visibly asks you something.*response evidence/s
        );
        return drawingResponse({
          contributionKind: 'response',
          contributionEvidenceId: 'response:0',
          drawingIntent: 'Answer that I am moving through the crossing without claiming it as our meeting place.',
          messageAction: 'movement',
          drawingPrompt: 'Draw a completed crossing behind one moving figure while a destination marker remains visibly uncertain.',
          groundedFeatureEvidenceIds: ['response:0', 'action:0']
        });
      }
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(drawingAttempts, 2);
  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.contributionKind, 'response');
  assert.equal(decision.contributionEvidenceId, 'response:0');
  assert.match(decision.informationDelta, /My response to the received drawing/);
});

test('a response that withholds route certainty cannot add a forward arrow', async () => {
  let drawingAttempts = 0;
  const requests = [];
  const responseEvidence =
    'New urban-movement cue from sheet; does not establish a concrete local route to copy.';
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      perception: {
        ...perceptionResponse(),
        communicationFunction: 'report',
        requestedResponse: '',
        evidenceDelta: {
          ...perceptionResponse().evidenceDelta,
          informationWorthSending: [responseEvidence]
        }
      },
      route: routeResponse({
        sheetReconciliation: {
          ...routeResponse().sheetReconciliation,
          informationWorthSending: [responseEvidence]
        }
      }),
      drawing(request) {
        drawingAttempts += 1;
        if (drawingAttempts === 1) {
          return drawingResponse({
            contributionKind: 'response',
            contributionEvidenceId: 'response:0',
            drawingIntent: 'Show a forward-moving urban cue.',
            messageAction: 'movement',
            drawingPrompt: 'Draw a large arrow pointing along a street toward a vanishing point.',
            groundedFeatureEvidenceIds: ['response:0']
          });
        }
        assert.match(
          request.messages[1].content[0].text,
          /explicitly withholds route certainty.*Remove arrows/s
        );
        return drawingResponse({
          contributionKind: 'response',
          contributionEvidenceId: 'response:0',
          drawingIntent: 'Show that the apparent route remains unresolved.',
          messageAction: 'unclear',
          drawingPrompt: 'Draw two incomplete urban fragments that do not visibly connect, held in unresolved tension.',
          groundedFeatureEvidenceIds: ['response:0']
        });
      }
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(drawingAttempts, 2);
  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.contributionKind, 'response');
  assert.doesNotMatch(decision.drawingPrompt, /arrow|vanishing point/i);
});

test('a response with no concrete destination cannot redraw a vanishing-point route', () => {
  assert.equal(responseDrawingContradictsRouteUncertainty({
    contributionKind: 'response',
    contributionSummary: 'Continuation into a busy public street is plausible; no concrete destination yet.',
    drawingIntent: 'Offer a fresh open-ended urban axis toward a vanishing point.',
    drawingPrompt: 'Draw a wide street receding toward a distant vanishing point.'
  }), true);
  assert.equal(responseDrawingContradictsRouteUncertainty({
    contributionKind: 'response',
    contributionSummary: 'Continuation into a busy public street is plausible; no concrete destination yet.',
    drawingIntent: 'Show that the apparent destination remains unresolved.',
    drawingPrompt: 'Draw two incomplete urban fragments held in unresolved tension.'
  }), false);
});

test('one partner observation can still be echoed as corroboration', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      drawing: drawingResponse({
        contributionKind: 'local_observation',
        contributionEvidenceId: 'local:0',
        drawingIntent: 'Show the three repeated stone arches.',
        messageAction: 'unclear',
        drawingPrompt: 'Sketch three repeated stone arches.',
        groundedFeatureEvidenceIds: ['local:0']
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({
    privateMemory: {
      ...input().privateMemory,
      receivedSheets: [{
        sequence: 8,
        communicationFunction: 'report',
        primarySubject: 'Three repeated stone arches',
        literalContents: ['three masonry arches in a row'],
        interpretation: 'A recognizable stone arcade'
      }]
    }
  }));

  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.contributionKind, 'local_observation');
});

test('an alternating local-observation echo cannot hide behind a narrower authored summary', async () => {
  let drawingAttempts = 0;
  const service = new RendezvousModelService({
    client: stagedClient([], {
      route: routeResponse({
        observation: 'A row of storefronts with awnings.',
        observedFeatures: ['row of storefronts with awnings']
      }),
      drawing() {
        drawingAttempts += 1;
        if (drawingAttempts === 1) {
          return drawingResponse({
            contributionKind: 'local_observation',
            contributionEvidenceId: 'local:0',
            drawingIntent: 'Align with Theo by showing the same storefront row and striped awnings.',
            messageAction: 'stillness',
            drawingPrompt: 'Sketch a row of storefronts with striped awnings.',
            groundedFeatureEvidenceIds: ['local:0']
          });
        }
        return drawingResponse({
          contributionKind: 'question',
          contributionEvidenceId: 'question:0',
          drawingIntent: 'Ask whether the recurring circle represents a lamp or a destination.',
          messageAction: 'unclear',
          drawingPrompt: 'Draw one uncertain circle balanced between a lamp and a destination symbol.',
          groundedFeatureEvidenceIds: ['question:0']
        });
      }
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({
    privateMemory: {
      ...input().privateMemory,
      sentMessages: [{
        sequence: 19,
        contributionKind: 'local_observation',
        contributionSummary: 'New local observation: Storefronts and yellow taxis visible',
        informationDelta: 'New local observation: Storefronts and yellow taxis visible',
        intent: 'Show storefronts and yellow taxis.'
      }],
      receivedSheets: [{
        sequence: 20,
        communicationFunction: 'report',
        primarySubject: 'the row of storefronts with awnings and ground-floor windows',
        literalContents: ['storefront buildings with striped and solid awnings'],
        interpretation: 'A quiet urban commercial strip with repeating awnings'
      }]
    }
  }));

  assert.equal(drawingAttempts, 2);
  assert.equal(decision.contributionKind, 'question');
});

test('distinct planner corrections receive one bounded extra attempt', async () => {
  let drawingAttempts = 0;
  const service = new RendezvousModelService({
    client: stagedClient([], {
      drawing() {
        drawingAttempts += 1;
        if (drawingAttempts === 1) {
          return drawingResponse({
            contributionEvidenceId: 'local:99'
          });
        }
        if (drawingAttempts === 2) {
          return drawingResponse({
            contributionKind: 'deliberate_repetition',
            contributionEvidenceId: 'prior_sent:0',
            drawingIntent: 'Repeat the prior stone-arch report.',
            continuityReason: '',
            messageAction: 'stillness',
            drawingPrompt: 'Draw the same three stone arches.',
            groundedFeatureEvidenceIds: ['prior_sent:0']
          });
        }
        return drawingResponse({
          contributionKind: 'question',
          contributionEvidenceId: 'question:0',
          drawingIntent: 'Ask whether the recurring circle is a lamp or destination.',
          messageAction: 'unclear',
          drawingPrompt: 'Draw one uncertain circle between a lamp and a distant place.',
          groundedFeatureEvidenceIds: ['question:0']
        });
      }
    }),
    logger: { warn() {} }
  });
  const repeatedObservation = {
    contributionKind: 'local_observation',
    contributionSummary: 'New local observation: three repeated stone arches',
    informationDelta: 'New local observation: three repeated stone arches',
    intent: 'Show the three repeated stone arches.'
  };

  const decision = await service.decide(input({
    privateMemory: {
      ...input().privateMemory,
      sentMessages: [
        { sequence: 5, ...repeatedObservation },
        { sequence: 7, ...repeatedObservation }
      ]
    }
  }));

  assert.equal(drawingAttempts, 3);
  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.contributionKind, 'question');
});

test('a repeatedly unanswered question cannot keep masquerading as a new message', async () => {
  let drawingAttempts = 0;
  const service = new RendezvousModelService({
    client: stagedClient([], {
      drawing() {
        drawingAttempts += 1;
        if (drawingAttempts === 1) {
          return drawingResponse({
            contributionKind: 'question',
            contributionEvidenceId: 'question:0',
            drawingIntent: 'Ask again whether the circle marks a lamp or destination.',
            messageAction: 'unclear',
            drawingPrompt: 'Draw the same uncertain circle balanced between a lamp and a distant target.',
            groundedFeatureEvidenceIds: ['question:0']
          });
        }
        return drawingResponse({
          contributionKind: 'deliberate_repetition',
          contributionEvidenceId: 'prior_sent:0',
          drawingIntent: 'Repeat the unresolved circle question so Theo can recognize that it remains unanswered.',
          continuityReason: 'The unchanged question is the signal: I still cannot distinguish the two meanings.',
          messageAction: 'unclear',
          drawingPrompt: 'Redraw the unresolved circle between two visibly uncertain interpretations.',
          groundedFeatureEvidenceIds: ['prior_sent:0']
        });
      }
    }),
    logger: { warn() {} }
  });
  const repeatedQuestion = {
    contributionKind: 'question',
    contributionSummary: 'Question I am sending: whether the circle represents a lamp or destination',
    informationDelta: 'Question I am sending: whether the circle represents a lamp or destination',
    intent: 'Ask whether the circle represents a lamp or destination.'
  };

  const decision = await service.decide(input({
    privateMemory: {
      ...input().privateMemory,
      sentMessages: [
        { sequence: 5, ...repeatedQuestion }
      ]
    }
  }));

  assert.equal(drawingAttempts, 2);
  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.contributionKind, 'deliberate_repetition');
  assert.match(decision.continuityReason, /still cannot distinguish/);
});

test('literal-versus-symbolic route wording is one repeated question', () => {
  assert.equal(repeatsRecentOutboundProposition({
    contributionKind: 'question',
    contributionSummary: 'Question I am sending: Is Ada signaling a literal forward path or a symbolic urge to move along a broad axis without a fixed destination?',
    informationDelta: 'Question I am sending: Is Ada signaling a literal forward path or a symbolic urge to move along a broad axis without a fixed destination?',
    drawingIntent: 'Depict a literal fork and symbolic uncertainty.'
  }, {
    sentMessages: [{
      sequence: 16,
      contributionKind: 'question',
      contributionSummary: 'Question I am sending: Should I treat the crosswalk cue as a literal path or a symbolic hint for future direction?',
      informationDelta: 'Question I am sending: Should I treat the crosswalk cue as a literal path or a symbolic hint for future direction?',
      intent: 'Ask whether the crosswalk cue is a literal path or a symbolic hint.'
    }]
  }), true);
});

test('a failed proposition is suppressed only while the same received sheet is current', () => {
  const candidate = {
    contributionKind: 'question',
    contributionSummary: 'Question I am sending: Is Ada signaling a literal path or a symbolic broad-axis cue without a fixed destination?',
    informationDelta: 'Question I am sending: Is Ada signaling a literal path or a symbolic broad-axis cue without a fixed destination?',
    drawingIntent: 'Contrast a literal route with a symbolic broad-axis cue.'
  };
  const failedMessage = {
    draftId: 'failed-question',
    sheetSequence: 43,
    contributionKind: 'question',
    contributionSummary: 'Question I am sending: Is Ada signaling a literal path or a symbolic broad-axis cue without a fixed destination?',
    informationDelta: 'Question I am sending: Is Ada signaling a literal path or a symbolic broad-axis cue without a fixed destination?',
    intent: 'Ask whether the cue is a literal path or symbolic broad-axis cue.'
  };

  assert.equal(repeatsRecentOutboundProposition(candidate, {
    receivedSheets: [{ sequence: 43 }],
    failedMessages: [failedMessage],
    sentMessages: []
  }), true);
  assert.equal(repeatsRecentOutboundProposition(candidate, {
    receivedSheets: [{ sequence: 43 }, { sequence: 44 }],
    failedMessages: [failedMessage],
    sentMessages: []
  }), false);
});

test('a later independent local observation can corroborate a failed same-sheet clue', () => {
  const candidate = {
    contributionKind: 'local_observation',
    contributionSummary: 'New local observation: river or water body visible to the right',
    informationDelta: 'New local observation: river or water body visible to the right',
    drawingIntent: 'Depict the visible river edge.'
  };
  const failedMessage = {
    draftId: 'failed-river',
    turn: 100,
    sheetSequence: 55,
    contributionKind: 'local_observation',
    contributionSummary: 'New local observation: river or water body visible to the right',
    informationDelta: 'New local observation: river or water body visible to the right',
    intent: 'Depict the visible river edge.'
  };
  const secondFailedMessage = {
    ...failedMessage,
    draftId: 'failed-river-again',
    turn: 110
  };

  assert.equal(repeatsRecentOutboundProposition(candidate, {
    receivedSheets: [{ sequence: 55 }],
    failedMessages: [failedMessage, secondFailedMessage],
    ownObservations: [{
      turn: 90,
      description: 'river visible beside a broad urban boulevard'
    }],
    sentMessages: []
  }), true);
  assert.equal(repeatsRecentOutboundProposition(candidate, {
    receivedSheets: [{ sequence: 55 }],
    failedMessages: [failedMessage, secondFailedMessage],
    ownObservations: [{
      turn: 140,
      description: 'I am beside a broad urban boulevard with a river visible to the right'
    }],
    sentMessages: []
  }), false);
});

test('the drawing planner can cite any proposition considered by recent-repeat detection', async () => {
  const oldQuestion = {
    sequence: 11,
    contributionKind: 'question',
    contributionSummary: 'Question I am sending: whether the stone arch is a place or only a symbol',
    informationDelta: 'Question I am sending: whether the stone arch is a place or only a symbol',
    intent: 'Ask whether the stone arch is a physical place or only a symbol.'
  };
  const interveningMessages = Array.from({ length: 5 }, (_, index) => ({
    sequence: 12 + index,
    contributionKind: 'own_action',
    contributionSummary: `My current chosen action: movement report ${index}`,
    informationDelta: `My current chosen action: movement report ${index}`,
    intent: `Show movement report ${index}.`
  }));
  const service = new RendezvousModelService({
    client: stagedClient([], {
      drawing: drawingResponse({
        contributionKind: 'deliberate_repetition',
        contributionEvidenceId: 'prior_sent:0',
        drawingIntent: 'Repeat the unresolved stone-arch question.',
        continuityReason: 'The same ambiguity remains useful to surface.',
        messageAction: 'unclear',
        drawingPrompt: 'Draw one uncertain stone arch poised between a real place and a symbolic shape.',
        groundedFeatureEvidenceIds: ['prior_sent:0']
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({
    privateMemory: {
      ...input().privateMemory,
      sentMessages: [oldQuestion, ...interveningMessages]
    }
  }));

  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.contributionKind, 'deliberate_repetition');
  assert.match(decision.contributionSummary, /stone arch is a place or only a symbol/);
});

test('a repeated question is offered directly as deliberate repetition', async () => {
  let drawingAttempts = 0;
  const service = new RendezvousModelService({
    client: stagedClient([], {
      drawing(request) {
        drawingAttempts += 1;
        const prompt = request.messages[1].content.map(item => item.text || '').join('\n');
        assert.doesNotMatch(prompt, /"id": "question:0"/);
        assert.match(prompt, /"id": "prior_sent:0"/);
        return drawingResponse({
          contributionKind: 'deliberate_repetition',
          contributionEvidenceId: 'prior_sent:0',
          drawingIntent: 'Ask whether the circle is a lamp or a destination.',
          continuityReason: 'The question remains unresolved, so I am asking it again.',
          messageAction: 'unclear',
          drawingPrompt: 'Draw one uncertain circle poised between a lamp and a distant destination.',
          groundedFeatureEvidenceIds: ['prior_sent:0']
        });
      }
    }),
    logger: { warn() {} }
  });
  const priorQuestion = {
    sequence: 16,
    contributionKind: 'question',
    contributionSummary: 'Question I am sending: whether the circle represents a lamp or destination',
    informationDelta: 'Question I am sending: whether the circle represents a lamp or destination',
    intent: 'Ask whether the circle represents a lamp or destination.'
  };

  const decision = await service.decide(input({
    privateMemory: {
      ...input().privateMemory,
      sentMessages: [priorQuestion]
    }
  }));

  assert.equal(drawingAttempts, 1);
  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.contributionKind, 'deliberate_repetition');
  assert.match(decision.contributionSummary, /circle represents a lamp or destination/);
  assert.ok(decision.continuityReason);
});

test('an intentional repeated proposition remains available through deliberate repetition', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      drawing: drawingResponse({
        contributionKind: 'deliberate_repetition',
        contributionEvidenceId: 'prior_sent:0',
        drawingIntent: 'Repeat the prior walking figure because the unchanged action is itself useful.',
        continuityReason: 'The unchanged movement report is the information I intend to send.',
        drawingPrompt: 'Draw the same walking figure and completed footprints as a deliberate echo.',
        groundedFeatureEvidenceIds: ['prior_sent:0']
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({
    privateMemory: {
      ...input().privateMemory,
      sentMessages: [{
        sequence: 5,
        contributionKind: 'own_action',
        contributionSummary: 'My current chosen action: I chose to move northeast along the selected public route.',
        informationDelta: 'My current chosen action: I chose to move northeast along the selected public route.',
        intent: 'Show a person walking away along a tree-lined public route with footprints behind.'
      }]
    }
  }));

  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.contributionKind, 'deliberate_repetition');
  assert.match(decision.continuityReason, /unchanged movement report/);
});

test('deliberate repetition needs a communicative reason beyond omitted motifs', () => {
  assert.equal(deliberateRepetitionHasPurpose({
    contributionKind: 'deliberate_repetition',
    continuityReason: 'The recurring "forward" motif is omitted because its physical meaning remains unsupported.'
  }), false);
  assert.equal(deliberateRepetitionHasPurpose({
    contributionKind: 'deliberate_repetition',
    continuityReason: 'The unchanged question remains unresolved, so I am deliberately asking it again. The recurring "forward" motif is omitted because its physical meaning remains unsupported.'
  }), true);
  assert.equal(deliberateRepetitionHasPurpose({
    contributionKind: 'deliberate_repetition',
    continuityReason: 'Introduce a genuinely new composition that emphasizes movement along a broad axis while using landmarks for coordination, rather than repeating a previous forward motif as a destination. The recurring "forward" motif is omitted because its physical meaning remains unsupported.'
  }), false);
});

test('planner-authored fields cannot reintroduce private place names for an own-action reply', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      route: routeResponse({
        selectedIndex: 1,
        intendedHeading: 90
      }),
      drawing: drawingResponse({
        contributionKind: 'own_action',
        contributionEvidenceId: 'action:0',
        drawingIntent: 'Anchor at Bowery/Prince and continue from W 47th St toward Delancey.',
        drawingPrompt: 'Draw Bowery/Prince with a tree, then follow Delancey St east from E 48th St.',
        continuityReason: 'The Bowery/Prince anchor connects W 47th St to Delancey.',
        groundedFeatureEvidenceIds: ['action:0']
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({
    options: [
      { panoId: 'west', heading: 270, label: 'Bowery' },
      { panoId: 'east', heading: 90, label: 'Delancey St' }
    ]
  }));
  const outbound = JSON.stringify({
    drawingIntent: decision.drawingIntent,
    drawingPrompt: decision.drawingPrompt,
    continuityReason: decision.continuityReason,
    drawingGroundedFeatures: decision.drawingGroundedFeatures
  });

  assert.equal(decision.fallbackCause, null);
  assert.doesNotMatch(outbound, /Bowery|Prince|Delancey|W 47th|E 48th/);
  assert.match(outbound, /local street/);
});

test('a new contribution cannot echo the received multi-panel template', async () => {
  const requests = [];
  let drawingAttempts = 0;
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      perception: {
        ...perceptionResponse(),
        literalContents: [
          'Three panels show an arch, a central star map, and a destination street.'
        ],
        sheetInterpretation: 'A triptych links three scenes with one arrow.'
      },
      drawing(request) {
        drawingAttempts += 1;
        if (drawingAttempts === 1) {
          return drawingResponse({
            drawingIntent: 'Repeat the three-panel route with my current arches.',
            drawingPrompt: 'Draw a triptych with left, middle, and right panels.'
          });
        }
        assert.match(
          request.messages[1].content[0].text,
          /AUTHORITATIVE PLANNING CORRECTION.*one coherent composition/
        );
        return drawingResponse({
          drawingIntent: 'Show my current arches as the primary reply.',
          drawingPrompt: 'Draw one coherent street scene centered on three stone arches.'
        });
      }
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(drawingAttempts, 2);
  assert.equal(decision.fallbackCause, null);
  assert.match(decision.drawingPrompt, /one coherent street scene/);
  assert.doesNotMatch(decision.drawingPrompt, /panel|triptych/i);
});

test('drawing planner cannot promote an uncited recurring motif into a shared destination', async () => {
  const requests = [];
  let drawingAttempts = 0;
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      drawing(request) {
        drawingAttempts += 1;
        if (drawingAttempts === 1) {
          return drawingResponse({
            drawingIntent: 'Show my arches leading to the star as our shared destination.',
            drawingPrompt: 'Draw one street scene with arches and a star as the shared target.'
          });
        }
        assert.match(
          request.messages[1].content[0].text,
          /AUTHORITATIVE PLANNING CORRECTION.*known shared destination/
        );
        return drawingResponse({
          drawingIntent: 'Show my newly observed arches with a small uncertain star retained from earlier sheets.',
          drawingPrompt: 'Draw one street scene centered on three arches, with a faint unresolved star in one corner.'
        });
      }
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.equal(drawingAttempts, 2);
  assert.doesNotMatch(decision.drawingIntent, /shared destination|shared target/);
  assert.match(decision.drawingIntent, /uncertain star/);
});

test('drawing planner cannot use an unsupported partner motif as an implied destination', async () => {
  const requests = [];
  let drawingAttempts = 0;
  const priorMemory = {
    ...input().privateMemory,
    partnerHypotheses: [{
      key: 'star-destination',
      description: 'Theo may intend the star to mark a physical destination.',
      confidence: 0.4,
      basisSequences: [5],
      evidenceStatus: 'unclear'
    }]
  };
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      drawing(request) {
        drawingAttempts += 1;
        if (drawingAttempts === 1) {
          return drawingResponse({
            drawingIntent: 'Show my arches leading toward Theo’s implied destination.',
            drawingPrompt: 'Draw one street scene with a path ending at a distant star.',
            continuityReason: 'The star keeps our forward movement coherent.'
          });
        }
        assert.match(
          request.messages[1].content[0].text,
          /AUTHORITATIVE PLANNING CORRECTION.*unsupported partner hypothesis/
        );
        return drawingResponse({
          drawingIntent: 'Show my newly observed arches while questioning whether the star identifies a place.',
          drawingPrompt: 'Draw one street scene centered on three arches, with a faint unresolved star off to one side.'
        });
      }
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({ privateMemory: priorMemory }));

  assert.equal(decision.fallbackCause, null);
  assert.equal(drawingAttempts, 2);
  assert.match(decision.drawingIntent, /questioning whether/);
});

test('generic planning words are not treated as distinctive unsupported motifs', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      drawing: drawingResponse({
        contributionKind: 'local_observation',
        contributionEvidenceId: 'local:0',
        drawingIntent: 'Show the tree canopy as the dominant local landmark without specifying a destination.',
        messageAction: 'stillness',
        drawingPrompt: 'Draw one dense tree canopy above a quiet sidewalk, with the distant view faint and subordinate.',
        groundedFeatureEvidenceIds: ['local:0']
      })
    }),
    logger: { warn() {} }
  });
  const priorMemory = {
    ...input().privateMemory,
    partnerHypotheses: [{
      key: 'forward-path-interpretation',
      description: 'sender guiding along a diagonal path toward a distant meeting point but not specifying exact destination',
      confidence: 0.2,
      basisSequences: [1],
      evidenceStatus: 'unclear'
    }]
  };

  const decision = await service.decide(input({ privateMemory: priorMemory }));

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.drawingIntent, /tree canopy/);
  assert.doesNotMatch(decision.drawingIntent, /Send the cited contribution/);
});

test('drawing planner neutralizes one stubborn unsupported motif after retries', async () => {
  const priorMemory = {
    ...input().privateMemory,
    partnerHypotheses: [{
      key: 'star-destination',
      description: 'Theo may intend the star to mark a physical destination.',
      confidence: 0.4,
      basisSequences: [5],
      evidenceStatus: 'unclear'
    }]
  };
  const service = new RendezvousModelService({
    client: stagedClient([], {
      drawing: drawingResponse({
        drawingIntent: 'Show my arches leading toward the star.',
        drawingPrompt: 'Draw one street scene with a path ending at a distant star.',
        continuityReason: 'The star keeps our forward movement coherent.'
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({ privateMemory: priorMemory }));

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.drawingIntent, /Show the cited local observation as the complete message/);
  assert.match(decision.drawingPrompt, /three repeated stone arches/);
  assert.doesNotMatch(
    `${decision.drawingIntent} ${decision.drawingPrompt} ${decision.continuityReason}`,
    /\bstar\b/i
  );
  assert.equal(decision.continuityReason, '');
  assert.equal(decision.messageAction, 'unclear');
});

test('drawing planner still rejects an unknown contribution evidence ID', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      drawing: drawingResponse({
        contributionKind: 'local_observation',
        contributionEvidenceId: 'local:99'
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, 'drawing_plan_error');
  assert.equal(decision.drawingPrompt, '');
  assert.equal(requests.filter(request =>
    /currently hold the one physical sheet/.test(request.messages[0].content)
  ).length, 2);
});

test('abstract sheet-language residue is excluded from local outbound evidence', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      route: routeResponse({
        observedFeatures: [
          'three repeated stone arches',
          'a suspended traffic light beside them',
          'Bowery/Prince intersection with central median tree',
          'FDR Drive beside the river',
          'street label W 47th St is visible beside the crossing',
          'E 48th St is printed on a nearby sign',
          'a star waypoint implied by the prior sheet cue',
          'Bowery/Prince intersection context',
          'bold diagonal route arrow toward the right'
        ]
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());
  const drawingRequest = requests.find(request =>
    /currently hold the one physical sheet/.test(request.messages[0].content)
  );
  const drawingUserText = drawingRequest.messages[1].content[0].text;
  const catalogText = drawingUserText.split('Available outbound evidence catalog:\n')[1];

  assert.equal(decision.fallbackCause, null);
  assert.match(catalogText, /three repeated stone arches/);
  assert.doesNotMatch(catalogText, /star waypoint implied by the prior sheet cue/);
  assert.doesNotMatch(catalogText, /Bowery\/Prince intersection context/);
  assert.doesNotMatch(catalogText, /bold diagonal route arrow/);
  assert.match(catalogText, /central median tree/);
  assert.doesNotMatch(catalogText, /Bowery|Prince|FDR Drive|W 47th|E 48th|street label/);
});

test('bare street substrate is omitted while distinctive local evidence remains', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      route: routeResponse({
        observation: 'A street with lane markings, crosswalks, and orange barriers beneath scaffolding.',
        observedFeatures: [
          'street with lane markings and crosswalks',
          'a cross-street environment',
          'curb, sidewalk, and asphalt street',
          'a broad urban street flanked by tall buildings on both sides',
          'a widthy urban street flanked by buildings',
          'a long street lined with tall buildings',
          'pedestrians and vehicles in the distance',
          'busy urban street with crosswalk markings',
          'crosswalk markings with bold white stripes ahead',
          'central axis receding toward a vanishing point',
          'no visible storefronts blocking the way',
          'orange construction barriers beneath dense scaffolding'
        ]
      }),
      drawing: drawingResponse({
        contributionKind: 'local_observation',
        contributionEvidenceId: 'local:0',
        drawingIntent: 'Show the orange barriers beneath dense scaffolding.',
        drawingPrompt: 'Draw orange construction barriers compressed beneath a dense scaffold canopy.',
        groundedFeatureEvidenceIds: ['local:0']
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());
  const drawingRequest = requests.find(request =>
    /currently hold the one physical sheet/.test(request.messages[0].content)
  );
  const catalogText = drawingRequest.messages[1].content[0].text
    .split('Available outbound evidence catalog:\n')[1];

  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.contributionSummary,
    'New local observation: orange construction barriers beneath dense scaffolding');
  assert.doesNotMatch(
    catalogText,
    /street with lane markings|cross-street environment|curb, sidewalk|broad urban street flanked|widthy urban street|long street lined|pedestrians and vehicles|busy urban street|bold white stripes|central axis|no visible storefronts/
  );
  assert.match(catalogText, /orange construction barriers beneath dense scaffolding/);
});

test('a list of generic city fixtures is not promoted into a locating clue', () => {
  assert.equal(
    isConcreteLocalEvidence(
      'New local observation: crosswalks, tall buildings, storefronts, pedestrians, taxis, and cars'
    ),
    false
  );
  assert.equal(isConcreteLocalEvidence('row of storefronts'), false);
  assert.equal(
    isConcreteLocalEvidence('New local observation: A busy Manhattan-like street corner'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: Active traffic including taxis and pedestrians'),
    false
  );
  assert.equal(isConcreteLocalEvidence('New local observation: ongoing vehicle'), false);
  assert.equal(isConcreteLocalEvidence('several moving taxis and pedestrians'), false);
  assert.equal(
    isConcreteLocalEvidence('Pedestrians and vehicles are present, suggesting a busy street'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('Several vehicles and pedestrians are present on sidewalks and roadway'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence(
      'New local observation: I am on a broad urban plaza-like street corridor'
    ),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: broad urban pedestrian pathway'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: empty urban promenade receding into the distance'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: pedestrian activity'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: pedestrian and vehicle activity along the avenue'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: wide, straight urban street with adjacent sidewalks'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: distinct crosswalk markings at intersections'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: crosswalk lines across the street'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: paved sidewalk and curb with a clear path ahead'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence(
      'New local observation: clear roadway with crosswalks and pedestrian elements visible in the distance'
    ),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: brick wall occupying the right side of the image'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence(
      'New local observation: tall brick building wall on the right with a window and protruding ledge'
    ),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: brick building façades on both sides'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('rectangular tiled pavement converging to a vanishing point'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: central vanishing point / strong linear perspective'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence(
      'New local observation: narrow urban street with a pronounced vanishing point ahead'
    ),
    false
  );
  assert.equal(
    isConcreteLocalEvidence(
      'New local observation: a central, straight road that recedes to a distant vanishing point'
    ),
    false
  );
  assert.equal(
    isConcreteLocalEvidence(
      'New local observation: south-east oriented street canyon with tall brick buildings on both sides'
    ),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: row of parked cars along the curb on both sides'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('subtle shading suggesting depth and distance'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: taxis and other vehicles on the street'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: I am on a broad, busy urban street canyon'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: I’m on a broad urban avenue'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: broad city boulevard and roadway'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: river visible beside a broad urban boulevard'),
    true
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: brick multi-story building on the left'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: brick clock tower on the left'),
    true
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: a street labeled as part of a dense downtown axis'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: No visible storefronts blocking the way'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('New local observation: a plaza without a distinctive structure'),
    false
  );
  assert.equal(
    isConcreteLocalEvidence('row of storefronts with striped awnings'),
    true
  );
  assert.equal(isConcreteLocalEvidence('a dense queue of yellow taxis beneath an iron viaduct'), true);
  assert.equal(
    isConcreteLocalEvidence('a south-east oriented street passing beneath an iron viaduct'),
    true
  );
  assert.equal(
    isConcreteLocalEvidence('orange construction barriers beneath dense scaffolding'),
    true
  );
  assert.equal(isConcreteLocalEvidence('a row of iron bollards beneath mature trees'), true);
  assert.equal(isConcreteLocalEvidence('a mosaic mural covering a brick wall'), true);
  assert.equal(isConcreteLocalEvidence('a gothic rose window with stone tracery'), true);
});

test('a blind recipient can validate a concrete local report despite sender-review disagreement', () => {
  assert.equal(localObservationMatchesBlindRead(
    'New local observation: river or water body visible to the right',
    {
      primarySubject: 'a quiet riverside landscape with a visible shoreline',
      likelyMessage: 'an observational rendering of a river edge'
    }
  ), true);
  assert.equal(localObservationMatchesBlindRead(
    'New local observation: river or water body visible to the right',
    {
      primarySubject: 'a runner moving down a road toward the horizon',
      likelyMessage: 'continue forward along the route'
    }
  ), false);
  assert.equal(localObservationMatchesBlindRead(
    'New local observation: construction activity with cones ahead on the right',
    {
      primarySubject: 'a scaffold structure surrounded by safety cones',
      likelyMessage: 'the sender sees an active construction zone'
    }
  ), true);
  assert.equal(localObservationMatchesBlindRead(
    'New local observation: construction activity with cones ahead on the right',
    {
      primarySubject: 'a group of workers under an otherwise empty scaffold',
      likelyMessage: 'people are working beside a building'
    }
  ), false);
});

test('generic local context remains private while outbound features require distinctive evidence', () => {
  const decision = sanitizeRendezvousDecision({
    ...routeResponse(),
    observation: 'broad urban street canyon between tall buildings; pedestrian and vehicle activity along the avenue',
    observedFeatures: [
      'broad urban street canyon between tall buildings',
      'pedestrian and vehicle activity along the avenue'
    ]
  }, input().options);

  assert.equal(
    decision.observation,
    'broad urban street canyon between tall buildings; pedestrian and vehicle activity along the avenue'
  );
  assert.deepEqual(decision.observedFeatures, []);
});

test('a branch may proceed without inventing a shareable feature from generic surroundings', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      route: routeResponse({
        observation: 'wide, straight urban street with adjacent sidewalks',
        observedFeatures: []
      }),
      drawing: drawingResponse({
        contributionKind: 'own_action',
        contributionEvidenceId: 'action:0',
        groundedFeatureEvidenceIds: ['action:0'],
        drawingIntent: 'Show my own movement as a retrospective report.',
        drawingPrompt: 'Sketch one traveler leaving a branching corner, with no text.'
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.observation, 'wide, straight urban street with adjacent sidewalks');
  assert.deepEqual(decision.observedFeatures, []);
  assert.equal(decision.contributionKind, 'own_action');
});

test('a local question must ask about its cited feature, not use it as scenery', () => {
  assert.equal(localQuestionPreservesCitedSubject({
    contributionKind: 'question',
    contributionEvidenceId: 'question_local:0',
    contributionSummary:
      'Question I am sending about this local evidence: pedestrians and taxis on the road',
    drawingIntent:
      'A lone figure stands near taxis. A question mark asks which direction to take or how to coordinate next.',
    drawingPrompt:
      'Draw the figure and taxis behind two large directional choices.'
  }), false);
  assert.equal(localQuestionPreservesCitedSubject({
    contributionKind: 'question',
    contributionEvidenceId: 'question_local:0',
    contributionSummary:
      'Question I am sending about this local evidence: three stone arches with one broken arch',
    drawingIntent:
      'Ask whether Theo has seen these three arches with the broken arch in the middle.',
    drawingPrompt:
      'Draw three stone arches, emphasizing the broken middle arch as an uncertain comparison.'
  }), true);
});

test('route planning rejects partner-cue dependency but preserves evidence-based waiting', async () => {
  const requests = [];
  let routeAttempts = 0;
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      route() {
        routeAttempts += 1;
        if (routeAttempts === 1) {
          return routeResponse({
            action: 'wait',
            reasoning: 'I will hold here until Theo gives me the next cue.',
            memoryUpdate: {
              currentPlan: 'Wait for Theo to signal that I should move.'
            }
          });
        }
        const correction = requests.at(-1).messages[1].content[0].text;
        assert.match(correction, /friend cannot cue, authorize, instruct, or grant permission/i);
        assert.match(correction, /justify it only by a recognizable feature visible/i);
        return routeResponse({
          action: 'wait',
          reasoning: 'I will hold briefly because this distinctive arch is easy to recognize.',
          memoryUpdate: {
            currentPlan: 'Stay visible at the distinctive arch for one turn, then reassess.'
          }
        });
      }
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(routeAttempts, 2);
  assert.equal(decision.action, 'wait');
  assert.match(decision.reasoning, /easy to recognize/);
  assert.doesNotMatch(decision.memoryUpdate.currentPlan, /Theo|cue|signal/);
});

test('repeated partner-cue movement is normalized to the selected local route', async () => {
  const warnings = [];
  let routeAttempts = 0;
  const service = new RendezvousModelService({
    client: stagedClient([], {
      route() {
        routeAttempts += 1;
        return routeResponse({
          action: 'move',
          selectedIndex: 1,
          reasoning: 'The northern opening has three visible stone arches, so I will move when Ada signals readiness.',
          memoryUpdate: {
            currentPlan: 'Use the locally visible stone arches and traffic light, then reassess.'
          }
        });
      }
    }),
    logger: { warn(message) { warnings.push(message); } }
  });

  const decision = await service.decide(input());

  assert.equal(routeAttempts, 2);
  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.action, 'move');
  assert.equal(decision.selectedIndex, 1);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /three repeated stone arches/i);
  assert.doesNotMatch(decision.reasoning, /Ada|cue|signal|when/i);
  assert.doesNotMatch(decision.memoryUpdate.currentPlan, /Ada|cue|signal/);
  assert.equal(decision.reconciliation.planAssessment, 'inconclusive');
  assert.ok(warnings.some(message => /normalized partner-cue route causality/i.test(message)));
});

test('repeated-only imagery cannot count as fresh support for the current plan', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      route: routeResponse({
        sheetReconciliation: {
          currentSenderAction: 'movement',
          currentSenderActionBasis: 'The same diagonal line and star appear again.',
          informationNovelty: 'repeated',
          newEvidenceIds: [],
          repeatedEvidence: ['the diagonal line and star repeat'],
          contradictions: [],
          unresolvedQuestions: ['whether the star identifies any physical place'],
          informationWorthSending: ['ask whether the star still matters'],
          planAssessment: 'supporting',
          conventionUpdate: {
            key: 'star-route',
            description: 'A star recurs at the end of a route line.',
            confidence: 0.6,
            basisSequences: [7],
            evidenceStatus: 'repetition_only'
          },
          partnerHypothesis: {
            key: 'star-destination',
            description: 'The star may be a shared physical destination.',
            confidence: 0.55,
            basisSequences: [7],
            evidenceStatus: 'repetition_only'
          }
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.reconciliation.planAssessment, 'inconclusive');
  assert.equal(decision.memoryUpdate.partnerHypothesis.evidenceStatus, 'repetition_only');
});

test('new corroboration must cite the current sheet in its provenance', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      route: routeResponse({
        sheetReconciliation: {
          ...routeResponse().sheetReconciliation,
          informationNovelty: 'mixed',
          newEvidenceIds: ['visible:0'],
          partnerHypothesis: {
            key: 'star-destination',
            description: 'The star may identify a physical destination.',
            confidence: 0.6,
            basisSequences: [5],
            evidenceStatus: 'new_corroboration'
          }
        },
        memoryUpdate: {
          currentPlan: 'Continue north while testing whether the star has any physical meaning.'
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.memoryUpdate.partnerHypothesis.evidenceStatus, 'unclear');
  assert.deepEqual(decision.memoryUpdate.partnerHypothesis.basisSequences, [5]);
});

test('route planning retries when the selected option contradicts its intended heading', async () => {
  const requests = [];
  let routeAttempts = 0;
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      route() {
        routeAttempts += 1;
        return routeAttempts === 1
          ? routeResponse({
              selectedIndex: 0,
              intendedHeading: 90,
              reasoning: 'I intend to move east.',
              memoryUpdate: { currentPlan: 'Move east using my local evidence.' }
            })
          : routeResponse();
      }
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(routeAttempts, 2);
  assert.equal(decision.selectedIndex, 1);
  assert.equal(decision.intendedHeading, 0);
});

test('route planning cannot make an unsupported partner motif its movement goal', async () => {
  const requests = [];
  let routeAttempts = 0;
  const priorMemory = {
    ...input().privateMemory,
    partnerHypotheses: [{
      key: 'star-destination',
      description: 'Theo may intend the star to mark a physical destination.',
      confidence: 0.4,
      basisSequences: [5],
      evidenceStatus: 'unclear'
    }]
  };
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      route() {
        routeAttempts += 1;
        if (routeAttempts === 2) {
          const correction = requests.at(-1).messages[1].content[0].text;
          assert.match(correction, /AUTHORITATIVE ROUTE CORRECTION/);
          assert.match(correction, /explicitly uncertain, questioned, or being tested/);
          assert.match(correction, /selected route contradicts its intended heading/);
          assert.match(correction, /motif "star"/);
        }
        return routeAttempts === 1
          ? routeResponse({
              selectedIndex: 0,
              intendedHeading: 90,
              memoryUpdate: {
                currentPlan: 'Continue north toward the star while preserving the shared visual language.'
              }
            })
          : routeResponse({
              memoryUpdate: {
                currentPlan: 'Continue north using local arches while testing whether the star has any physical meaning.'
              }
            });
      }
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({ privateMemory: priorMemory }));

  assert.equal(routeAttempts, 2);
  assert.equal(decision.fallbackCause, null);
  assert.match(decision.memoryUpdate.currentPlan, /testing whether/);
});

test('route planning neutralizes one stubborn unsupported motif after retries', async () => {
  const priorMemory = {
    ...input().privateMemory,
    partnerHypotheses: [{
      key: 'star-destination',
      description: 'Theo may intend the star to mark a physical destination.',
      confidence: 0.4,
      basisSequences: [5],
      evidenceStatus: 'unclear'
    }]
  };
  const service = new RendezvousModelService({
    client: stagedClient([], {
      route: routeResponse({
        memoryUpdate: {
          currentPlan: 'Continue north toward the star as the destination.'
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({ privateMemory: priorMemory }));

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.memoryUpdate.currentPlan, /uncertain visual vocabulary/);
  assert.match(decision.memoryUpdate.currentPlan, /not a known physical destination/);
  assert.equal(decision.reconciliation.planAssessment, 'inconclusive');
});

test('overlapping non-supporting sheet errors normalize as one route failure', async () => {
  const priorMemory = {
    ...input().privateMemory,
    partnerHypotheses: [{
      key: 'forward-destination',
      description: 'Ada may intend a recurring forward motif as a physical destination.',
      confidence: 0.4,
      basisSequences: [5],
      evidenceStatus: 'unclear'
    }]
  };
  let routeAttempts = 0;
  const warnings = [];
  const service = new RendezvousModelService({
    client: stagedClient([], {
      route() {
        routeAttempts += 1;
        return routeResponse({
          action: 'move',
          selectedIndex: 1,
          reasoning:
            'I will move when Ada cues me because the newest sheet points forward along the public axis.',
          memoryUpdate: {
            currentPlan:
              'Continue toward the forward motif as our destination when Ada signals readiness.'
          }
        });
      }
    }),
    logger: { warn(message) { warnings.push(message); } }
  });

  const decision = await service.decide(input({ privateMemory: priorMemory }));

  assert.equal(routeAttempts, 2);
  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.action, 'move');
  assert.equal(decision.selectedIndex, 1);
  assert.match(decision.reasoning, /what I can currently see/i);
  assert.match(decision.reasoning, /not route guidance/i);
  assert.doesNotMatch(decision.reasoning, /Ada cues|points forward/i);
  assert.doesNotMatch(decision.memoryUpdate.currentPlan, /destination|signals readiness/i);
  assert.equal(decision.reconciliation.planAssessment, 'inconclusive');
  assert.ok(warnings.some(message => /normalized partner-cue route causality/i.test(message)));
});

test('ordinary spatial language is not mistaken for an unsupported visual motif', async () => {
  const priorMemory = {
    ...input().privateMemory,
    partnerHypotheses: [{
      key: 'routecontinuation-se-block',
      description: 'Theo signaling continued inland movement with inland reorientation via the grid, star as waypoint.',
      confidence: 0.4,
      basisSequences: [5],
      evidenceStatus: 'unclear'
    }]
  };
  const service = new RendezvousModelService({
    client: stagedClient([], {
      route: routeResponse({
        sheetReconciliation: {
          ...routeResponse().sheetReconciliation,
          partnerHypothesis: {
            key: 'routecontinuation-se-block',
            description: 'Theo may be continuing inland while the star remains ambiguous.',
            confidence: 0.35,
            basisSequences: [5],
            evidenceStatus: 'unclear'
          }
        },
        memoryUpdate: {
          currentPlan: 'Continue inland using current local evidence while testing whether the star has physical meaning.'
        }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({ privateMemory: priorMemory }));

  assert.equal(decision.fallbackCause, null);
  assert.match(decision.memoryUpdate.currentPlan, /Continue inland/);
});

test('public-route boilerplate is not mistaken for an unsupported visual motif', async () => {
  let routeAttempts = 0;
  const warnings = [];
  const priorMemory = {
    ...input().privateMemory,
    partnerHypotheses: [{
      key: 'fork-coordination',
      description: 'Continue along public route while seeking a joint decision at the fork.',
      confidence: 0.1,
      basisSequences: [5],
      evidenceStatus: 'unclear'
    }]
  };
  const service = new RendezvousModelService({
    client: stagedClient([], {
      route() {
        routeAttempts += 1;
        return routeResponse({
          memoryUpdate: {
            currentPlan: 'Approach the locally visible arches on this public street.'
          }
        });
      }
    }),
    logger: { warn(message) { warnings.push(message); } }
  });

  const decision = await service.decide(input({ privateMemory: priorMemory }));

  assert.equal(routeAttempts, 1, warnings.join('\n'));
  assert.equal(decision.fallbackCause, null);
  assert.match(decision.memoryUpdate.currentPlan, /public street/);
});

test('connective planning words are not treated as current-sheet motifs', async () => {
  let routeAttempts = 0;
  const priorMemory = {
    ...input().privateMemory,
    partnerHypotheses: [{
      key: 'fork-coordination',
      description: 'Continue around a public route obstacle while seeking a joint decision from a directional cue at the fork.',
      confidence: 0.1,
      basisSequences: [5],
      evidenceStatus: 'unclear'
    }]
  };
  const service = new RendezvousModelService({
    client: stagedClient([], {
      route() {
        routeAttempts += 1;
        return routeResponse({
          memoryUpdate: {
            currentPlan: 'The newest sheet remains inconclusive while its directional quality remains uncertain around my local plan anchored to visible arches.'
          }
        });
      }
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input({ privateMemory: priorMemory }));

  assert.equal(routeAttempts, 1);
  assert.equal(decision.fallbackCause, null);
  assert.match(decision.memoryUpdate.currentPlan, /directional quality remains uncertain/);
});

test('a route response that fails every validation attempt cannot leak through', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      route: routeResponse({
        selectedIndex: 0,
        intendedHeading: 90,
        memoryUpdate: { currentPlan: 'Move east using my local evidence.' }
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, 'route_model_error');
  assert.equal(decision.action, 'wait');
});

test('cue-dependency detection ignores explicit rejection of permission seeking', () => {
  assert.equal(isCueDependentSearchPlan(
    'I will wait for Ada to cue me before moving.'
  ), true);
  assert.equal(isCueDependentSearchPlan(
    'Wait for Theo to signal that I should move.'
  ), true);
  assert.equal(isCueDependentSearchPlan(
    'Maintain the tree anchor; advance east when Ada signals readiness.'
  ), true);
  assert.equal(isCueDependentSearchPlan(
    'Waiting preserves flexibility while the scene clarifies whether Ada is signaling a meet point.'
  ), true);
  assert.equal(isCueDependentSearchPlan(
    'I remain here until I understand what Theo means by the newest drawing.'
  ), true);
  assert.equal(isCueDependentSearchPlan(
    'Waiting lets me anchor on local cues and any clearer sheet from Ada before moving.'
  ), true);
  assert.equal(isCueDependentSearchPlan(
    'I do not wait for Ada to cue me; I move using my own local evidence.'
  ), false);
  assert.equal(isCueDependentSearchPlan(
    'I move using local evidence while preserving flexibility for Theo’s next cue.'
  ), true);
  assert.equal(isCueDependentSearchPlan(
    'I move using local evidence and treat Theo’s next drawing as evidence, not a cue.'
  ), false);
  assert.equal(isCueDependentSearchPlan(
    'I wait one turn beside the singular clock because it is easy to recognize.'
  ), false);
});

test('own-action evidence overrides a contradictory paused drawing', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      drawing: drawingResponse({
        contributionKind: 'own_action',
        contributionEvidenceId: 'action:0',
        messageAction: 'stillness',
        drawingIntent: 'Hold at the tree anchor while keeping the diagonal route toward the storefront visible.',
        drawingPrompt: 'Draw a waiting figure at a tree anchor with a diagonal path toward a distant storefront.'
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.messageAction, 'movement');
});

test('own-action wait evidence is always rendered as stillness', () => {
  assert.equal(reconcileRendezvousContributionAction(
    'own_action',
    'My current chosen action: I chose to wait at this branch.',
    'transition',
    'Keep the fork visible while I wait.',
    'Draw two route options around a stationary figure.'
  ), 'stillness');
});

test('a static local corridor cannot force a moving subject into the drawing', () => {
  assert.equal(reconcileRendezvousContributionAction(
    'local_observation',
    'New local observation: a clear northward corridor ahead. The approach appears navigable',
    'movement',
    'Show a broad urban street receding toward the corridor.',
    'Draw the navigable approach in perspective.'
  ), 'unclear');
});

test('a genuinely moving local subject can remain movement-dominant', () => {
  assert.equal(reconcileRendezvousContributionAction(
    'local_observation',
    'New local observation: a cyclist crossing beneath the tree canopy',
    'movement',
    'Show the cyclist crossing beneath the trees.',
    'Draw the moving cyclist as the primary observed subject.'
  ), 'movement');
});

test('a single-frame local observation cannot invent a temporal transition', () => {
  assert.equal(reconcileRendezvousContributionAction(
    'local_observation',
    'New local observation: crosswalks',
    'transition',
    'Show the crosswalks.',
    'Draw before and after states around the crosswalks.'
  ), 'unclear');
});

test('a durable paused route retry is reconciled to transition', () => {
  assert.equal(reconcileRendezvousMessageAction(
    'stillness',
    'Remain at the tree anchor while keeping the diagonal route visible.',
    'Authoritative correction: show the path toward the future destination.',
    'Preserve the shared waypoint.'
  ), 'transition');
});

test('negated route cues preserve a pure stillness retry', () => {
  assert.equal(reconcileRendezvousMessageAction(
    'stillness',
    'Show that I am holding this corner.',
    'Remove the route arrow. Keep the stopped figure and barrier dominant.'
  ), 'stillness');
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
    visualHistory: [{
      sequence: 5,
      direction: 'sent',
      mimeType: 'image/webp',
      buffer: Buffer.from('prior-drawing')
    }],
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, false);
  assert.match(review.revisionPrompt, /Separate the arch groups/);
  assert.equal(requests.length, 2);
  assert.match(requests[0].messages[0].content, /without any knowledge/);
  assert.equal(requests[0].messages[1].content[0].type, 'image_url');
  assert.match(requests[1].messages[0].content, /independent recipient/);
  assert.match(requests[1].messages[0].content, /blind reading primarily describes an inherited route/);
  assert.match(requests[1].messages[0].content, /delta must read as the image's primary message/);
  assert.match(requests[1].messages[0].content, /substantially the same layout and visual hierarchy/);
  assert.match(requests[1].messages[1].content[0].text, /nearer arches now match/);
  assert.match(requests[1].messages[1].content[0].text, /deliberately continue/);
  assert.match(requests[1].messages[1].content[0].text, /context-free reading/);
  assert.match(requests[1].messages[1].content[1].text, /RECENT SHEET FOR VISUAL COMPARISON.*sequence 5/);
  assert.equal(requests[1].messages[1].content[2].type, 'image_url');
});

test('drawing review rejects an accidental near-copy even when the model accepts it', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      blindRead: {
        literalContents: ['a singular median tree appears inside a repeated triptych'],
        primarySubject: 'a singular median tree',
        likelyMessage: 'The sender sees a singular median tree.',
        dominantAction: 'movement',
        frameOfReference: 'sender',
        frameBasis: 'The observation is presented by the sender.',
        communicationFunction: 'report',
        movementCues: ['a small route arrow'],
        stillnessCues: [],
        readableText: false
      },
      review: {
        accepted: true,
        contributionPrimary: true,
        visualNovelty: 'near_copy',
        assessment: 'The same triptych and route arrow appear again.',
        revisionPrompt: ''
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Theo',
    partnerName: 'Ada',
    contributionKind: 'local_observation',
    contributionSummary: 'New local observation: a singular median tree.',
    drawingIntent: 'Show the median tree I can see.',
    informationDelta: 'New local observation: a singular median tree.',
    messageAction: 'movement',
    drawingPrompt: 'Repeat the prior triptych and add a tree.',
    groundedFeatures: ['a singular median tree'],
    visualHistory: [{
      sequence: 8,
      direction: 'received',
      mimeType: 'image/webp',
      buffer: Buffer.from('prior-triptych')
    }],
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, false);
  assert.match(review.assessment, /near_copy/);
  assert.match(review.revisionPrompt, /Replace the repeated layout/);
  assert.match(review.revisionPrompt, /one small recurring symbol/);
});

test('drawing review does not redraw a legible contribution only to reproduce inherited layout', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      blindRead: {
        literalContents: ['a figure and arrow move southeast around a median tree'],
        likelyMessage: 'Move southeast past the median tree.',
        dominantAction: 'movement',
        frameOfReference: 'sender',
        frameBasis: 'The route visibly trails from the depicted sender figure.',
        movementCues: ['southeast arrow'],
        stillnessCues: [],
        readableText: false
      },
      review: {
        accepted: false,
        contributionPrimary: true,
        materialContributionConflict: false,
        visualNovelty: 'distinct',
        assessment: 'The movement is clear, but the old grid and star triptych are absent.',
        revisionPrompt: 'Restore all three panels and the star.'
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Theo',
    partnerName: 'Ada',
    contributionKind: 'own_action',
    contributionSummary: 'My current chosen action: I chose to move southeast.',
    drawingIntent: 'Show southeast movement from a median tree.',
    informationDelta: 'My current chosen action: I chose to move southeast.',
    messageAction: 'movement',
    drawingPrompt: 'Draw southeast movement from a median tree.',
    groundedFeatures: ['move southeast', 'median tree'],
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, true);
  assert.match(review.assessment, /layout-only objection ignored/);
});

test('drawing review still rejects a material contribution conflict', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      review: {
        accepted: false,
        contributionPrimary: true,
        materialContributionConflict: true,
        visualNovelty: 'distinct',
        assessment: 'The route points northeast instead of southeast.',
        revisionPrompt: 'Point the movement southeast.'
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Theo',
    partnerName: 'Ada',
    contributionKind: 'own_action',
    contributionSummary: 'My current chosen action: I chose to move southeast.',
    drawingIntent: 'Show southeast movement.',
    informationDelta: 'My current chosen action: I chose to move southeast.',
    messageAction: 'movement',
    drawingPrompt: 'Draw southeast movement.',
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, false);
  assert.match(review.revisionPrompt, /Point the movement southeast/);
});

test('drawing review rejects enumerated text-like marks even when the reader boolean is false', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      blindRead: {
        literalContents: ['two yellow taxis wait outside storefronts'],
        primarySubject: 'yellow taxis and storefront awnings',
        likelyMessage: 'The sender sees taxis beside storefronts.',
        dominantAction: 'stillness',
        frameOfReference: 'sender',
        frameBasis: 'The street scene is presented as an observation.',
        communicationFunction: 'report',
        movementCues: [],
        stillnessCues: ['parked taxis'],
        textLikeMarks: ['the numeral 30 on a taxi roof sign'],
        readableText: false
      },
      review: {
        accepted: true,
        contributionPrimary: true,
        materialContributionConflict: false,
        visualNovelty: 'distinct',
        assessment: 'The taxis and storefronts are primary.',
        revisionPrompt: ''
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Ada',
    partnerName: 'Theo',
    contributionKind: 'local_observation',
    contributionSummary: 'New local observation: storefronts and yellow taxis.',
    drawingIntent: 'Show storefronts and yellow taxis.',
    informationDelta: 'New local observation: storefronts and yellow taxis.',
    messageAction: 'stillness',
    drawingPrompt: 'Draw yellow taxis outside storefronts without text.',
    groundedFeatures: ['storefronts and yellow taxis'],
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, false);
  assert.equal(review.blindRead.readableText, true);
  assert.deepEqual(review.blindRead.textLikeMarks, ['the numeral 30 on a taxi roof sign']);
  assert.match(review.revisionPrompt, /Remove every readable word, letter, number/);
});

test('own-action drawing review rejects a recipient-framed command', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      blindRead: {
        literalContents: ['a large arrow points away from the viewer'],
        likelyMessage: 'The recipient should proceed in the arrow direction.',
        dominantAction: 'movement',
        frameOfReference: 'recipient',
        frameBasis: 'The arrow is aimed outward from the viewer with no acting subject.',
        communicationFunction: 'directive',
        movementCues: ['large outward arrow'],
        stillnessCues: [],
        readableText: false
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Theo',
    partnerName: 'Ada',
    contributionKind: 'own_action',
    contributionSummary: 'My current chosen action: I chose to move southeast.',
    drawingIntent: 'Show the movement I chose.',
    informationDelta: 'My current chosen action: I chose to move southeast.',
    messageAction: 'movement',
    drawingPrompt: 'Draw a large southeast arrow.',
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, false);
  assert.match(review.assessment, /prospective arrow.*frame was labeled recipient/i);
  assert.match(review.revisionPrompt, /Remove every standalone or forward-projecting arrow/);
  assert.match(review.revisionPrompt, /completed motion behind/);
  assert.equal(requests.length, 1);
});

test('own-action drawing review rejects a generic scene with unclear authorship', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      blindRead: {
        literalContents: [
          'a busy avenue with pedestrians, vehicles, and a foreground crosswalk'
        ],
        primarySubject: 'a crowded city crossing framed by tall buildings',
        likelyMessage: 'A snapshot of a typical urban commute or street life.',
        dominantAction: 'movement',
        frameOfReference: 'unclear',
        frameBasis: 'No person or trail is distinguished as the sender.',
        communicationFunction: 'unclear',
        movementCues: ['pedestrians and vehicles moving through the crossing'],
        stillnessCues: [],
        readableText: false
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Theo',
    partnerName: 'Ada',
    contributionKind: 'own_action',
    contributionSummary: 'My current chosen action: I chose to move northeast.',
    drawingIntent: 'Report my chosen movement through the city.',
    informationDelta: 'My current chosen action: I chose to move northeast.',
    messageAction: 'movement',
    drawingPrompt: 'Draw a busy city crossing with movement along the avenue.',
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, false);
  assert.match(review.assessment, /unclear.*not clearly the sender's own action/);
  assert.match(review.revisionPrompt, /completed motion behind/);
  assert.equal(requests.length, 1);
});

test('repeating an own action retains sender-frame review', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      blindRead: {
        literalContents: [
          'a runner advances beneath a large red arrow on a broad avenue'
        ],
        primarySubject: 'a large forward arrow projected down the avenue',
        likelyMessage: 'A forward-directed cue urging movement along a path.',
        dominantAction: 'movement',
        frameOfReference: 'recipient',
        frameBasis: 'The arrow projects ahead as the viewer\'s next action.',
        communicationFunction: 'deliberate_repetition',
        movementCues: ['a large arrow pointing ahead'],
        stillnessCues: [],
        readableText: false
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Ada',
    partnerName: 'Theo',
    contributionKind: 'deliberate_repetition',
    contributionSummary:
      'Deliberately repeating existing visual evidence without treating it as new: My current chosen action: I chose to move northeast along the selected public route.',
    drawingIntent: 'Signal continued movement along the broad public axis ahead.',
    informationDelta:
      'Deliberately repeating existing visual evidence without treating it as new: My current chosen action: I chose to move northeast along the selected public route.',
    continuityReason: 'The unchanged movement report is useful to repeat.',
    messageAction: 'movement',
    drawingPrompt: 'Draw a runner beneath a large forward arrow on a broad avenue.',
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, false);
  assert.match(review.assessment, /prospective arrow.*frame was labeled recipient/i);
  assert.match(review.revisionPrompt, /Remove every standalone or forward-projecting arrow/);
  assert.equal(requests.length, 1);
});

test('a sender-labeled action still rejects a prospective standalone arrow', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      blindRead: {
        literalContents: [
          'a yellow taxi beneath a large northeast arrow on an otherwise empty road'
        ],
        primarySubject: 'a yellow taxi moving toward a large northeast arrow',
        likelyMessage: 'Move northeast along the open road.',
        dominantAction: 'movement',
        frameOfReference: 'sender',
        frameBasis: 'The taxi may stand for the sender, but the arrow projects ahead.',
        communicationFunction: 'report',
        movementCues: ['a large arrow pointing northeast', 'a taxi moving forward'],
        stillnessCues: [],
        readableText: false
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Theo',
    partnerName: 'Ada',
    contributionKind: 'deliberate_repetition',
    contributionSummary:
      'Deliberately repeating existing visual evidence without treating it as new: My current chosen action: I chose to move northeast along the selected public route.',
    drawingIntent: 'Repeat my northeast movement report.',
    informationDelta:
      'Deliberately repeating existing visual evidence without treating it as new: My current chosen action: I chose to move northeast along the selected public route.',
    continuityReason: 'The unchanged movement report is useful to repeat.',
    messageAction: 'movement',
    drawingPrompt: 'Draw a taxi traveling beneath a large northeast arrow.',
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, false);
  assert.match(review.assessment, /prospective arrow without a completed sender trail/i);
  assert.match(review.revisionPrompt, /Remove every standalone or forward-projecting arrow/i);
  assert.match(review.revisionPrompt, /completed motion behind/i);
  assert.equal(requests.length, 1);
});

test('own-action drawing review permits an intrinsically ambiguous retrospective report', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      blindRead: {
        literalContents: ['a person walks away with footprints trailing behind'],
        primarySubject: 'a walking person with a completed trail of footprints',
        likelyMessage: 'Someone has departed and is continuing through the street.',
        dominantAction: 'movement',
        frameOfReference: 'recipient',
        frameBasis: 'The person is seen from behind, so the exact role remains ambiguous.',
        communicationFunction: 'unclear',
        movementCues: ['footprints behind the walking person'],
        stillnessCues: [],
        readableText: false
      },
      review: {
        accepted: true,
        contributionPrimary: true,
        materialContributionConflict: false,
        visualNovelty: 'distinct',
        assessment: 'The completed trail makes the sender movement report primary.',
        revisionPrompt: ''
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Theo',
    partnerName: 'Ada',
    contributionKind: 'own_action',
    contributionSummary: 'My current chosen action: I chose to move northeast.',
    drawingIntent: 'Report my completed movement.',
    informationDelta: 'My current chosen action: I chose to move northeast.',
    messageAction: 'movement',
    drawingPrompt: 'Draw a person moving with a fading trail behind them.',
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, true);
  assert.equal(requests.length, 2);
});

test('response review rejects route guidance that contradicts explicit uncertainty', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      blindRead: {
        literalContents: ['a large arrow rises from a sheet toward the upper-left'],
        primarySubject: 'a dominant up-left arrow',
        likelyMessage: 'The viewer should move or look toward the upper-left.',
        dominantAction: 'transition',
        frameOfReference: 'recipient',
        frameBasis: 'A standalone arrow projects outward as the viewer action.',
        communicationFunction: 'directive',
        movementCues: ['large directional arrow'],
        stillnessCues: [],
        readableText: false
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Ada',
    partnerName: 'Theo',
    contributionKind: 'response',
    contributionSummary:
      'My response to the received drawing: New urban-movement cue from sheet; does not establish a concrete local route to copy.',
    drawingIntent: 'Acknowledge the cue while preserving uncertainty about its meaning.',
    informationDelta:
      'New urban-movement cue from sheet; does not establish a concrete local route to copy.',
    messageAction: 'unclear',
    drawingPrompt: 'Draw a sheet with a dominant arrow pointing upper-left.',
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, false);
  assert.match(review.assessment, /route guidance.*explicitly withholds route certainty/);
  assert.match(review.revisionPrompt, /Remove arrows, paths/);
  assert.match(review.revisionPrompt, /unresolved relationship itself visually primary/);
  assert.equal(requests.length, 1);
});

test('response review preserves sender framing unless the response explicitly directs the recipient', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      blindRead: {
        literalContents: ['a large arrow points forward along an avenue'],
        primarySubject: 'a dominant forward arrow projected down the street',
        likelyMessage: 'The viewer should proceed straight along the indicated route.',
        dominantAction: 'movement',
        frameOfReference: 'shared',
        frameBasis: 'The arrow continues ahead of the viewer with no acting sender.',
        communicationFunction: 'directive',
        movementCues: ['large forward arrow'],
        stillnessCues: [],
        readableText: false
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Ada',
    partnerName: 'Theo',
    contributionKind: 'response',
    contributionSummary:
      'My response to the received drawing: Grounded local continuation decision toward a new street axis; avoids copying the drawn route.',
    drawingIntent: 'Report the locally grounded continuation I chose.',
    informationDelta: 'I chose a new local continuation.',
    messageAction: 'movement',
    drawingPrompt: 'Draw a large arrow sweeping forward down an avenue.',
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, false);
  assert.match(review.assessment, /sender-framed response as route guidance/);
  assert.match(review.revisionPrompt, /sender observed, concluded, chose, or did/);
  assert.match(review.revisionPrompt, /Remove any standalone arrow/);
  assert.equal(requests.length, 1);
});

test('question review requires both sides of a stop-versus-move contrast', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      blindRead: {
        literalContents: [
          'a central figure faces arrows pointing left, right, and straight'
        ],
        primarySubject: 'a question mark surrounded by three route arrows',
        likelyMessage: 'The viewer is asked which direction to take.',
        dominantAction: 'transition',
        frameOfReference: 'recipient',
        frameBasis: 'All arrows project ahead of the viewer.',
        communicationFunction: 'request',
        movementCues: ['three directional arrows'],
        stillnessCues: [],
        readableText: false
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Ada',
    partnerName: 'Theo',
    contributionKind: 'question',
    contributionSummary:
      'Question I am sending: Does Theo intend to stop at the crossroads, or continue moving through it?',
    drawingIntent: 'Ask whether Theo will stop or continue.',
    informationDelta: 'Does Theo intend to stop or continue moving?',
    messageAction: 'unclear',
    drawingPrompt: 'Draw a figure facing left, right, and forward arrows.',
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, false);
  assert.match(review.assessment, /both sides.*stillness-versus-movement/);
  assert.match(review.revisionPrompt, /stationary.*moving/s);
  assert.match(review.revisionPrompt, /do not substitute a left-versus-right route choice/);
  assert.equal(requests.length, 1);
});

test('acknowledgement drawing review rejects a replay that reads as a movement report', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      blindRead: {
        literalContents: ['a backpacked figure follows an arrow along a sidewalk'],
        likelyMessage: 'A person is moving forward along the indicated route.',
        dominantAction: 'movement',
        frameOfReference: 'sender',
        frameBasis: 'The walking figure is embedded in the route scene.',
        communicationFunction: 'report',
        movementCues: ['walking figure', 'forward arrow'],
        stillnessCues: [],
        readableText: false
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Theo',
    partnerName: 'Ada',
    contributionKind: 'acknowledgement',
    contributionSummary: 'Acknowledging the received walking figure and arrow.',
    drawingIntent: 'Show that I recognized the received route scene.',
    informationDelta: 'Acknowledging the received walking figure and arrow.',
    continuityReason: 'I want Ada to know I understood the image.',
    messageAction: 'movement',
    drawingPrompt: 'Redraw the same walking figure and arrow.',
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, false);
  assert.match(review.assessment, /report, not an acknowledgement/);
  assert.match(review.revisionPrompt, /function as a response/);
});

test('local-observation review rejects a chase scene that relegates the landmark to background', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      blindRead: {
        literalContents: ['a large foreground runner chases a smaller figure past sidewalk trees'],
        primarySubject: 'a foreground runner urgently chasing another person',
        likelyMessage: 'An urgent pursuit moves down the street.',
        dominantAction: 'movement',
        frameOfReference: 'unclear',
        frameBasis: 'The figures dominate the scene.',
        communicationFunction: 'report',
        movementCues: ['two running figures', 'speed lines'],
        stillnessCues: [],
        readableText: false
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Theo',
    partnerName: 'Ada',
    contributionKind: 'local_observation',
    contributionSummary: 'New local observation: trees lining the sidewalk',
    drawingIntent: 'Show the trees lining the sidewalk.',
    informationDelta: 'New local observation: trees lining the sidewalk',
    messageAction: 'movement',
    drawingPrompt: 'Draw a runner moving through a tree-lined street.',
    groundedFeatures: ['trees lining the sidewalk'],
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, false);
  assert.match(review.assessment, /foreground runner.*primary/);
  assert.match(review.revisionPrompt, /foreground runner urgently chasing another person/);
  assert.match(review.revisionPrompt, /observation itself.*largest/);
});

test('local-observation review rejects an invented clock dominating generic street evidence', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      blindRead: {
        literalContents: [
          'an ornate clock on a pedestal surrounded by pedestrians, cars, and a crosswalk'
        ],
        primarySubject:
          'The ornate clock pedestal in the middle of a busy urban street, with people and traffic framing it.',
        likelyMessage:
          'A public clock may be a meeting point or signal a moment of synchronization.',
        dominantAction: 'stillness',
        frameOfReference: 'recipient',
        frameBasis: 'The clock is the largest and most detailed subject.',
        communicationFunction: 'report',
        movementCues: [],
        stillnessCues: ['central stationary clock'],
        readableText: false
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Ada',
    partnerName: 'Theo',
    contributionKind: 'local_observation',
    contributionSummary:
      'New local observation: Pedestrians and vehicles are present, suggesting a busy street',
    drawingIntent: 'Show pedestrians and vehicles on a busy street.',
    informationDelta:
      'New local observation: Pedestrians and vehicles are present, suggesting a busy street',
    messageAction: 'stillness',
    drawingPrompt:
      'Draw a busy street with pedestrians, vehicles, and a central decorative clock.',
    groundedFeatures: [
      'Pedestrians and vehicles are present, suggesting a busy street'
    ],
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, false);
  assert.match(review.assessment, /uncited distinctive subject.*ornate clock pedestal/i);
  assert.match(review.revisionPrompt, /invented or unsupported focal subject/i);
  assert.match(review.revisionPrompt, /abandon this contribution/i);
});

test('local-observation review accepts a clock when the clock is cited local evidence', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      blindRead: {
        literalContents: [
          'an ornate clock on a pedestal surrounded by pedestrians, cars, and a crosswalk'
        ],
        primarySubject:
          'The ornate clock pedestal in the middle of a busy urban street, with people and traffic framing it.',
        likelyMessage: 'The sender sees a distinctive public clock at a busy crossing.',
        dominantAction: 'stillness',
        frameOfReference: 'sender',
        frameBasis: 'The observed clock is the largest and most detailed subject.',
        communicationFunction: 'report',
        movementCues: [],
        stillnessCues: ['central stationary clock'],
        readableText: false
      },
      review: {
        accepted: true,
        contributionPrimary: true,
        materialContributionConflict: false,
        visualNovelty: 'distinct',
        assessment: 'The cited clock is visually primary.',
        revisionPrompt: ''
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Ada',
    partnerName: 'Theo',
    contributionKind: 'local_observation',
    contributionSummary:
      'New local observation: ornate sidewalk clock on a pedestal at a busy crossing',
    drawingIntent: 'Show the ornate clock on its pedestal.',
    informationDelta:
      'New local observation: ornate sidewalk clock on a pedestal at a busy crossing',
    messageAction: 'stillness',
    drawingPrompt: 'Draw the observed ornate sidewalk clock on its pedestal.',
    groundedFeatures: [
      'ornate sidewalk clock on a pedestal at a busy crossing'
    ],
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, true);
});

test('local-observation review recognizes a river from a shoreline drawing', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      blindRead: {
        literalContents: ['a broad water edge with a tree-lined shoreline'],
        primarySubject: 'water and shoreline with trees',
        likelyMessage: 'The sender is beside a broad body of water.',
        dominantAction: 'stillness',
        frameOfReference: 'sender',
        frameBasis: 'The water fills most of the composition.',
        communicationFunction: 'report',
        movementCues: [],
        stillnessCues: ['broad still water'],
        readableText: false
      },
      review: {
        accepted: true,
        contributionPrimary: true,
        materialContributionConflict: false,
        visualNovelty: 'distinct',
        assessment: 'The waterfront is the primary observation.',
        revisionPrompt: ''
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Theo',
    partnerName: 'Ada',
    contributionKind: 'local_observation',
    contributionSummary:
      'New local observation: river or water body visible to the right',
    drawingIntent: 'Show the river or water body visible to the right.',
    informationDelta:
      'New local observation: river or water body visible to the right',
    messageAction: 'stillness',
    drawingPrompt: 'Draw the broad water edge as the dominant observed landmark.',
    groundedFeatures: ['river or water body visible to the right'],
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, true);
});

test('local-observation review recognizes a midtown-scale urban canyon', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      blindRead: {
        literalContents: ['a narrow street canyon between tall rows of buildings'],
        primarySubject: 'a narrow urban canyon formed by tall buildings',
        likelyMessage: 'The sender is observing a dense high-rise district.',
        dominantAction: 'stillness',
        frameOfReference: 'sender',
        frameBasis: 'The balanced building rows dominate the image.',
        communicationFunction: 'report',
        movementCues: [],
        stillnessCues: ['balanced static building rows'],
        readableText: false
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Theo',
    partnerName: 'Ada',
    contributionKind: 'local_observation',
    contributionSummary: 'New local observation: urban midtown-scale street scene',
    drawingIntent: 'Show the scale and rhythm of the surrounding buildings.',
    informationDelta: 'New local observation: urban midtown-scale street scene',
    messageAction: 'stillness',
    drawingPrompt: 'Draw balanced rows of tall buildings.',
    groundedFeatures: ['urban midtown-scale street scene'],
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, true);
});

test('local-observation review recognizes a distant city along a perspective axis', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      blindRead: {
        literalContents: ['a long road receding from the foreground toward a distant city'],
        primarySubject: 'the long road/axis leading from foreground to the distant city',
        likelyMessage: 'The sender sees a distant skyline at the end of a long central road.',
        dominantAction: 'unclear',
        frameOfReference: 'sender',
        frameBasis: 'The road and skyline form a static perspective study.',
        communicationFunction: 'report',
        movementCues: [],
        stillnessCues: ['static distant skyline'],
        readableText: false
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Theo',
    partnerName: 'Ada',
    contributionKind: 'local_observation',
    contributionSummary: 'New local observation: Distant city core visible along a central axis',
    drawingIntent: 'Show the distant city core along the central axis.',
    informationDelta: 'New local observation: Distant city core visible along a central axis',
    messageAction: 'unclear',
    drawingPrompt: 'Draw a distant city core visible along a central axis.',
    groundedFeatures: ['Distant city core visible along a central axis'],
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, true);
});

test('local-observation review requires the perspective axis as well as the skyline', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      blindRead: {
        literalContents: ['a distant city skyline inside a circular opening surrounded by trees'],
        primarySubject: 'distant city skyline framed by a circular pass-through with surrounding trees',
        likelyMessage: 'The sender sees a city through a circular opening.',
        dominantAction: 'stillness',
        frameOfReference: 'sender',
        frameBasis: 'The circular opening dominates the composition.',
        communicationFunction: 'report',
        movementCues: [],
        stillnessCues: ['static circular frame'],
        readableText: false
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Theo',
    partnerName: 'Ada',
    contributionKind: 'local_observation',
    contributionSummary: 'New local observation: Distant city core visible along a central axis',
    drawingIntent: 'Show the distant city core along the central axis.',
    informationDelta: 'New local observation: Distant city core visible along a central axis',
    messageAction: 'unclear',
    drawingPrompt: 'Draw a distant city core visible along a central axis.',
    groundedFeatures: ['Distant city core visible along a central axis'],
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, false);
  assert.match(review.assessment, /circular pass-through.*not the cited local observation/);
});

test('local-observation review recognizes a skyline framed by a receding avenue', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      blindRead: {
        literalContents: ['a tree-lined avenue framing a distant skyline'],
        primarySubject: 'the distant city skyline framed by the tree-lined avenue',
        likelyMessage: 'The sender sees a city core at the end of an avenue.',
        dominantAction: 'unclear',
        frameOfReference: 'sender',
        frameBasis: 'The avenue and skyline form a static perspective.',
        communicationFunction: 'report',
        movementCues: [],
        stillnessCues: ['static skyline'],
        readableText: false
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Theo',
    partnerName: 'Ada',
    contributionKind: 'local_observation',
    contributionSummary: 'New local observation: Distant city core visible along a central axis',
    drawingIntent: 'Show the distant city core along the central axis.',
    informationDelta: 'New local observation: Distant city core visible along a central axis',
    messageAction: 'unclear',
    drawingPrompt: 'Draw a distant city core visible along a central axis.',
    groundedFeatures: ['Distant city core visible along a central axis'],
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, true);
});

test('local-observation review recognizes a continuous avenue-axis paraphrase', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      blindRead: {
        literalContents: [
          'a long straight avenue lined with trees and street furniture'
        ],
        primarySubject:
          'Long, straight avenue lined with trees and street furniture, receding toward the city center',
        likelyMessage: 'The sender sees a continuous avenue leading into the city.',
        dominantAction: 'unclear',
        frameOfReference: 'sender',
        frameBasis: 'The avenue is the central static subject.',
        communicationFunction: 'report',
        movementCues: [],
        stillnessCues: ['static avenue perspective'],
        readableText: false
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Ada',
    partnerName: 'Theo',
    contributionKind: 'local_observation',
    contributionSummary:
      'New local observation: a visible avenue layout suggesting a continuous public axis toward the city.',
    drawingIntent: 'Show the continuous avenue axis through the city.',
    informationDelta:
      'New local observation: a visible avenue layout suggesting a continuous public axis toward the city.',
    messageAction: 'unclear',
    drawingPrompt: 'Draw a long avenue as a continuous perspective axis.',
    groundedFeatures: ['a visible avenue layout suggesting a continuous public axis toward the city'],
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, true);
});

test('local-observation review recognizes a distant focal building along an axis', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      blindRead: {
        literalContents: ['an avenue receding toward a distant building'],
        primarySubject: 'the central perspective of an avenue receding to a distant building',
        likelyMessage: 'The sender sees a continuous public axis toward a distant focal point.',
        dominantAction: 'unclear',
        frameOfReference: 'sender',
        frameBasis: 'The avenue and building form a static perspective study.',
        communicationFunction: 'report',
        movementCues: [],
        stillnessCues: ['static avenue and distant building'],
        readableText: false
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Ada',
    partnerName: 'Theo',
    contributionKind: 'local_observation',
    contributionSummary: 'New local observation: General sense of a continuous public axis toward a distant focal point',
    drawingIntent: 'Show the continuous public axis toward a distant focal point.',
    informationDelta: 'New local observation: General sense of a continuous public axis toward a distant focal point',
    messageAction: 'unclear',
    drawingPrompt: 'Draw a static avenue receding toward a distant focal building.',
    groundedFeatures: ['General sense of a continuous public axis toward a distant focal point'],
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, true);
});

test('local-observation focal-landmark review still requires the perspective axis', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      blindRead: {
        literalContents: ['a distant building framed inside a circular opening'],
        primarySubject: 'the circular opening framing a distant building',
        likelyMessage: 'The sender sees a distant building through a round frame.',
        dominantAction: 'stillness',
        frameOfReference: 'sender',
        frameBasis: 'The circular opening dominates the composition.',
        communicationFunction: 'report',
        movementCues: [],
        stillnessCues: ['static circular frame'],
        readableText: false
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Ada',
    partnerName: 'Theo',
    contributionKind: 'local_observation',
    contributionSummary: 'New local observation: General sense of a continuous public axis toward a distant focal point',
    drawingIntent: 'Show the continuous public axis toward a distant focal point.',
    informationDelta: 'New local observation: General sense of a continuous public axis toward a distant focal point',
    messageAction: 'unclear',
    drawingPrompt: 'Draw a static avenue receding toward a distant focal building.',
    groundedFeatures: ['General sense of a continuous public axis toward a distant focal point'],
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, false);
  assert.match(review.assessment, /circular opening.*not the cited local observation/);
});

test('local-observation review rejects a generic crosswalk despite matching wording', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      blindRead: {
        literalContents: ['a crosswalk spans a street extending into the city'],
        primarySubject: 'the crosswalk and the street extending into the city',
        likelyMessage: 'A crosswalk is visible before a continuing street.',
        dominantAction: 'unclear',
        frameOfReference: 'unclear',
        frameBasis: 'No acting subject is present.',
        communicationFunction: 'report',
        movementCues: [],
        stillnessCues: [],
        readableText: false
      },
      review: {
        accepted: true,
        contributionPrimary: true,
        materialContributionConflict: false,
        visualNovelty: 'distinct',
        assessment: 'The crosswalk is the primary observed feature.',
        revisionPrompt: ''
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Ada',
    partnerName: 'Theo',
    contributionKind: 'local_observation',
    contributionSummary: 'New local observation: crosswalk markings visible ahead',
    drawingIntent: 'Show the crosswalk markings.',
    informationDelta: 'New local observation: crosswalk markings visible ahead',
    messageAction: 'unclear',
    drawingPrompt: 'Sketch crosswalk markings visible ahead.',
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, false);
  assert.match(review.assessment, /not the cited local observation/);
  assert.equal(requests.length, 1);
});

test('local-question review rejects a generic route choice that displaces its city-axis subject', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      blindRead: {
        literalContents: [
          'a person faces three diverging roads, two arrows, a question mark, and a distant city'
        ],
        primarySubject:
          'a crossroads choice between forest, rocky, and central routes toward a city',
        likelyMessage: 'Which route should the viewer take toward the city?',
        dominantAction: 'movement',
        frameOfReference: 'recipient',
        frameBasis: 'The arrows and diverging roads address the viewer.',
        communicationFunction: 'request',
        movementCues: ['two route arrows', 'three diverging roads'],
        stillnessCues: [],
        readableText: false
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Theo',
    partnerName: 'Ada',
    contributionKind: 'question',
    contributionEvidenceId: 'question_local:0',
    contributionSummary:
      'Question I am sending about this local evidence: Distant city core along a central axis',
    drawingIntent: 'Ask about the distant city core along the central axis.',
    informationDelta:
      'Question I am sending about this local evidence: Distant city core along a central axis',
    messageAction: 'movement',
    drawingPrompt: 'Draw a route question around the city.',
    groundedFeatures: ['Distant city core along a central axis'],
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, false);
  assert.match(review.assessment, /not the local subject cited by the question/);
});

test('local-question review retains a city-axis subject in a genuine comparison', async () => {
  const service = new RendezvousModelService({
    client: stagedClient([], {
      blindRead: {
        literalContents: ['a distant skyline centered at the end of one receding avenue'],
        primarySubject: 'a distant city skyline framed by a central avenue',
        likelyMessage: 'Does the recipient recognize this skyline and avenue relationship?',
        dominantAction: 'unclear',
        frameOfReference: 'sender',
        frameBasis: 'The skyline and avenue dominate the page.',
        communicationFunction: 'question',
        movementCues: [],
        stillnessCues: ['static skyline'],
        readableText: false
      }
    }),
    logger: { warn() {} }
  });

  const review = await service.reviewDrawing({
    agentName: 'Theo',
    partnerName: 'Ada',
    contributionKind: 'question',
    contributionEvidenceId: 'question_local:0',
    contributionSummary:
      'Question I am sending about this local evidence: Distant city core along a central axis',
    drawingIntent: 'Ask whether Ada recognizes this skyline and avenue relationship.',
    informationDelta:
      'Question I am sending about this local evidence: Distant city core along a central axis',
    messageAction: 'unclear',
    drawingPrompt: 'Draw the skyline and central avenue as an unresolved comparison.',
    groundedFeatures: ['Distant city core along a central axis'],
    imageBuffer: Buffer.from('generated-image')
  });

  assert.equal(review.accepted, true);
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

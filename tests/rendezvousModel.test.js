import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isCueDependentSearchPlan,
  RendezvousModelService,
  reconcileRendezvousMessageAction,
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
    sheetReconciliation: {
      currentSenderAction: 'movement',
      currentSenderActionBasis: 'A small figure visibly approaches the nearer arches.',
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
    drawingIntent: 'Tell Theo that I see matching arches and intend to investigate them.',
    informationDelta: 'I now see three matching arches beside a suspended traffic light.',
    continuityReason: 'Repeating the arches links this observation to Theo’s earlier motif.',
    messageAction: 'movement',
    drawingPrompt: 'Draw two groups of arches echoing each other, with one small figure moving toward the nearer group and a large uncertain circle above the distant group.',
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
          } else if (/without any knowledge of what its sender intended/.test(prompt)) {
            payload = overrides.blindRead || {
              literalContents: ['two separated arch groups and a moving figure'],
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
  assert.match(decision.drawingIntent, /intend to investigate/);
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
  assert.equal(decision.messageAction, 'movement');
  assert.match(decision.drawingPrompt, /figure moving/);

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

test('drawing planner normalizes a mismatched contribution kind to its cited evidence', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      drawing: drawingResponse({
        contributionKind: 'local_observation',
        contributionEvidenceId: 'received:0',
        contributionSummary: 'I am claiming the received arch motif as my own observation.'
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.contributionKind, 'acknowledgement');
  assert.equal(decision.contributionEvidenceId, 'received:0');
  assert.match(decision.contributionSummary, /without claiming it as my own/);
  assert.match(decision.contributionSummary, /bright circle/);
  assert.equal(decision.informationDelta, decision.contributionSummary);
  assert.match(decision.drawingPrompt, /figure moving/);
  assert.equal(requests.filter(request =>
    /currently hold the one physical sheet/.test(request.messages[0].content)
  ).length, 1);
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
        drawingIntent: 'Anchor at Bowery/Prince and continue toward Delancey.',
        drawingPrompt: 'Draw Bowery/Prince with a tree, then follow Delancey St east.',
        continuityReason: 'The Bowery/Prince anchor connects to Delancey.',
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
  assert.doesNotMatch(outbound, /Bowery|Prince|Delancey/);
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
  assert.match(decision.drawingIntent, /leaving the inherited "star" motif unresolved/);
  assert.match(decision.drawingPrompt, /Do not depict the inherited "star" motif as a destination/);
  assert.match(decision.drawingPrompt, /three repeated stone arches/);
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
  assert.match(catalogText, /beside the river/);
  assert.doesNotMatch(catalogText, /Bowery|Prince|FDR Drive/);
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
    'I do not wait for Ada to cue me; I move using my own local evidence.'
  ), false);
  assert.equal(isCueDependentSearchPlan(
    'I wait one turn beside the singular clock because it is easy to recognize.'
  ), false);
});

test('a paused route drawing is reconciled to transition before image review', async () => {
  const requests = [];
  const service = new RendezvousModelService({
    client: stagedClient(requests, {
      drawing: drawingResponse({
        messageAction: 'stillness',
        drawingIntent: 'Hold at the tree anchor while keeping the diagonal route toward the storefront visible.',
        drawingPrompt: 'Draw a waiting figure at a tree anchor with a diagonal path toward a distant storefront.'
      })
    }),
    logger: { warn() {} }
  });

  const decision = await service.decide(input());

  assert.equal(decision.fallbackCause, null);
  assert.equal(decision.messageAction, 'transition');
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
  assert.match(review.assessment, /recipient.*not clearly the sender's own action/);
  assert.match(review.revisionPrompt, /Avoid a standalone command-like arrow/);
  assert.equal(requests.length, 1);
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

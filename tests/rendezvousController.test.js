import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  areAgentsStreetViewAdjacent,
  composeDrawingRevisionPrompt,
  isAgentPositionPathConsistent,
  RendezvousController,
  isShortPanoLoop
} from '../server/rendezvous/rendezvousController.js';
import {
  commitRasterScratchpadMessage,
  createRasterScratchpad,
  queueRasterScratchpadMessage
} from '../server/rendezvous/scratchpad.js';
import { RENDEZVOUS_MEMORY_VERSION } from '../server/rendezvous/rendezvousMemory.js';

function distance(pos1, pos2) {
  const lat1 = Number(pos1.lat);
  const lng1 = Number(pos1.lng);
  const lat2 = Number(pos2.lat);
  const lng2 = Number(pos2.lng);
  const earthRadius = 6371e3;
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const deltaPhi = (lat2 - lat1) * Math.PI / 180;
  const deltaLambda = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(deltaPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

class FakeStreetView {
  constructor() {
    this.currentPanoId = null;
    this.heading = 0;
    this.nodes = new Map([
      ['ada-start', {
        panoId: 'ada-start',
        position: { lat: 40.759011, lng: -73.984472 },
        links: [
          { pano: 'ada-mid', heading: 170, description: 'toward the library blocks' },
          { pano: 'ada-away', heading: 310, description: 'back toward theater lights' }
        ]
      }],
      ['ada-away', {
        panoId: 'ada-away',
        position: { lat: 40.761, lng: -73.987 },
        links: [{ pano: 'ada-start', heading: 130, description: 'return to the avenue' }]
      }],
      ['ada-mid', {
        panoId: 'ada-mid',
        position: { lat: 40.7559, lng: -73.9838 },
        links: [
          { pano: 'target', heading: 175, description: 'park edge ahead' },
          { pano: 'ada-start', heading: 350, description: 'back north' }
        ]
      }],
      ['theo-start', {
        panoId: 'theo-start',
        position: { lat: 40.750298, lng: -73.977873 },
        links: [
          { pano: 'theo-mid', heading: 300, description: 'toward the library lawn' },
          { pano: 'theo-away', heading: 90, description: 'toward the terminal traffic' }
        ]
      }],
      ['theo-away', {
        panoId: 'theo-away',
        position: { lat: 40.7505, lng: -73.974 },
        links: [{ pano: 'theo-start', heading: 270, description: 'back west' }]
      }],
      ['theo-mid', {
        panoId: 'theo-mid',
        position: { lat: 40.7522, lng: -73.9805 },
        links: [
          { pano: 'target', heading: 300, description: 'park and library signs' },
          { pano: 'theo-start', heading: 110, description: 'back east' }
        ]
      }],
      ['target', {
        panoId: 'target',
        position: { lat: 40.753596, lng: -73.983233 },
        links: [
          { pano: 'ada-mid', heading: 355, description: 'north edge' },
          { pano: 'theo-mid', heading: 115, description: 'east edge' }
        ]
      }]
    ]);
  }

  async initialize() {}

  async close() {}

  async getPanorama(positionOrPanoId) {
    if (typeof positionOrPanoId === 'string') {
      const node = this.nodes.get(positionOrPanoId);
      if (!node) throw new Error(`No fake pano ${positionOrPanoId}`);
      return structuredClone(node);
    }

    const closest = Array.from(this.nodes.values())
      .map(node => ({ node, distance: distance(positionOrPanoId, node.position) }))
      .sort((a, b) => a.distance - b.distance)[0]?.node;
    if (!closest) throw new Error('No fake pano for coordinate');
    return structuredClone(closest);
  }

  async navigateAndGetPanorama(panoId) {
    this.currentPanoId = panoId;
    return this.getPanorama(panoId);
  }

  async setHeading(heading) {
    this.heading = heading;
  }

  async getScreenshot() {
    return Buffer.from(`fake-street-view-${this.currentPanoId}-${this.heading}`);
  }
}

class FakeRendezvousModel {
  constructor() {
    this.calls = [];
  }

  async decide(input) {
    this.calls.push(structuredClone({
      agent: input.agent,
      partnerName: input.partnerName,
      options: input.options,
      privateMemory: input.privateMemory,
      movementSinceDecision: input.movementSinceDecision,
      allowWait: input.allowWait,
      consecutiveWaitDecisions: input.consecutiveWaitDecisions,
      sheetMessage: input.sheetMessage,
      visualHistory: input.visualHistory.map(item => ({
        sequence: item.sequence,
        direction: item.direction,
        content: item.buffer.toString()
      }))
    }));
    return {
      action: 'move',
      selectedIndex: input.options.findIndex(option => !input.agent.visitedPanos.includes(option.panoId)) >= 0
        ? input.options.findIndex(option => !input.agent.visitedPanos.includes(option.panoId))
        : 0,
      reasoning: `${input.agent.name} follows the clearest unfamiliar public route using only the sheet and the visible street.`,
      observation: `${input.agent.name} sees a broad public route beside a stone facade.`,
      observedFeatures: ['a broad public road', 'a stone facade beside it'],
      drawingGroundedFeatures: ['a broad public road', 'a stone facade beside it'],
      contributionKind: 'local_observation',
      contributionEvidenceId: 'local:0',
      contributionSummary: `${input.agent.name} can show the broad public road now visible here.`,
      sheetInterpretation: `${input.agent.name} thinks the current sheet suggests convergence.`,
      sheetConfidence: 0.35,
      memoryUpdate: {
        currentPlan: 'Keep moving while exchanging grounded landmarks.',
        conventionUpdate: {
          key: 'circle',
          description: 'A circle may indicate convergence.',
          confidence: 0.35,
          basisSequences: input.sheetMessage?.sequence ? [input.sheetMessage.sequence] : []
        }
      },
      drawingIntent: `${input.agent.name} intends to show a grounded route toward convergence.`,
      drawingPrompt: `A grounded hand sketch chosen by ${input.agent.name}`,
      fallbackCause: null
    };
  }
}

class ScriptedRendezvousModel extends FakeRendezvousModel {
  constructor(decision) {
    super();
    this.decision = decision;
  }

  async decide(input) {
    await super.decide(input);
    return {
      action: 'move',
      selectedIndex: 0,
      reasoning: 'I make a cooperative choice from what I remember.',
      observation: 'A grounded public landmark is visible at this branch.',
      observedFeatures: ['a grounded public landmark', 'a traffic light beside it'],
      drawingGroundedFeatures: ['a grounded public landmark', 'a traffic light beside it'],
      sheetInterpretation: 'The received drawing may indicate convergence near a landmark.',
      sheetConfidence: 0.35,
      memoryUpdate: {
        currentPlan: 'Coordinate movement and deliberate waiting through the sheet.'
      },
      drawingIntent: 'Show the landmark, my chosen action, and a convergence cue.',
      drawingPrompt: 'A hand-drawn landmark, one clear path, and two circles approaching.',
      fallbackCause: null,
      ...this.decision
    };
  }
}

class FakeImageModel {
  constructor() {
    this.calls = [];
  }

  async generate(input) {
    this.calls.push({
      drawingPrompt: input.drawingPrompt,
      groundedFeatures: input.groundedFeatures,
      referenceImage: input.referenceImage
        ? {
            content: input.referenceImage.buffer.toString(),
            mimeType: input.referenceImage.mimeType
          }
        : null
    });
    return {
      buffer: Buffer.from(`fake-raster-${this.calls.length}`),
      mimeType: 'image/webp',
      model: 'fake-image',
      requestId: `request-${this.calls.length}`
    };
  }
}

test('a text-only drawing correction preserves the intended composition', () => {
  const prompt = composeDrawingRevisionPrompt(
    'A long straight avenue narrowing toward a luminous distant skyline.',
    'Remove every readable word, letter, number, caption, street label, logo, signature, and watermark. Communicate only through visible objects, spatial relationships, symbols, and tone.',
    'unclear',
    'New local observation: nearly straight axis toward a distant core',
    'local_observation'
  );

  assert.match(prompt, /Recreate the same intended composition/);
  assert.match(prompt, /long straight avenue narrowing toward a luminous distant skyline/);
  assert.doesNotMatch(prompt, /Do not reuse the rejected composition/);
});

test('a semantic drawing correction still requires a new composition', () => {
  const prompt = composeDrawingRevisionPrompt(
    'A runner on a road with a river in the background.',
    'Remove the runner and make the river the primary subject.',
    'unclear',
    'New local observation: river visible to the right',
    'local_observation'
  );

  assert.match(prompt, /Do not reuse the rejected composition/);
  assert.doesNotMatch(prompt, /Recreate the same intended composition/);
});

test('legacy raster history is approximated from durable paths and serves older images', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-history-test-'));
  try {
    const controller = new RendezvousController({ dataDir: tempDir, logger: { warn() {}, error() {} } });
    let sheet = queueRasterScratchpadMessage(createRasterScratchpad({ owner: 'ada' }), {
      id: 'older-sheet',
      agentId: 'ada',
      turn: 2,
      drawingPrompt: 'An older drawing.',
      sourcePanoId: 'ada-old'
    });
    sheet = commitRasterScratchpadMessage(sheet, {
      pendingId: 'older-sheet',
      imageFile: 'older-sheet.webp'
    });
    sheet = queueRasterScratchpadMessage(sheet, {
      id: 'current-sheet',
      agentId: 'theo',
      turn: 4,
      drawingPrompt: 'A newer drawing.',
      sourcePanoId: 'theo-old'
    });
    sheet = commitRasterScratchpadMessage(sheet, {
      pendingId: 'current-sheet',
      imageFile: 'current-sheet.webp'
    });
    controller.state = {
      ...controller.state,
      runId: 'legacy-run',
      status: 'running',
      turn: 5,
      scratchpad: sheet,
      agents: {
        ada: {
          id: 'ada', name: 'Ada', panoId: 'ada-now', position: { lat: 40.72, lng: -73.97 },
          path: [
            { lat: 40.7, lng: -73.99, panoId: 'ada-old', timestamp: '2020-01-01T00:00:00.000Z' },
            { lat: 40.72, lng: -73.97, panoId: 'ada-now', timestamp: '2030-01-01T00:00:00.000Z' }
          ]
        },
        theo: {
          id: 'theo', name: 'Theo', panoId: 'theo-now', position: { lat: 40.73, lng: -73.96 },
          path: [
            { lat: 40.71, lng: -73.98, panoId: 'theo-old', timestamp: '2020-01-01T00:00:00.000Z' },
            { lat: 40.73, lng: -73.96, panoId: 'theo-now', timestamp: '2030-01-01T00:00:00.000Z' }
          ]
        }
      }
    };

    const history = controller.getPublicHistory();
    assert.equal(history.items.length, 2);
    assert.ok(history.items.every(item => item.snapshot.approximate));
    assert.equal(history.items[0].snapshot.agents.ada.pathLength, 1);
    assert.equal(path.basename(controller.getDrawingPath('legacy-run', 'older-sheet')), 'older-sheet.webp');
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class IndoorAdaStartStreetView extends FakeStreetView {
  constructor() {
    super();
    this.indoorPano = {
      panoId: 'ada-indoor-store',
      position: { lat: 40.759011, lng: -73.984472 },
      links: []
    };
    this.nodes.set(this.indoorPano.panoId, this.indoorPano);
  }

  async getPanorama(positionOrPanoId) {
    if (positionOrPanoId === this.indoorPano.panoId) {
      return structuredClone(this.indoorPano);
    }
    if (
      typeof positionOrPanoId !== 'string' &&
      Math.abs(Number(positionOrPanoId?.lat) - this.indoorPano.position.lat) < 0.0000001 &&
      Math.abs(Number(positionOrPanoId?.lng) - this.indoorPano.position.lng) < 0.0000001
    ) {
      return structuredClone(this.indoorPano);
    }
    return super.getPanorama(positionOrPanoId);
  }
}

class CrossContaminatedStreetView extends FakeStreetView {
  async navigateAndGetPanorama(panoId) {
    if (panoId === 'ada-start') return this.getPanorama('theo-start');
    return super.navigateAndGetPanorama(panoId);
  }
}

test('isShortPanoLoop detects an active ABAB suffix after an older third pano', () => {
  assert.equal(isShortPanoLoop(['midtown', 'central', 'midtown', '4d', 'midtown', '4d']), true);
  assert.equal(isShortPanoLoop(['midtown', 'central', 'midtown', '4d', 'midtown', 'east']), false);
});

test('path consistency rejects a current position copied from the other agent', () => {
  assert.equal(isAgentPositionPathConsistent({
    position: { lat: 40.902873, lng: -73.878663 },
    path: [{ lat: 40.793088, lng: -73.957448 }]
  }), false);
  assert.equal(isAgentPositionPathConsistent({
    position: { lat: 40.793089, lng: -73.957447 },
    path: [{ lat: 40.793088, lng: -73.957448 }]
  }), true);
});

test('meeting connectivity requires the same or directly linked Street View pano', () => {
  assert.equal(areAgentsStreetViewAdjacent(
    { panoId: 'a', neighborPanoIds: ['b'] },
    { panoId: 'b', neighborPanoIds: [] }
  ), true);
  assert.equal(areAgentsStreetViewAdjacent(
    { panoId: 'a', neighborPanoIds: ['c'] },
    { panoId: 'b', neighborPanoIds: ['d'] }
  ), false);
});

test('a cross-agent Street View fallback cannot move or falsely complete the run', async () => {
  const previousPairIndex = process.env.RENDEZVOUS_START_PAIR_INDEX;
  process.env.RENDEZVOUS_START_PAIR_INDEX = '0';
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-pano-drift-test-'));
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new CrossContaminatedStreetView(),
      agentModel: new FakeRendezvousModel(),
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.status = 'running';
    controller.running = true;
    const before = structuredClone(controller.state.agents.ada);

    await assert.rejects(
      controller.tick(),
      /settled .*m from its expected position/
    );

    assert.equal(controller.state.status, 'running');
    assert.equal(controller.state.turn, 0);
    assert.deepEqual(controller.state.agents.ada.position, before.position);
    assert.equal(controller.state.agents.ada.panoId, before.panoId);
    assert.equal(controller.state.meeting.distanceMeters > 0, true);
  } finally {
    if (previousPairIndex === undefined) delete process.env.RENDEZVOUS_START_PAIR_INDEX;
    else process.env.RENDEZVOUS_START_PAIR_INDEX = previousPairIndex;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('corridor movement is automatic and a nonholder waits at a real branch', async () => {
  const previousPairIndex = process.env.RENDEZVOUS_START_PAIR_INDEX;
  process.env.RENDEZVOUS_START_PAIR_INDEX = '0';
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-protocol-test-'));
  const model = new FakeRendezvousModel();
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: model,
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.status = 'running';
    controller.running = true;
    controller.state.scratchpad.owner = 'theo';
    controller.state.agents.ada.lastThought = {
      reasoning: 'I will remember this model-authored choice.',
      turn: 0,
      stepCount: 0,
      mode: 'decision',
      selectedLabel: 'the remembered route',
      createdAt: new Date().toISOString()
    };

    await controller.tick();
    assert.equal(controller.state.agents.ada.panoId, 'ada-start');
    assert.equal(controller.state.agents.ada.stepCount, 0);
    assert.equal(controller.state.agents.ada.lastDecision.mode, 'waiting_for_sheet');
    assert.equal(controller.state.agents.ada.lastThought.reasoning, 'I will remember this model-authored choice.');
    assert.equal(model.calls.length, 0);

    controller.state.turn = 0;
    controller.state.agents.ada.panoId = 'ada-mid';
    controller.state.agents.ada.position = { lat: 40.7559, lng: -73.9838 };
    controller.state.agents.ada.path.push({ ...controller.state.agents.ada.position, panoId: 'ada-mid' });
    controller.state.agents.ada.visitedPanos = ['ada-start', 'ada-mid'];
    await controller.tick();
    assert.equal(controller.state.agents.ada.panoId, 'target');
    assert.equal(controller.state.agents.ada.lastDecision.mode, 'auto');
    assert.equal(controller.state.agents.ada.lastThought.reasoning, 'I will remember this model-authored choice.');
    assert.equal(model.calls.length, 0);
  } finally {
    if (previousPairIndex === undefined) delete process.env.RENDEZVOUS_START_PAIR_INDEX;
    else process.env.RENDEZVOUS_START_PAIR_INDEX = previousPairIndex;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('private memory survives restart, stays out of public state, and supports deliberate waiting', async () => {
  const previousPairIndex = process.env.RENDEZVOUS_START_PAIR_INDEX;
  process.env.RENDEZVOUS_START_PAIR_INDEX = '0';
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-memory-test-'));
  const model = new ScriptedRendezvousModel({ action: 'wait', waitTurns: 3 });
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: model,
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad.owner = 'theo';
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'incoming-memory-sheet',
      agentId: 'theo',
      turn: 0,
      drawingIntent: 'Tell Ada that Theo is approaching a shared landmark.',
      drawingPrompt: 'Two paths approaching one landmark.'
    });
    await controller.resumePendingDrawing();

    controller.state.status = 'running';
    controller.running = true;
    await controller.tick();
    assert.equal(controller.state.agents.ada.panoId, 'ada-start');
    assert.equal(controller.state.agents.ada.lastDecision.mode, 'decision_wait');
    assert.equal(controller.state.agents.ada.lastThought.reasoning, 'I make a cooperative choice from what I remember.');
    assert.equal(controller.state.agents.ada.lastThought.mode, 'decision_wait');
    assert.equal(controller.state.agents.ada.waitTurnsRemaining, 2);
    assert.equal(controller.state.agents.ada.consecutiveWaitDecisions, 1);
    assert.equal(controller.state.agents.ada.privateMemory.receivedSheets[0].sequence, 1);
    assert.match(controller.state.agents.ada.privateMemory.receivedSheets[0].interpretation, /convergence/);
    await controller.resumePendingDrawing();
    assert.equal(controller.state.agents.ada.privateMemory.sentMessages[0].sequence, 2);
    assert.match(controller.state.agents.ada.privateMemory.sentMessages[0].intent, /landmark/);

    const publicState = controller.getPublicState();
    assert.equal(Object.hasOwn(publicState.agents.ada, 'privateMemory'), false);
    assert.equal(Object.hasOwn(publicState.agents.ada, 'movementSinceDecision'), false);
    assert.equal(Object.hasOwn(publicState.agents.ada, 'waitTurnsRemaining'), false);
    assert.equal(Object.hasOwn(publicState.agents.ada, 'consecutiveWaitDecisions'), false);
    assert.doesNotMatch(JSON.stringify(publicState), /approaching a shared landmark|circle may indicate convergence/i);

    await controller.saveState();
    const persistedPath = path.join(tempDir, 'rendezvous-current.json');
    const persisted = JSON.parse(await fsp.readFile(persistedPath, 'utf8'));
    delete persisted.agents.ada.lastThought;
    await fsp.writeFile(persistedPath, `${JSON.stringify(persisted, null, 2)}\n`);
    const restartedModel = new ScriptedRendezvousModel({ action: 'move' });
    const restarted = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: restartedModel,
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await restarted.loadState();
    assert.equal(restarted.state.agents.ada.privateMemory.receivedSheets[0].sequence, 1);
    assert.equal(restarted.state.agents.ada.privateMemory.sentMessages[0].sequence, 2);
    assert.equal(restarted.state.agents.ada.waitTurnsRemaining, 2);
    assert.equal(restarted.state.agents.ada.consecutiveWaitDecisions, 1);
    assert.equal(restarted.state.agents.ada.lastThought.reasoning, 'I make a cooperative choice from what I remember.');
    assert.equal(restarted.state.agents.ada.lastThought.mode, 'decision_wait');

    restarted.state.turn = 2;
    await restarted.tick();
    assert.equal(restarted.state.agents.ada.panoId, 'ada-start');
    assert.equal(restarted.state.agents.ada.lastDecision.mode, 'deliberate_wait');
    assert.equal(restarted.state.agents.ada.lastThought.reasoning, 'I make a cooperative choice from what I remember.');
    assert.equal(restarted.state.agents.ada.waitTurnsRemaining, 1);
    assert.equal(restartedModel.calls.length, 0);
  } finally {
    if (previousPairIndex === undefined) delete process.env.RENDEZVOUS_START_PAIR_INDEX;
    else process.env.RENDEZVOUS_START_PAIR_INDEX = previousPairIndex;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('repeated same-branch waiting yields to movement while preserving the authored drawing', async () => {
  const previousPairIndex = process.env.RENDEZVOUS_START_PAIR_INDEX;
  process.env.RENDEZVOUS_START_PAIR_INDEX = '0';
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-wait-patience-test-'));
  const model = new ScriptedRendezvousModel({
    action: 'wait',
    waitTurns: 4,
    reasoning: 'I intend to remain at this corner.',
    drawingIntent: 'Show that I am remaining here.',
    drawingPrompt: 'A still figure anchored beneath an arch.'
  });
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: model,
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.status = 'running';
    controller.running = true;
    controller.state.scratchpad.owner = 'ada';
    controller.state.agents.ada.consecutiveWaitDecisions = 2;

    await controller.tick();

    assert.equal(model.calls.length, 1);
    assert.equal(model.calls[0].allowWait, false);
    assert.equal(model.calls[0].consecutiveWaitDecisions, 2);
    assert.equal(controller.state.agents.ada.panoId, 'ada-mid');
    assert.equal(controller.state.agents.ada.stepCount, 1);
    assert.equal(controller.state.agents.ada.consecutiveWaitDecisions, 0);
    assert.equal(controller.state.agents.ada.lastDecision.fallbackCause, null);
    assert.ok(controller.state.scratchpad.pendingMessage);
    assert.match(controller.state.scratchpad.pendingMessage.drawingIntent, /remaining here/);
    assert.ok(controller.state.eventLog.some(event => event.type === 'wait_patience_expired'));
    await controller.resumePendingDrawing();
  } finally {
    if (previousPairIndex === undefined) delete process.env.RENDEZVOUS_START_PAIR_INDEX;
    else process.env.RENDEZVOUS_START_PAIR_INDEX = previousPairIndex;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a model fallback does not replace the last genuine agent thought', async () => {
  const previousPairIndex = process.env.RENDEZVOUS_START_PAIR_INDEX;
  process.env.RENDEZVOUS_START_PAIR_INDEX = '0';
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-thought-fallback-test-'));
  const model = new ScriptedRendezvousModel({
    reasoning: 'Model unavailable; I choose the first public route.',
    fallbackCause: 'model_unavailable'
  });
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: model,
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.status = 'running';
    controller.running = true;
    controller.state.scratchpad.owner = 'ada';
    controller.state.agents.ada.lastThought = {
      reasoning: 'I recognize the stone facade and choose the brighter crossing.',
      turn: 0,
      stepCount: 0,
      mode: 'decision',
      selectedLabel: 'brighter crossing',
      createdAt: new Date().toISOString()
    };

    await controller.tick();

    assert.equal(model.calls.length, 1);
    assert.equal(controller.state.agents.ada.panoId, 'ada-start');
    assert.equal(controller.state.agents.ada.stepCount, 0);
    assert.equal(controller.state.agents.ada.lastDecision.mode, 'decision_retry');
    assert.equal(controller.state.agents.ada.lastDecision.fallbackCause, 'model_unavailable');
    assert.match(controller.state.agents.ada.lastDecision.reasoning, /Model unavailable/);
    assert.equal(
      controller.getPublicState().agents.ada.lastThought.reasoning,
      'I recognize the stone facade and choose the brighter crossing.'
    );
    await controller.resumePendingDrawing();
    await controller.shutdown();
  } finally {
    if (previousPairIndex === undefined) delete process.env.RENDEZVOUS_START_PAIR_INDEX;
    else process.env.RENDEZVOUS_START_PAIR_INDEX = previousPairIndex;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a drawing fallback preserves completed sheet perception for the retry', async () => {
  const previousPairIndex = process.env.RENDEZVOUS_START_PAIR_INDEX;
  process.env.RENDEZVOUS_START_PAIR_INDEX = '0';
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-perception-fallback-test-'));
  const model = new ScriptedRendezvousModel({
    fallbackCause: 'drawing_plan_error',
    sheetInterpretation: 'Theo may be asking about two equally uncertain arches.',
    sheetConfidence: 0.48,
    sheetPerception: {
      literalContents: ['two arches separated by an uncertain circle'],
      possiblePlaces: [],
      possibleIntentions: ['Theo may be asking Ada to compare the arches'],
      primarySubject: 'two arches and an uncertain circle',
      communicationFunction: 'question',
      frameOfReference: 'sender',
      requestedResponse: 'compare the two arches',
      informationNovelty: 'new'
    },
    reconciliation: {
      newEvidence: ['two arches separated by an uncertain circle'],
      repeatedEvidence: [],
      contradictions: [],
      unresolvedQuestions: ['whether the arches depict the same place'],
      informationWorthSending: [],
      planAssessment: 'inconclusive'
    }
  });
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: model,
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad.owner = 'theo';
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'incoming-fallback-sheet',
      agentId: 'theo',
      turn: 0,
      drawingIntent: 'Ask Ada to compare two arches.',
      drawingPrompt: 'Two arches separated by an uncertain circle.'
    });
    await controller.resumePendingDrawing();
    controller.state.status = 'running';
    controller.running = true;

    await controller.tick();

    const memory = controller.state.agents.ada.privateMemory;
    assert.equal(memory.receivedSheets.at(-1).sequence, 1);
    assert.match(memory.receivedSheets.at(-1).interpretation, /equally uncertain arches/);
    assert.equal(memory.reconciliations.at(-1).sheetSequence, 1);
    assert.equal(controller.state.agents.ada.lastDecision.fallbackCause, 'drawing_plan_error');
    assert.ok(controller.state.eventLog.some(event =>
      event.type === 'sheet_perception_preserved' &&
      event.payload.sheetSequence === 1
    ));

    assert.equal(
      controller.state.agents.ada.privateMemory.reconciliations
        .filter(item => item.sheetSequence === 1).length,
      1
    );
    await controller.resumePendingDrawing();
    await controller.shutdown();
  } finally {
    if (previousPairIndex === undefined) delete process.env.RENDEZVOUS_START_PAIR_INDEX;
    else process.env.RENDEZVOUS_START_PAIR_INDEX = previousPairIndex;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a holder can deliberately retrace a walked route at a genuine branch', async () => {
  const previousPairIndex = process.env.RENDEZVOUS_START_PAIR_INDEX;
  process.env.RENDEZVOUS_START_PAIR_INDEX = '0';
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-retrace-test-'));
  const streetView = new FakeStreetView();
  streetView.nodes.set('memory-hub', {
    panoId: 'memory-hub',
    position: { lat: 40.7600, lng: -73.9800 },
    links: [
      { pano: 'fresh-west', heading: 270, description: 'unfamiliar west route' },
      { pano: 'fresh-east', heading: 90, description: 'unfamiliar east route' },
      { pano: 'remembered-south', heading: 180, description: 'back toward the remembered arch' }
    ]
  });
  streetView.nodes.set('fresh-west', {
    panoId: 'fresh-west',
    position: { lat: 40.7600, lng: -73.9810 },
    links: [{ pano: 'memory-hub', heading: 90, description: 'back to the branch' }]
  });
  streetView.nodes.set('fresh-east', {
    panoId: 'fresh-east',
    position: { lat: 40.7600, lng: -73.9790 },
    links: [{ pano: 'memory-hub', heading: 270, description: 'back to the branch' }]
  });
  streetView.nodes.set('remembered-south', {
    panoId: 'remembered-south',
    position: { lat: 40.7590, lng: -73.9800 },
    links: [{ pano: 'memory-hub', heading: 0, description: 'return to the branch' }]
  });
  const model = new ScriptedRendezvousModel({ action: 'retrace', selectedIndex: 2 });
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView,
      agentModel: model,
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.status = 'running';
    controller.running = true;
    controller.state.agents.ada.panoId = 'memory-hub';
    controller.state.agents.ada.position = { lat: 40.7600, lng: -73.9800 };
    controller.state.agents.ada.path.push({ ...controller.state.agents.ada.position, panoId: 'memory-hub' });
    controller.state.agents.ada.visitedPanos = ['remembered-south', 'memory-hub'];

    await controller.tick();
    assert.equal(model.calls.length, 1);
    assert.equal(model.calls[0].options.length, 3);
    assert.equal(model.calls[0].options[2].visited, true);
    assert.equal(controller.state.agents.ada.panoId, 'remembered-south');
    assert.equal(controller.state.agents.ada.lastDecision.mode, 'retrace');
    await controller.resumePendingDrawing();
  } finally {
    if (previousPairIndex === undefined) delete process.env.RENDEZVOUS_START_PAIR_INDEX;
    else process.env.RENDEZVOUS_START_PAIR_INDEX = previousPairIndex;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a persisted pending drawing resumes after controller restart', async () => {
  const previousPairIndex = process.env.RENDEZVOUS_START_PAIR_INDEX;
  process.env.RENDEZVOUS_START_PAIR_INDEX = '0';
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-restart-test-'));
  try {
    const first = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: new FakeRendezvousModel(),
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await first.createRun();
    first.state.scratchpad = queueRasterScratchpadMessage(first.state.scratchpad, {
      id: 'restart-message',
      agentId: 'ada',
      turn: 3,
      drawingPrompt: 'A soft graphite sketch of three receding arches.',
      referenceViewIndices: [1]
    });
    const referenceDirectory = path.join(
      tempDir,
      'rendezvous-drawings',
      first.state.runId
    );
    const referencePath = path.join(
      referenceDirectory,
      'restart-message-reference-1.jpg'
    );
    await fsp.mkdir(referenceDirectory, { recursive: true });
    await fsp.writeFile(referencePath, 'durable-private-source');
    await first.saveState();

    const imageModel = new FakeImageModel();
    const restarted = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: new FakeRendezvousModel(),
      imageModel,
      logger: { warn() {}, error() {} }
    });
    await restarted.loadState();
    await restarted.resumePendingDrawing();
    assert.equal(restarted.state.scratchpad.pendingMessage, null);
    assert.equal(restarted.state.scratchpad.currentMessage.id, 'restart-message');
    assert.equal(restarted.state.scratchpad.owner, 'theo');
    assert.equal(imageModel.calls.length, 1);
    assert.deepEqual(imageModel.calls[0].referenceImage, {
      content: 'durable-private-source',
      mimeType: 'image/jpeg'
    });
    await assert.rejects(fsp.access(referencePath), { code: 'ENOENT' });
  } finally {
    if (previousPairIndex === undefined) delete process.env.RENDEZVOUS_START_PAIR_INDEX;
    else process.env.RENDEZVOUS_START_PAIR_INDEX = previousPairIndex;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('the sender reviews a generated drawing and one rejection produces a revised render', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-review-test-'));
  const reviews = [];
  const agentModel = {
    async reviewDrawing(input) {
      reviews.push(input);
      return reviews.length === 1
        ? {
            accepted: false,
            assessment: 'The two landmarks collapsed into one.',
            revisionPrompt: 'Separate the landmarks and make the moving figure visible.'
          }
        : {
            accepted: true,
            assessment: 'The two landmarks and intended movement are now clear.',
            revisionPrompt: ''
          };
    }
  };
  const imageModel = new FakeImageModel();
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel,
      imageModel,
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'reviewed-message',
      agentId: 'ada',
      turn: 2,
      drawingIntent: 'Show two related landmarks and my intended movement.',
      drawingPrompt: 'Draw two arch groups and a figure moving toward one.',
      groundedFeatures: ['two arch groups']
    });

    await controller.resumePendingDrawing();

    assert.equal(imageModel.calls.length, 2);
    assert.match(imageModel.calls[1].drawingPrompt, /Separate the landmarks/);
    assert.match(imageModel.calls[1].drawingPrompt, /Show two related landmarks and my intended movement/);
    assert.match(imageModel.calls[1].drawingPrompt, /^Authoritative rendering correction:/);
    assert.doesNotMatch(imageModel.calls[1].drawingPrompt, /Draw two arch groups/);
    assert.equal(reviews.length, 2);
    assert.equal(controller.state.scratchpad.owner, 'theo');
    assert.equal(controller.state.scratchpad.currentMessage.id, 'reviewed-message');
    assert.equal(controller.state.scratchpad.messageAudit[0].renderAttempts, 2);
    assert.match(controller.state.scratchpad.messageAudit[0].reviewAssessment, /now clear/);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a rejected local observation revision drops incidental scene anchors', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-local-revision-test-'));
  let reviewCount = 0;
  const agentModel = {
    async reviewDrawing() {
      reviewCount += 1;
      return reviewCount === 1
        ? {
            accepted: false,
            assessment: 'The surrounding street displaced the cited bus.',
            revisionPrompt: 'Make the yellow school bus the only dominant subject.'
          }
        : {
            accepted: true,
            assessment: 'The cited bus is now unmistakable.',
            revisionPrompt: ''
          };
    }
  };
  const imageModel = new FakeImageModel();
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel,
      imageModel,
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'local-observation-revision',
      agentId: 'ada',
      turn: 2,
      contributionKind: 'local_observation',
      contributionSummary: 'New local observation: yellow school bus on the left',
      informationDelta: 'New local observation: yellow school bus on the left',
      drawingIntent: 'Show the cited local observation.',
      drawingPrompt: 'Sketch the bus within the surrounding street.',
      groundedFeatures: [
        'yellow school bus on the left',
        'white delivery van on the right',
        'bare trees and surrounding buildings'
      ]
    });

    await controller.resumePendingDrawing();

    assert.equal(imageModel.calls.length, 2);
    assert.deepEqual(imageModel.calls[1].groundedFeatures, ['yellow school bus on the left']);
    assert.equal(controller.state.scratchpad.currentMessage.id, 'local-observation-revision');
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a rejected question revision cannot resolve its own alternatives', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-question-revision-test-'));
  let reviewCount = 0;
  const agentModel = {
    async reviewDrawing() {
      reviewCount += 1;
      return reviewCount === 1
        ? {
            accepted: false,
            assessment: 'One route is marked as the correct answer.',
            revisionPrompt: 'Make the unresolved choice visually primary.'
          }
        : {
            accepted: true,
            assessment: 'Both alternatives remain equally unresolved.',
            revisionPrompt: ''
          };
    }
  };
  const imageModel = new FakeImageModel();
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel,
      imageModel,
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'question-revision-message',
      agentId: 'ada',
      turn: 2,
      contributionKind: 'question',
      contributionSummary: 'Question I am sending: is this a crossing point or a continuation?',
      drawingIntent: 'Ask whether this is a crossing point or a continuation.',
      drawingPrompt: 'Draw a crossing point and a continuation with equal visual weight.',
      messageAction: 'unclear',
      groundedFeatures: ['crossing point', 'continuation']
    });

    await controller.resumePendingDrawing();

    assert.equal(imageModel.calls.length, 2);
    assert.match(imageModel.calls[1].drawingPrompt, /remain an unresolved question/i);
    assert.match(imageModel.calls[1].drawingPrompt, /alternatives equal visual weight/i);
    assert.match(imageModel.calls[1].drawingPrompt, /Do not answer the question/i);
    assert.match(imageModel.calls[1].drawingPrompt, /check marks, X marks, green\/red approval/i);
    assert.equal(controller.state.scratchpad.currentMessage.id, 'question-revision-message');
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a persisted question revision gains the unresolved constraint without resetting its retry', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-question-upgrade-test-'));
  const imageModel = new FakeImageModel();
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: {},
      imageModel,
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'persisted-question-message',
      agentId: 'ada',
      turn: 2,
      contributionKind: 'question',
      contributionSummary: 'Question I am sending: is this a crossing point or a continuation?',
      drawingIntent: 'Ask which of two possible spatial readings is intended.',
      drawingPrompt: 'Draw two possible readings around an uncertain crossing.',
      messageAction: 'unclear',
      groundedFeatures: ['crossing point', 'continuation']
    });
    const pending = controller.state.scratchpad.pendingMessage;
    pending.drawingPrompt = 'Authoritative rendering correction: Remove readable text and preserve the crossing.';
    pending.attempts = 5;
    pending.totalAttempts = 5;
    pending.nextAttemptAt = new Date(Date.now() + 60_000).toISOString();

    await controller.resumePendingDrawing();

    const upgraded = controller.state.scratchpad.pendingMessage;
    assert.equal(imageModel.calls.length, 0);
    assert.equal(upgraded.id, 'persisted-question-message');
    assert.equal(upgraded.attempts, 5);
    assert.equal(upgraded.totalAttempts, 5);
    assert.match(upgraded.drawingPrompt, /remain an unresolved question/i);
    assert.match(upgraded.drawingPrompt, /Remove readable text and preserve the crossing/i);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a persisted local question cannot substitute the received cue for its cited subject', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-local-question-subject-test-'));
  const imageModel = new FakeImageModel();
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: {},
      imageModel,
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'misattributed-local-question',
      agentId: 'ada',
      turn: 3,
      contributionKind: 'question',
      contributionEvidenceId: 'question_local:0',
      contributionSummary:
        'Question I am sending about this local evidence: three stone arches with one broken arch',
      drawingIntent: 'Ask Theo whether his forward cue means literal movement or a symbolic axis.',
      drawingPrompt: 'Draw a street fork behind three stone arches with one broken arch.',
      messageAction: 'unclear',
      groundedFeatures: ['three stone arches with one broken arch']
    });
    controller.state.scratchpad.pendingMessage.replanCount = 2;

    await controller.resumePendingDrawing();

    assert.equal(imageModel.calls.length, 0);
    assert.equal(controller.state.scratchpad.pendingMessage, null);
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).status, 'failed');
    assert.match(
      controller.state.scratchpad.messageAudit.at(-1).error,
      /displaced its cited subject with the received cue/i
    );
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a persisted local question cannot promote generic city fixtures into a clue', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-local-question-fixture-test-'));
  const imageModel = new FakeImageModel();
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: {},
      imageModel,
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'generic-local-question',
      agentId: 'ada',
      turn: 3,
      contributionKind: 'question',
      contributionEvidenceId: 'question_local:0',
      contributionSummary:
        'Question I am sending about this local evidence: pedestrians and vehicles (taxis, cars) on the road',
      drawingIntent:
        'A lone figure near taxis asks which direction to take or how to coordinate next.',
      drawingPrompt: 'Draw the figure and taxis behind two large directional choices.',
      messageAction: 'unclear',
      groundedFeatures: ['pedestrians and vehicles (taxis, cars) on the road']
    });
    controller.state.scratchpad.pendingMessage.replanCount = 2;

    await controller.resumePendingDrawing();

    assert.equal(imageModel.calls.length, 0);
    assert.equal(controller.state.scratchpad.pendingMessage, null);
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).status, 'failed');
    assert.match(
      controller.state.scratchpad.messageAudit.at(-1).error,
      /low-information urban street/i
    );
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('sender revision feedback survives a durable retry and controller restart', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-review-retry-test-'));
  const rejectingModel = {
    async reviewDrawing() {
      return {
        accepted: false,
        assessment: 'The large arrow still makes this stillness message read as movement.',
        revisionPrompt: 'Remove the large arrow and make the stopped figure behind the barrier dominant.'
      };
    }
  };
  try {
    const first = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: rejectingModel,
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await first.createRun();
    first.state.scratchpad = queueRasterScratchpadMessage(first.state.scratchpad, {
      id: 'revision-retry-message',
      agentId: 'ada',
      turn: 3,
      drawingIntent: 'Show that I am holding this corner.',
      informationDelta: 'I am deliberately waiting rather than advancing.',
      messageAction: 'stillness',
      drawingPrompt: 'Draw a stopped figure beside a route arrow.',
      groundedFeatures: ['fixed median tree', 'bold route arrow']
    });

    await first.resumePendingDrawing();

    assert.equal(first.state.scratchpad.pendingMessage.status, 'retrying');
    assert.match(first.state.scratchpad.pendingMessage.drawingPrompt, /Remove the large arrow/);
    assert.match(first.state.scratchpad.pendingMessage.drawingPrompt, /I am deliberately waiting rather than advancing/);
    assert.match(first.state.scratchpad.pendingMessage.drawingPrompt, /^Authoritative rendering correction:/);
    assert.doesNotMatch(first.state.scratchpad.pendingMessage.drawingPrompt, /For the next rendering/);
    first.state.scratchpad.pendingMessage.nextAttemptAt = new Date(0).toISOString();
    await first.saveState();

    const acceptingModel = {
      async reviewDrawing() {
        return {
          accepted: true,
          assessment: 'The stopped figure and barrier now dominate the image.',
          revisionPrompt: ''
        };
      }
    };
    const recoveredImageModel = new FakeImageModel();
    const restarted = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: acceptingModel,
      imageModel: recoveredImageModel,
      logger: { warn() {}, error() {} }
    });
    await restarted.loadState();
    await restarted.resumePendingDrawing();

    assert.match(recoveredImageModel.calls[0].drawingPrompt, /Remove the large arrow/);
    assert.deepEqual(recoveredImageModel.calls[0].groundedFeatures, ['fixed median tree']);
    assert.equal(restarted.state.scratchpad.pendingMessage, null);
    assert.equal(restarted.state.scratchpad.currentMessage.id, 'revision-retry-message');
    assert.equal(restarted.state.scratchpad.owner, 'theo');
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a persisted own-action wait is reconciled to stillness before rendering', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-wait-action-test-'));
  const reviews = [];
  const agentModel = {
    async reviewDrawing(input) {
      reviews.push(input);
      return {
        accepted: true,
        assessment: 'The sender is visibly stationary at a fixed street feature.',
        blindRead: {
          dominantAction: 'stillness',
          frameOfReference: 'sender',
          communicationFunction: 'report',
          readableText: false,
          likelyMessage: 'The sender is waiting here.'
        }
      };
    }
  };
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel,
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'persisted-wait-action',
      agentId: 'ada',
      turn: 4,
      contributionKind: 'own_action',
      contributionSummary: 'My current chosen action: I chose to wait at this branch.',
      informationDelta: 'My current chosen action: I chose to wait at this branch.',
      messageAction: 'transition',
      drawingIntent: 'Show a quiet street anchor while the fork remains unresolved.',
      drawingPrompt: 'Draw two paths around a stationary figure.'
    });

    await controller.resumePendingDrawing();

    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].messageAction, 'stillness');
    assert.match(reviews[0].drawingPrompt, /dominant action must be stillness/i);
    assert.equal(controller.state.scratchpad.pendingMessage, null);
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).messageAction, 'stillness');
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a persisted static observation drops a spurious movement requirement', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-static-observation-test-'));
  const reviews = [];
  const agentModel = {
    async reviewDrawing(input) {
      reviews.push(input);
      return {
        accepted: true,
        assessment: 'The corridor itself is the primary observed subject.',
        blindRead: {
          dominantAction: 'unclear',
          frameOfReference: 'sender',
          communicationFunction: 'report',
          readableText: false,
          likelyMessage: 'The sender sees a clear urban corridor.'
        }
      };
    }
  };
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel,
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'persisted-static-observation',
      agentId: 'ada',
      turn: 4,
      contributionKind: 'local_observation',
      contributionSummary: 'New local observation: a clear northward corridor ahead. The approach appears navigable',
      informationDelta: 'New local observation: a clear northward corridor ahead. The approach appears navigable',
      messageAction: 'transition',
      drawingIntent: 'Show the clear urban corridor itself.',
      drawingPrompt: 'Draw before and after states around the clear urban corridor.'
    });

    await controller.resumePendingDrawing();

    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].messageAction, 'unclear');
    assert.match(reviews[0].drawingPrompt, /Show the clear urban corridor itself/i);
    assert.doesNotMatch(reviews[0].drawingPrompt, /runner|movement requirement/i);
    assert.equal(controller.state.scratchpad.pendingMessage, null);
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).messageAction, 'unclear');
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a recipient-legible own-action drawing escapes an intent-review livelock after repeated retries', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-review-livelock-test-'));
  const agentModel = {
    async reviewDrawing() {
      return {
        accepted: false,
        assessment: 'The readiness cue could still be more explicit.',
        revisionPrompt: 'Keep the figures waiting while making anticipation visible.',
        blindRead: {
          dominantAction: 'stillness',
          frameOfReference: 'sender',
          communicationFunction: 'report',
          readableText: false,
          likelyMessage: 'Two people wait at a corner while anticipating a later move.'
        }
      };
    }
  };
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel,
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'recipient-legible-message',
      agentId: 'ada',
      turn: 4,
      contributionKind: 'own_action',
      messageAction: 'stillness',
      drawingIntent: 'Show that I am waiting but attentive.',
      drawingPrompt: 'Draw two people waiting beside a fixed landmark.'
    });
    controller.state.scratchpad.pendingMessage.attempts = 3;

    await controller.resumePendingDrawing();

    assert.equal(controller.state.scratchpad.pendingMessage, null);
    assert.equal(controller.state.scratchpad.currentMessage.id, 'recipient-legible-message');
    assert.match(
      controller.state.scratchpad.messageAudit.at(-1).reviewAssessment,
      /independent recipient read the intended dominant action/
    );
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('matching movement cannot waive a rejected local observation', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-observation-waiver-test-'));
  const agentModel = {
    async reviewDrawing() {
      return {
        accepted: false,
        assessment: 'The runner is primary, not the cited tree-lined street.',
        revisionPrompt: 'Remove the runner and foreground the tree-lined street.',
        blindRead: {
          dominantAction: 'movement',
          frameOfReference: 'sender',
          communicationFunction: 'report',
          readableText: false,
          likelyMessage: 'The sender is running down a street.'
        }
      };
    }
  };
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel,
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'runner-dominates-observation',
      agentId: 'ada',
      turn: 4,
      contributionKind: 'local_observation',
      contributionSummary: 'New local observation: tree-lined street',
      informationDelta: 'New local observation: tree-lined street',
      messageAction: 'movement',
      drawingIntent: 'Show the tree-lined street.',
      drawingPrompt: 'Draw a runner on a tree-lined street.'
    });
    controller.state.scratchpad.pendingMessage.attempts = 3;

    await controller.resumePendingDrawing();

    assert.equal(controller.state.scratchpad.currentMessage, null);
    assert.equal(controller.state.scratchpad.pendingMessage.id, 'runner-dominates-observation');
    assert.equal(controller.state.scratchpad.pendingMessage.attempts, 4);
    assert.match(controller.state.scratchpad.pendingMessage.lastError, /runner is primary/i);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a durable retry cannot waive an own-action sender-frame failure', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-frame-retry-test-'));
  const agentModel = {
    async reviewDrawing() {
      return {
        accepted: false,
        assessment: 'The arrow still reads as a command to the recipient.',
        revisionPrompt: 'Show the sender reporting completed motion.',
        blindRead: {
          dominantAction: 'movement',
          frameOfReference: 'recipient',
          communicationFunction: 'directive',
          readableText: false,
          likelyMessage: 'Follow this arrow.'
        }
      };
    }
  };
  const imageModel = new FakeImageModel();
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel,
      imageModel,
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'sender-frame-message',
      agentId: 'ada',
      turn: 4,
      contributionKind: 'own_action',
      messageAction: 'movement',
      drawingIntent: 'Report my own southeast movement.',
      drawingPrompt: 'Draw my movement southeast.',
      groundedFeatures: [
        'I chose to move south along the selected public route.',
        'a long avenue toward a distant vanishing point',
        'a steel bridge visible to the left'
      ]
    });
    controller.state.scratchpad.pendingMessage.attempts = 3;

    await controller.resumePendingDrawing();

    assert.equal(controller.state.scratchpad.currentMessage, null);
    assert.equal(controller.state.scratchpad.pendingMessage.id, 'sender-frame-message');
    assert.equal(controller.state.scratchpad.pendingMessage.attempts, 4);
    assert.match(controller.state.scratchpad.pendingMessage.lastError, /command to the recipient/);
    assert.deepEqual(imageModel.calls[1].groundedFeatures, ['a steel bridge visible to the left']);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a repeated own action cannot waive sender framing at the terminal retry', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-repeated-frame-test-'));
  const agentModel = {
    async reviewDrawing() {
      return {
        accepted: false,
        assessment: 'The repeated arrow still reads as a command to the recipient.',
        revisionPrompt: 'Show the sender reporting completed motion.',
        blindRead: {
          dominantAction: 'movement',
          frameOfReference: 'recipient',
          communicationFunction: 'deliberate_repetition',
          readableText: false,
          likelyMessage: 'A forward cue urges the viewer to keep moving.'
        }
      };
    }
  };
  const imageModel = new FakeImageModel();
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel,
      imageModel,
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'repeated-sender-frame-message',
      agentId: 'ada',
      turn: 4,
      contributionKind: 'deliberate_repetition',
      contributionSummary:
        'Deliberately repeating existing visual evidence without treating it as new: My current chosen action: I chose to move northeast along the selected public route.',
      informationDelta:
        'Deliberately repeating existing visual evidence without treating it as new: My current chosen action: I chose to move northeast along the selected public route.',
      continuityReason: 'The unchanged movement report is useful to repeat.',
      messageAction: 'movement',
      drawingIntent: 'Repeat my own movement report.',
      drawingPrompt: 'Draw my movement northeast.',
      groundedFeatures: [
        'My current chosen action: I chose to move northeast along the selected public route.',
        'a broad avenue toward a distant vanishing point',
        'a steel bridge visible to the left'
      ]
    });
    controller.state.scratchpad.pendingMessage.attempts = 6;
    controller.state.scratchpad.pendingMessage.totalAttempts = 6;
    controller.state.scratchpad.pendingMessage.replanCount = 2;

    await controller.resumePendingDrawing();

    assert.equal(controller.state.scratchpad.currentMessage, null);
    assert.equal(controller.state.scratchpad.pendingMessage, null);
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).status, 'failed');
    assert.match(controller.state.scratchpad.messageAudit.at(-1).error, /command to the recipient/);
    assert.deepEqual(imageModel.calls[1].groundedFeatures, ['a steel bridge visible to the left']);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a repeatedly unrenderable action is replanned without changing the run or route', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-replan-test-'));
  const replans = [];
  const agentModel = {
    async replanUnrenderableDrawing(input) {
      replans.push(input);
      await new Promise(resolve => setTimeout(resolve, 10));
      return {
        contributionKind: 'local_observation',
        contributionEvidenceId: 'local:0',
        contributionSummary: 'New local observation: a stone arcade.',
        drawingIntent: 'Show the stone arcade now visible here.',
        informationDelta: 'New local observation: a stone arcade.',
        continuityReason: '',
        messageAction: 'stillness',
        drawingPrompt: 'Draw one quiet stone arcade.',
        groundedFeatures: ['a stone arcade']
      };
    },
    async reviewDrawing() {
      return {
        accepted: true,
        assessment: 'The stone arcade is the primary observation.',
        blindRead: {
          dominantAction: 'stillness',
          frameOfReference: 'sender',
          communicationFunction: 'report',
          readableText: false,
          likelyMessage: 'The sender sees a stone arcade.'
        }
      };
    }
  };
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel,
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    const runId = controller.state.runId;
    const senderPano = controller.state.agents.ada.panoId;
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'replanned-message',
      agentId: 'ada',
      turn: 4,
      contributionKind: 'own_action',
      contributionEvidenceId: 'action:0',
      contributionSummary: 'My current chosen action: move south.',
      drawingIntent: 'Show my movement south.',
      informationDelta: 'My current chosen action: move south.',
      messageAction: 'movement',
      drawingPrompt: 'Draw my movement south.',
      groundedFeatures: ['I chose to move south.', 'a stone arcade']
    });
    controller.state.scratchpad.pendingMessage.attempts = 3;

    await Promise.all(Array.from({ length: 4 }, () => controller.resumePendingDrawing()));

    assert.equal(replans.length, 1);
    assert.equal(controller.state.runId, runId);
    assert.equal(controller.state.agents.ada.panoId, senderPano);
    assert.equal(controller.state.scratchpad.pendingMessage, null);
    assert.equal(controller.state.scratchpad.currentMessage.id, 'replanned-message');
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).contributionKind, 'local_observation');
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).totalAttempts, 4);
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).replanCount, 1);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a repeatedly unrenderable acknowledgement gets one bounded replan', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-ack-replan-test-'));
  const replans = [];
  const agentModel = {
    async replanUnrenderableDrawing(input) {
      replans.push(input);
      return {
        contributionKind: 'question',
        contributionEvidenceId: 'question:0',
        contributionSummary: 'Question I am sending: whether the arch is repeated ahead.',
        drawingIntent: 'Ask whether the arch appears again.',
        informationDelta: 'Question I am sending: whether the arch is repeated ahead.',
        continuityReason: '',
        messageAction: 'unclear',
        drawingPrompt: 'Draw one arch beside its faint uncertain echo.',
        groundedFeatures: ['whether the arch is repeated ahead']
      };
    },
    async reviewDrawing() {
      return {
        accepted: true,
        assessment: 'The drawing reads as an unresolved visual question.',
        blindRead: {
          dominantAction: 'unclear',
          frameOfReference: 'recipient',
          communicationFunction: 'question',
          readableText: false,
          likelyMessage: 'Does this arch appear again?'
        }
      };
    }
  };
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel,
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    const runId = controller.state.runId;
    const senderPano = controller.state.agents.ada.panoId;
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'unrenderable-acknowledgement',
      agentId: 'ada',
      turn: 7,
      contributionKind: 'acknowledgement',
      contributionEvidenceId: 'received:0',
      contributionSummary: 'Acknowledging received visual evidence: a path and footprints.',
      drawingIntent: 'Acknowledge the path and footprints.',
      informationDelta: 'Acknowledging received visual evidence: a path and footprints.',
      messageAction: 'movement',
      drawingPrompt: 'Draw a path and footprints.',
      groundedFeatures: ['a path and footprints']
    });
    controller.state.scratchpad.pendingMessage.attempts = 3;

    await Promise.all(Array.from({ length: 4 }, () => controller.resumePendingDrawing()));

    assert.equal(replans.length, 1);
    assert.equal(replans[0].pending.contributionKind, 'acknowledgement');
    assert.equal(controller.state.runId, runId);
    assert.equal(controller.state.agents.ada.panoId, senderPano);
    assert.equal(controller.state.scratchpad.pendingMessage, null);
    assert.equal(controller.state.scratchpad.currentMessage.id, 'unrenderable-acknowledgement');
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).contributionKind, 'question');
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).replanCount, 1);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a persisted acknowledgement route proposal is replanned before rendering', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-ack-proposal-test-'));
  const replans = [];
  const agentModel = {
    async replanUnrenderableDrawing(input) {
      replans.push(input);
      return {
        contributionKind: 'local_observation',
        contributionEvidenceId: 'local:0',
        contributionSummary: 'New local observation: river visible to the right.',
        drawingIntent: 'Show the river visible to the right.',
        informationDelta: 'New local observation: river visible to the right.',
        continuityReason: '',
        messageAction: 'stillness',
        drawingPrompt: 'Draw the river as the dominant local landmark.',
        groundedFeatures: ['river visible to the right']
      };
    },
    async reviewDrawing() {
      return {
        accepted: true,
        assessment: 'The river is the primary observation.',
        blindRead: {
          dominantAction: 'stillness',
          frameOfReference: 'sender',
          communicationFunction: 'report',
          readableText: false,
          likelyMessage: 'The sender sees a river.'
        }
      };
    }
  };
  const imageModel = new FakeImageModel();
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel,
      imageModel,
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'acknowledgement-route-proposal',
      agentId: 'ada',
      turn: 4,
      contributionKind: 'acknowledgement',
      contributionEvidenceId: 'received:0',
      contributionSummary:
        'Acknowledging received visual evidence without claiming it as my own: long pedestrian plaza',
      drawingIntent:
        'Propose moving along a shared axis toward a circular meeting point.',
      informationDelta:
        'Acknowledging received visual evidence without claiming it as my own: long pedestrian plaza',
      continuityReason: 'The shared route proposal is why I repeat the plaza.',
      messageAction: 'movement',
      drawingPrompt: 'Draw a forward path toward a shared circular meeting point.',
      groundedFeatures: ['long pedestrian plaza']
    });

    await controller.resumePendingDrawing();

    assert.equal(replans.length, 1);
    assert.equal(imageModel.calls.length, 1);
    assert.equal(controller.state.scratchpad.currentMessage.id, 'acknowledgement-route-proposal');
    assert.equal(
      controller.state.scratchpad.messageAudit.at(-1).contributionKind,
      'local_observation'
    );
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a persisted acknowledgement drops forced movement before rendering', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-ack-action-test-'));
  const imageModel = new FakeImageModel();
  const reviews = [];
  const agentModel = {
    async reviewDrawing(input) {
      reviews.push(input);
      return {
        accepted: true,
        assessment: 'The drawing visibly acknowledges the received scene.',
        blindRead: {
          dominantAction: 'movement',
          frameOfReference: 'shared',
          communicationFunction: 'acknowledgement',
          readableText: false,
          likelyMessage: 'The sender recognizes the received moving scene.'
        }
      };
    }
  };
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel,
      imageModel,
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'acknowledgement-forced-movement',
      agentId: 'ada',
      turn: 4,
      contributionKind: 'acknowledgement',
      contributionEvidenceId: 'received:0',
      contributionSummary:
        'Acknowledging received visual evidence without claiming it as my own: long pedestrian plaza',
      drawingIntent: 'Recognize the received plaza without treating it as my own.',
      informationDelta:
        'Acknowledging received visual evidence without claiming it as my own: long pedestrian plaza',
      continuityReason: 'I repeat the plaza only to show recognition.',
      messageAction: 'movement',
      drawingPrompt: 'Show reception and reflection around the received plaza.',
      groundedFeatures: ['long pedestrian plaza']
    });

    await controller.resumePendingDrawing();

    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].messageAction, 'unclear');
    assert.equal(controller.state.scratchpad.currentMessage.id, 'acknowledgement-forced-movement');
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a recipient-legible local sketch can override an unclear sender review', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-terminal-report-test-'));
  let reviews = 0;
  const agentModel = {
    async reviewDrawing() {
      reviews += 1;
      return {
        accepted: false,
        assessment: 'The median tree is more dominant than the broad avenue.',
        revisionPrompt: 'Make the avenue more dominant.',
        blindRead: {
          dominantAction: 'stillness',
          frameOfReference: 'sender',
          communicationFunction: 'unclear',
          readableText: false,
          likelyMessage: 'The sender sees a broad avenue with a central median tree.'
        }
      };
    }
  };
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel,
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'recipient-legible-terminal-report',
      agentId: 'ada',
      turn: 9,
      contributionKind: 'local_observation',
      contributionEvidenceId: 'local:0',
      contributionSummary: 'New local observation: broad avenue with a central median tree',
      drawingIntent: 'Show the broad avenue and central median tree.',
      informationDelta: 'New local observation: broad avenue with a central median tree',
      messageAction: 'unclear',
      drawingPrompt: 'Draw a broad avenue with a central median tree.',
      groundedFeatures: ['broad avenue with a central median tree']
    });
    await controller.resumePendingDrawing();

    assert.equal(reviews, 2);
    assert.equal(controller.state.scratchpad.pendingMessage, null);
    assert.equal(controller.state.scratchpad.currentMessage.id, 'recipient-legible-terminal-report');
    assert.match(
      controller.state.scratchpad.messageAudit.at(-1).reviewAssessment,
      /Accepted after 1 durable attempts/
    );
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a bounded retry accepts a legible unresolved visual question', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-terminal-question-test-'));
  let reviews = 0;
  const agentModel = {
    async reviewDrawing() {
      reviews += 1;
      return {
        accepted: false,
        assessment: 'The two alternatives could still be more explicit.',
        revisionPrompt: 'Keep both alternatives equally unresolved.',
        blindRead: {
          dominantAction: 'stillness',
          frameOfReference: 'recipient',
          communicationFunction: 'directive',
          readableText: false,
          likelyMessage: 'There is uncertainty between the shared crossing and a continuation.'
        }
      };
    }
  };
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel,
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'recipient-legible-terminal-question',
      agentId: 'ada',
      turn: 9,
      contributionKind: 'question',
      contributionEvidenceId: 'question:0',
      contributionSummary: 'Question I am sending: is this a shared crossing or a continuation?',
      drawingIntent: 'Ask whether this is a shared crossing or a continuation.',
      informationDelta: 'Question I am sending: is this a shared crossing or a continuation?',
      messageAction: 'unclear',
      drawingPrompt: 'Draw a shared crossing and a continuation with equal visual weight.',
      groundedFeatures: ['shared crossing', 'continuation']
    });
    controller.state.scratchpad.pendingMessage.attempts = 6;
    controller.state.scratchpad.pendingMessage.totalAttempts = 6;
    controller.state.scratchpad.pendingMessage.replanCount = 2;

    await controller.resumePendingDrawing();

    assert.equal(reviews, 2);
    assert.equal(controller.state.scratchpad.pendingMessage, null);
    assert.equal(controller.state.scratchpad.currentMessage.id, 'recipient-legible-terminal-question');
    assert.match(
      controller.state.scratchpad.messageAudit.at(-1).reviewAssessment,
      /Accepted after 7 durable attempts/
    );
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a bounded question retry cannot waive a preferred route directive', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-terminal-question-directive-test-'));
  const agentModel = {
    async reviewDrawing() {
      return {
        accepted: false,
        assessment: 'The drawing answers its own question.',
        revisionPrompt: 'Remove the preferred route.',
        blindRead: {
          dominantAction: 'movement',
          frameOfReference: 'recipient',
          communicationFunction: 'directive',
          readableText: false,
          likelyMessage: 'Go left at the crossing.'
        }
      };
    }
  };
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel,
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'preferred-route-question',
      agentId: 'ada',
      turn: 9,
      contributionKind: 'question',
      contributionEvidenceId: 'question:0',
      contributionSummary: 'Question I am sending: is this a shared crossing or a continuation?',
      drawingIntent: 'Ask whether this is a shared crossing or a continuation.',
      informationDelta: 'Question I am sending: is this a shared crossing or a continuation?',
      messageAction: 'unclear',
      drawingPrompt: 'Draw a shared crossing and a continuation with equal visual weight.',
      groundedFeatures: ['shared crossing', 'continuation']
    });
    controller.state.scratchpad.pendingMessage.attempts = 6;
    controller.state.scratchpad.pendingMessage.totalAttempts = 6;
    controller.state.scratchpad.pendingMessage.replanCount = 2;

    await controller.resumePendingDrawing();

    assert.notEqual(controller.state.scratchpad.currentMessage?.id, 'preferred-route-question');
    assert.equal(controller.state.scratchpad.pendingMessage, null);
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).status, 'failed');
    assert.match(controller.state.scratchpad.messageAudit.at(-1).error, /answers its own question/i);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a persisted alternating echo is abandoned after semantic replans are exhausted', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-echo-revalidation-test-'));
  let generatedImages = 0;
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: {
        async reviewDrawing() {
          throw new Error('A repeated draft should not reach visual review');
        }
      },
      imageModel: {
        async generate() {
          generatedImages += 1;
          throw new Error('A repeated draft should not reach image generation');
        }
      },
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.agents.ada.privateMemory.sentMessages = [{
      turn: 19,
      sequence: 19,
      to: 'theo',
      intent: 'Show storefronts and yellow taxis.',
      contributionKind: 'local_observation',
      contributionEvidenceId: 'local:0',
      contributionSummary: 'New local observation: Storefronts and yellow taxis visible',
      informationDelta: 'New local observation: Storefronts and yellow taxis visible',
      continuityReason: '',
      groundedFeatures: ['storefronts and yellow taxis'],
      createdAt: new Date().toISOString()
    }];
    controller.state.agents.ada.privateMemory.receivedSheets = [{
      turn: 20,
      sequence: 20,
      from: 'theo',
      interpretation: 'A quiet commercial strip with repeating awnings.',
      confidence: 0.6,
      literalContents: ['storefront buildings with striped and solid awnings'],
      possiblePlaces: [],
      possibleIntentions: [],
      primarySubject: 'the row of storefronts with awnings and ground-floor windows',
      communicationFunction: 'report',
      frameOfReference: 'sender',
      requestedResponse: '',
      informationNovelty: 'mixed',
      createdAt: new Date().toISOString()
    }];
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'persisted-alternating-echo',
      agentId: 'ada',
      turn: 21,
      contributionKind: 'local_observation',
      contributionEvidenceId: 'local:0',
      contributionSummary: 'New local observation: row of storefronts with awnings',
      drawingIntent: 'Align with Theo by showing the same storefront row and awnings.',
      informationDelta: 'New local observation: row of storefronts with awnings',
      messageAction: 'stillness',
      drawingPrompt: 'Sketch a row of storefronts with striped awnings.',
      groundedFeatures: ['row of storefronts with awnings']
    });
    controller.state.scratchpad.pendingMessage.replanCount = 2;
    controller.state.scratchpad.pendingMessage.replanFailureCount = 2;

    await controller.resumePendingDrawing();

    assert.equal(generatedImages, 0);
    assert.equal(controller.state.scratchpad.pendingMessage, null);
    assert.equal(controller.state.scratchpad.sequence, 0);
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).id, 'persisted-alternating-echo');
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).status, 'failed');
    assert.match(controller.state.scratchpad.messageAudit.at(-1).error, /shared-channel proposition/);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a persisted broad plaza-corridor report is abandoned after semantic replans are exhausted', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-low-info-revalidation-test-'));
  let generatedImages = 0;
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: {},
      imageModel: {
        async generate() {
          generatedImages += 1;
          throw new Error('A low-information draft should not reach image generation');
        }
      },
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'persisted-low-information-report',
      agentId: 'ada',
      turn: 22,
      contributionKind: 'local_observation',
      contributionEvidenceId: 'local:0',
      contributionSummary: 'New local observation: I am on a broad urban plaza-like street corridor',
      drawingIntent: 'Show the broad urban plaza-like street corridor.',
      informationDelta: 'New local observation: I am on a broad urban plaza-like street corridor',
      messageAction: 'stillness',
      drawingPrompt: 'Sketch a broad urban plaza-like street corridor.',
      groundedFeatures: ['broad urban plaza-like street corridor']
    });
    controller.state.scratchpad.pendingMessage.replanCount = 2;
    controller.state.scratchpad.pendingMessage.replanFailureCount = 2;
    controller.state.agents.ada.status = 'waiting';
    controller.state.agents.ada.sheetBlockedPanoId = controller.state.agents.ada.panoId;
    controller.state.status = 'running';
    controller.running = true;

    await controller.resumePendingDrawing();

    assert.equal(generatedImages, 0);
    assert.equal(controller.state.scratchpad.pendingMessage, null);
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).status, 'failed');
    assert.match(controller.state.scratchpad.messageAudit.at(-1).error, /low-information urban street/);
    assert.equal(controller.state.agents.ada.status, 'searching');
    assert.equal(controller.state.agents.ada.sheetBlockedPanoId, null);
    assert.notEqual(controller.timer, null);
    await controller.stop();
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a persisted crosswalk-only report cannot gain information from stripe adjectives', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-crosswalk-revalidation-test-'));
  let generatedImages = 0;
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: {},
      imageModel: {
        async generate() {
          generatedImages += 1;
          throw new Error('A crosswalk-only draft should not reach image generation');
        }
      },
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'persisted-crosswalk-only-report',
      agentId: 'ada',
      turn: 23,
      contributionKind: 'local_observation',
      contributionEvidenceId: 'local:0',
      contributionSummary: 'New local observation: Crosswalk markings with bold white stripes ahead',
      drawingIntent: 'Show the bold white crosswalk stripes ahead.',
      informationDelta: 'New local observation: Crosswalk markings with bold white stripes ahead',
      messageAction: 'stillness',
      drawingPrompt: 'Sketch crosswalk markings with bold white stripes ahead.',
      groundedFeatures: ['Crosswalk markings with bold white stripes ahead']
    });
    controller.state.scratchpad.pendingMessage.replanCount = 2;
    controller.state.scratchpad.pendingMessage.replanFailureCount = 2;

    await controller.resumePendingDrawing();

    assert.equal(generatedImages, 0);
    assert.equal(controller.state.scratchpad.pendingMessage, null);
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).status, 'failed');
    assert.match(controller.state.scratchpad.messageAudit.at(-1).error, /low-information urban street/);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a persisted empty perspective axis is not treated as a landmark', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-axis-revalidation-test-'));
  let generatedImages = 0;
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: {},
      imageModel: {
        async generate() {
          generatedImages += 1;
          throw new Error('An empty perspective axis should not reach image generation');
        }
      },
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'persisted-empty-axis-report',
      agentId: 'ada',
      turn: 25,
      contributionKind: 'local_observation',
      contributionEvidenceId: 'local:0',
      contributionSummary: 'New local observation: Central axis receding toward a vanishing point',
      drawingIntent: 'Show the central axis receding toward a vanishing point.',
      informationDelta: 'New local observation: Central axis receding toward a vanishing point',
      messageAction: 'stillness',
      drawingPrompt: 'Sketch a central axis receding toward a vanishing point.',
      groundedFeatures: ['Central axis receding toward a vanishing point']
    });
    controller.state.scratchpad.pendingMessage.replanCount = 2;
    controller.state.scratchpad.pendingMessage.replanFailureCount = 2;

    await controller.resumePendingDrawing();

    assert.equal(generatedImages, 0);
    assert.equal(controller.state.scratchpad.pendingMessage, null);
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).status, 'failed');
    assert.match(controller.state.scratchpad.messageAudit.at(-1).error, /low-information urban street/);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a persisted response cannot depict a route after withholding destination certainty', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-response-revalidation-test-'));
  let generatedImages = 0;
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: {},
      imageModel: {
        async generate() {
          generatedImages += 1;
          throw new Error('A contradictory response should not reach image generation');
        }
      },
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'persisted-contradictory-response',
      agentId: 'ada',
      turn: 23,
      contributionKind: 'response',
      contributionEvidenceId: 'response:0',
      contributionSummary: 'My response to the received drawing: Continuation is plausible; no concrete destination yet.',
      drawingIntent: 'Offer an open urban axis toward a vanishing point.',
      informationDelta: 'My response to the received drawing: Continuation is plausible; no concrete destination yet.',
      messageAction: 'movement',
      drawingPrompt: 'Sketch a street receding toward a distant vanishing point.',
      groundedFeatures: ['Continuation is plausible; no concrete destination yet.']
    });
    controller.state.scratchpad.pendingMessage.replanCount = 2;
    controller.state.scratchpad.pendingMessage.replanFailureCount = 2;

    await controller.resumePendingDrawing();

    assert.equal(generatedImages, 0);
    assert.equal(controller.state.scratchpad.pendingMessage, null);
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).status, 'failed');
    assert.match(controller.state.scratchpad.messageAudit.at(-1).error, /route uncertainty/);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a persisted response cannot invent route coordination from a received report', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-invented-coordination-test-'));
  let generatedImages = 0;
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: {},
      imageModel: {
        async generate() {
          generatedImages += 1;
          throw new Error('An invented coordination response should not reach image generation');
        }
      },
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'persisted-invented-coordination-response',
      agentId: 'ada',
      turn: 24,
      contributionKind: 'response',
      contributionEvidenceId: 'response:0',
      contributionSummary: 'My response to the received drawing: Crosswalk-focused urban movement cue; supports continuing along a public corridor rather than copying a specific drawn route.',
      drawingIntent: 'Crosswalk-focused urban movement cue',
      informationDelta: 'My response to the received drawing: Crosswalk-focused urban movement cue; supports continuing along a public corridor rather than copying a specific drawn route.',
      messageAction: 'movement',
      drawingPrompt: 'Sketch a lone pedestrian crossing a broad public corridor.',
      groundedFeatures: ['Crosswalk-focused urban movement cue']
    });
    controller.state.scratchpad.pendingMessage.replanCount = 2;
    controller.state.scratchpad.pendingMessage.replanFailureCount = 2;

    await controller.resumePendingDrawing();

    assert.equal(generatedImages, 0);
    assert.equal(controller.state.scratchpad.pendingMessage, null);
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).status, 'failed');
    assert.match(controller.state.scratchpad.messageAudit.at(-1).error, /route coordination/);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a persisted reworded route-meaning question is not fresh', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-question-repeat-test-'));
  let generatedImages = 0;
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: {},
      imageModel: {
        async generate() {
          generatedImages += 1;
          throw new Error('A repeated route-meaning question should not reach image generation');
        }
      },
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.agents.ada.privateMemory.sentMessages = [{
      sequence: 16,
      contributionKind: 'question',
      contributionSummary: 'Question I am sending: Should I treat the crosswalk cue as a literal path or a symbolic hint for future direction?',
      informationDelta: 'Question I am sending: Should I treat the crosswalk cue as a literal path or a symbolic hint for future direction?',
      intent: 'Ask whether the crosswalk cue is a literal path or a symbolic hint.'
    }];
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'persisted-reworded-question',
      agentId: 'ada',
      turn: 27,
      contributionKind: 'question',
      contributionEvidenceId: 'question:0',
      contributionSummary: 'Question I am sending: Is Theo signaling a literal forward path or a symbolic urge to move along a broad axis without a fixed destination?',
      drawingIntent: 'Depict a literal fork and symbolic uncertainty.',
      informationDelta: 'Question I am sending: Is Theo signaling a literal forward path or a symbolic urge to move along a broad axis without a fixed destination?',
      messageAction: 'unclear',
      drawingPrompt: 'Sketch a fork asking whether the route is literal or symbolic.',
      groundedFeatures: ['literal forward path or symbolic urge']
    });
    controller.state.scratchpad.pendingMessage.replanCount = 2;
    controller.state.scratchpad.pendingMessage.replanFailureCount = 2;

    await controller.resumePendingDrawing();

    assert.equal(generatedImages, 0);
    assert.equal(controller.state.scratchpad.pendingMessage, null);
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).status, 'failed');
    assert.match(controller.state.scratchpad.messageAudit.at(-1).error, /shared-channel proposition/);
    assert.equal(controller.state.agents.ada.privateMemory.failedMessages.length, 1);
    assert.equal(
      controller.state.agents.ada.privateMemory.failedMessages[0].draftId,
      'persisted-reworded-question'
    );
    assert.equal(controller.state.agents.ada.privateMemory.failedMessages[0].sheetSequence, 0);
    assert.equal(controller.state.agents.ada.privateMemory.sentMessages.length, 1);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('semantic recovery exhaustion abandons only the unsent draft', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-abandoned-draft-test-'));
  let reviews = 0;
  const agentModel = {
    async reviewDrawing() {
      reviews += 1;
      return {
        accepted: false,
        assessment: 'The perspective reads as an invitation to move, not a local report.',
        revisionPrompt: 'Make the observed crossing primary without inviting movement.',
        blindRead: {
          dominantAction: 'movement',
          frameOfReference: 'recipient',
          communicationFunction: 'directive',
          readableText: false,
          likelyMessage: 'Walk toward the horizon.'
        }
      };
    }
  };
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel,
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'last-delivered-sheet',
      agentId: 'ada',
      turn: 8,
      contributionKind: 'local_observation',
      drawingPrompt: 'Draw a stone arcade.'
    });
    controller.state.scratchpad = commitRasterScratchpadMessage(controller.state.scratchpad, {
      pendingId: 'last-delivered-sheet',
      imageFile: 'last-delivered-sheet.webp'
    });
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'unsendable-draft',
      agentId: 'theo',
      turn: 9,
      contributionKind: 'local_observation',
      contributionSummary: 'New local observation: a crossing before a vanishing point',
      drawingIntent: 'Show the crossing as a stationary local observation.',
      informationDelta: 'New local observation: a crossing before a vanishing point',
      messageAction: 'stillness',
      drawingPrompt: 'Draw a crossing before a vanishing point.'
    });
    controller.state.scratchpad.pendingMessage.attempts = 5;
    controller.state.scratchpad.pendingMessage.replanCount = 2;

    await controller.resumePendingDrawing();

    assert.equal(reviews, 2);
    assert.equal(controller.state.scratchpad.pendingMessage, null);
    assert.equal(controller.state.scratchpad.sequence, 1);
    assert.equal(controller.state.scratchpad.owner, 'theo');
    assert.equal(controller.state.scratchpad.currentMessage.id, 'last-delivered-sheet');
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).id, 'unsendable-draft');
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).status, 'failed');
    assert.equal(controller.state.agents.theo.privateMemory.failedMessages.length, 1);
    assert.equal(
      controller.state.agents.theo.privateMemory.failedMessages[0].draftId,
      'unsendable-draft'
    );
    assert.equal(controller.state.agents.theo.privateMemory.failedMessages[0].sheetSequence, 1);
    assert.equal(controller.state.agents.theo.privateMemory.sentMessages.length, 0);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('failed semantic replanning abandons the draft instead of retrying its known-bad render prompt', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-replan-failure-test-'));
  let replans = 0;
  let reviews = 0;
  const agentModel = {
    async replanUnrenderableDrawing() {
      replans += 1;
      throw new Error('Rendezvous drawing replan omitted its visual message');
    },
    async reviewDrawing() {
      reviews += 1;
      return {
        accepted: false,
        assessment: 'The median tree is more dominant than the broad avenue.',
        revisionPrompt: 'Make the avenue more dominant.',
        blindRead: {
          dominantAction: 'stillness',
          frameOfReference: 'sender',
          communicationFunction: 'report',
          readableText: false,
          likelyMessage: 'The sender sees a broad avenue with a central median tree.'
        }
      };
    }
  };
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel,
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'failed-replan-report',
      agentId: 'ada',
      turn: 9,
      contributionKind: 'local_observation',
      contributionEvidenceId: 'local:0',
      contributionSummary: 'New local observation: broad avenue with a central median tree',
      drawingIntent: 'Show the broad avenue and central median tree.',
      informationDelta: 'New local observation: broad avenue with a central median tree',
      messageAction: 'unclear',
      drawingPrompt: 'Draw a broad avenue with a central median tree.',
      groundedFeatures: ['broad avenue with a central median tree']
    });
    controller.state.scratchpad.pendingMessage.attempts = 6;
    controller.state.scratchpad.pendingMessage.totalAttempts = 6;
    controller.state.scratchpad.pendingMessage.replanCount = 1;
    controller.state.agents.ada.status = 'waiting';
    controller.state.agents.ada.sheetBlockedPanoId = controller.state.agents.ada.panoId;

    await controller.resumePendingDrawing();

    assert.equal(replans, 1);
    assert.equal(controller.state.scratchpad.pendingMessage.replanCount, 1);
    assert.equal(controller.state.scratchpad.pendingMessage.replanFailureCount, 1);
    assert.ok(Date.parse(controller.state.scratchpad.pendingMessage.nextAttemptAt) > Date.now());

    controller.state.scratchpad.pendingMessage.nextAttemptAt = new Date(Date.now() - 1).toISOString();
    await controller.resumePendingDrawing();

    assert.equal(replans, 2);
    assert.equal(reviews, 0);
    assert.equal(controller.state.scratchpad.pendingMessage, null);
    assert.equal(controller.state.scratchpad.currentMessage, null);
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).replanCount, 2);
    assert.equal(controller.state.scratchpad.messageAudit.at(-1).status, 'failed');
    assert.match(
      controller.state.scratchpad.messageAudit.at(-1).error,
      /Semantic drawing replanning exhausted/
    );
    assert.equal(controller.state.agents.ada.status, 'searching');
    assert.equal(controller.state.agents.ada.sheetBlockedPanoId, null);
    assert.equal(controller.state.agents.ada.privateMemory.failedMessages.at(-1).draftId, 'failed-replan-report');
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('drawing failure preserves a retryable handoff across controller restart', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-drawing-retry-test-'));
  try {
    const first = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: new FakeRendezvousModel(),
      imageModel: {
        async generate() {
          throw new Error('temporary image outage');
        }
      },
      logger: { warn() {}, error() {} }
    });
    await first.createRun();
    first.state.scratchpad = queueRasterScratchpadMessage(first.state.scratchpad, {
      id: 'retry-message',
      agentId: 'ada',
      turn: 3,
      drawingIntent: 'Preserve this message until it can cross.',
      drawingPrompt: 'Draw two circles separated by an arch.',
      referenceViewIndices: [0]
    });
    const referenceDirectory = path.join(
      tempDir,
      'rendezvous-drawings',
      first.state.runId
    );
    const referencePath = path.join(
      referenceDirectory,
      'retry-message-reference-0.jpg'
    );
    await fsp.mkdir(referenceDirectory, { recursive: true });
    await fsp.writeFile(referencePath, 'retry-source-view');

    await first.resumePendingDrawing();

    assert.equal(first.state.scratchpad.owner, 'ada');
    assert.equal(first.state.scratchpad.pendingMessage.id, 'retry-message');
    assert.equal(first.state.scratchpad.pendingMessage.status, 'retrying');
    assert.equal(first.state.scratchpad.pendingMessage.attempts, 1);
    assert.match(first.state.scratchpad.pendingMessage.lastError, /temporary image outage/);
    assert.equal(first.state.scratchpad.messageAudit.length, 0);
    assert.equal((await fsp.readFile(referencePath, 'utf8')), 'retry-source-view');

    first.state.scratchpad.pendingMessage.nextAttemptAt = new Date(0).toISOString();
    await first.saveState();
    const restartedImageModel = new FakeImageModel();
    const restarted = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: new FakeRendezvousModel(),
      imageModel: restartedImageModel,
      logger: { warn() {}, error() {} }
    });
    await restarted.loadState();
    await restarted.resumePendingDrawing();

    assert.equal(restarted.state.scratchpad.pendingMessage, null);
    assert.equal(restarted.state.scratchpad.currentMessage.id, 'retry-message');
    assert.equal(restarted.state.scratchpad.owner, 'theo');
    assert.equal(restarted.state.scratchpad.messageAudit[0].status, 'sent');
    assert.equal(
      restartedImageModel.calls[0].referenceImage.content,
      'retry-source-view'
    );
    await assert.rejects(fsp.access(referencePath), { code: 'ENOENT' });
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('an image finishing after reset cannot commit into the successor run', async () => {
  const previousPairIndex = process.env.RENDEZVOUS_START_PAIR_INDEX;
  process.env.RENDEZVOUS_START_PAIR_INDEX = '0';
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-reset-image-race-test-'));
  const imageGate = deferred();
  const imageModel = {
    calls: 0,
    async generate() {
      this.calls += 1;
      await imageGate.promise;
      return {
        buffer: Buffer.from('stale-raster'),
        mimeType: 'image/webp',
        model: 'deferred-image',
        requestId: 'stale-request'
      };
    }
  };
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: new FakeRendezvousModel(),
      imageModel,
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    const oldRunId = controller.state.runId;
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'stale-message',
      agentId: 'ada',
      turn: 3,
      drawingPrompt: 'A drawing that belongs only to the old run.'
    });
    const staleWork = controller.resumePendingDrawing();
    while (imageModel.calls === 0) await new Promise(resolve => setTimeout(resolve, 1));

    await controller.reset();
    const newRunId = controller.state.runId;
    assert.notEqual(newRunId, oldRunId);
    assert.equal(controller.state.scratchpad.sequence, 0);
    assert.equal(controller.state.scratchpad.messageAudit.length, 0);

    imageGate.resolve();
    await staleWork;
    assert.equal(controller.state.runId, newRunId);
    assert.equal(controller.state.scratchpad.sequence, 0);
    assert.equal(controller.state.scratchpad.currentMessage, null);
    assert.equal(controller.state.scratchpad.messageAudit.length, 0);
    await assert.rejects(
      fsp.access(path.join(tempDir, 'rendezvous-drawings', newRunId, 'stale-message.webp')),
      { code: 'ENOENT' }
    );
  } finally {
    if (previousPairIndex === undefined) delete process.env.RENDEZVOUS_START_PAIR_INDEX;
    else process.env.RENDEZVOUS_START_PAIR_INDEX = previousPairIndex;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('reset waits for an active step before replacing run state', async () => {
  const previousPairIndex = process.env.RENDEZVOUS_START_PAIR_INDEX;
  process.env.RENDEZVOUS_START_PAIR_INDEX = '0';
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-reset-step-race-test-'));
  const decisionGate = deferred();
  let decisionStarted = false;
  const agentModel = {
    async decide(input) {
      decisionStarted = true;
      await decisionGate.promise;
      return {
        action: 'move',
        selectedIndex: 0,
        reasoning: 'I choose the locally distinctive open street.',
        observation: 'A stone facade stands beside a broad public road.',
        observedFeatures: ['a stone facade', 'a broad public road beside it'],
        drawingGroundedFeatures: ['a stone facade', 'a broad public road beside it'],
        sheetInterpretation: '',
        sheetConfidence: 0,
        memoryUpdate: { currentPlan: 'Keep gathering local evidence.' },
        drawingIntent: 'Preserve the facade beside the broad road.',
        drawingPrompt: 'Sketch a stone facade beside a broad public road.',
        fallbackCause: null
      };
    }
  };
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel,
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    const oldRunId = controller.state.runId;
    controller.state.status = 'running';
    controller.running = true;
    const tickWork = controller.tick();
    while (!decisionStarted) await new Promise(resolve => setTimeout(resolve, 1));

    let resetFinished = false;
    const resetWork = controller.reset().then(value => {
      resetFinished = true;
      return value;
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(resetFinished, false);

    decisionGate.resolve();
    await tickWork;
    await resetWork;
    assert.notEqual(controller.state.runId, oldRunId);
    assert.equal(controller.state.turn, 0);
    assert.equal(controller.state.scratchpad.sequence, 0);
    assert.equal(controller.state.scratchpad.messageAudit.length, 0);
    assert.equal(controller.state.agents.ada.stepCount, 0);
    assert.equal(controller.state.agents.theo.stepCount, 0);
  } finally {
    if (previousPairIndex === undefined) delete process.env.RENDEZVOUS_START_PAIR_INDEX;
    else process.env.RENDEZVOUS_START_PAIR_INDEX = previousPairIndex;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('drawing cleanup removes only raster files no longer referenced by durable state', async () => {
  const previousPairIndex = process.env.RENDEZVOUS_START_PAIR_INDEX;
  process.env.RENDEZVOUS_START_PAIR_INDEX = '0';
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-drawing-cleanup-test-'));
  try {
    const first = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: new FakeRendezvousModel(),
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await first.createRun();
    first.state.scratchpad = queueRasterScratchpadMessage(first.state.scratchpad, {
      id: 'retained-first',
      agentId: 'ada',
      turn: 1,
      drawingPrompt: 'A first retained drawing.'
    });
    await first.resumePendingDrawing();

    const drawingDir = path.join(tempDir, 'rendezvous-drawings', first.state.runId);
    await fsp.writeFile(path.join(drawingDir, 'orphaned.webp'), 'orphan');
    await fsp.writeFile(path.join(drawingDir, 'orphaned.png'), 'orphan');
    await fsp.writeFile(path.join(drawingDir, 'operator-note.txt'), 'keep non-raster files');
    await first.saveState();

    const restarted = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: new FakeRendezvousModel(),
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await restarted.loadState();
    assert.equal(await fsp.readFile(path.join(drawingDir, 'retained-first.webp'), 'utf8'), 'fake-raster-1');
    await assert.rejects(fsp.access(path.join(drawingDir, 'orphaned.webp')), { code: 'ENOENT' });
    await assert.rejects(fsp.access(path.join(drawingDir, 'orphaned.png')), { code: 'ENOENT' });
    assert.equal(await fsp.readFile(path.join(drawingDir, 'operator-note.txt'), 'utf8'), 'keep non-raster files');

    await fsp.writeFile(path.join(drawingDir, 'post-load-orphan.webp'), 'orphan');
    restarted.state.scratchpad = queueRasterScratchpadMessage(restarted.state.scratchpad, {
      id: 'retained-second',
      agentId: 'theo',
      turn: 2,
      drawingPrompt: 'A second retained drawing.'
    });
    await restarted.resumePendingDrawing();
    assert.equal(await fsp.readFile(path.join(drawingDir, 'retained-first.webp'), 'utf8'), 'fake-raster-1');
    assert.equal(await fsp.readFile(path.join(drawingDir, 'retained-second.webp'), 'utf8'), 'fake-raster-1');
    await assert.rejects(fsp.access(path.join(drawingDir, 'post-load-orphan.webp')), { code: 'ENOENT' });
  } finally {
    if (previousPairIndex === undefined) delete process.env.RENDEZVOUS_START_PAIR_INDEX;
    else process.env.RENDEZVOUS_START_PAIR_INDEX = previousPairIndex;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('starting a successor run preserves archived drawings and removes only orphaned run directories', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-archive-drawing-cleanup-test-'));
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: new FakeRendezvousModel(),
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    const archivedRunId = controller.state.runId;
    const archivedDir = path.join(tempDir, 'rendezvous-drawings', archivedRunId);
    await fsp.mkdir(archivedDir, { recursive: true });
    await fsp.writeFile(path.join(archivedDir, 'old.webp'), 'archived raster');
    const orphanedRunId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const orphanedDir = path.join(tempDir, 'rendezvous-drawings', orphanedRunId);
    await fsp.mkdir(orphanedDir, { recursive: true });
    await fsp.writeFile(path.join(orphanedDir, 'orphaned.webp'), 'orphaned raster');
    const nonRunDir = path.join(tempDir, 'rendezvous-drawings', 'operator-assets');
    await fsp.mkdir(nonRunDir, { recursive: true });
    await fsp.writeFile(path.join(nonRunDir, 'keep.webp'), 'operator raster');

    await controller.createRun();

    assert.equal(await fsp.readFile(path.join(archivedDir, 'old.webp'), 'utf8'), 'archived raster');
    await assert.rejects(fsp.access(orphanedDir), { code: 'ENOENT' });
    assert.equal(await fsp.readFile(path.join(nonRunDir, 'keep.webp'), 'utf8'), 'operator raster');
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a live v4 run migrates in place with an exact rollback save and rasterized current sheet', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-v4-migration-test-'));
  const runId = 'active-v4-run';
  const legacyState = {
    mode: 'rendezvous',
    runId,
    status: 'paused',
    turn: 42,
    meeting: { goal: 'find_each_other', distanceMeters: 800 },
    agents: {},
    eventLog: [],
    scratchpad: {
      version: 4,
      width: 768,
      height: 512,
      owner: 'theo',
      inTransit: null,
      sequence: 2,
      heldSinceTurn: 40,
      operations: [
        { id: 'replace', type: 'replaceSheet', author: 'ada', sequence: 1, turn: 40 },
        { id: 'sketch', type: 'sketch', author: 'ada', scene: 'landmark', details: ['tower'], label: '', secondaryLabel: '', movement: null, sequence: 2, turn: 40 }
      ]
    }
  };
  const original = `${JSON.stringify(legacyState, null, 2)}\n`;
  await fsp.writeFile(path.join(tempDir, 'rendezvous-current.json'), original);
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: new FakeRendezvousModel(),
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.loadState();

    assert.equal(controller.state.runId, runId);
    assert.equal(controller.state.turn, 42);
    assert.equal(controller.state.scratchpad.version, 5);
    assert.equal(controller.state.scratchpad.owner, 'theo');
    assert.equal(controller.state.scratchpad.currentMessage.from, 'ada');
    assert.equal(controller.state.scratchpad.currentMessage.to, 'theo');
    assert.equal(controller.state.eventLog.at(-1).type, 'scratchpad_migrated');
    assert.equal(
      await fsp.readFile(path.join(tempDir, 'rendezvous-runs', `${runId}-pre-v5.json`), 'utf8'),
      original
    );
    const imagePath = controller.getDrawingPath(runId, controller.state.scratchpad.currentMessage.id);
    assert.ok(imagePath);
    assert.ok((await fsp.stat(imagePath)).size > 100);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('an active run gains private memory with an exact pre-migration rollback save', async () => {
  const previousPairIndex = process.env.RENDEZVOUS_START_PAIR_INDEX;
  process.env.RENDEZVOUS_START_PAIR_INDEX = '0';
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-memory-migration-test-'));
  try {
    const first = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: new FakeRendezvousModel(),
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await first.createRun();
    first.state.status = 'paused';
    first.state.turn = 88;
    for (const agent of Object.values(first.state.agents)) {
      delete agent.privateMemory;
      delete agent.movementSinceDecision;
      delete agent.waitTurnsRemaining;
    }
    const original = `${JSON.stringify(first.state, null, 2)}\n`;
    await fsp.writeFile(path.join(tempDir, 'rendezvous-current.json'), original);

    const migrated = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: new FakeRendezvousModel(),
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await migrated.loadState();

    assert.equal(migrated.state.turn, 88);
    assert.equal(migrated.state.agents.ada.privateMemory.version, RENDEZVOUS_MEMORY_VERSION);
    assert.equal(migrated.state.agents.theo.privateMemory.version, RENDEZVOUS_MEMORY_VERSION);
    assert.match(migrated.state.agents.ada.privateMemory.ownObservations.at(-1).description, /unfamiliar Manhattan corner/);
    assert.equal(
      await fsp.readFile(
        path.join(tempDir, 'rendezvous-runs', `${first.state.runId}-pre-memory-v${RENDEZVOUS_MEMORY_VERSION}.json`),
        'utf8'
      ),
      original
    );
    const persisted = JSON.parse(await fsp.readFile(path.join(tempDir, 'rendezvous-current.json'), 'utf8'));
    assert.equal(persisted.agents.ada.privateMemory.version, RENDEZVOUS_MEMORY_VERSION);
  } finally {
    if (previousPairIndex === undefined) delete process.env.RENDEZVOUS_START_PAIR_INDEX;
    else process.env.RENDEZVOUS_START_PAIR_INDEX = previousPairIndex;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('RendezvousController uses one causal drawing pad and can find the other agent', async () => {
  const previousPairIndex = process.env.RENDEZVOUS_START_PAIR_INDEX;
  process.env.RENDEZVOUS_START_PAIR_INDEX = '0';
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-test-'));
  const events = [];
  const model = new FakeRendezvousModel();
  const imageModel = new FakeImageModel();

  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: model,
      imageModel,
      emit: (event, data) => events.push({ event, data }),
      logger: { warn() {}, error() {} }
    });

    await controller.createRun();
    controller.state.status = 'running';
    controller.running = true;

    for (let i = 0; i < 6 && controller.state.status !== 'found'; i += 1) {
      await controller.tick();
      await controller.resumePendingDrawing();
    }

    assert.equal(controller.state.status, 'found');
    assert.ok(events.some(entry => entry.event === 'rendezvous-found'));
    assert.ok(events.some(entry =>
      entry.event === 'rendezvous-step' &&
        /only the sheet/.test(entry.data?.reasoning || '')
    ));
    assert.ok(controller.state.scratchpad);
    assert.ok(controller.state.scratchpad.currentMessage);
    assert.ok(events.some(entry => entry.event === 'rendezvous-scratchpad' && entry.data?.kind === 'sent'));
    assert.ok(controller.state.eventLog.some(entry => entry.type === 'scratchpad_queued'));
    assert.ok(controller.state.eventLog.some(entry => entry.type === 'scratchpad_sent'));
    assert.equal(imageModel.calls.length, model.calls.length);
    assert.ok(model.calls.length > 0);
    assert.ok(imageModel.calls.every(call => call.groundedFeatures.length >= 2));
    for (const call of model.calls) {
      assert.equal(Object.hasOwn(call.agent, 'position'), false);
      assert.equal(Object.hasOwn(call.agent, 'path'), false);
      assert.equal(Object.hasOwn(call, 'partner'), false);
      assert.equal(Object.hasOwn(call, 'distanceToFriend'), false);
      assert.equal(call.options.some(option => Object.hasOwn(option, 'distanceToFriend')), false);
      assert.equal(call.options.some(option => Object.hasOwn(option, 'position')), false);
      assert.equal(Object.hasOwn(call, 'ownPadText'), false);
      assert.equal(Object.hasOwn(call, 'partnerPadText'), false);
    }
    assert.ok(model.calls.every(call => call.options.length >= 2));

    const publicState = controller.getPublicState();
    const completedRunId = publicState.runId;
    assert.equal(publicState.mode, 'rendezvous');
    assert.equal(publicState.meeting.goal, 'find_each_other');
    assert.equal(publicState.meeting.target, null);
    assert.equal(publicState.meeting.adaDistanceToTarget, null);
    assert.equal(publicState.meeting.theoDistanceToTarget, null);
    assert.equal(publicState.notebook, null);
    assert.equal(publicState.scratchpad.version, 5);
    assert.match(publicState.scratchpad.currentMessage.imageUrl, /^\/api\/rendezvous\/drawings\//);
    assert.equal(Object.hasOwn(publicState.scratchpad, 'messageAudit'), false);
    assert.equal(Object.hasOwn(publicState.scratchpad, 'pendingMessage'), false);
    assert.doesNotMatch(JSON.stringify(publicState.scratchpad), /observational sketch chosen/i);
    const history = controller.getPublicHistory();
    assert.equal(history.runId, completedRunId);
    assert.equal(history.items.length, controller.state.scratchpad.messageAudit.filter(message => message.status === 'sent').length);
    assert.ok(history.items.every(item => item.snapshot?.approximate === false));
    assert.ok(history.items.every(item => item.snapshot.agents.ada.pathLength <= publicState.agents.ada.path.length));
    assert.ok(history.items.every(item => item.snapshot.agents.theo.pathLength <= publicState.agents.theo.path.length));
    assert.ok(controller.getDrawingPath(completedRunId, history.items[0].id));
    assert.doesNotMatch(JSON.stringify(history), /drawingPrompt|drawingIntent|groundedFeatures|privateMemory/);
    assert.equal(publicState.eventLog.some(entry => entry.type === 'agent_step' && entry.payload.searchTargetName), false);
    assert.equal(publicState.eventLog.some(entry => Object.hasOwn(entry.payload || {}, 'targetName')), false);
    assert.equal(publicState.eventLog.some(entry => Object.hasOwn(entry.payload || {}, 'distanceToTarget')), false);

    const legacyTelegram = {
      id: 'legacy-wire',
      from: 'ada',
      to: 'theo',
      status: 'delivered',
      text: 'I am in Midtown near Bryant Park.',
      clues: {
        neighborhood: 'Midtown',
        nearestLandmark: 'Bryant Park',
        landmarkDistance: 'a few blocks',
        intention: 'moving west',
        target: 'Bryant Park',
        answer: 'hold the plan'
      },
      roughPosition: { position: { lat: 40.75, lng: -73.98 } }
    };
    controller.state.telegrams.push(legacyTelegram);
    controller.state.agents.theo.inbox.push(legacyTelegram);

    const migratedPublicState = controller.getPublicState();
    const migratedWire = migratedPublicState.telegrams.find(telegram => telegram.id === 'legacy-wire');
    const migratedInboxWire = migratedPublicState.agents.theo.inbox.find(telegram => telegram.id === 'legacy-wire');
    assert.equal(migratedWire.text, 'Legacy wire archived; the drawing sheet is now the only shared channel.');
    assert.deepEqual(migratedWire.clues, { answer: 'hold the plan' });
    assert.equal(Object.hasOwn(migratedWire, 'roughPosition'), false);
    assert.equal(migratedInboxWire.text, migratedWire.text);
    assert.equal(Object.hasOwn(migratedInboxWire, 'roughPosition'), false);

    controller.state.agents.ada.lastDecision = {
      reasoning: 'Ada turns south using Union Square as the nearest guidebook anchor. The last telegram puts their friend somewhere around NoHo, so the route bends toward that rough wire.'
    };
    controller.state.agents.ada.recentNotes = [
      'The last telegram puts Theo somewhere around NoHo before the wire before Union Square.'
    ];
    controller.state.eventLog.push({
      type: 'agent_step',
      turn: controller.state.turn,
      payload: {
        agentName: 'Ada',
        reasoning: 'The last telegram puts Theo somewhere around NoHo, so Ada follows the rough wire.'
      }
    });
    controller.state.eventLog.push({
      type: 'telegram_sent',
      turn: controller.state.turn,
      payload: legacyTelegram
    });
    const sanitizedPublicState = controller.getPublicState();
    assert.doesNotMatch(sanitizedPublicState.agents.ada.lastDecision.reasoning, /telegram|rough wire|nearest guidebook|somewhere around/i);
    assert.equal(Object.hasOwn(sanitizedPublicState.agents.ada.lastDecision, 'targetName'), false);
    assert.equal(Object.hasOwn(sanitizedPublicState.agents.ada.lastDecision, 'distanceToTarget'), false);
    assert.match(sanitizedPublicState.agents.ada.lastDecision.reasoning, /shared (?:drawing )?sheet|personal street observations/);
    assert.doesNotMatch(sanitizedPublicState.agents.ada.recentNotes[0], /telegram|wire before|somewhere around/i);
    const sanitizedAgentEvent = sanitizedPublicState.eventLog.filter(entry => entry.type === 'agent_step').at(-1);
    assert.doesNotMatch(sanitizedAgentEvent.payload.reasoning, /telegram|rough wire|somewhere around/i);
    assert.match(sanitizedAgentEvent.payload.reasoning, /shared (?:drawing )?sheet|personal street observations/);
    const sanitizedTelegramEvent = sanitizedPublicState.eventLog.find(entry =>
      entry.type === 'telegram_sent' && entry.payload?.id === 'legacy-wire'
    );
    assert.equal(sanitizedTelegramEvent.payload.text, 'Legacy wire archived; the drawing sheet is now the only shared channel.');
    assert.deepEqual(sanitizedTelegramEvent.payload.clues, { answer: 'hold the plan' });
    assert.equal(sanitizedPublicState.notebook, null);

    await controller.reset();
    const archived = JSON.parse(await fsp.readFile(
      path.join(tempDir, 'rendezvous-runs', `${completedRunId}.json`),
      'utf8'
    ));
    assert.equal(archived.runId, completedRunId);
    assert.equal(archived.status, 'found');
    assert.notEqual(controller.state.runId, completedRunId);
  } finally {
    if (previousPairIndex === undefined) {
      delete process.env.RENDEZVOUS_START_PAIR_INDEX;
    } else {
      process.env.RENDEZVOUS_START_PAIR_INDEX = previousPairIndex;
    }
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('an agent receives prior sent and received drawings as private visual history', async () => {
  const previousPairIndex = process.env.RENDEZVOUS_START_PAIR_INDEX;
  process.env.RENDEZVOUS_START_PAIR_INDEX = '0';
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-visual-history-test-'));
  const model = new FakeRendezvousModel();
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: model,
      imageModel: new FakeImageModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'ada-history',
      agentId: 'ada',
      turn: 0,
      drawingIntent: 'First grounded clue.',
      drawingPrompt: 'Sketch the stone facade and its hanging traffic light.',
      groundedFeatures: ['a stone facade', 'a hanging traffic light']
    });
    await controller.resumePendingDrawing();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'theo-current',
      agentId: 'theo',
      turn: 1,
      drawingIntent: 'Return a grounded clue.',
      drawingPrompt: 'Sketch the broad road and the row of globe lamps.',
      groundedFeatures: ['a broad road', 'a row of globe lamps']
    });
    await controller.resumePendingDrawing();
    controller.state.status = 'running';
    controller.running = true;

    await controller.tick();
    await controller.resumePendingDrawing();

    assert.equal(model.calls.length, 1);
    assert.deepEqual(model.calls[0].visualHistory, [{
      sequence: 1,
      direction: 'sent',
      content: 'fake-raster-1'
    }]);
  } finally {
    if (previousPairIndex === undefined) delete process.env.RENDEZVOUS_START_PAIR_INDEX;
    else process.env.RENDEZVOUS_START_PAIR_INDEX = previousPairIndex;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('a run ends honestly after its persisted branch-decision budget', async () => {
  const previousPairIndex = process.env.RENDEZVOUS_START_PAIR_INDEX;
  const previousBudget = process.env.RENDEZVOUS_MAX_BRANCH_DECISIONS;
  process.env.RENDEZVOUS_START_PAIR_INDEX = '0';
  process.env.RENDEZVOUS_MAX_BRANCH_DECISIONS = '2';
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-budget-test-'));
  const events = [];
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: new FakeRendezvousModel(),
      imageModel: new FakeImageModel(),
      emit: (event, data) => events.push({ event, data }),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.status = 'running';
    controller.running = true;

    await controller.tick();
    await controller.resumePendingDrawing();
    await controller.tick();
    await controller.resumePendingDrawing();

    assert.equal(controller.state.status, 'lost');
    assert.equal(controller.running, false);
    assert.match(controller.state.lostReason, /2-decision search budget/);
    assert.ok(events.some(entry => entry.event === 'rendezvous-lost'));
    assert.ok(controller.state.eventLog.some(entry => entry.type === 'rendezvous_lost'));
    assert.equal(controller.state.scratchpad.pendingMessage, null);
    assert.match(
      controller.state.scratchpad.messageAudit.at(-1).error,
      /search budget ended before this draft was sent/
    );
    assert.equal(controller.getPublicState().agents.ada.branchDecisionCount, undefined);
  } finally {
    if (previousPairIndex === undefined) delete process.env.RENDEZVOUS_START_PAIR_INDEX;
    else process.env.RENDEZVOUS_START_PAIR_INDEX = previousPairIndex;
    if (previousBudget === undefined) delete process.env.RENDEZVOUS_MAX_BRANCH_DECISIONS;
    else process.env.RENDEZVOUS_MAX_BRANCH_DECISIONS = previousBudget;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('loading a terminal run cancels and audits its persisted pending drawing', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-terminal-pending-test-'));
  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      logger: { warn() {}, error() {} }
    });
    await controller.createRun();
    controller.state.scratchpad = queueRasterScratchpadMessage(controller.state.scratchpad, {
      id: 'terminal-unsent-draft',
      agentId: 'ada',
      turn: 12,
      contributionKind: 'local_observation',
      contributionEvidenceId: 'local:0',
      contributionSummary: 'New local observation: tree canopy overhead along the path',
      drawingIntent: 'Show the tree canopy overhead along the path.',
      informationDelta: 'New local observation: tree canopy overhead along the path',
      messageAction: 'unclear',
      drawingPrompt: 'Draw a tree canopy overhead along a path.',
      groundedFeatures: ['tree canopy overhead along the path']
    });
    controller.state.status = 'lost';
    controller.state.lostReason = 'The search budget ended.';
    await controller.saveState();

    const restored = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      logger: { warn() {}, error() {} }
    });
    const publicState = await restored.loadState();

    assert.equal(publicState.status, 'lost');
    assert.equal(publicState.scratchpad.isGenerating, false);
    assert.equal(restored.state.scratchpad.pendingMessage, null);
    assert.equal(restored.state.scratchpad.messageAudit.at(-1).id, 'terminal-unsent-draft');
    assert.match(
      restored.state.scratchpad.messageAudit.at(-1).error,
      /search budget ended before this draft was sent/
    );
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('RendezvousController avoids indoor start panos and recovers blocked agents', async () => {
  const previousPairIndex = process.env.RENDEZVOUS_START_PAIR_INDEX;
  process.env.RENDEZVOUS_START_PAIR_INDEX = '0';
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-test-'));
  const events = [];

  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new IndoorAdaStartStreetView(),
      emit: (event, data) => events.push({ event, data }),
      logger: { warn() {}, error() {} }
    });

    await controller.createRun();
    assert.equal(controller.state.agents.ada.panoId, 'ada-start');
    assert.equal(controller.state.agents.ada.path[0].panoId, 'ada-start');

    controller.state.agents.ada.panoId = 'ada-indoor-store';
    controller.state.agents.ada.position = { lat: 40.759011, lng: -73.984472 };
    controller.state.agents.ada.path = [{
      ...controller.state.agents.ada.position,
      panoId: 'ada-indoor-store',
      timestamp: new Date().toISOString()
    }];
    controller.state.agents.ada.visitedPanos = ['ada-indoor-store'];
    controller.state.status = 'running';
    controller.running = true;
    controller.state.turn = 0;

    await controller.tick();

    assert.equal(controller.state.agents.ada.panoId, 'ada-start');
    assert.equal(controller.state.agents.ada.path.length, 2);
    assert.equal(controller.state.agents.ada.lastDecision.mode, 'recovering');
    assert.ok(events.some(entry => entry.event === 'rendezvous-step' && entry.data?.mode === 'recovering'));
    assert.ok(controller.state.eventLog.some(entry => entry.type === 'street_recovery'));
  } finally {
    if (previousPairIndex === undefined) {
      delete process.env.RENDEZVOUS_START_PAIR_INDEX;
    } else {
      process.env.RENDEZVOUS_START_PAIR_INDEX = previousPairIndex;
    }
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('legacy rendezvous stays read-only until an explicit start archives it', async () => {
  const previousPairIndex = process.env.RENDEZVOUS_START_PAIR_INDEX;
  process.env.RENDEZVOUS_START_PAIR_INDEX = '0';
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-test-'));
  const legacyRunId = 'legacy-run';
  const legacyState = {
    mode: 'rendezvous',
    runId: legacyRunId,
    status: 'idle',
    turn: 0,
    notebook: { version: 1, lastReliableClue: 'legacy clue' },
    agents: {},
    eventLog: []
  };
  await fsp.writeFile(path.join(tempDir, 'rendezvous-current.json'), JSON.stringify(legacyState));

  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: new FakeRendezvousModel(),
      logger: { warn() {}, error() {} }
    });
    await controller.loadState();

    assert.equal(controller.state.runId, legacyRunId);
    assert.equal(controller.state.scratchpad, null);
    assert.equal(controller.getPublicState().scratchpad.version, 4);

    await controller.start();
    await controller.stop();

    assert.notEqual(controller.state.runId, legacyRunId);
    assert.equal(controller.state.scratchpad.version, 5);
    const archived = JSON.parse(await fsp.readFile(
      path.join(tempDir, 'rendezvous-runs', `${legacyRunId}.json`),
      'utf8'
    ));
    assert.deepEqual(archived.notebook, legacyState.notebook);
  } finally {
    if (previousPairIndex === undefined) {
      delete process.env.RENDEZVOUS_START_PAIR_INDEX;
    } else {
      process.env.RENDEZVOUS_START_PAIR_INDEX = previousPairIndex;
    }
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

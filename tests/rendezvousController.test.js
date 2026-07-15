import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  RendezvousController,
  isShortPanoLoop
} from '../server/rendezvous/rendezvousController.js';
import { queueRasterScratchpadMessage } from '../server/rendezvous/scratchpad.js';

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
      sheetMessage: input.sheetMessage
    }));
    return {
      action: 'move',
      selectedIndex: input.options.findIndex(option => !input.agent.visitedPanos.includes(option.panoId)) >= 0
        ? input.options.findIndex(option => !input.agent.visitedPanos.includes(option.panoId))
        : 0,
      reasoning: `${input.agent.name} follows the clearest unfamiliar public route using only the sheet and the visible street.`,
      observation: `${input.agent.name} sees a broad public route beside a stone facade.`,
      sheetInterpretation: `${input.agent.name} thinks the current sheet suggests convergence.`,
      memoryUpdate: {
        journeySummary: `${input.agent.name} remembers the streets already walked and the current stone facade.`,
        partnerBelief: `${input.partnerName} is also moving and trying to converge.`,
        visualVocabulary: 'A circle may indicate convergence.',
        jointPlan: 'Keep moving while exchanging grounded landmarks.'
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
      sheetInterpretation: 'The received drawing may indicate convergence near a landmark.',
      memoryUpdate: {
        journeySummary: 'I remember my route and the public landmark at this branch.',
        partnerBelief: 'My friend is actively moving and trying to coordinate with me.',
        visualVocabulary: 'A circle may indicate convergence near a landmark.',
        jointPlan: 'Coordinate movement and deliberate waiting through the sheet.'
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
      drawingPrompt: input.drawingPrompt
    });
    return {
      buffer: Buffer.from(`fake-raster-${this.calls.length}`),
      mimeType: 'image/webp',
      model: 'fake-image',
      requestId: `request-${this.calls.length}`
    };
  }
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

test('isShortPanoLoop detects an active ABAB suffix after an older third pano', () => {
  assert.equal(isShortPanoLoop(['midtown', 'central', 'midtown', '4d', 'midtown', '4d']), true);
  assert.equal(isShortPanoLoop(['midtown', 'central', 'midtown', '4d', 'midtown', 'east']), false);
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

    await controller.tick();
    assert.equal(controller.state.agents.ada.panoId, 'ada-start');
    assert.equal(controller.state.agents.ada.stepCount, 0);
    assert.equal(controller.state.agents.ada.lastDecision.mode, 'waiting_for_sheet');
    assert.equal(model.calls.length, 0);

    controller.state.turn = 0;
    controller.state.agents.ada.panoId = 'ada-mid';
    controller.state.agents.ada.position = { lat: 40.7559, lng: -73.9838 };
    controller.state.agents.ada.path.push({ ...controller.state.agents.ada.position, panoId: 'ada-mid' });
    controller.state.agents.ada.visitedPanos = ['ada-start', 'ada-mid'];
    await controller.tick();
    assert.equal(controller.state.agents.ada.panoId, 'target');
    assert.equal(controller.state.agents.ada.lastDecision.mode, 'auto');
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
    assert.equal(controller.state.agents.ada.waitTurnsRemaining, 2);
    assert.equal(controller.state.agents.ada.privateMemory.receivedSheets[0].sequence, 1);
    assert.match(controller.state.agents.ada.privateMemory.receivedSheets[0].interpretation, /convergence/);
    await controller.resumePendingDrawing();
    assert.equal(controller.state.agents.ada.privateMemory.sentMessages[0].sequence, 2);
    assert.match(controller.state.agents.ada.privateMemory.sentMessages[0].intent, /landmark/);

    const publicState = controller.getPublicState();
    assert.equal(Object.hasOwn(publicState.agents.ada, 'privateMemory'), false);
    assert.equal(Object.hasOwn(publicState.agents.ada, 'movementSinceDecision'), false);
    assert.equal(Object.hasOwn(publicState.agents.ada, 'waitTurnsRemaining'), false);
    assert.doesNotMatch(JSON.stringify(publicState), /approaching a shared landmark|circle may indicate convergence/i);

    await controller.saveState();
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

    restarted.state.turn = 2;
    await restarted.tick();
    assert.equal(restarted.state.agents.ada.panoId, 'ada-start');
    assert.equal(restarted.state.agents.ada.lastDecision.mode, 'deliberate_wait');
    assert.equal(restarted.state.agents.ada.waitTurnsRemaining, 1);
    assert.equal(restartedModel.calls.length, 0);
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
      drawingPrompt: 'A soft graphite sketch of three receding arches.'
    });
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
    assert.equal(migrated.state.agents.ada.privateMemory.version, 1);
    assert.equal(migrated.state.agents.theo.privateMemory.version, 1);
    assert.match(migrated.state.agents.ada.privateMemory.journeySummary, /unfamiliar Manhattan corner/);
    assert.equal(
      await fsp.readFile(
        path.join(tempDir, 'rendezvous-runs', `${first.state.runId}-pre-memory-v1.json`),
        'utf8'
      ),
      original
    );
    const persisted = JSON.parse(await fsp.readFile(path.join(tempDir, 'rendezvous-current.json'), 'utf8'));
    assert.equal(persisted.agents.ada.privateMemory.version, 1);
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

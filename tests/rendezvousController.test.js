import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { RendezvousController } from '../server/rendezvous/rendezvousController.js';

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
      canEditPad: input.canEditPad,
      forcePass: input.forcePass,
      padStatus: input.padStatus
    }));
    return {
      selectedIndex: input.options.findIndex(option => !input.agent.visitedPanos.includes(option.panoId)) >= 0
        ? input.options.findIndex(option => !input.agent.visitedPanos.includes(option.panoId))
        : 0,
      reasoning: `${input.agent.name} follows the clearest unfamiliar public route using only the sheet and the visible street.`,
      padOperations: input.canEditPad
        ? [{
            type: 'text',
            text: `${input.agent.name}: broad crossing`,
            at: { x: 0.12, y: input.agent.id === 'ada' ? 0.2 : 0.35 },
            size: 28
          }]
        : [],
      passPad: input.canEditPad,
      fallbackCause: null
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

test('RendezvousController uses one causal drawing pad and can find the other agent', async () => {
  const previousPairIndex = process.env.RENDEZVOUS_START_PAIR_INDEX;
  process.env.RENDEZVOUS_START_PAIR_INDEX = '0';
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-test-'));
  const events = [];
  const model = new FakeRendezvousModel();

  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
      agentModel: model,
      emit: (event, data) => events.push({ event, data }),
      logger: { warn() {}, error() {} }
    });

    await controller.createRun();
    controller.state.status = 'running';
    controller.running = true;

    for (let i = 0; i < 6 && controller.state.status !== 'found'; i += 1) {
      await controller.tick();
    }

    assert.equal(controller.state.status, 'found');
    assert.ok(events.some(entry => entry.event === 'rendezvous-found'));
    assert.ok(events.some(entry =>
      entry.event === 'rendezvous-step' &&
        /only the sheet/.test(entry.data?.reasoning || '')
    ));
    assert.ok(controller.state.scratchpad);
    assert.ok(controller.state.scratchpad.operations.length > 0);
    assert.ok(events.some(entry => entry.event === 'rendezvous-scratchpad' && entry.data?.kind === 'drawn'));
    assert.ok(events.some(entry => entry.event === 'rendezvous-scratchpad' && entry.data?.kind === 'delivered'));
    assert.ok(controller.state.eventLog.some(entry => entry.type === 'scratchpad_drawn'));
    assert.ok(controller.state.eventLog.some(entry => entry.type === 'scratchpad_passed'));
    assert.ok(model.calls.length > 0);
    for (const call of model.calls) {
      assert.equal(Object.hasOwn(call.agent, 'position'), false);
      assert.equal(Object.hasOwn(call.agent, 'path'), false);
      assert.equal(Object.hasOwn(call, 'partner'), false);
      assert.equal(Object.hasOwn(call, 'distanceToFriend'), false);
      assert.equal(call.options.some(option => Object.hasOwn(option, 'distanceToFriend')), false);
      assert.equal(call.options.some(option => Object.hasOwn(option, 'position')), false);
      if (call.options.some(option => !call.agent.visitedPanos.includes(option.panoId))) {
        assert.equal(
          call.options.every(option => !call.agent.visitedPanos.includes(option.panoId)),
          true,
          'visited back-links should be withheld while a progressive route exists'
        );
      }
    }

    const publicState = controller.getPublicState();
    const completedRunId = publicState.runId;
    assert.equal(publicState.mode, 'rendezvous');
    assert.equal(publicState.meeting.goal, 'find_each_other');
    assert.equal(publicState.meeting.target, null);
    assert.equal(publicState.meeting.adaDistanceToTarget, null);
    assert.equal(publicState.meeting.theoDistanceToTarget, null);
    assert.equal(publicState.notebook, null);
    assert.equal(publicState.scratchpad.version, 2);
    assert.equal(publicState.scratchpad.operations.some(operation => /-?\d+\.\d{3,}/.test(operation.text || '')), false);
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
    assert.equal(controller.getPublicState().scratchpad.version, 2);

    await controller.start();
    await controller.stop();

    assert.notEqual(controller.state.runId, legacyRunId);
    assert.equal(controller.state.scratchpad.version, 2);
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

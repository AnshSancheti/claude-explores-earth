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
}

test('RendezvousController delivers useful telegrams and can reach a found state', async () => {
  const previousPairIndex = process.env.RENDEZVOUS_START_PAIR_INDEX;
  process.env.RENDEZVOUS_START_PAIR_INDEX = '0';
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rendezvous-test-'));
  const events = [];

  try {
    const controller = new RendezvousController({
      dataDir: tempDir,
      streetView: new FakeStreetView(),
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
    assert.ok(controller.state.telegrams.some(telegram => telegram.status === 'delivered'));
    assert.ok(events.some(entry =>
      entry.event === 'rendezvous-step' &&
        /rough wire/.test(entry.data?.reasoning || '')
    ));

    const publicState = controller.getPublicState();
    assert.equal(publicState.mode, 'rendezvous');
    assert.equal(publicState.agents.ada.friendEstimate?.position, undefined);
    assert.equal(publicState.telegrams.some(telegram => Object.hasOwn(telegram, 'roughPosition')), false);
    assert.match(publicState.telegrams[0].text, /Bryant Park/);
    assert.doesNotMatch(publicState.telegrams[0].text, /-?\d+\.\d{3,}/);
  } finally {
    if (previousPairIndex === undefined) {
      delete process.env.RENDEZVOUS_START_PAIR_INDEX;
    } else {
      process.env.RENDEZVOUS_START_PAIR_INDEX = previousPairIndex;
    }
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

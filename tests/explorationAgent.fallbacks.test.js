import test from 'node:test';
import assert from 'node:assert/strict';
import { ExplorationAgent } from '../server/agents/explorationAgent.js';

function makeAgentWithMocks({ links, frontier }) {
  process.env.START_LAT = process.env.START_LAT || '40.75';
  process.env.START_LNG = process.env.START_LNG || '-73.98';
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';

  const globalExploration = { broadcast: () => {} };
  const logger = { log: () => {} };
  const agent = new ExplorationAgent(globalExploration, logger);

  agent.streetViewHeadless = {
    shouldRefresh: () => false,
    getCurrentPanorama: async () => ({
      panoId: 'A',
      position: { lat: 40.75, lng: -73.98 },
      links
    }),
    navigateToPano: async () => ({ settledPanoId: 'A', reason: 'already-there' }),
    setHeading: async () => {},
    getScreenshot: async () => Buffer.from([])
  };

  agent.pathfinder = {
    findPathToNearestFrontier: () => null,
    findClusteredPathToFrontier: () => null,
    findBestEscapeDirection: () => null
  };

  agent.currentPanoId = 'A';
  agent.currentPosition = { lat: 40.75, lng: -73.98 };
  agent.coverage.addVisited('A', { lat: 40.75, lng: -73.98 }, links);

  for (const link of links) {
    agent.coverage.addVisited(
      link.pano,
      { lat: 40.7501, lng: -73.9801 },
      [{ pano: 'A', heading: (link.heading + 180) % 360, description: '' }]
    );
  }

  if (frontier) {
    agent.coverage.frontier.set(frontier.panoId, {
      discoveredFrom: frontier.discoveredFrom,
      heading: frontier.heading ?? 0,
      description: ''
    });
  }

  return agent;
}

test('exploreStep teleports when pathfinder proposes unavailable next hop', async () => {
  const links = [
    { pano: 'B', heading: 0, description: '' },
    { pano: 'C', heading: 180, description: '' }
  ];
  const agent = makeAgentWithMocks({
    links,
    frontier: { panoId: 'F1', discoveredFrom: 'B', heading: 90 }
  });

  agent.pathfinder.findPathToNearestFrontier = () => ({
    targetPanoId: 'F1',
    nextStep: 'Z_NOT_IN_CURRENT_LINKS',
    pathLength: 3,
    fullPath: ['Z_NOT_IN_CURRENT_LINKS', 'Y', 'F1'],
    expanded: 12
  });

  let teleportCalls = 0;
  agent.teleportToFrontier = async () => {
    teleportCalls++;
    return {
      stepCount: 1,
      reasoning: 'Teleporting to unreachable frontier',
      panoId: 'TELEPORTED',
      mode: 'pathfinding',
      screenshots: []
    };
  };

  const result = await agent.exploreStep();
  assert.equal(teleportCalls, 1);
  assert.equal(result.reasoning, 'Teleporting to unreachable frontier');
});

test('single-link oscillation triggers second-chance teleport guard', async () => {
  const links = [{ pano: 'B', heading: 180, description: '' }];
  const agent = makeAgentWithMocks({
    links,
    frontier: { panoId: 'F2', discoveredFrom: 'A', heading: 10 }
  });

  // Force pathfinding branch to fail once, then rely on single-link loop guard.
  agent.pathfinder.findPathToNearestFrontier = () => null;
  agent.pathfinder.findClusteredPathToFrontier = () => null;
  agent.pathfinder.findBestEscapeDirection = () => null;

  // Recent oscillation: A->B->A->B->A and single-link would go to B again.
  agent.coverage.recentHistory = ['A', 'B', 'A', 'B', 'A'];

  let teleportCalls = 0;
  agent.teleportToFrontier = async () => {
    teleportCalls++;
    if (teleportCalls === 1) {
      return null; // pathfinding fallback fails first time
    }
    return {
      stepCount: 1,
      reasoning: 'Teleporting to unreachable frontier',
      panoId: 'TELEPORTED_ON_GUARD',
      mode: 'pathfinding',
      screenshots: []
    };
  };

  const result = await agent.exploreStep();
  assert.equal(teleportCalls, 2);
  assert.equal(result.panoId, 'TELEPORTED_ON_GUARD');
});

test('stale-cell threshold forces immediate frontier teleport', async () => {
  const links = [{ pano: 'B', heading: 180, description: '' }];
  const agent = makeAgentWithMocks({
    links,
    frontier: { panoId: 'F3', discoveredFrom: 'A', heading: 45 }
  });

  agent.stepsSinceNewCell = 5;
  agent.staleCellThresholdSteps = 5;

  let teleportCalls = 0;
  agent.teleportToFrontier = async () => {
    teleportCalls++;
    return {
      stepCount: 1,
      reasoning: 'Teleporting to unreachable frontier',
      panoId: 'TELEPORTED_STALE',
      mode: 'pathfinding',
      screenshots: []
    };
  };

  const result = await agent.exploreStep();
  assert.equal(teleportCalls, 1);
  assert.equal(result.panoId, 'TELEPORTED_STALE');
});

test('multi-link loop filter removes cycle-extending option and moves to safe link', async () => {
  const links = [
    { pano: 'B', heading: 0, description: '' },
    { pano: 'C', heading: 90, description: '' }
  ];
  const agent = makeAgentWithMocks({ links, frontier: null });

  const panos = {
    A: { panoId: 'A', position: { lat: 40.75, lng: -73.98 }, links },
    B: { panoId: 'B', position: { lat: 40.7501, lng: -73.9801 }, links: [{ pano: 'A', heading: 180, description: '' }] },
    C: { panoId: 'C', position: { lat: 40.7502, lng: -73.9799 }, links: [{ pano: 'A', heading: 270, description: '' }] }
  };
  let currentPano = 'A';
  agent.streetViewHeadless = {
    shouldRefresh: () => false,
    getCurrentPanorama: async () => panos[currentPano],
    navigateToPano: async (panoId) => {
      currentPano = panoId;
      return { settledPanoId: panoId, reason: 'ok' };
    },
    setHeading: async () => {},
    getScreenshot: async () => Buffer.from([])
  };

  agent.screenshot = {
    capture: async (step, heading) => ({
      filename: `${step}-${Math.round(heading)}.jpg`,
      thumbFilename: `${step}-${Math.round(heading)}-thumb.jpg`,
      base64: ''
    })
  };

  // Build a recent A<->B pattern so choosing B again is loop-risk, while C is safe.
  agent.coverage.recentHistory = ['B', 'A', 'B', 'A', 'B', 'A'];

  let aiCandidatePanos = [];
  agent.ai = {
    decideNextMove: async ({ links: aiLinks }) => {
      aiCandidatePanos = aiLinks.map(link => link.pano);
      return {
        selectedPanoId: aiLinks[0].pano,
        reasoning: 'Pick first safe option'
      };
    }
  };

  const result = await agent.exploreStep();
  assert.deepEqual(aiCandidatePanos, []);
  assert.equal(result.panoId, 'C');
});

test('pathfinding move that extends 3-node cycle tail is diverted via teleport', async () => {
  const links = [{ pano: 'C', heading: 120, description: '' }];
  const agent = makeAgentWithMocks({
    links,
    frontier: { panoId: 'F4', discoveredFrom: 'C', heading: 120 }
  });

  agent.currentPanoId = 'B';
  agent.currentPosition = { lat: 40.75015, lng: -73.98005 };
  agent.coverage.addVisited('B', agent.currentPosition, links);
  agent.coverage.recentHistory = ['A', 'B', 'C', 'A', 'B', 'C', 'A', 'B'];

  agent.streetViewHeadless = {
    shouldRefresh: () => false,
    getCurrentPanorama: async () => ({
      panoId: 'B',
      position: { lat: 40.75015, lng: -73.98005 },
      links
    }),
    navigateToPano: async () => ({ settledPanoId: 'C', reason: 'ok' }),
    setHeading: async () => {},
    getScreenshot: async () => Buffer.from([])
  };

  agent.pathfinder.findPathToNearestFrontier = () => ({
    targetPanoId: 'F4',
    nextStep: 'C',
    pathLength: 2,
    fullPath: ['C', 'F4'],
    expanded: 5
  });

  let teleportCalls = 0;
  agent.teleportToFrontier = async () => {
    teleportCalls++;
    return {
      stepCount: 1,
      reasoning: 'Teleporting to unreachable frontier',
      panoId: 'TELEPORTED_CYCLE',
      mode: 'pathfinding',
      screenshots: []
    };
  };

  const result = await agent.exploreStep();
  assert.equal(teleportCalls, 1);
  assert.equal(result.panoId, 'TELEPORTED_CYCLE');
});

test('soak: avoids sustained two-node oscillation when alternate visited link exists', async () => {
  const links = [
    { pano: 'B', heading: 0, description: '' },
    { pano: 'C', heading: 90, description: '' }
  ];
  const agent = makeAgentWithMocks({ links, frontier: null });

  const world = {
    A: { panoId: 'A', position: { lat: 40.75, lng: -73.98 }, links },
    B: { panoId: 'B', position: { lat: 40.7501, lng: -73.9801 }, links: [{ pano: 'A', heading: 180, description: '' }] },
    C: { panoId: 'C', position: { lat: 40.7502, lng: -73.9799 }, links: [{ pano: 'A', heading: 270, description: '' }] }
  };

  let currentPano = 'A';
  agent.currentPanoId = currentPano;
  agent.currentPosition = { ...world[currentPano].position };
  agent.coverage.recentHistory = ['A'];
  agent.streetViewHeadless = {
    shouldRefresh: () => false,
    getCurrentPanorama: async () => world[currentPano],
    navigateToPano: async (panoId) => {
      currentPano = panoId;
      return { settledPanoId: panoId, reason: 'ok' };
    },
    setHeading: async () => {},
    getScreenshot: async () => Buffer.from([])
  };
  agent.screenshot = {
    capture: async (step, heading) => ({
      filename: `${step}-${Math.round(heading)}.jpg`,
      thumbFilename: `${step}-${Math.round(heading)}-thumb.jpg`,
      base64: ''
    })
  };
  agent.ai = {
    decideNextMove: async ({ links: aiLinks }) => ({
      selectedPanoId: aiLinks[0].pano,
      reasoning: 'Deterministic first-choice selection'
    })
  };

  const sequence = ['A'];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    for (let i = 0; i < 30; i++) {
      const step = await agent.exploreStep();
      sequence.push(step.panoId);
    }
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }

  const longestAlternatingRun = (nodes) => {
    let best = 0;
    for (let i = 0; i + 1 < nodes.length; i++) {
      const a = nodes[i];
      const b = nodes[i + 1];
      if (!a || !b || a === b) continue;
      let len = 2;
      while (i + len < nodes.length) {
        const expected = len % 2 === 0 ? a : b;
        if (nodes[i + len] !== expected) break;
        len++;
      }
      if (len > best) best = len;
    }
    return best;
  };

  const maxAltRun = longestAlternatingRun(sequence);
  const visitsToB = sequence.filter(id => id === 'B').length;
  const visitsToC = sequence.filter(id => id === 'C').length;

  assert.ok(maxAltRun < 12, `expected no sustained ping-pong tail, got alternating run length ${maxAltRun}`);
  assert.ok(visitsToB > 0, 'expected B to be visited at least once');
  assert.ok(visitsToC > 0, 'expected C to be visited at least once');
});

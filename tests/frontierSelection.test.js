import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectClosestFrontierByDiscovery } from '../server/agents/explorationAgent.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function haversineMeters(a, b) {
  const R = 6371e3;
  const p1 = a.lat * Math.PI / 180;
  const p2 = b.lat * Math.PI / 180;
  const dp = (b.lat - a.lat) * Math.PI / 180;
  const dl = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

test('selectClosestFrontierByDiscovery chooses nearest discoveredFrom anchor', () => {
  const graph = new Map([
    ['A', { lat: 40.7000, lng: -74.0000 }],
    ['B', { lat: 40.7100, lng: -73.9900 }],
    ['C', { lat: 40.7300, lng: -73.9700 }]
  ]);
  const frontiers = [
    { panoId: 'F1', discoveredFrom: 'A' },
    { panoId: 'F2', discoveredFrom: 'B' },
    { panoId: 'F3', discoveredFrom: 'C' }
  ];
  const current = { lat: 40.7098, lng: -73.9902 };

  const selected = selectClosestFrontierByDiscovery(frontiers, graph, current, haversineMeters);
  assert.ok(selected);
  assert.equal(selected.frontier.panoId, 'F2');
  assert.equal(selected.frontier.discoveredFrom, 'B');
});

test('selectClosestFrontierByDiscovery works on saved hairy graph', (t) => {
  const savePath = path.join(__dirname, '..', 'runs', 'saves', 'current-run.json');
  if (!fs.existsSync(savePath)) {
    t.skip('save file not available in this environment');
    return;
  }

  const saveData = JSON.parse(fs.readFileSync(savePath, 'utf8'));
  const graphObj = saveData.graph || {};
  const graph = new Map();
  for (const [panoId, node] of Object.entries(graphObj)) {
    graph.set(panoId, { lat: node.lat, lng: node.lng });
  }

  // Derive frontier candidates from neighbors not present in graph.
  const frontiers = [];
  for (const [panoId, node] of Object.entries(graphObj)) {
    for (const nei of node.neighbors || []) {
      if (!graph.has(nei)) {
        frontiers.push({ panoId: nei, discoveredFrom: panoId });
      }
    }
  }
  assert.ok(frontiers.length > 0, 'expected unresolved neighbors in saved graph');

  const current = saveData.currentState?.position || { lat: 40.75, lng: -73.98 };
  const selected = selectClosestFrontierByDiscovery(frontiers, graph, current, haversineMeters);
  assert.ok(selected, 'expected to select a closest frontier from save graph');
  assert.ok(selected.frontier.discoveredFrom);
  assert.ok(graph.has(selected.frontier.discoveredFrom));
  assert.ok(Number.isFinite(selected.distanceMeters));
});

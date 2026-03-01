import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoverageTracker } from '../server/services/coverage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('isAlternatingLoop detects A-B oscillation tails', () => {
  const coverage = new CoverageTracker();
  coverage.recentHistory = ['A', 'B', 'A', 'B', 'A'];

  assert.equal(coverage.isAlternatingLoop('B', 6), true);
  assert.equal(coverage.isAlternatingLoop('C', 6), false);
  assert.equal(coverage.isAlternatingLoop('B', 8), false);
});

test('replay-style sequence from logs matches alternating loop detector', (t) => {
  const logPath = path.join(__dirname, '..', 'runs', 'exploration_logs', 'exploration-1755553502417.log');
  if (!fs.existsSync(logPath)) {
    t.skip('replay log not available in this environment');
    return;
  }

  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  const toSequence = [];

  for (const line of lines) {
    const entry = JSON.parse(line);
    if (entry.event !== 'exploration-step') continue;
    if (!entry.data?.to) continue;
    toSequence.push(entry.data.to);
  }

  // Find an ABABAB pattern window and assert the detector flags continuing it.
  let found = null;
  for (let i = 0; i + 5 < toSequence.length; i++) {
    const win = toSequence.slice(i, i + 6);
    if (win[0] === win[1]) continue;
    const alternating = win.every((id, idx) => id === (idx % 2 === 0 ? win[0] : win[1]));
    if (alternating) {
      found = { i, win };
      break;
    }
  }

  assert.ok(found, 'expected at least one alternating window in replay log');
  const coverage = new CoverageTracker();
  coverage.recentHistory = found.win.slice(0, 5);
  assert.equal(coverage.isAlternatingLoop(found.win[5], 6), true);
});

test('spatial cell tracking treats tiny moves as same cell', () => {
  process.env.LOOP_CELL_SIZE_M = '5';
  const coverage = new CoverageTracker();
  const a = coverage.addVisited('A', { lat: 40.750000, lng: -73.980000 }, []);
  const b = coverage.addVisited('B', { lat: 40.750002, lng: -73.980002 }, []);

  assert.equal(a.isNewCell, true);
  assert.equal(b.isNewCell, false);
  assert.equal(coverage.visitedCells.size, 1);
});

test('wouldExtendRepeatingCycle detects 3-node repeating tail', () => {
  const coverage = new CoverageTracker();
  coverage.recentHistory = ['A', 'B', 'C', 'A', 'B', 'C', 'A', 'B'];

  assert.equal(
    coverage.wouldExtendRepeatingCycle('C', {
      minPeriod: 2,
      maxPeriod: 6,
      minRepeats: 3
    }),
    true
  );
  assert.equal(
    coverage.wouldExtendRepeatingCycle('D', {
      minPeriod: 2,
      maxPeriod: 6,
      minRepeats: 3
    }),
    false
  );
});

test('run-log replay tail would trigger repeating-cycle guard', (t) => {
  const logPath = path.join(__dirname, '..', 'runs', 'exploration_logs', 'exploration-1755553502417.log');
  if (!fs.existsSync(logPath)) {
    t.skip('replay log not available in this environment');
    return;
  }

  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  const toSequence = [];
  for (const line of lines) {
    const entry = JSON.parse(line);
    if (entry.event === 'exploration-step' && entry.data?.to) {
      toSequence.push(entry.data.to);
    }
  }

  let tail = null;
  for (let i = 0; i + 7 < toSequence.length; i++) {
    const window = toSequence.slice(i, i + 8);
    const a = window[0];
    const b = window[1];
    if (!a || !b || a === b) continue;
    const alternating = window.every((id, idx) => id === (idx % 2 === 0 ? a : b));
    if (alternating) {
      tail = window;
      break;
    }
  }

  assert.ok(tail, 'expected alternating tail window in replay log');
  const coverage = new CoverageTracker();
  const shouldTrigger = [];
  for (let i = 5; i < tail.length; i++) {
    coverage.recentHistory = tail.slice(0, i);
    const next = tail[i];
    shouldTrigger.push(
      coverage.wouldExtendRepeatingCycle(next, {
        minPeriod: 2,
        maxPeriod: 4,
        minRepeats: 3
      })
    );
  }
  assert.ok(shouldTrigger.some(Boolean), 'expected at least one continuation to trigger repeating-cycle guard');
});

import { test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SAVES_DIR = path.join(ROOT, 'runs', 'saves');
const PERSISTENT_LOGS_DIR = path.join(ROOT, 'runs', 'persistent_logs');
const OUT_DIR = path.join(ROOT, 'runs', 'ui-inspection', 'playwright-loop-audit');
const CURRENT_SAVE = path.join(SAVES_DIR, 'current-run.json');
const BACKUP_SAVE = path.join(SAVES_DIR, 'current-run.json.bak-playwright-loop-audit');

const RUN_STEPS = parseInt(process.env.LOOP_AUDIT_STEPS || '90', 10);
const RUN_TIMEOUT_MS = parseInt(process.env.LOOP_AUDIT_TIMEOUT_MS || '180000', 10);
const SAVE_FILTER = (process.env.LOOP_AUDIT_SAVES || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getSaveFiles() {
  let files = fs.readdirSync(SAVES_DIR)
    .filter((f) => /^current-run-\d+\.json$/.test(f))
    .sort((a, b) => {
      const aN = parseInt(a.match(/\d+/)[0], 10);
      const bN = parseInt(b.match(/\d+/)[0], 10);
      return aN - bN;
    });
  if (SAVE_FILTER.length > 0) {
    const allowed = new Set(SAVE_FILTER);
    files = files.filter(f => allowed.has(f));
  }
  return files;
}

function getLatestPersistentLogFile() {
  const files = fs.readdirSync(PERSISTENT_LOGS_DIR)
    .filter((f) => /^exploration-.*\.jsonl$/.test(f))
    .sort((a, b) => b.localeCompare(a)); // ISO-like timestamp in filename => lexicographic newest-first
  return files.length ? path.join(PERSISTENT_LOGS_DIR, files[0]) : null;
}

function parseStepEntries(logPath, minStepExclusive, maxStepInclusive) {
  if (!logPath || !fs.existsSync(logPath)) return [];
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const stepCount = entry?.stepCount;
    if (typeof stepCount !== 'number') continue;
    if (stepCount <= minStepExclusive || stepCount > maxStepInclusive) continue;
    if (!entry?.panoId) continue;
    entries.push(entry);
  }
  return entries;
}

function maxAlternatingRun(sequence) {
  let best = 0;
  for (let i = 0; i + 1 < sequence.length; i++) {
    const a = sequence[i];
    const b = sequence[i + 1];
    if (!a || !b || a === b) continue;
    let len = 2;
    for (let j = i + 2; j < sequence.length; j++) {
      const expected = ((j - i) % 2 === 0) ? a : b;
      if (sequence[j] !== expected) break;
      len++;
    }
    if (len > best) best = len;
  }
  return best;
}

function maxPeriodicRun(sequence, minPeriod = 2, maxPeriod = 6) {
  let best = { length: 0, period: null };
  for (let period = minPeriod; period <= maxPeriod; period++) {
    for (let i = 0; i + period * 2 <= sequence.length; i++) {
      let len = period;
      for (let j = i + period; j < sequence.length; j++) {
        if (sequence[j] !== sequence[j - period]) break;
        len++;
      }
      if (len > best.length) {
        best = { length: len, period };
      }
    }
  }
  return best;
}

function computeLoopMetrics(stepEntries, before, after) {
  const sequence = stepEntries
    .slice()
    .sort((a, b) => a.stepCount - b.stepCount)
    .map((e) => e.panoId);
  const uniqueNodes = new Set(sequence).size;
  const edges = [];
  for (let i = 1; i < sequence.length; i++) {
    edges.push(`${sequence[i - 1]}->${sequence[i]}`);
  }
  const edgeCounts = new Map();
  for (const edge of edges) {
    edgeCounts.set(edge, (edgeCounts.get(edge) || 0) + 1);
  }
  const topEdgeCount = edgeCounts.size ? Math.max(...edgeCounts.values()) : 0;
  const topEdge = edgeCounts.size
    ? [...edgeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
    : null;
  const altRun = maxAlternatingRun(sequence);
  const periodic = maxPeriodicRun(sequence, 2, 6);
  const totalSteps = sequence.length;
  const locationDelta = Math.max(0, (after.locations || 0) - (before.locations || 0));
  const uniqueRatio = totalSteps > 0 ? uniqueNodes / totalSteps : 0;
  const topEdgeRatio = edges.length > 0 ? topEdgeCount / edges.length : 0;
  const progressPerStep = totalSteps > 0 ? locationDelta / totalSteps : 0;

  const loopSignals = [];
  if (altRun >= 12) {
    loopSignals.push(`long alternating tail (${altRun})`);
  }
  if (periodic.length >= 14 && periodic.period <= 4) {
    loopSignals.push(`periodic tail length ${periodic.length} (period ${periodic.period})`);
  }
  if (totalSteps >= 40 && progressPerStep < 0.12) {
    loopSignals.push(`low discovery rate (${locationDelta}/${totalSteps})`);
  }
  if (totalSteps >= 40 && topEdgeRatio > 0.45) {
    loopSignals.push(`dominant repeated edge ${topEdge} (${(topEdgeRatio * 100).toFixed(1)}%)`);
  }

  return {
    totalSteps,
    locationDelta,
    progressPerStep,
    uniqueNodes,
    uniqueRatio,
    maxAlternatingRun: altRun,
    maxPeriodicLength: periodic.length,
    maxPeriodicPeriod: periodic.period,
    topEdge,
    topEdgeCount,
    topEdgeRatio,
    loopSignals,
    hasLoopProblem: loopSignals.length > 0
  };
}

async function uiStats(page) {
  return page.evaluate(() => {
    const asNum = (id) => Number((document.getElementById(id)?.textContent || '0').replace(/[^\d.-]/g, '')) || 0;
    return {
      step: asNum('currentStep'),
      locations: asNum('locationsVisited'),
      distanceMeters: asNum('distanceTraveled')
    };
  });
}

test.describe.configure({ mode: 'serial' });

test('playwright save loop audit', async ({ page }) => {
  test.setTimeout(30 * 60 * 1000);

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }
  if (!fs.existsSync(CURRENT_SAVE)) {
    throw new Error(`Missing save file: ${CURRENT_SAVE}`);
  }

  fs.copyFileSync(CURRENT_SAVE, BACKUP_SAVE);

  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    await dialog.accept();
  });

  const browserErrors = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error' || /\berror\b/i.test(text)) {
      browserErrors.push(text);
    }
  });

  const auth = {
    token: Buffer.from(`admin:${Date.now()}`).toString('base64'),
    expires: Date.now() + 60 * 60 * 1000
  };

  await page.addInitScript((adminAuth) => {
    localStorage.setItem('adminAuth', JSON.stringify(adminAuth));
  }, auth);

  const saveFiles = getSaveFiles();
  const initialLogFile = getLatestPersistentLogFile();
  if (!initialLogFile) {
    throw new Error('Could not find active persistent exploration log file');
  }
  const logFilesUsed = new Set([initialLogFile]);

  const results = [];
  try {
    await page.goto('http://127.0.0.1:5173', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForSelector('#loadBtn', { timeout: 60000 });
    await page.waitForSelector('#startBtn', { timeout: 60000 });

    // Ensure control buttons are visible in automation.
    await page.evaluate(() => {
      if (window.adminAuth?.showControls) {
        window.adminAuth.showControls();
      }
    });

    for (const saveFile of saveFiles) {
      const savePath = path.join(SAVES_DIR, saveFile);
      const save = readJson(savePath);
      fs.copyFileSync(savePath, CURRENT_SAVE);

      await page.click('#loadBtn');
      await page.waitForFunction(
        (expectedStep) => Number(document.getElementById('currentStep')?.textContent || '0') === expectedStep,
        save.stepCount,
        { timeout: 120000 }
      );
      await page.waitForTimeout(1500);

      const before = await uiStats(page);
      const stepTarget = before.step + RUN_STEPS;

      const startBtnDisabledBefore = await page.locator('#startBtn').isDisabled();
      if (!startBtnDisabledBefore) {
        await page.click('#startBtn');
      }

      let reachedTarget = true;
      try {
        await page.waitForFunction(
          (target) => Number(document.getElementById('currentStep')?.textContent || '0') >= target,
          stepTarget,
          { timeout: RUN_TIMEOUT_MS }
        );
      } catch {
        reachedTarget = false;
      }

      const stopBtnDisabled = await page.locator('#stopBtn').isDisabled();
      if (!stopBtnDisabled) {
        await page.click('#stopBtn');
      }
      await page.waitForFunction(
        () => !document.getElementById('startBtn')?.disabled,
        { timeout: 120000 }
      );
      await page.waitForTimeout(1500);

      const after = await uiStats(page);
      const stepLogFile = getLatestPersistentLogFile() || initialLogFile;
      logFilesUsed.add(stepLogFile);
      const stepEntries = parseStepEntries(stepLogFile, before.step, after.step);
      const metrics = computeLoopMetrics(stepEntries, before, after);

      const screenshotPath = path.join(OUT_DIR, saveFile.replace('.json', '.png'));
      await page.screenshot({ path: screenshotPath, fullPage: true });

      results.push({
        saveFile,
        expectedStep: save.stepCount,
        reachedTarget,
        before,
        after,
        stepDeltaUI: after.step - before.step,
        persistentLogFile: stepLogFile,
        metrics,
        screenshotPath
      });
    }
  } finally {
    fs.copyFileSync(BACKUP_SAVE, CURRENT_SAVE);
    fs.unlinkSync(BACKUP_SAVE);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    runStepsTarget: RUN_STEPS,
    runTimeoutMs: RUN_TIMEOUT_MS,
    logFilesUsed: Array.from(logFilesUsed),
    dialogs,
    browserErrorCount: browserErrors.length,
    browserErrors: browserErrors.slice(-50),
    results
  };

  const reportPath = path.join(OUT_DIR, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`Playwright loop audit report: ${reportPath}`);
  for (const r of results) {
    const loopStatus = r.metrics.hasLoopProblem ? 'LOOP-RISK' : 'OK';
    console.log(
      `${r.saveFile}: ${loopStatus} | steps=${r.metrics.totalSteps} loc+${r.metrics.locationDelta} ` +
      `alt=${r.metrics.maxAlternatingRun} periodic=${r.metrics.maxPeriodicLength}/${r.metrics.maxPeriodicPeriod ?? '-'} ` +
      `topEdgeRatio=${(r.metrics.topEdgeRatio * 100).toFixed(1)}%`
    );
  }
});

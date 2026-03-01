import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = path.resolve('.');
const SAVES_DIR = path.join(ROOT, 'runs', 'saves');
const CURRENT_SAVE = path.join(SAVES_DIR, 'current-run.json');
const BACKUP_SAVE = path.join(SAVES_DIR, 'current-run.json.bak-inspect');
const OUT_DIR = path.join(ROOT, 'runs', 'ui-inspection');

const CANDIDATES = [
  'current-run-709.json',
  'current-run-6720.json',
  'current-run-19151.json'
];

function readExpected(saveFile) {
  const data = JSON.parse(fs.readFileSync(path.join(SAVES_DIR, saveFile), 'utf8'));
  return {
    saveFile,
    expectedStep: data.stepCount,
    expectedLocations: data.stats?.locationsVisited ?? null
  };
}

function setCurrentSave(saveFile) {
  fs.copyFileSync(path.join(SAVES_DIR, saveFile), CURRENT_SAVE);
}

async function getUiState(page) {
  return await page.evaluate(() => {
    const step = Number(document.getElementById('currentStep')?.textContent || 0);
    const locations = Number(document.getElementById('locationsVisited')?.textContent || 0);
    const distance = document.getElementById('distanceTraveled')?.textContent || '';
    return { step, locations, distance };
  });
}

async function waitForLoadApplied(page, expectedStep) {
  await page.waitForFunction(
    (target) => Number(document.getElementById('currentStep')?.textContent || 0) === target,
    { timeout: 30000 },
    expectedStep
  );
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }
  if (!fs.existsSync(CURRENT_SAVE)) {
    throw new Error(`Missing ${CURRENT_SAVE}`);
  }
  if (fs.existsSync(BACKUP_SAVE)) {
    fs.unlinkSync(BACKUP_SAVE);
  }
  fs.copyFileSync(CURRENT_SAVE, BACKUP_SAVE);

  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1720, height: 1080 });

  const dialogs = [];
  page.on('dialog', async (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    await dialog.accept();
  });

  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('Error') || text.includes('error')) {
      console.log(`[browser-console] ${text}`);
    }
  });

  const token = Buffer.from(`admin:${Date.now()}`).toString('base64');
  const auth = JSON.stringify({
    token,
    expires: Date.now() + 60 * 60 * 1000
  });

  await page.evaluateOnNewDocument((adminAuthJson) => {
    localStorage.setItem('adminAuth', adminAuthJson);
  }, auth);

  try {
    await page.goto('http://127.0.0.1:5173', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#loadBtn', { timeout: 30000 });
    await page.waitForSelector('#currentStep', { timeout: 30000 });
    await new Promise((resolve) => setTimeout(resolve, 4000));

    const results = [];
    for (const saveFile of CANDIDATES) {
      const expected = readExpected(saveFile);
      setCurrentSave(saveFile);

      const before = await getUiState(page);
      await page.click('#loadBtn');
      await waitForLoadApplied(page, expected.expectedStep);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const after = await getUiState(page);

      const screenshotPath = path.join(OUT_DIR, `${saveFile.replace('.json', '')}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      results.push({
        ...expected,
        before,
        after,
        screenshotPath
      });
    }

    const reportPath = path.join(OUT_DIR, 'report.json');
    fs.writeFileSync(reportPath, JSON.stringify({ dialogs, results }, null, 2));
    console.log(`Wrote report: ${reportPath}`);
    for (const r of results) {
      console.log(
        `${r.saveFile} -> step ${r.after.step} (expected ${r.expectedStep}), locations ${r.after.locations} (expected ${r.expectedLocations})`
      );
      console.log(`screenshot: ${r.screenshotPath}`);
    }
  } finally {
    await browser.close();
    fs.copyFileSync(BACKUP_SAVE, CURRENT_SAVE);
    fs.unlinkSync(BACKUP_SAVE);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

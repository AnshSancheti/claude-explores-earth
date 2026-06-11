import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  prunePersistentLogs,
  shouldRotatePersistentLog
} from '../server/utils/persistentLogRetention.js';

async function makeLogsDir() {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'persistent-log-retention-'));
  const logsDir = path.join(dataDir, 'persistent_logs');
  await fsp.mkdir(logsDir, { recursive: true });
  return logsDir;
}

async function writeLog(logsDir, name, bytes, mtimeMs) {
  const filePath = path.join(logsDir, name);
  await fsp.writeFile(filePath, Buffer.alloc(bytes, 'x'));
  const when = new Date(mtimeMs);
  await fsp.utimes(filePath, when, when);
  return filePath;
}

async function listNames(logsDir) {
  return (await fsp.readdir(logsDir)).sort();
}

test('prunePersistentLogs keeps current log and deletes old files by count', async () => {
  const logsDir = await makeLogsDir();
  await writeLog(logsDir, 'exploration-old.jsonl', 10, 1000);
  await writeLog(logsDir, 'exploration-mid.jsonl', 10, 2000);
  const current = await writeLog(logsDir, 'exploration-current.jsonl', 10, 3000);

  const result = await prunePersistentLogs(logsDir, {
    currentLogPath: current,
    maxFiles: 2,
    maxBytes: 1024
  });

  assert.equal(result.deleted, 1);
  assert.deepEqual(await listNames(logsDir), [
    'exploration-current.jsonl',
    'exploration-mid.jsonl'
  ]);
});

test('prunePersistentLogs deletes oldest files until under byte budget', async () => {
  const logsDir = await makeLogsDir();
  await writeLog(logsDir, 'exploration-a.jsonl', 20, 1000);
  await writeLog(logsDir, 'exploration-b.jsonl', 20, 2000);
  const current = await writeLog(logsDir, 'exploration-current.jsonl', 20, 3000);

  await prunePersistentLogs(logsDir, {
    currentLogPath: current,
    maxFiles: 5,
    maxBytes: 45
  });

  assert.deepEqual(await listNames(logsDir), [
    'exploration-b.jsonl',
    'exploration-current.jsonl'
  ]);
});

test('shouldRotatePersistentLog detects oversized current log', async () => {
  const logsDir = await makeLogsDir();
  const current = await writeLog(logsDir, 'exploration-current.jsonl', 11, 1000);

  assert.equal(await shouldRotatePersistentLog(current, { maxFileBytes: 10 }), true);
  assert.equal(await shouldRotatePersistentLog(current, { maxFileBytes: 12 }), false);
});

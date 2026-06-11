import * as fsp from 'fs/promises';
import path from 'path';

export const DEFAULT_PERSISTENT_LOG_MAX_FILES = 5;
export const DEFAULT_PERSISTENT_LOG_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_PERSISTENT_LOG_MAX_FILE_BYTES = 10 * 1024 * 1024;

function normalizeLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function listPersistentLogs(logsDir) {
  let entries = [];
  try {
    entries = await fsp.readdir(logsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const logs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^exploration-.*\.jsonl$/.test(entry.name)) continue;
    const filePath = path.join(logsDir, entry.name);
    const stat = await fsp.stat(filePath).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) continue;
    logs.push({
      filePath,
      name: entry.name,
      size: stat.size,
      mtimeMs: stat.mtimeMs
    });
  }

  return logs.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
}

export async function prunePersistentLogs(logsDir, {
  currentLogPath = null,
  maxFiles = DEFAULT_PERSISTENT_LOG_MAX_FILES,
  maxBytes = DEFAULT_PERSISTENT_LOG_MAX_BYTES,
  logger = console
} = {}) {
  const normalizedMaxFiles = normalizeLimit(maxFiles, DEFAULT_PERSISTENT_LOG_MAX_FILES);
  const normalizedMaxBytes = normalizeLimit(maxBytes, DEFAULT_PERSISTENT_LOG_MAX_BYTES);
  const currentResolved = currentLogPath ? path.resolve(currentLogPath) : null;
  const logs = await listPersistentLogs(logsDir);
  const protectedLogs = new Set();
  if (currentResolved) protectedLogs.add(currentResolved);

  const removable = logs.filter(log => !protectedLogs.has(path.resolve(log.filePath)));
  const keepByCount = Math.max(0, normalizedMaxFiles - protectedLogs.size);
  const toDelete = new Set(removable.slice(keepByCount).map(log => log.filePath));

  let retainedBytes = logs
    .filter(log => !toDelete.has(log.filePath))
    .reduce((sum, log) => sum + log.size, 0);

  for (const log of removable.slice(0, keepByCount).reverse()) {
    if (retainedBytes <= normalizedMaxBytes) break;
    toDelete.add(log.filePath);
    retainedBytes -= log.size;
  }

  for (const filePath of toDelete) {
    await fsp.rm(filePath, { force: true }).catch(error => {
      logger.warn?.(`Failed to prune persistent log ${filePath}: ${error.message}`);
    });
  }

  return {
    deleted: toDelete.size,
    retainedBytes
  };
}

export async function shouldRotatePersistentLog(logPath, {
  maxFileBytes = DEFAULT_PERSISTENT_LOG_MAX_FILE_BYTES
} = {}) {
  const normalizedMaxFileBytes = normalizeLimit(maxFileBytes, DEFAULT_PERSISTENT_LOG_MAX_FILE_BYTES);
  if (normalizedMaxFileBytes <= 0) return false;
  const stat = await fsp.stat(logPath).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  return Boolean(stat && stat.size >= normalizedMaxFileBytes);
}

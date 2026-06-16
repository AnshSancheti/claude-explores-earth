import * as fsp from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

export const EVENT_LOG_VERSION = 1;
export const SNAPSHOT_SCHEMA_VERSION = 2;
const EVENT_LOG_TAIL_READ_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_EVENT_LOG_COMPACT_MAX_BYTES = 128 * 1024 * 1024;

function parseIntOr(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const EVENT_LOG_COMPACT_MAX_BYTES = parseIntOr(
  process.env.RUN_EVENT_LOG_COMPACT_MAX_BYTES,
  DEFAULT_EVENT_LOG_COMPACT_MAX_BYTES
);

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function appendUnique(list, value) {
  if (!value) return list;
  return list.includes(value) ? list : [...list, value];
}

function compactDecisionStep(stepData) {
  if (!stepData || typeof stepData !== 'object') return stepData;
  const { coverageDelta, ...compact } = stepData;
  return compact;
}

function applyCompletedStepDelta(snapshot, event) {
  const stepData = event.payload?.stepData;
  if (!stepData) return snapshot;

  const reduced = cloneJson(snapshot);
  const delta = stepData.coverageDelta || {};
  const panoId = stepData.panoId || delta.panoId;
  const position = stepData.newPosition || delta.position;
  const stepCount = Number(stepData.stepCount) || Number(event.stepCount) || Number(reduced.stepCount) || 0;

  reduced.schemaVersion = SNAPSHOT_SCHEMA_VERSION;
  reduced.stepCount = stepCount;
  reduced.currentState = {
    ...(reduced.currentState || {}),
    panoId: panoId || reduced.currentState?.panoId || null,
    position: position || reduced.currentState?.position || null,
    heading: Number.isFinite(stepData.direction) ? stepData.direction : reduced.currentState?.heading,
    mode: stepData.mode || reduced.currentState?.mode || 'exploration'
  };

  if (stepData.stats) {
    reduced.stats = cloneJson(stepData.stats);
  }

  if (panoId && position) {
    const graph = { ...(reduced.graph || {}) };
    const existing = graph[panoId] || {};
    const linkNeighbors = asArray(delta.links)
      .map(link => link?.pano)
      .filter(Boolean);
    const traversedFrom = delta.traversedFrom || stepData.previousPanoId || null;
    const neighbors = [
      ...asArray(existing.neighbors),
      ...linkNeighbors
    ];
    if (traversedFrom) neighbors.push(traversedFrom);

    graph[panoId] = {
      lat: typeof position.lat === 'number' ? position.lat : existing.lat,
      lng: typeof position.lng === 'number' ? position.lng : existing.lng,
      neighbors: Array.from(new Set(neighbors)),
      timestamp: Number(delta.timestamp) || existing.timestamp || Date.parse(event.timestamp) || Date.now()
    };

    if (traversedFrom && graph[traversedFrom]) {
      graph[traversedFrom] = {
        ...graph[traversedFrom],
        neighbors: appendUnique(asArray(graph[traversedFrom].neighbors), panoId)
      };
    }

    for (const neighborId of linkNeighbors) {
      if (!graph[neighborId]) continue;
      graph[neighborId] = {
        ...graph[neighborId],
        neighbors: appendUnique(asArray(graph[neighborId].neighbors), panoId)
      };
    }

    reduced.graph = graph;
  }

  if (Array.isArray(delta.recentHistory)) {
    reduced.recentHistory = delta.recentHistory.slice(-10);
  } else if (panoId) {
    reduced.recentHistory = [...asArray(reduced.recentHistory), panoId].slice(-10);
  }

  reduced.decisionHistory = [
    ...asArray(reduced.decisionHistory),
    compactDecisionStep(stepData)
  ].slice(-100);

  return reduced;
}

async function atomicWriteJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const contents = `${JSON.stringify(value, null, 2)}\n`;

  let handle = null;
  try {
    handle = await fsp.open(tempPath, 'w');
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function reduceSnapshotWithEvents(snapshot, events = []) {
  let reduced = cloneJson(snapshot);
  if (!reduced) return null;

  const sortedEvents = [...events].sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
  for (const event of sortedEvents) {
    const eventSnapshot = event.payload?.snapshot;
    if (eventSnapshot) {
      reduced = cloneJson(eventSnapshot);
    } else if (event.type === 'step_completed' && event.payload?.stepData) {
      reduced = applyCompletedStepDelta(reduced, event);
    }

    reduced.schemaVersion = SNAPSHOT_SCHEMA_VERSION;
    reduced.runId = reduced.runId || event.runId;
    reduced.activeEpoch = Number.isFinite(event.epoch)
      ? Math.max(Number(reduced.activeEpoch) || 0, event.epoch)
      : (Number(reduced.activeEpoch) || 0);
    reduced.eventLog = {
      ...(reduced.eventLog || {}),
      lastSequence: event.sequence,
      lastEventId: event.eventId
    };
    if (event.timestamp) {
      reduced.lastUpdated = event.timestamp;
    }
  }

  return reduced;
}

export class RunStore {
  constructor({ dataDir, logger = console, eventLogCompactMaxBytes = EVENT_LOG_COMPACT_MAX_BYTES } = {}) {
    if (!dataDir) {
      throw new Error('RunStore requires dataDir');
    }

    this.dataDir = dataDir;
    this.logger = logger;
    this.eventLogCompactMaxBytes = eventLogCompactMaxBytes;
    this.lastSequenceByRun = new Map();
    this.appendQueues = new Map();
  }

  getRunDir(runId) {
    return path.join(this.dataDir, 'runs', runId);
  }

  getEventLogPath(runId) {
    return path.join(this.getRunDir(runId), 'events.jsonl');
  }

  getSnapshotPath(runId) {
    return path.join(this.getRunDir(runId), 'snapshot.json');
  }

  getCurrentSavePath() {
    return path.join(this.dataDir, 'saves', 'current-run.json');
  }

  async findHighestStepSnapshot() {
    const runsDir = path.join(this.dataDir, 'runs');
    let entries = [];
    try {
      entries = await fsp.readdir(runsDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }

    let best = null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runId = entry.name;
      const snapshot = await this.readSnapshot(runId).catch(error => {
        this.logger.warn?.(`Failed to read snapshot for run ${runId}: ${error.message}`);
        return null;
      });
      if (!snapshot?.runId) continue;
      const stepCount = Number(snapshot.stepCount) || 0;
      const bestStepCount = Number(best?.stepCount) || 0;
      if (
        !best ||
        stepCount > bestStepCount ||
        (stepCount === bestStepCount && Date.parse(snapshot.lastUpdated || 0) > Date.parse(best.lastUpdated || 0))
      ) {
        best = snapshot;
      }
    }
    return best;
  }

  async chooseCurrentSnapshot(snapshot) {
    const highest = await this.findHighestStepSnapshot();
    if (!highest) return snapshot;
    if (!snapshot) return highest;

    const currentStepCount = Number(snapshot.stepCount) || 0;
    const highestStepCount = Number(highest.stepCount) || 0;
    const recoveryMinStepDelta = Number(process.env.RUNSTORE_RECOVERY_MIN_STEP_DELTA) || 100;
    if (highestStepCount - currentStepCount >= recoveryMinStepDelta) {
      this.logger.warn?.(
        `Current save points at ${snapshot.runId} step ${currentStepCount}, ` +
        `but run ${highest.runId} has step ${highestStepCount}; restoring highest-step snapshot.`
      );
      return highest;
    }

    return snapshot;
  }

  async appendEvent(runId, eventInput) {
    if (!runId) {
      throw new Error('Cannot append run event without runId');
    }
    if (!eventInput?.type) {
      throw new Error('Cannot append run event without type');
    }

    return this.#withEventLogLock(runId, () => this.#appendEventUnlocked(runId, eventInput));
  }

  async #withEventLogLock(runId, operation) {
    const previous = this.appendQueues.get(runId) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.appendQueues.set(runId, next.catch(() => {}));
    return next;
  }

  async #appendEventUnlocked(runId, eventInput) {
    let lastSequence = this.lastSequenceByRun.get(runId);
    if (!Number.isFinite(lastSequence)) {
      lastSequence = await this.getLastSequence(runId);
    }

    await this.prepareEventLogForAppend(runId);

    const sequence = lastSequence + 1;
    const event = {
      version: EVENT_LOG_VERSION,
      eventId: eventInput.eventId || randomUUID(),
      runId,
      epoch: Number.isFinite(eventInput.epoch) ? eventInput.epoch : 0,
      sequence,
      type: eventInput.type,
      timestamp: eventInput.timestamp || new Date().toISOString(),
      stepId: eventInput.stepId || null,
      stepCount: Number.isFinite(eventInput.stepCount) ? eventInput.stepCount : null,
      payload: eventInput.payload || {}
    };

    await fsp.mkdir(this.getRunDir(runId), { recursive: true });
    const handle = await fsp.open(this.getEventLogPath(runId), 'a');
    try {
      await handle.write(`${JSON.stringify(event)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }

    this.lastSequenceByRun.set(runId, sequence);
    return event;
  }

  async prepareEventLogForAppend(runId) {
    const logPath = this.getEventLogPath(runId);
    try {
      const stat = await fsp.stat(logPath);
      if (stat.size === 0) return;

      const handle = await fsp.open(logPath, 'r');
      try {
        const lastByte = Buffer.alloc(1);
        await handle.read(lastByte, 0, 1, stat.size - 1);
        if (lastByte[0] === 0x0a) return;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }

    let contents = '';
    try {
      contents = await fsp.readFile(logPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }

    if (!contents || contents.endsWith('\n')) return;

    const trailingStart = contents.lastIndexOf('\n') + 1;
    const trailingLine = contents.slice(trailingStart).trim();
    if (!trailingLine) {
      await fsp.appendFile(logPath, '\n');
      return;
    }

    try {
      JSON.parse(trailingLine);
      await fsp.appendFile(logPath, '\n');
    } catch {
      await fsp.truncate(logPath, trailingStart);
      this.logger.warn?.(`Truncated corrupt trailing event log line for run ${runId}`);
    }
  }

  async getLastSequence(runId) {
    const { events } = await this.readEvents(runId);
    return events.reduce((max, event) => Math.max(max, Number(event.sequence) || 0), 0);
  }

  async readEvents(runId, { afterSequence = 0 } = {}) {
    const normalizedAfterSequence = Number(afterSequence) || 0;
    if (normalizedAfterSequence > 0) {
      return this.#readEventsAfterSequence(runId, normalizedAfterSequence);
    }

    return this.#readEventsFull(runId, normalizedAfterSequence);
  }

  async #readEventsFull(runId, afterSequence = 0) {
    let contents = '';
    try {
      contents = await fsp.readFile(this.getEventLogPath(runId), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { events: [], warnings: [] };
      }
      throw error;
    }

    const lines = contents.split(/\r?\n/);
    let lastContentLineIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim()) {
        lastContentLineIndex = i;
        break;
      }
    }

    const events = [];
    const warnings = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      let event = null;
      try {
        event = JSON.parse(line);
      } catch (error) {
        if (i === lastContentLineIndex) {
          warnings.push(`Ignored corrupt trailing event log line ${i + 1} for run ${runId}`);
          break;
        }
        throw new Error(`Corrupt event log line ${i + 1} for run ${runId}: ${error.message}`);
      }

      if ((Number(event.sequence) || 0) > afterSequence) {
        events.push(event);
      }
    }

    return { events, warnings };
  }

  async #readEventsAfterSequence(runId, afterSequence) {
    let stat = null;
    try {
      stat = await fsp.stat(this.getEventLogPath(runId));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { events: [], warnings: [] };
      }
      throw error;
    }

    if (stat.size === 0) return { events: [], warnings: [] };

    const events = [];
    const warnings = [];
    const handle = await fsp.open(this.getEventLogPath(runId), 'r');
    let position = stat.size;
    let carry = '';
    let sawValidLine = false;
    let ignoredTrailingCorruption = false;

    try {
      while (position > 0) {
        const readSize = Math.min(EVENT_LOG_TAIL_READ_CHUNK_BYTES, position);
        position -= readSize;
        const buffer = Buffer.allocUnsafe(readSize);
        const { bytesRead } = await handle.read(buffer, 0, readSize, position);
        const chunk = buffer.toString('utf8', 0, bytesRead);
        const lines = `${chunk}${carry}`.split(/\r?\n/);
        carry = position > 0 ? lines.shift() : '';

        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const line = lines[i].trim();
          if (!line) continue;

          let event = null;
          try {
            event = JSON.parse(line);
          } catch {
            if (!sawValidLine && !ignoredTrailingCorruption) {
              warnings.push(`Ignored corrupt trailing event log line for run ${runId}`);
              ignoredTrailingCorruption = true;
              continue;
            }
            return this.#readEventsFull(runId, afterSequence);
          }

          sawValidLine = true;
          const sequence = Number(event.sequence) || 0;
          if (sequence <= afterSequence) {
            events.reverse();
            return { events, warnings };
          }
          events.push(event);
        }
      }
    } finally {
      await handle.close();
    }

    events.reverse();
    return { events, warnings };
  }

  async writeSnapshot(runId, snapshot) {
    if (!runId) {
      throw new Error('Cannot write run snapshot without runId');
    }

    const normalized = {
      ...cloneJson(snapshot),
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      runId,
      lastUpdated: snapshot?.lastUpdated || new Date().toISOString(),
      eventLog: {
        lastSequence: Number(snapshot?.eventLog?.lastSequence) || 0,
        lastEventId: snapshot?.eventLog?.lastEventId || null
      }
    };

    await atomicWriteJson(this.getSnapshotPath(runId), normalized);
    await atomicWriteJson(this.getCurrentSavePath(), normalized);
    await this.compactEventLogIfNeeded(runId, normalized);
    return normalized;
  }

  async compactEventLogIfNeeded(runId, snapshot = null) {
    if (!runId || this.eventLogCompactMaxBytes <= 0) return false;

    const logPath = this.getEventLogPath(runId);
    let stat = null;
    try {
      stat = await fsp.stat(logPath);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }

    if (stat.size <= this.eventLogCompactMaxBytes) return false;

    return this.#withEventLogLock(runId, async () => {
      const freshStat = await fsp.stat(logPath).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!freshStat || freshStat.size <= this.eventLogCompactMaxBytes) return false;

      const compactSnapshot = snapshot || await this.readSnapshot(runId);
      const checkpointSequence = Number(compactSnapshot?.eventLog?.lastSequence) || 0;
      if (checkpointSequence <= 0) return false;

      const { events: trailingEvents, warnings } = await this.readEvents(runId, {
        afterSequence: checkpointSequence
      });
      for (const warning of warnings) {
        this.logger.warn?.(warning);
      }

      const checkpointEvent = {
        version: EVENT_LOG_VERSION,
        eventId: `checkpoint-${checkpointSequence}`,
        runId,
        epoch: Number(compactSnapshot.activeEpoch) || 0,
        sequence: checkpointSequence,
        type: 'snapshot_checkpoint',
        timestamp: compactSnapshot.lastUpdated || new Date().toISOString(),
        stepId: null,
        stepCount: Number(compactSnapshot.stepCount) || null,
        payload: {
          snapshotStepCount: Number(compactSnapshot.stepCount) || 0,
          compactedAt: new Date().toISOString()
        }
      };
      const compactEvents = [checkpointEvent, ...trailingEvents];
      const tempPath = `${logPath}.${process.pid}.${Date.now()}.${randomUUID()}.compact`;
      const contents = compactEvents.map(event => JSON.stringify(event)).join('\n') + '\n';

      await fsp.writeFile(tempPath, contents);
      await fsp.rename(tempPath, logPath);
      const lastSequence = compactEvents.reduce(
        (max, event) => Math.max(max, Number(event.sequence) || 0),
        checkpointSequence
      );
      this.lastSequenceByRun.set(runId, lastSequence);
      this.logger.log?.(
        `Compacted event log for run ${runId}: ${freshStat.size} bytes -> ${Buffer.byteLength(contents)} bytes`
      );
      return true;
    });
  }

  async readSnapshot(runId) {
    try {
      return JSON.parse(await fsp.readFile(this.getSnapshotPath(runId), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async readCurrentSnapshot() {
    try {
      return JSON.parse(await fsp.readFile(this.getCurrentSavePath(), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async restoreCurrent() {
    const snapshot = await this.chooseCurrentSnapshot(await this.readCurrentSnapshot());
    if (!snapshot) {
      return {
        snapshot: null,
        events: [],
        warnings: [],
        restoreSource: 'none'
      };
    }

    if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || !snapshot.eventLog || !snapshot.runId) {
      return {
        snapshot,
        events: [],
        warnings: [],
        restoreSource: 'legacy-snapshot'
      };
    }

    const afterSequence = Number(snapshot.eventLog.lastSequence) || 0;
    const { events, warnings } = await this.readEvents(snapshot.runId, { afterSequence });
    const restoredSnapshot = reduceSnapshotWithEvents(snapshot, events);
    this.lastSequenceByRun.set(
      snapshot.runId,
      Number(restoredSnapshot?.eventLog?.lastSequence) || afterSequence
    );
    return {
      snapshot: restoredSnapshot,
      events,
      warnings,
      restoreSource: events.length > 0 ? 'v2-snapshot+events' : 'v2-snapshot'
    };
  }
}

import { simplifyPath } from '../utils/pathSimplification.js';
import * as fsp from 'fs/promises';
import path from 'path';

export const TILE_RENDERER_REVISION = 2;
const TILE_PATH_CACHE_LIMIT = 256;
const DEFAULT_TILE_VERSION_DIR_LIMIT = 20;

let createCanvasFn = null;

async function getCreateCanvas() {
  if (!createCanvasFn) {
    ({ createCanvas: createCanvasFn } = await import('canvas'));
  }
  return createCanvasFn;
}

export function archivedPointCount(totalPoints, tailPoints) {
  return Math.max(0, totalPoints - Math.max(0, tailPoints));
}

export function archiveVersionForPoints(archivedPoints) {
  return Math.max(0, Number.isFinite(Number(archivedPoints)) ? Math.floor(Number(archivedPoints)) : 0);
}

function lonLatToWorldPixels(lng, lat, z) {
  const tile = 256;
  const scale = tile * Math.pow(2, z);
  const x = (lng + 180) / 360 * scale;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return [x, y];
}

function tileYToLat(tileY, z) {
  const n = Math.PI - 2 * Math.PI * tileY / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

function tileGeoBounds(z, x, y, marginPixels = 0) {
  const marginTiles = marginPixels / 256;
  return {
    west: ((x - marginTiles) / Math.pow(2, z)) * 360 - 180,
    east: ((x + 1 + marginTiles) / Math.pow(2, z)) * 360 - 180,
    north: tileYToLat(y - marginTiles, z),
    south: tileYToLat(y + 1 + marginTiles, z)
  };
}

function segmentIntersectsBounds(a, b, bounds) {
  if (!a || !b) return false;
  const minLat = Math.min(a.lat, b.lat);
  const maxLat = Math.max(a.lat, b.lat);
  const minLng = Math.min(a.lng, b.lng);
  const maxLng = Math.max(a.lng, b.lng);
  return (
    maxLat >= bounds.south &&
    minLat <= bounds.north &&
    maxLng >= bounds.west &&
    minLng <= bounds.east
  );
}

function archiveTileEpsilonForZoom(z) {
  if (z <= 8) return 0.001;
  if (z === 9) return 0.0005;
  if (z === 10) return 0.00025;
  if (z === 11) return 0.00012;
  if (z === 12) return 0.00006;
  if (z === 13) return 0.00003;
  if (z === 14) return 0.000015;
  return 0;
}

function cacheSet(map, key, value) {
  if (!map) return;
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size > TILE_PATH_CACHE_LIMIT) {
    const firstKey = map.keys().next().value;
    map.delete(firstKey);
  }
}

export function getArchiveTilePath(sourcePath, z, archivedCount, pathCache = null) {
  const boundedArchivedCount = Math.max(0, Math.min(archiveVersionForPoints(archivedCount), sourcePath.length));
  const epsilon = archiveTileEpsilonForZoom(z);
  if (epsilon <= 0) {
    return sourcePath.slice(0, boundedArchivedCount);
  }

  const cacheKey = `${TILE_RENDERER_REVISION}:${z}:${boundedArchivedCount}`;
  const cached = pathCache?.get(cacheKey);
  if (cached) return cached;

  const simplified = simplifyPath(sourcePath.slice(0, boundedArchivedCount), epsilon);
  if (pathCache) {
    cacheSet(pathCache, cacheKey, simplified);
  }
  return simplified;
}

export async function drawArchiveTileFromPath(sourcePath, z, x, y, {
  archivedCount,
  pathCache = null
} = {}) {
  const createCanvas = await getCreateCanvas();
  const boundedArchivedCount = Math.max(
    0,
    Math.min(archiveVersionForPoints(archivedCount ?? sourcePath.length), sourcePath.length)
  );
  const canvas = createCanvas(256, 256);
  if (boundedArchivedCount < 2) {
    return canvas.toBuffer('image/png');
  }

  const pathArr = getArchiveTilePath(sourcePath, z, boundedArchivedCount, pathCache);
  const ctx = canvas.getContext('2d');

  function strokeWidthForZoom(zoom) {
    if (zoom >= 20) return 12;
    if (zoom >= 19) return 10;
    if (zoom >= 18) return 8;
    if (zoom >= 17) return 6;
    if (zoom >= 16) return 4;
    if (zoom >= 15) return 3;
    return 2;
  }

  const strokeWidth = strokeWidthForZoom(z);
  ctx.lineWidth = strokeWidth;
  ctx.strokeStyle = '#f44336';
  ctx.globalAlpha = 0.8;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const tileOriginX = x * 256;
  const tileOriginY = y * 256;
  const bounds = tileGeoBounds(z, x, y, strokeWidth);
  const minPixelStep = z <= 9 ? 0.75 : z <= 12 ? 0.5 : 0.25;
  const minPixelStepSq = minPixelStep * minPixelStep;

  let started = false;
  let lastDrawn = null;
  let segmentsDrawn = 0;
  ctx.beginPath();

  for (let i = 0; i < pathArr.length - 1; i += 1) {
    const a = pathArr[i];
    const b = pathArr[i + 1];
    if (!segmentIntersectsBounds(a, b, bounds)) {
      started = false;
      continue;
    }

    const [awx, awy] = lonLatToWorldPixels(a.lng, a.lat, z);
    const [bwx, bwy] = lonLatToWorldPixels(b.lng, b.lat, z);
    const ax = awx - tileOriginX;
    const ay = awy - tileOriginY;
    const bx = bwx - tileOriginX;
    const by = bwy - tileOriginY;

    if (!started) {
      ctx.moveTo(ax, ay);
      started = true;
      lastDrawn = [ax, ay];
    }

    const dx = bx - lastDrawn[0];
    const dy = by - lastDrawn[1];
    const movedEnough = dx * dx + dy * dy >= minPixelStepSq;
    if (movedEnough || i === pathArr.length - 2) {
      ctx.lineTo(bx, by);
      lastDrawn = [bx, by];
      segmentsDrawn += 1;
    }
  }

  if (segmentsDrawn > 0) {
    ctx.stroke();
  }

  return canvas.toBuffer('image/png');
}

export async function pruneArchiveTileVersions(dataDir, runId, {
  rendererRevision = TILE_RENDERER_REVISION,
  keepVersions = DEFAULT_TILE_VERSION_DIR_LIMIT
} = {}) {
  if (!dataDir || !runId || keepVersions <= 0) return;

  const rendererDir = path.join(dataDir, 'tiles', runId, `renderer-${rendererRevision}`);
  let entries = [];
  try {
    entries = await fsp.readdir(rendererDir, { withFileTypes: true });
  } catch {
    return;
  }

  const versionDirs = entries
    .filter(entry => entry.isDirectory() && Number.isFinite(Number(entry.name)))
    .map(entry => ({ name: entry.name, version: Number(entry.name) }))
    .sort((a, b) => b.version - a.version);

  await Promise.all(
    versionDirs
      .slice(Math.max(0, keepVersions))
      .map(entry => fsp.rm(path.join(rendererDir, entry.name), { recursive: true, force: true }).catch(() => {}))
  );
}

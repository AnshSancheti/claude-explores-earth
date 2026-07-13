import { randomUUID } from 'crypto';
import sharp from 'sharp';

export const SCRATCHPAD_WIDTH = 768;
export const SCRATCHPAD_HEIGHT = 512;
export const SCRATCHPAD_MAX_OPERATIONS = 240;
export const SCRATCHPAD_MAX_OPS_PER_TURN = 12;

const AGENT_INK = Object.freeze({
  ada: '#24211d',
  theo: '#185e78'
});

function clamp(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function point(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    x: clamp(value.x, 0, 1, 0.5),
    y: clamp(value.y, 0, 1, 0.5)
  };
}

function textValue(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
}

export function sanitizeScratchpadOperation(raw, agentId) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '').toLowerCase();
  const base = {
    type,
    author: agentId,
    color: AGENT_INK[agentId] || AGENT_INK.ada,
    width: clamp(raw.width, 1, 12, 4)
  };

  if (type === 'text') {
    const text = textValue(raw.text);
    const at = point(raw.at || raw);
    if (!text || !at) return null;
    return {
      ...base,
      text,
      at,
      size: clamp(raw.size, 14, 54, 28),
      rotation: clamp(raw.rotation, -18, 18, 0)
    };
  }

  if (type === 'circle') {
    const center = point(raw.center || raw);
    if (!center) return null;
    return {
      ...base,
      center,
      radiusX: clamp(raw.radiusX ?? raw.radius, 0.015, 0.35, 0.1),
      radiusY: clamp(raw.radiusY ?? raw.radius, 0.015, 0.35, 0.1)
    };
  }

  if (type === 'line' || type === 'arrow' || type === 'erase') {
    const from = point(raw.from);
    const to = point(raw.to);
    if (!from || !to) return null;
    return {
      ...base,
      from,
      to,
      width: type === 'erase' ? clamp(raw.width, 12, 80, 28) : base.width
    };
  }

  if (type === 'stroke') {
    const points = Array.isArray(raw.points)
      ? raw.points.slice(0, 48).map(point).filter(Boolean)
      : [];
    if (points.length < 2) return null;
    return { ...base, points };
  }

  return null;
}

export function createScratchpad({ owner = 'ada', turn = 0 } = {}) {
  return {
    version: 2,
    width: SCRATCHPAD_WIDTH,
    height: SCRATCHPAD_HEIGHT,
    owner,
    inTransit: null,
    sequence: 0,
    heldSinceTurn: turn,
    operations: [],
    updatedAt: new Date().toISOString()
  };
}

export function normalizeScratchpad(raw, { turn = 0 } = {}) {
  const base = createScratchpad({ turn });
  if (!raw || typeof raw !== 'object' || Number(raw.version) < 2) return base;

  const operations = Array.isArray(raw.operations)
    ? raw.operations
        .map((operation) => {
          const sanitized = sanitizeScratchpadOperation(operation, operation?.author);
          if (!sanitized) return null;
          return {
            ...sanitized,
            id: String(operation.id || randomUUID()),
            sequence: Math.max(1, Math.floor(Number(operation.sequence) || 1)),
            turn: Math.max(0, Math.floor(Number(operation.turn) || 0)),
            createdAt: operation.createdAt || null
          };
        })
        .filter(Boolean)
        .slice(-SCRATCHPAD_MAX_OPERATIONS)
    : [];

  const owner = raw.owner === 'ada' || raw.owner === 'theo' ? raw.owner : null;
  const inTransit = raw.inTransit && typeof raw.inTransit === 'object'
    ? {
        from: raw.inTransit.from === 'theo' ? 'theo' : 'ada',
        to: raw.inTransit.to === 'ada' ? 'ada' : 'theo',
        sentTurn: Math.max(0, Math.floor(Number(raw.inTransit.sentTurn) || 0)),
        deliverTurn: Math.max(0, Math.floor(Number(raw.inTransit.deliverTurn) || 0))
      }
    : null;

  return {
    ...base,
    owner: inTransit ? null : owner || 'ada',
    inTransit,
    sequence: Math.max(
      Math.floor(Number(raw.sequence) || 0),
      operations.at(-1)?.sequence || 0
    ),
    heldSinceTurn: Math.max(0, Math.floor(Number(raw.heldSinceTurn) || turn)),
    operations,
    updatedAt: raw.updatedAt || base.updatedAt
  };
}

export function appendScratchpadOperations(scratchpad, rawOperations, { agentId, turn }) {
  const normalized = normalizeScratchpad(scratchpad, { turn });
  const incoming = Array.isArray(rawOperations) ? rawOperations : [];
  const accepted = incoming
    .slice(0, SCRATCHPAD_MAX_OPS_PER_TURN)
    .map(operation => sanitizeScratchpadOperation(operation, agentId))
    .filter(Boolean)
    .map(operation => ({
      ...operation,
      id: randomUUID(),
      sequence: ++normalized.sequence,
      turn,
      createdAt: new Date().toISOString()
    }));

  normalized.operations = [...normalized.operations, ...accepted].slice(-SCRATCHPAD_MAX_OPERATIONS);
  normalized.updatedAt = new Date().toISOString();
  return { scratchpad: normalized, accepted };
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function svgPoint(value) {
  return {
    x: Number(value.x) * SCRATCHPAD_WIDTH,
    y: Number(value.y) * SCRATCHPAD_HEIGHT
  };
}

function operationSvg(operation) {
  const color = escapeXml(operation.color || AGENT_INK[operation.author] || AGENT_INK.ada);
  const width = Number(operation.width) || 4;
  if (operation.type === 'text') {
    const at = svgPoint(operation.at);
    return `<text x="${at.x}" y="${at.y}" fill="${color}" font-family="sans-serif" font-size="${operation.size}" transform="rotate(${operation.rotation} ${at.x} ${at.y})">${escapeXml(operation.text)}</text>`;
  }
  if (operation.type === 'circle') {
    const center = svgPoint(operation.center);
    return `<ellipse cx="${center.x}" cy="${center.y}" rx="${operation.radiusX * SCRATCHPAD_WIDTH}" ry="${operation.radiusY * SCRATCHPAD_HEIGHT}" fill="none" stroke="${color}" stroke-width="${width}" />`;
  }
  if (operation.type === 'stroke') {
    const points = operation.points.map(svgPoint);
    const d = points.map((entry, index) => `${index === 0 ? 'M' : 'L'} ${entry.x} ${entry.y}`).join(' ');
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" />`;
  }
  if (operation.type === 'line' || operation.type === 'arrow' || operation.type === 'erase') {
    const from = svgPoint(operation.from);
    const to = svgPoint(operation.to);
    const stroke = operation.type === 'erase' ? '#f2ecdd' : color;
    let result = `<path d="M ${from.x} ${from.y} L ${to.x} ${to.y}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" />`;
    if (operation.type === 'arrow') {
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const length = Math.max(12, width * 4);
      const left = { x: to.x - Math.cos(angle - Math.PI / 6) * length, y: to.y - Math.sin(angle - Math.PI / 6) * length };
      const right = { x: to.x - Math.cos(angle + Math.PI / 6) * length, y: to.y - Math.sin(angle + Math.PI / 6) * length };
      result += `<path d="M ${left.x} ${left.y} L ${to.x} ${to.y} L ${right.x} ${right.y}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" />`;
    }
    return result;
  }
  return '';
}

export async function renderScratchpad(scratchpad, { throughSequence = Infinity } = {}) {
  const normalized = normalizeScratchpad(scratchpad);
  const rules = Array.from({ length: 12 }, (_, index) => {
    const y = 52 + index * 38;
    return `<line x1="22" y1="${y}" x2="746" y2="${y}" stroke="#48676f" stroke-opacity="0.10" stroke-width="1" />`;
  }).join('');
  const operations = normalized.operations
    .filter(operation => operation.sequence <= throughSequence)
    .map(operationSvg)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SCRATCHPAD_WIDTH}" height="${SCRATCHPAD_HEIGHT}" viewBox="0 0 ${SCRATCHPAD_WIDTH} ${SCRATCHPAD_HEIGHT}">
    <rect width="100%" height="100%" fill="#f2ecdd" />
    ${rules}
    <line x1="58" y1="18" x2="58" y2="494" stroke="#b44d43" stroke-opacity="0.16" stroke-width="1" />
    ${operations}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

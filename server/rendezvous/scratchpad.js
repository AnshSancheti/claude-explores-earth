import { randomUUID } from 'crypto';
import sharp from 'sharp';

export const SCRATCHPAD_WIDTH = 768;
export const SCRATCHPAD_HEIGHT = 512;
export const SCRATCHPAD_MAX_OPERATIONS = 720;
export const SCRATCHPAD_MAX_OPS_PER_TURN = 12;
export const SCRATCHPAD_MAX_CURRENT_OPS_PER_AUTHOR = 9;
export const SCRATCHPAD_MAX_CURRENT_TEXT_OPS_PER_AUTHOR = 3;
export const SCRATCHPAD_LABEL_MAX_CHARS = 28;

const AGENT_INK = Object.freeze({
  ada: '#24211d',
  theo: '#087fa8'
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
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SCRATCHPAD_LABEL_MAX_CHARS);
  if (/-?\d{1,3}\.\d{3,}/.test(text)) return '';
  if (/\b(?:ada|theo|friend|partner)\b.{0,14}\b\d+(?:\.\d+)?\s?(?:m|km|meters?|kilometers?)\b/i.test(text)) {
    return '';
  }
  if (/\b(?:go|head|follow|pursue|meet|intercept|target|rendezvous|to)\b/i.test(text)) return '';
  if (/\btoward(?:s)?\b|->/i.test(text)) return '';
  return text;
}

export function sanitizeScratchpadOperation(raw, agentId) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '').toLowerCase();
  const author = agentId === 'theo' ? 'theo' : 'ada';
  const base = {
    type,
    author,
    color: AGENT_INK[author] || AGENT_INK.ada,
    width: clamp(raw.width, 1, 12, 4)
  };

  if (type === 'replacemine') {
    return {
      type: 'replaceMine',
      author,
      color: base.color,
      scope: 'mine'
    };
  }

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

  if (type === 'landmark') {
    const center = point(raw.center || raw);
    if (!center) return null;
    const symbol = ['dot', 'star', 'park', 'station', 'square'].includes(raw.symbol)
      ? raw.symbol
      : 'dot';
    const label = textValue(raw.label || raw.text || '');
    return {
      ...base,
      center,
      symbol,
      label,
      radius: clamp(raw.radius, 0.025, 0.14, 0.055)
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
    version: 3,
    width: SCRATCHPAD_WIDTH,
    height: SCRATCHPAD_HEIGHT,
    owner,
    inTransit: null,
    sequence: 0,
    heldSinceTurn: turn,
    operations: [],
    currentOperations: [],
    updatedAt: new Date().toISOString()
  };
}

function renderableOperation(operation) {
  return operation && !['replaceMine'].includes(operation.type);
}

function distance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y));
}

function normalizedText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function endpoints(operation) {
  if (operation.type === 'stroke') {
    const points = Array.isArray(operation.points) ? operation.points : [];
    return { from: points[0], to: points.at(-1) };
  }
  return { from: operation.from, to: operation.to };
}

function similarGeometry(a, b) {
  const aEnds = endpoints(a);
  const bEnds = endpoints(b);
  const direct = distance(aEnds.from, bEnds.from) + distance(aEnds.to, bEnds.to);
  const reverse = distance(aEnds.from, bEnds.to) + distance(aEnds.to, bEnds.from);
  return Math.min(direct, reverse) < 0.075;
}

function similarOperation(a, b) {
  if (!a || !b || a.author !== b.author) return false;
  if (a.type === 'text' && b.type === 'text') {
    return normalizedText(a.text) === normalizedText(b.text) && distance(a.at, b.at) < 0.12;
  }
  if (['line', 'arrow', 'erase', 'stroke'].includes(a.type) && ['line', 'arrow', 'erase', 'stroke'].includes(b.type)) {
    return similarGeometry(a, b);
  }
  if (a.type === b.type && a.type === 'circle') {
    return distance(a.center, b.center) < 0.08 &&
      Math.abs(Number(a.radiusX) - Number(b.radiusX)) < 0.04 &&
      Math.abs(Number(a.radiusY) - Number(b.radiusY)) < 0.04;
  }
  if (a.type === b.type && a.type === 'landmark') {
    return distance(a.center, b.center) < 0.08 &&
      normalizedText(a.label) === normalizedText(b.label);
  }
  return false;
}

function supersede(operation, byOperation, reason) {
  if (!operation || operation.supersededAtSequence) return;
  operation.supersededBy = byOperation.id;
  operation.supersededAtSequence = byOperation.sequence;
  operation.supersededReason = reason;
}

function isTextLike(operation) {
  return operation.type === 'text' || (operation.type === 'landmark' && operation.label);
}

function applyCurrentViewRules(operations) {
  const result = operations
    .map(operation => ({ ...operation }))
    .sort((a, b) => (a.sequence - b.sequence) || String(a.id).localeCompare(String(b.id)));

  for (const operation of result) {
    delete operation.supersededBy;
    delete operation.supersededAtSequence;
    delete operation.supersededReason;
  }

  const visibleNow = (author, predicate = () => true, throughSequence = Infinity) => result.filter(operation =>
    renderableOperation(operation) &&
    operation.author === author &&
    !operation.supersededAtSequence &&
    operation.sequence <= throughSequence &&
    predicate(operation)
  );

  for (const operation of result) {
    if (operation.type === 'replaceMine') {
      for (const previous of visibleNow(operation.author, () => true, operation.sequence)) {
        if (previous.sequence < operation.sequence) supersede(previous, operation, 'replaced_by_author');
      }
      continue;
    }

    if (!renderableOperation(operation)) continue;

    for (const previous of visibleNow(operation.author, () => true, operation.sequence)) {
      if (previous.id !== operation.id && previous.sequence < operation.sequence && similarOperation(previous, operation)) {
        supersede(previous, operation, 'deduplicated');
      }
    }

    let authorVisible = visibleNow(operation.author, () => true, operation.sequence);
    while (authorVisible.length > SCRATCHPAD_MAX_CURRENT_OPS_PER_AUTHOR) {
      const oldest = authorVisible[0];
      supersede(oldest, operation, 'compacted');
      authorVisible = visibleNow(operation.author, () => true, operation.sequence);
    }

    let textVisible = visibleNow(operation.author, isTextLike, operation.sequence);
    while (textVisible.length > SCRATCHPAD_MAX_CURRENT_TEXT_OPS_PER_AUTHOR) {
      const oldest = textVisible[0];
      supersede(oldest, operation, 'compacted_text');
      textVisible = visibleNow(operation.author, isTextLike, operation.sequence);
    }
  }

  return result;
}

export function currentScratchpadOperations(scratchpad, { throughSequence = Infinity } = {}) {
  const sequenceLimit = Number.isFinite(Number(throughSequence)) ? Number(throughSequence) : Infinity;
  const operations = Array.isArray(scratchpad?.operations) ? scratchpad.operations : [];
  return operations.filter(operation =>
    renderableOperation(operation) &&
    Number(operation.sequence) <= sequenceLimit &&
    (!Number.isFinite(Number(operation.supersededAtSequence)) ||
      Number(operation.supersededAtSequence) > sequenceLimit)
  );
}

export function normalizeScratchpad(raw, { turn = 0 } = {}) {
  const base = createScratchpad({ turn });
  if (!raw || typeof raw !== 'object' || Number(raw.version) < 2) return base;

  const rawOperations = Array.isArray(raw.operations)
    ? raw.operations
        .map((operation, index) => {
          const sanitized = sanitizeScratchpadOperation(operation, operation?.author);
          if (!sanitized) return null;
          return {
            ...sanitized,
            id: String(operation.id || `legacy-${Math.max(1, Math.floor(Number(operation.sequence) || index + 1))}-${index}`),
            sequence: Math.max(1, Math.floor(Number(operation.sequence) || 1)),
            turn: Math.max(0, Math.floor(Number(operation.turn) || 0)),
            createdAt: operation.createdAt || null
          };
        })
        .filter(Boolean)
    : [];
  const operations = applyCurrentViewRules(rawOperations);

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
      operations.reduce((max, operation) => Math.max(max, operation.sequence), 0)
    ),
    heldSinceTurn: Math.max(0, Math.floor(Number(raw.heldSinceTurn) || turn)),
    operations,
    currentOperations: currentScratchpadOperations({ operations }),
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

  normalized.operations = applyCurrentViewRules([...normalized.operations, ...accepted]);
  normalized.currentOperations = currentScratchpadOperations(normalized);
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
  if (operation.type === 'landmark') {
    const center = svgPoint(operation.center);
    const radius = (Number(operation.radius) || 0.055) * SCRATCHPAD_WIDTH;
    const label = operation.label
      ? `<text x="${center.x + radius + 8}" y="${center.y + 5}" fill="${color}" font-family="sans-serif" font-size="22">${escapeXml(operation.label)}</text>`
      : '';
    const diamond = [
      `${center.x} ${center.y - radius}`,
      `${center.x + radius} ${center.y}`,
      `${center.x} ${center.y + radius}`,
      `${center.x - radius} ${center.y}`
    ].join(' L ');
    return `<path d="M ${diamond} Z" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" />${label}`;
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
  const operations = currentScratchpadOperations(normalized, { throughSequence })
    .map(operationSvg)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SCRATCHPAD_WIDTH}" height="${SCRATCHPAD_HEIGHT}" viewBox="0 0 ${SCRATCHPAD_WIDTH} ${SCRATCHPAD_HEIGHT}">
    <rect width="100%" height="100%" fill="#f2ecdd" />
    ${rules}
    <line x1="58" y1="18" x2="58" y2="494" stroke="#b44d43" stroke-opacity="0.16" stroke-width="1" />
    <text x="638" y="28" fill="#24211d" fill-opacity="0.62" font-family="sans-serif" font-size="13">Ada</text>
    <text x="686" y="28" fill="#087fa8" fill-opacity="0.78" font-family="sans-serif" font-size="13">Theo</text>
    ${operations}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

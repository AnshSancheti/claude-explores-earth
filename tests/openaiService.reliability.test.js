import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIService } from '../server/services/openai.js';

function makeInput(overrides = {}) {
  return {
    currentPosition: { lat: 40.748817, lng: -73.985428 },
    screenshots: [{ base64: 'dGVzdA==' }, { base64: 'dGVzdA==' }, { base64: 'dGVzdA==' }],
    links: [
      { pano: 'A', heading: 0, description: '' },
      { pano: 'B', heading: 120, description: '' },
      { pano: 'C', heading: 240, description: '' }
    ],
    visitedPanos: [],
    stats: { locationsVisited: 10 },
    stepNumber: 42,
    recentMovements: [],
    tone: 'urban field notes',
    intent: 'seek density and civic energy',
    recentNarratives: [],
    ...overrides
  };
}

function createServiceWithMock(mockCreate) {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
  const service = new OpenAIService();
  service.client = {
    chat: {
      completions: {
        create: mockCreate
      }
    }
  };
  return service;
}

test('decision prompt includes exploration policy and route option context', async () => {
  let request = null;
  const service = createServiceWithMock(async (req) => {
    request = req;
    return {
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
      choices: [{
        message: {
          content: JSON.stringify({
            selectedIndex: 1,
            reasoning: 'The side street stays public and bright while opening a fresh line through the neighborhood.',
            sceneTag: 'open-branch'
          })
        }
      }]
    };
  });

  const result = await service.decideNextMove(makeInput({
    screenshots: [
      { base64: 'dGVzdA==', direction: 15, description: 'Main Street', visited: false },
      { base64: 'dGVzdA==', direction: 95, description: 'Side Street', visited: false },
      { base64: 'dGVzdA==', direction: 190, description: 'Station entrance', visited: true }
    ],
    recentMovements: [
      { from: 'A', to: 'B', heading: 90, reasoning: 'A narrow corridor drew me onward.' },
      { from: 'B', to: 'A', heading: 270, reasoning: 'I doubled back.' }
    ],
    recentNarratives: ['The route started to feel like a loop.'],
    stats: { locationsVisited: 12, distanceTraveled: 340, pathLength: 14 }
  }));

  assert.equal(result.selectedPanoId, 'B');
  assert.equal(result.sceneTag, 'open-branch');
  assert.equal(request.model, 'gpt-5-nano');

  const systemPrompt = request.messages[0].content;
  const userText = request.messages[1].content[0].text;

  assert.match(systemPrompt, /Exploration policy, in priority order/);
  assert.match(systemPrompt, /Do not go deeper into indoor shops/);
  assert.match(systemPrompt, /Preserve the wanderer's soul/);
  assert.match(userText, /Option 0: 15 degrees; not yet visited; Street View label: "Main Street"/);
  assert.match(userText, /Option 2: 190 degrees; already visited; Street View label: "Station entrance"/);
  assert.match(userText, /Recent movement context/);
  assert.match(userText, /Recent field notes/);
});

test('retries once after parse failure and succeeds without fallback', async () => {
  let calls = 0;
  const service = createServiceWithMock(async () => {
    calls++;
    if (calls === 1) {
      return {
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
        choices: [{ message: { content: '{"selectedIndex":1,"reasoning":"Broken JSON"' } }]
      };
    }

    return {
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
      choices: [{ message: { content: JSON.stringify({ selectedIndex: 2, reasoning: 'The brighter corridor looks less traveled and visually open.' }) } }]
    };
  });

  const result = await service.decideNextMove(makeInput());

  assert.equal(calls, 2);
  assert.equal(result.selectedPanoId, 'C');
  assert.equal(result.fallbackCause, null);
});

test('returns fallback with parse_error_after_retries when JSON stays malformed', async () => {
  let calls = 0;
  const service = createServiceWithMock(async () => {
    calls++;
    return {
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
      choices: [{ message: { content: 'not json at all' } }]
    };
  });

  const result = await service.decideNextMove(makeInput({ stepNumber: 88 }));

  assert.equal(calls, 2);
  assert.equal(result.fallbackCause, 'parse_error_after_retries');
  assert.equal(result.selectedPanoId, 'A');
  assert.match(result.reasoning, /Model unavailable;/);
});

test('retries when JSON has braces but invalid syntax', async () => {
  let calls = 0;
  const service = createServiceWithMock(async () => {
    calls++;
    if (calls === 1) {
      return {
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
        choices: [{ message: { content: '{not json}' } }]
      };
    }

    return {
      usage: { prompt_tokens: 90, completion_tokens: 20, total_tokens: 110 },
      choices: [{ message: { content: JSON.stringify({ selectedIndex: 1, reasoning: 'The corner storefront and side-street depth suggest stronger branching just ahead.' }) } }]
    };
  });

  const result = await service.decideNextMove(makeInput({ stepNumber: 73 }));

  assert.equal(calls, 2);
  assert.equal(result.selectedPanoId, 'B');
  assert.equal(result.fallbackCause, null);
});

test('blank-content retry escalates completion token budget', async () => {
  let calls = 0;
  const requestedTokens = [];
  const service = createServiceWithMock(async (req) => {
    calls++;
    requestedTokens.push(req.max_completion_tokens);
    if (calls === 1) {
      return {
        usage: {
          prompt_tokens: 100,
          completion_tokens: req.max_completion_tokens,
          total_tokens: 100 + req.max_completion_tokens
        },
        choices: [{ message: { content: '' } }]
      };
    }
    return {
      usage: { prompt_tokens: 90, completion_tokens: 20, total_tokens: 110 },
      choices: [{ message: { content: JSON.stringify({ selectedIndex: 0, reasoning: 'Crosswalk activity and signage suggest an active route with fresh branches ahead.' }) } }]
    };
  });

  const result = await service.decideNextMove(makeInput({ stepNumber: 51 }));

  assert.equal(calls, 2);
  assert.ok(requestedTokens[0] >= 2000, 'initial token budget should be practical for GPT-5 reasoning output');
  assert.ok(requestedTokens[1] > requestedTokens[0], 'retry should raise token budget after blank output');
  assert.equal(result.selectedPanoId, 'A');
  assert.equal(result.fallbackCause, null);
});

test('retries retryable API error and succeeds', async () => {
  let calls = 0;
  const service = createServiceWithMock(async () => {
    calls++;
    if (calls === 1) {
      const err = new Error('rate limit');
      err.status = 429;
      throw err;
    }

    return {
      usage: { prompt_tokens: 90, completion_tokens: 20, total_tokens: 110 },
      choices: [{ message: { content: JSON.stringify({ selectedIndex: 0, reasoning: 'Crosswalk activity and signage suggest an active route with fresh branches ahead.' }) } }]
    };
  });

  const result = await service.decideNextMove(makeInput());

  assert.equal(calls, 2);
  assert.equal(result.selectedPanoId, 'A');
  assert.equal(result.fallbackCause, null);
});

test('non-retryable API error falls back with explicit cause', async () => {
  let calls = 0;
  const service = createServiceWithMock(async () => {
    calls++;
    const err = new Error('unauthorized');
    err.status = 401;
    throw err;
  });

  const result = await service.decideNextMove(makeInput({ stepNumber: 64 }));

  assert.equal(calls, 1);
  assert.equal(result.fallbackCause, 'api_error_401');
  assert.equal(result.selectedPanoId, 'A');
});

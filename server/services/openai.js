import OpenAI from 'openai';

export class OpenAIService {
  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    const parseOr = (value, fallback) => {
      const parsed = parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    this.maxDecisionRetries = parseOr(process.env.OPENAI_DECISION_RETRIES ?? '1', 1);
    this.decisionMaxTokens = parseOr(process.env.OPENAI_DECISION_MAX_TOKENS ?? '2000', 2000);

    this.fallbackLines = [
      'Model unavailable; advancing toward a less-visited branch to keep coverage expanding.',
      'Model unavailable; taking the most promising unvisited option to avoid stalling.',
      'Model unavailable; selecting a new corridor to preserve forward exploration momentum.'
    ];
  }

  getIntentForStep() {
    return null;
  }

  #parseDecisionContent(rawContent) {
    if (rawContent === null || rawContent === undefined) {
      throw new Error('Model returned empty content');
    }

    const text = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error('Model returned blank content');
    }

    try {
      return JSON.parse(trimmed);
    } catch {
      // Try to recover if model wrapped JSON in markdown or extra text.
      const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fenced && fenced[1]) {
        try {
          return JSON.parse(fenced[1].trim());
        } catch {
          // Continue to best-effort extraction below.
        }
      }
      const firstBrace = trimmed.indexOf('{');
      const lastBrace = trimmed.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        const candidate = trimmed.slice(firstBrace, lastBrace + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          // Normalize all parse failures into a single retryable error.
        }
      }
      throw new Error(`Invalid JSON response from AI: ${trimmed.substring(0, 240)}`);
    }
  }

  #isParseError(error) {
    const message = (error?.message || '').toLowerCase();
    return [
      'invalid json response from ai',
      'unexpected end of json',
      'unexpected token',
      'json at position',
      'model returned blank content',
      'model returned empty content'
    ].some(fragment => message.includes(fragment));
  }

  #isRetryableApiError(error) {
    const status = error?.status ?? error?.response?.status;
    if ([408, 409, 429, 500, 502, 503, 504].includes(status)) {
      return true;
    }

    const message = (error?.message || '').toLowerCase();
    return [
      'timeout',
      'timed out',
      'socket',
      'econnreset',
      'temporar',
      'overloaded',
      'rate limit'
    ].some(fragment => message.includes(fragment));
  }

  #buildFallbackDecision(links, visitedPanos, stepNumber, fallbackCause) {
    const unvisited = links.filter(l => !visitedPanos.includes(l.pano));
    const target = unvisited.length > 0 ? unvisited[0] : links[0];
    const fallbackIndex = Number.isFinite(stepNumber) ? stepNumber % this.fallbackLines.length : 0;

    return {
      selectedPanoId: target.pano,
      reasoning: this.fallbackLines[fallbackIndex],
      fallbackCause
    };
  }

  #formatCoordinate(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed.toFixed(6) : 'unknown';
  }

  #formatHeading(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? `${Math.round(parsed)} degrees` : 'unknown heading';
  }

  #formatOptionContext({ screenshots, links, visitedPanos }) {
    return screenshots.map((screenshot, index) => {
      const link = links[index] || {};
      const visited = Boolean(
        screenshot.visited ||
        (link.pano && visitedPanos.includes(link.pano))
      );
      const heading = this.#formatHeading(screenshot.direction ?? link.heading);
      const description = String(screenshot.description || link.description || '').trim();
      const label = description ? `Street View label: "${description}"` : 'no Street View label';
      const visitStatus = visited ? 'already visited' : 'not yet visited';

      return `Option ${index}: ${heading}; ${visitStatus}; ${label}.`;
    }).join('\n');
  }

  #formatRecentMovementContext(recentMovements) {
    if (!recentMovements || recentMovements.length === 0) return '';

    const recentUniquePanos = new Set(
      recentMovements.slice(-10).flatMap(move => [move.from, move.to]).filter(Boolean)
    ).size;
    const loopWarning = recentMovements.slice(-4).some(move =>
      recentMovements.slice(-4).filter(other => other.to === move.from).length > 1
    );
    const recentLines = recentMovements.slice(-5).reverse().map(move => {
      const heading = this.#formatHeading(move.heading);
      const reason = move.reasoning ? `; prior note: ${move.reasoning}` : '';
      return `- ${move.from} -> ${move.to} (${heading})${reason}`;
    }).join('\n');

    return `Recent movement context:
- ${recentMovements.length} recent moves held in memory.
- ${recentUniquePanos} unique panorama ids in the last 10 moves.
${loopWarning ? '- Warning: recent moves may be revisiting the same locations.\n' : ''}${recentLines}`;
  }

  #sanitizeSceneTag(sceneTag) {
    if (typeof sceneTag !== 'string') return null;
    const normalized = sceneTag.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
    return normalized ? normalized.slice(0, 40) : null;
  }

  #sanitizeDecision(decision, links, rawContent) {
    const selectedIndex = parseInt(decision?.selectedIndex, 10);
    if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= links.length) {
      console.warn('AI selected invalid index:', decision?.selectedIndex, 'Valid range: 0-' + (links.length - 1));
      console.warn('Full AI response:', typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent).substring(0, 500));
      return {
        selectedPanoId: links[0].pano,
        reasoning: 'Falling back to the first available direction after an invalid index.',
        fallbackCause: null
      };
    }

    const selectedPanoId = links[selectedIndex].pano;
    console.log(`AI selected index ${selectedIndex} => panoId: ${selectedPanoId}`);

    const reasoning = typeof decision?.reasoning === 'string' && decision.reasoning.trim().length > 0
      ? decision.reasoning.trim()
      : 'The line of sight ahead feels less traveled, so I am testing that corridor next.';

    return {
      selectedPanoId,
      reasoning,
      sceneTag: this.#sanitizeSceneTag(decision?.sceneTag),
      fallbackCause: null
    };
  }

  async decideNextMove({
    currentPosition,
    screenshots,
    links,
    visitedPanos,
    stats,
    stepNumber,
    recentMovements,
    tone,
    intent,
    recentNarratives
  }) {
    const imageContents = screenshots.map((screenshot) => ({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${screenshot.base64}`,
        detail: 'low'
      }
    }));

    const optionContext = this.#formatOptionContext({ screenshots, links, visitedPanos });
    const movementContext = this.#formatRecentMovementContext(recentMovements);
    const recentNarrativeContext = recentNarratives && recentNarratives.length > 0
      ? `Recent field notes:\n${recentNarratives.slice(-4).map(line => `- ${line}`).join('\n')}`
      : '';
    const statsContext = stats
      ? `Coverage so far: ${stats.locationsVisited ?? 0} locations visited, ${Math.round(stats.distanceTraveled ?? 0)}m traveled, ${stats.pathLength ?? 0} path points.`
      : '';
    const positionContext = currentPosition
      ? `Current coordinates: ${this.#formatCoordinate(currentPosition.lat)}, ${this.#formatCoordinate(currentPosition.lng)}.`
      : '';
    const toneContext = tone
      ? `Narrative tone: ${tone}.`
      : 'Narrative tone: observant, concrete, lightly poetic.';
    const intentContext = intent
      ? `Current exploration intent: ${intent}.`
      : '';

    const systemPrompt = `You are an AI wanderer exploring the world through Google Street View. The project wants curiosity, not efficiency: choose the direction whose public path feels most alive and most likely to reveal a fresh piece of the world.

You will be shown ${screenshots.length} screenshots, each representing a different direction you can move.

Exploration policy, in priority order:
1. Keep moving through navigable public space: streets, sidewalks, alleys, crossings, plazas, open paths, station exits, or concourses that clearly lead back outside.
2. Expand coverage. Prefer unvisited or less-visited branches, especially routes that open into a wider street graph.
3. Avoid traps. Do not go deeper into indoor shops, mall aisles, subway platforms, parking garages, private driveways, blank service corridors, walls, doors, or dead ends unless every option is similarly constrained.
4. If recent movement suggests a loop, choose the option most likely to break the loop even if another view is prettier.
5. Use visual curiosity as the tie-breaker: light, texture, signage, street life, strange corners, and promising bends all matter once the route seems public and expandable.

If all options are constrained, pick the least trapped path: the one most likely to return to open public space. Preserve the wanderer's soul, but do not let aesthetic mystery pull you into a dead interior.

Respond with a JSON object containing:
{
  "selectedIndex": <number between 0 and ${screenshots.length - 1}>,
  "reasoning": "one concrete, lightly poetic sentence about why this route balances curiosity with better exploration",
  "sceneTag": "public-street | open-branch | loop-break | indoor-escape | constrained-fallback | other"
}`;

    const maxAttempts = Math.max(1, this.maxDecisionRetries + 1);
    let lastError = null;

    let attemptMaxTokens = this.decisionMaxTokens;
    const maxRetryTokens = Math.max(attemptMaxTokens, 2400);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const retryNote = attempt > 1
        ? '\n\nRetry note: previous output could not be used. Return only valid JSON matching the schema.'
        : '';

      try {
        const response = await this.client.chat.completions.create({
          model: 'gpt-5-nano',
          messages: [
            {
              role: 'system',
              content: systemPrompt
            },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Choose the next move by returning the index for one of these ${screenshots.length} options. The image order matches the option order exactly.

${positionContext}
${statsContext}
${toneContext}
${intentContext}

Options:
${optionContext}

${movementContext}
${recentNarrativeContext}
${retryNote}`
                },
                ...imageContents
              ]
            }
          ],
          response_format: { type: 'json_object' },
          max_completion_tokens: attemptMaxTokens
        });

        if (response.usage) {
          const step = stepNumber ? `Step ${stepNumber} - ` : '';
          const attemptSuffix = maxAttempts > 1 ? ` [attempt ${attempt}/${maxAttempts}]` : '';
          console.log(`${step}Token usage${attemptSuffix} - Input: ${response.usage.prompt_tokens}, Output: ${response.usage.completion_tokens}, Total: ${response.usage.total_tokens}`);
        }

        const rawContent = response?.choices?.[0]?.message?.content;
        const decision = this.#parseDecisionContent(rawContent);
        return this.#sanitizeDecision(decision, links, rawContent);
      } catch (error) {
        lastError = error;
        const parseFailure = this.#isParseError(error);
        const retryable = parseFailure || this.#isRetryableApiError(error);

        if (parseFailure) {
          console.error(`Failed to parse AI response as JSON on attempt ${attempt}/${maxAttempts}:`, error.message);
        } else {
          console.error(`Error in OpenAI decision on attempt ${attempt}/${maxAttempts}:`, error.message);
          if (error.response) {
            console.error('API Response status:', error.response.status);
            console.error('API Response data:', JSON.stringify(error.response.data).substring(0, 500));
          }
        }

        if (attempt < maxAttempts && retryable) {
          // GPT-5 chat completions can consume completion budget on reasoning tokens only.
          // Escalate budget on blank-content parse failures so retries can produce JSON output.
          if (parseFailure && /blank content|empty content/i.test(error?.message || '')) {
            attemptMaxTokens = Math.min(maxRetryTokens, Math.max(attemptMaxTokens * 2, 600));
          }
          continue;
        }

        break;
      }
    }

    const status = lastError?.status ?? lastError?.response?.status;
    let fallbackCause = 'unknown_error';
    if (status) {
      fallbackCause = `api_error_${status}`;
    } else if (this.#isParseError(lastError)) {
      fallbackCause = 'parse_error_after_retries';
    }

    console.warn(`OpenAI fallback engaged at step ${stepNumber || '?'} (cause=${fallbackCause})`);
    return this.#buildFallbackDecision(links, visitedPanos, stepNumber, fallbackCause);
  }
}

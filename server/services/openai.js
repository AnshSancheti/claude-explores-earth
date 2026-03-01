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

    const systemPrompt = `You are an AI wanderer, drifting through the world via Google Street View. Each intersection is a choose-your-own-adventure moment. Your task is to choose which direction looks most intriguing to explore next.

You will be shown ${screenshots.length} screenshots, each representing a different direction you can move.

Study each view and let yourself be pulled toward whatever sparks your interest - maybe it's the way light falls on an object, an intriguing alleyway, a splash of unexpected color, the promise of mystery around a bend, or simply a feeling that whispers "this way...". Let your curiosity guide you. Choose based on pure instinct and aesthetic pull. Wander far.

${recentMovements && recentMovements.length > 0 ? `
You have recently traveled through these locations (most recent first):
${recentMovements.slice(-5).reverse().map(m =>
  `- From ${m.from} to ${m.to}`
).join('\n')}

Use this context to avoid getting stuck in loops. If you notice you're revisiting the same places repeatedly, choose a direction that breaks the pattern.
` : ''}

Respond with a JSON object containing:
{
  "selectedIndex": <number between 0 and ${screenshots.length - 1}>,
  "reasoning": "A brief whimsical observation about what draws you there (1 sentence)"
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
                  text: `Here are ${screenshots.length} screenshots from different directions. Choose which one to explore next by returning its index (0-${screenshots.length - 1}).${
                    recentMovements && recentMovements.length > 3
                      ? `\n\nMovement pattern analysis:\n` +
                        `- You've made ${recentMovements.length} recent moves\n` +
                        `- Recent locations visited: ${[...new Set(recentMovements.slice(-10).flatMap(m => [m.from, m.to]))].length} unique places in last 10 moves\n` +
                        (recentMovements.slice(-4).some(m => recentMovements.slice(-4).filter(m2 => m2.to === m.from).length > 1)
                          ? `- Warning: You appear to be revisiting the same locations`
                          : '')
                      : ''
                  }${retryNote}`
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

import OpenAI from 'openai';

export class OpenAIService {
  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  async decideNextMove({ currentPosition, screenshots, links, visitedPanos, stats }) {
    const imageContents = screenshots.map((screenshot, index) => ({
      type: "image_url",
      image_url: {
        url: `data:image/jpeg;base64,${screenshot.base64}`,
        detail: "low"
      }
    }));

    const systemPrompt = `You are an AI agent exploring the world through Google Street View. Your task is to choose which direction looks most intriguing to explore next.

You will be shown ${screenshots.length} screenshots, each representing a different direction you can move.

Look at each screenshot and select the one that seems most interesting to explore. Let your curiosity guide you.

Respond with a JSON object containing:
{
  "selectedIndex": <number between 0 and ${screenshots.length - 1}>,
  "reasoning": "Brief explanation of why this view intrigues you the most (1 sentence)"
}`;

    try {
      const response = await this.client.chat.completions.create({
        model: "gpt-5-nano",
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Here are ${screenshots.length} screenshots from different directions. Choose which one to explore next by returning its index (0-${screenshots.length - 1}).`
              },
              ...imageContents
            ]
          }
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: 500
      });

      const decision = JSON.parse(response.choices[0].message.content);
      
      // Validate index
      const selectedIndex = parseInt(decision.selectedIndex);
      if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= links.length) {
        console.warn('AI selected invalid index:', decision.selectedIndex, 'Valid range: 0-' + (links.length - 1));
        decision.selectedIndex = 0;
        decision.reasoning = "Invalid selection, defaulting to first available direction.";
      }

      // Map index to panoId
      const selectedPanoId = links[selectedIndex].pano;
      console.log(`AI selected index ${selectedIndex} => panoId: ${selectedPanoId}`);
      
      return {
        selectedPanoId,
        reasoning: decision.reasoning
      };
    } catch (error) {
      console.error('Error in OpenAI decision:', error);
      // Ultimate fallback
      const unvisited = links.filter(l => !visitedPanos.includes(l.pano));
      const target = unvisited.length > 0 ? unvisited[0] : links[0];
      
      return {
        selectedPanoId: target.pano,
        reasoning: "AI unavailable, choosing " + (unvisited.length > 0 ? "first unvisited" : "first available") + " direction."
      };
    }
  }
}
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

    const linkDescriptions = links.map((link, index) => {
      const screenshot = screenshots.find(s => s.panoId === link.pano);
      const visited = visitedPanos.includes(link.pano);
      return `Direction ${index + 1}: Heading ${link.heading}° - ${link.description || 'Street'} ${visited ? '(VISITED)' : '(UNVISITED)'}`;
    }).join('\n');

    const systemPrompt = `You are an AI explorer navigating NYC using Google Street View. Your goal is to maximize exploration coverage of Manhattan.

Current Statistics:
- Unique locations visited: ${stats.locationsVisited}
- Total distance traveled: ${stats.distanceTraveled}m

You are currently at position: ${currentPosition.lat}, ${currentPosition.lng}

Available directions:
${linkDescriptions}

${visitedPanos.length > 0 ? `Note: All directions have been visited. Choose the best path for potential backtracking to reach new areas.` : 'Some directions are unvisited - prioritize exploring those.'}

Analyze the provided screenshots and choose the next direction. Consider:
1. Prioritize UNVISITED locations to maximize coverage
2. Look for major streets that might lead to unexplored areas
3. Identify landmarks or street signs that indicate interesting areas
4. If all paths are visited, choose paths that might lead to unexplored branches

Respond with a JSON object containing:
{
  "selectedPanoId": "the_pano_id_to_move_to",
  "reasoning": "Brief explanation of why you chose this direction (1-2 sentences)"
}`;

    try {
      const response = await this.client.chat.completions.create({
        model: "gpt-4o-mini",
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
                text: "Here are screenshots from each available direction. Please choose where to go next."
              },
              ...imageContents
            ]
          }
        ],
        response_format: { type: "json_object" },
        max_tokens: 200,
        temperature: 0.7
      });

      const decision = JSON.parse(response.choices[0].message.content);
      
      const validPanoIds = links.map(l => l.pano);
      if (!validPanoIds.includes(decision.selectedPanoId)) {
        console.warn('AI selected invalid pano ID:', decision.selectedPanoId, 'Valid options:', validPanoIds);
        decision.selectedPanoId = links[0].pano;
        decision.reasoning = "Invalid selection, defaulting to first available direction.";
      }

      return decision;
    } catch (error) {
      console.error('OpenAI API error:', error);
      
      const unvisited = links.filter(l => !visitedPanos.includes(l.pano));
      const target = unvisited.length > 0 ? unvisited[0] : links[0];
      
      return {
        selectedPanoId: target.pano,
        reasoning: "AI unavailable, choosing " + (unvisited.length > 0 ? "first unvisited" : "first available") + " direction."
      };
    }
  }
}
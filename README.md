# Scout

A digital flâneur - an autonomous AI agent that leisurely strolls through the streets of NYC via Google Street View. See it live at https://claude-explores-earth.fly.dev/ or clone and BYO API Keys.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)

## Demo

https://claude-explores-earth.fly.dev/

## ✨ Features

### Autonomous Exploration
- **AI-Powered Navigation**: Uses GPT-5-nano to analyze Street View images and decide where to go next
- **Dual Mode Operation**: 
  - 🔍 **Exploration Mode**: AI chooses based on visual interest
  - 🧭 **Pathfinding Mode**: BFS navigation to nearest unexplored area when stuck
  - **[Beta] Clustered Pathfinding**: Street View doesn't necessarily create a connected graph. For example, position A may neighbor B, but B neighbors A', not A. Clusters handle A/A' pano splits by clustering nearby panos (≤2m by default) and allowing intra‑cluster repositioning to reach exits toward the frontier

### Real-Time Visualization
- **Live Street View**: Watch exactly what the AI sees as it explores
- **Minimap**: Track the exploration path with markers and route visualization. The minimap path is simplified on the server using a tiered Douglas–Peucker strategy that preserves recent detail and aggressively reduces older segments.
- **Coverage Statistics**: Monitor unique locations visited and total distance traveled
- **Decision Log**: See the AI's reasoning for each move with screenshot thumbnails

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ 
- npm or yarn
- Google Maps API key with Street View access
- OpenAI API key

### Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/claude-explores-earth.git
cd claude-explores-earth
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file (see `.env.example`):
```env
# Required API Keys
GOOGLE_MAPS_API_KEY=your_google_maps_key
OPENAI_API_KEY=your_openai_key
```

4. Start the application:
```bash
npm start
# or for development with auto-reload
npm run dev
```

5. Open your browser to `http://localhost:5173` (or the port specified in your .env)

## 🎮 Usage

### Admin Console
- **Toggle Controls**: Toggle access to admin controls by clicking on the compass and entering your admin password(defined in your .env)

### Controls
- **Start Exploration**: Begin autonomous exploration
- **Take Step**: Execute a single exploration step
- **Stop**: Pause the exploration
- **Reset**: Return to starting position and clear history
- **Load**: Load a saved run file(loads from /runs/saves/current-run.json)

## 🏗️ Architecture

### System Design
```
┌─────────────┐     WebSocket       ┌─────────────┐
│   Browser   │ ◄─────────────────► │   Server    │
│  (Display)  │                     │  (Control)  │
└─────────────┘                     └─────────────┘
       │                                    │
       │                                    ▼
       ▼                            ┌─────────────┐
┌─────────────┐                     │  Puppeteer  │
│ Street View │                     │  (Headless) │
│  (Visible)  │                     └─────────────┘
└─────────────┘                            │
                                           ▼
                                    ┌─────────────┐
                                    │   OpenAI    │
                                    │  GPT-5-nano │
                                    └─────────────┘
```

### Key Components
- **Frontend Street View**: What users see in the browser
- **Headless Street View**: Server-side Puppeteer instance for screenshots
- **Exploration Agent**: Coordinates navigation and decision-making
- **Coverage Tracker**: Maintains visited locations, frontier, and statistics
- **[Beta] Pathfinder**: BFS-based navigation to escape loops and reach unexplored areas, with cluster graph support and diagnostics

### Pathfinding Details
- **Graph BFS**: Searches visited→visited directed edges for any boundary where a neighbor is unvisited.
- **[Beta] Clustered BFS**: Groups nearby panos into clusters and searches the cluster graph. If the exit is from a different pano in the same cluster, the agent performs an intra‑cluster reposition step, then exits toward the frontier.
- **Diagnostics**: Logs decisions like cross‑cluster moves, intra‑cluster repositioning, unreachable boundaries, and fallbacks to heuristics.

## 🗂️ Project Structure

```
ai-explores-nyc/
├── server/
│   ├── index.js                 # Express server & WebSocket
│   ├── agents/
│   │   └── explorationAgent.js  # Main exploration logic
│   ├── services/
│   │   ├── streetViewHeadless.js # Puppeteer Street View
│   │   ├── openai.js            # GPT-5-nano Vision integration
│   │   ├── coverage.js          # Exploration & frontier tracking
│   └── utils/
│       ├── logger.js            # Session logging
│       └── screenshot.js        # Image capture & storage
├── public/
│   ├── index.html               # Main UI
│   ├── js/
│   │   ├── app.js              # Application controller
│   │   ├── streetview.js       # Frontend Street View
│   │   ├── map.js              # Minimap management
│   │   └── ui.js               # UI updates
│   └── css/
│       └── styles.css          # Styling
├── runs/                        # Logs & screenshots (auto-created)
└── package.json
```

## 📸 Data Storage

### Screenshots
- Location: `runs/shots/<runId>/<step>/`
- Format: `<step>-dir<heading>.jpg`
- Captured for each direction the AI analyzes

### Logs
- Location: `runs/`
- Format: JSON lines with timestamps
- Includes all navigation decisions and API calls

### Customization
- Modify starting location in `.env`
- Adjust exploration interval for faster/slower navigation
- Configure AI prompts in `server/services/openai.js`
- Tune path simplification using the PATH_* env vars above to keep the minimap performant on long runs

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Google Maps Platform for Street View API
- OpenAI for GPT-4 Vision API
- MapLibre GL JS for map visualization
- The open-source community for the amazing tools

## ⚠️ Important Notes

- **API Costs**: This application uses paid APIs (Google Maps & OpenAI). Monitor your usage to avoid unexpected charges.
- **Rate Limits**: Respect API rate limits. The default 5-second interval helps prevent hitting limits.
- **Browser Requirements**: Modern browser with WebSocket support required.

## 📧 Contact

For questions or support, please open an issue on GitHub.

## To-Do:
- Thinking icon when agent is choosing
- Stop/backtrack for something interesting

---

Vibed with ❤️ by developers who believe AI should explore the world
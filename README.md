# Flaneur 🚶

A digital flâneur - an autonomous AI agent that leisurely strolls through the streets of NYC via Google Street View. Named after the French term for one who walks without hurry, observing society and urban life, this agent explores Manhattan with curiosity and whimsy, analyzing Street View imagery and making intelligent navigation decisions.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)

## 🎥 Demo

The AI agent autonomously navigates NYC streets, capturing multi-directional views and making exploration decisions based on visual analysis. Watch as it builds a map of its journey in real-time!

## ✨ Features

### 🤖 Autonomous Exploration
- **AI-Powered Navigation**: Uses GPT-5-nano Vision to analyze Street View images and decide where to go next
- **Multi-Directional Vision**: Captures screenshots in multiple directions before moving
- **Smart Path Planning**: Prioritizes unvisited locations to maximize exploration coverage
- **Loop Prevention**: Automatically escapes repetitive paths using frontier-based pathfinding
- **Dual Mode Operation**: 
  - 🔍 **Exploration Mode**: AI chooses based on visual interest
  - 🧭 **Pathfinding Mode**: BFS navigation to nearest unexplored area when stuck
- **Manual Step Mode**: Take single exploration steps with the "Take Step" button

### 📊 Real-Time Visualization
- **Live Street View**: Watch exactly what the AI sees as it explores
- **Interactive Minimap**: Track the exploration path with markers and route visualization
- **Coverage Statistics**: Monitor unique locations visited and total distance traveled
- **Decision Log**: See the AI's reasoning for each move with screenshot thumbnails

### 🛠️ Technical Features
- **Dual Street View System**: Synchronized frontend display and headless backend capture
- **Screenshot Archival**: All captured images saved with timestamps
- **Session Logging**: Detailed logs for replay and analysis
- **Multi-Session Support**: Each browser connection gets its own exploration session

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ 
- npm or yarn
- Google Maps API key with Street View access
- OpenAI API key with GPT-4 Vision access

### Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/ai-explores-nyc.git
cd ai-explores-nyc
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file:
```env
# Required API Keys
GOOGLE_MAPS_API_KEY=your_google_maps_key
OPENAI_API_KEY=your_openai_key

# Configuration
STEP_INTERVAL_MS=500

# Starting Location (default: Empire State Building)
START_LAT=40.748817
START_LNG=-73.985428
# Optional: Use a specific panorama ID
START_PANO_ID=PfZ-rW8bzPDXJsJuJqsBVA
```

4. Start the application:
```bash
npm start
# or for development with auto-reload
npm run dev
```

5. Open your browser to `http://localhost:5173` (or the port specified in your .env)

## 🎮 Usage

### Controls
- **Start Exploration**: Begin autonomous exploration
- **Take Step**: Execute a single exploration step
- **Stop**: Pause the exploration
- **Reset**: Return to starting position and clear history

### Exploration Modes
1. **Continuous Mode**: Agent explores automatically every few seconds
2. **Manual Mode**: Use "Take Step" for controlled exploration
3. **Hybrid**: Start/stop continuous exploration as needed

## 🏗️ Architecture

### System Design
```
┌─────────────┐     WebSocket      ┌─────────────┐
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
                                    │ GPT-4 Vision│
                                    └─────────────┘
```

### Key Components
- **Frontend Street View**: What users see in the browser
- **Headless Street View**: Server-side Puppeteer instance for screenshots
- **Exploration Agent**: Coordinates navigation and decision-making
- **Coverage Tracker**: Maintains visited locations, frontier, and statistics
- **Pathfinder**: BFS-based navigation to escape loops and reach unexplored areas

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
│   │   └── pathfinder.js        # BFS pathfinding for loop escape
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

## 🔧 Configuration

### Environment Variables
| Variable | Description | Default |
|----------|-------------|---------|
| `STEP_INTERVAL_MS` | Time between exploration steps | 500 |
| `START_LAT` | Starting latitude | 40.748817 |
| `START_LNG` | Starting longitude | -73.985428 |
| `START_PANO_ID` | Optional panorama ID (overrides lat/lng) | - |

### Customization
- Modify starting location in `.env`
- Adjust exploration interval for faster/slower navigation
- Configure AI prompts in `server/services/openai.js`

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

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

## 🐛 Troubleshooting

### Common Issues

1. **"No panorama found at location"**
   - Ensure your starting coordinates have Street View coverage
   - Try using a panorama ID instead of lat/lng

2. **Screenshots not displaying**
   - Check that the `runs/` directory is created and writable
   - Verify the server can access the file system

3. **AI making invalid selections**
   - Ensure you're using GPT-4 Vision (not GPT-3.5)
   - Check that screenshots are being captured correctly

## 📧 Contact

For questions or support, please open an issue on GitHub.

---

Built with ❤️ by developers who believe AI should explore the world
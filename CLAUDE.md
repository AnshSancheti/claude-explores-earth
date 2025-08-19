# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

```bash
# Install dependencies
npm install

# Start the server
npm start
# or
./start.sh

# Development mode with auto-reload
npm run dev

# The app runs at http://localhost:5173
```

## Architecture Overview

This is an autonomous AI agent that explores NYC using Google Street View. The system has two parallel Street View instances:

### Dual Street View Architecture
1. **Frontend Street View** (`public/js/streetview.js` - `StreetViewManager`)
   - Visible to users in the browser
   - Displays what the AI is "seeing"
   - Synchronized via WebSocket events

2. **Headless Street View** (`server/services/streetViewHeadless.js` - `StreetViewHeadless`)
   - Hidden Puppeteer instance on server
   - Captures screenshots for AI analysis
   - Gets panorama navigation data
   - Never visible to users

### Key Architectural Decisions

#### Panorama ID Handling
The system uses `getCurrentPanorama()` to get the exact panorama ID being displayed, avoiding lat/lng conversion errors. This ensures:
- AI screenshots match navigation data exactly
- No drift between intended and actual navigation
- Better accuracy in dense urban areas

#### Link Selection Logic
- `targetLinks` = unvisited links (or all links if everything is visited)
- Screenshots are only taken for `targetLinks`
- AI only receives `targetLinks` to ensure it has visual data for all options

#### Frontier-Based Exploration
The system prevents getting stuck in loops through intelligent pathfinding:
- **Frontier Tracking**: Maintains a set of discovered but unvisited panoramas
- **Loop Detection**: Identifies when revisiting same locations repeatedly
- **Mode Switching**: Automatically switches between:
  - 🔍 **Exploration Mode**: AI chooses based on visual interest
  - 🧭 **Pathfinding Mode**: BFS navigation to nearest frontier when stuck
- **Escape Strategy**: Uses heuristics to escape fully-explored areas

#### Communication Flow
```
Browser ←→ WebSocket (Socket.io) ←→ Server
                ↓
         Headless Street View (Puppeteer)
                ↓
         Screenshot Capture → OpenAI GPT-4 Vision
                ↓
         Navigation Decision
```

### Global Exploration Architecture
The system uses a single global exploration that all users observe:
- **Single Agent**: One exploration agent shared by all connected clients
- **Shared State**: All users see the same exploration in real-time
- **Persistent Operation**: Exploration continues even with 0 connected users
- **Shared Control**: Any user can control the exploration (start/stop/step/reset)
- **History Management**: 
  - Last N decisions shown to new users (configurable via `DECISION_HISTORY_LIMIT`)
  - Full history persisted to disk in `runs/persistent_logs/`
  - Screenshot caching for recent steps
- **Broadcasting**: All events broadcast to all connected clients

## Environment Configuration

Required `.env` variables:
```env
GOOGLE_MAPS_API_KEY=<your_key>
OPENAI_API_KEY=<your_key>
PORT=5173
STEP_INTERVAL_MS=5000

# Starting location
START_LAT=40.748817
START_LNG=-73.985428
START_PANO_ID=<optional_pano_id>  # Takes priority over lat/lng if set
```

## File Organization

### Server Components
- `server/agents/explorationAgent.js` - Main exploration logic, coordinates all services
- `server/services/streetViewHeadless.js` - Puppeteer-based Street View for screenshots
- `server/services/openai.js` - GPT-5-nano vision integration (index-based selection)
- `server/services/coverage.js` - Tracks visited panoramas, frontier, and path history
- `server/services/pathfinder.js` - BFS pathfinding to escape loops and reach frontiers

### Frontend Components
- `public/js/app.js` - Main application controller
- `public/js/streetview.js` - User-visible Street View display
- `public/js/map.js` - Minimap showing exploration path with user interaction tracking
- `public/js/ui.js` - UI updates and decision log with smart pathfinding grouping

### UI Features
- **Glass Morphism Design**: Modern glass effects on header and sidebar with backdrop blur
- **Icon-Based Controls**: Consistent SVG icons for play, step, stop, and reset actions
- **Smart Decision Log**: 
  - Groups consecutive pathfinding steps to reduce clutter
  - Smooth slide-down animations for new entries
  - Timeline connectors between entries with color-coded dots
  - Green indicators for exploration decisions, yellow for pathfinding
- **Interactive Minimap**: 
  - Respects manual user adjustments (pan/zoom)
  - Reset button to recenter on full exploration path
  - Doesn't auto-reposition after user interaction

## Data Storage

- **Screenshots**: `runs/shots/<runId>/<step>/<step>-dir<heading>.jpg`
- **Logs**: `runs/exploration-<timestamp>.log`
- Both are automatically created, no database required

## Important Implementation Details

### Screenshot-Link Synchronization
The system ensures AI only sees panoramas it has screenshots for by:
1. Taking screenshots only for `targetLinks`
2. Passing only `targetLinks` to the AI service
3. Validating AI selection against available options

### Step Execution Synchronization
To prevent race conditions and ensure data consistency:
1. Each step captures its step number at the start
2. Server-side locks prevent concurrent step execution
3. Agent-level locks provide additional safety
4. Screenshot filenames are validated before sending to client

### Manual Step Mode
The "Take Step" button reuses the same exploration logic but triggers single steps instead of continuous exploration. The agent persists between manual steps with proper synchronization to prevent race conditions.

### Start Location Flexibility
The system prioritizes `START_PANO_ID` over lat/lng coordinates when both are provided. This ensures precise starting positions in Street View while still showing correct minimap location.
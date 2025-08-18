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

### Session Management
Each WebSocket connection maintains its own session with:
- Independent exploration agent
- Separate headless browser instance
- Isolated coverage tracking

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
- `server/services/openai.js` - GPT-4 vision integration for decision making
- `server/services/coverage.js` - Tracks visited panoramas and path history

### Frontend Components
- `public/js/app.js` - Main application controller
- `public/js/streetview.js` - User-visible Street View display
- `public/js/map.js` - Minimap showing exploration path
- `public/js/ui.js` - UI updates and decision log

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

### Manual Step Mode
The "Take Step" button reuses the same exploration logic but triggers single steps instead of continuous exploration. The agent persists between manual steps.

### Start Location Flexibility
The system prioritizes `START_PANO_ID` over lat/lng coordinates when both are provided. This ensures precise starting positions in Street View while still showing correct minimap location.
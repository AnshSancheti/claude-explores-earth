# AI Explores NYC 🗽

An autonomous AI agent that explores Manhattan using Google Street View, attempting to maximize coverage of NYC. The agent analyzes Street View imagery in multiple directions, tracks its exploration progress with a real-time coverage map, and makes intelligent navigation decisions every few seconds.

## 🎯 Key Features

### Autonomous Exploration
- **AI-Powered Navigation**: Uses GPT-5 to analyze Street View images and decide where to go next
- **Multi-Directional Vision**: Captures screenshots in multiple directions without moving, allowing the AI to "look around" before deciding
- **Smart Path Planning**: Prioritizes unvisited locations to maximize exploration coverage
- **Backtracking Capability**: Can return to previous locations to reach unexplored areas

### Real-Time Visualization
- **Interactive MapLibre Map**: Live map showing:
  - Agent's exploration path (red line)
  - Starting position marker (green) at Empire State Building
  - Current position marker (red) that follows the agent
- **Coverage Statistics**: 
  - Number of unique locations visited
  - Total distance traveled
- **Decision Log**: Real-time display of AI's reasoning for each move with thumbnails

### Technical Features
- **Screenshot Archival**: All captured images saved with timestamps
- **Session Logging**: Detailed logs for replay and analysis

## 🎮 How It Works

1. **Initialization**: Agent starts at Empire State Building
2. **Multi-Directional Observation**: 
   - Rotates camera to face each available path
   - Captures screenshots of unvisited directions (prioritized)
   - If all paths are visited, captures all directions
3. **AI Decision**: Passes in screenshots to AI agent, which analyzes all images and coverage data simultaneously to choose next move
4. **Navigation**: Moves to selected location via Street View API
5. **Coverage Tracking**: Updates real-time map, statistics, and grid cells
6. **Repeat**: Continues exploring until session ends or user resets

## 🧠 AI Decision Making

The agent uses a sophisticated prompt that considers:
- **Visual Analysis**: Street scenes from multiple directions
- **Landmark Detection**: Identifies notable buildings and signs
- **Visit History**: Track visited panoramas locally to avoid loops, only sending visited panoramas to AI agent if all panos have been visited.

### Multi-Directional Screenshot System
The agent can "look around" before moving:
1. **Rotation without Movement**: Camera smoothly pivots to face each available direction while staying at the same location
2. **Smart Capture Priority**: 
   - If some paths are unvisited: captures only those
   - If all paths are visited: captures all for context
3. **Simultaneous Analysis**: AI sees all viable directions at once for informed decisions
4. **Visual Memory**: Helps identify landmarks and remember areas

## 📊 Coverage Tracking

The system tracks exploration using:
- **Visited Panoramas**: Set of unique Street View panorama IDs
- **Path History**: Ordered list of coordinates for route display
- **Distance Metrics**: Total meters traveled

## 📝 Logging System

All sessions are comprehensively logged:

### Log Files
- **Location**: `runs/` directory
- **Contents**: Complete server log history with metadata

### Screenshots
- **Location**: `runs/shots/<runId>/<step>/`
- **Naming**: `<step>-dir<direction>.jpg`
- **Multi-directional**: Separate images for each viewed direction

### Detailed Logs
- **API Calls**: All Google Maps and OpenAI requests
- **Navigation Events**: Movement between panoramas
- **Model I/O**: AI inputs and outputs

## 🗺️ Map Features

The interactive map (powered by MapLibre GL JS) shows:
- **Base Layer**: OpenStreetMap tiles
- **Exploration Path**: Red line showing agent's route
- **Markers**: 
  - Green: Starting point (Empire State Building)
  - Red: Current position
- **Auto-Pan**: Follows agent when moving beyond view
- **Zoom Controls**: Navigate and explore the map
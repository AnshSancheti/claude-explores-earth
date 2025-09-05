# Repository Guidelines

## Project Structure & Module Organization
- `server/`: Express app and core logic
  - `agents/explorationAgent.js`: Main autonomous exploration loop
  - `services/`: Street View (Puppeteer), OpenAI, coverage, pathfinder
  - `utils/`: logging, screenshots, geo/path utilities
  - `middleware/secureRuns.js`: production access controls for `runs/`
- `public/`: Static UI (`index.html`, `js/`, `css/`, assets)
- `runs/`: Session logs and screenshots (created at runtime)
- Root: `package.json`, `Dockerfile`, `start.sh`, deployment docs

## Build, Test, and Development Commands
- `npm install`: Install dependencies
- `npm start`: Start server (`server/index.js`) on `PORT` (default 3000)
- `npm run dev`: Start with `nodemon` (watches `server/**` and `public/**`)
- `./start.sh`: Friendly wrapper for `npm start`
- Docker (optional): `docker build -t explorer .` then `docker run --env-file .env -p 3000:3000 explorer`

Access the app at `http://localhost:<PORT>` (default `3000`). Ensure `.env` is set before starting.

## Coding Style & Naming Conventions
- JavaScript (ESM): `import`/`export`, semicolons, single quotes, 2‑space indent
- Filenames: lowerCamelCase for modules (`streetViewHeadless.js`), PascalCase for classes
- Constants and env keys: `UPPER_SNAKE_CASE`
- Keep functions small and side‑effect aware; prefer pure utils in `utils/`

## Testing Guidelines
- No formal test runner yet; prioritize manual runs:
  1) `npm run dev` 2) observe logs and UI path/coverage updates
- When adding tests, use `server/**/__tests__/*.(spec|test).js` and target pure utils/services first
- Aim for meaningful coverage on `utils/` and `services/`; mock network and filesystem

## Commit & Pull Request Guidelines
- Commits: imperative mood, concise scope (e.g., "Add dead‑end recovery", "Refactor path simplification")
- Branches: `feature/<slug>`, `fix/<slug>`, `chore/<slug>`
- PRs: clear description, linked issue, scope of change, local verification steps, and screenshots (UI) or logs (server)

## Security & Configuration Tips
- Required `.env`: `GOOGLE_MAPS_API_KEY`, `OPENAI_API_KEY`; recommended: `CONTROL_PASSWORD`, optional: `ADMIN_API_KEY`, `URL_SIGNING_SECRET`
- Runtime config: `STEP_INTERVAL_MS`, `START_LAT`, `START_LNG`, `START_PANO_ID`
- `runs/` is public in dev; production should use `productionSecurity()` in `secureRuns.js`
- Never commit secrets or `runs/` artifacts

## Agent Notes
- Exploration logic lives in `server/agents/explorationAgent.js`; UI sync via Socket.io in `server/index.js`
- Prefer adding new heuristics in services (pathfinder/coverage) and keep agent orchestration minimal

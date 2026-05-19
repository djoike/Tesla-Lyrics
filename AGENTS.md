# AGENTS.md — Tesla Lyrics

Project context for AI agents working in this repository.

## What this project is

A self-hosted Node.js/Express app that displays Spotify lyrics on a Tesla Model 3 browser in real time. It polls the Spotify API, fetches lyrics from LRCLIB, and pushes updates to the browser over Server-Sent Events.

## Stack

- **Runtime:** Node.js 20, plain JavaScript (no TypeScript, no build step)
- **Backend:** Express.js (`server.js` — single file, no src/ directory)
- **Frontend:** Vanilla HTML/CSS/JS (`public/index.html` — single file, zero dependencies)
- **Communication:** Server-Sent Events (SSE) from server to browser
- **Container:** Docker, image published to `ghcr.io/djoike/tesla-lyrics` via GitHub Actions

## Project structure

```
server.js              # All backend logic: OAuth, SSE, polling, lyrics fetching
public/index.html      # All frontend logic: UI, SSE client, font sizing, wake lock
Dockerfile             # Single-stage Node 20 Alpine, npm ci, EXPOSE 5011
.github/workflows/
  publish.yml          # Builds and pushes to GHCR on push to main/master
.env.example           # Environment variable template
package.json           # Dependencies: express, axios, dotenv
package-lock.json      # Lockfile — always commit, used by npm ci in Docker
```

## Port

The app runs on **port 5011** (set via `PORT` env var, default `5011`).

## Environment variables

| Variable | Description |
|---|---|
| `SPOTIFY_CLIENT_ID` | From Spotify Developer Dashboard |
| `SPOTIFY_CLIENT_SECRET` | From Spotify Developer Dashboard |
| `REDIRECT_URI` | Must match exactly what is registered in Spotify dashboard |
| `PORT` | Server port (default: `5011`) |

## Key backend behaviour

- **Token storage:** Spotify tokens are persisted to `.tokens.json` in the app root. This file must be bind-mounted on the host so tokens survive container restarts. It must be created (`touch`) before the container starts or Docker will create a directory instead.
- **Polling state machine:** `isPolling` bool, toggled via `POST /api/start` and `POST /api/stop`. Auto-stops after 60 minutes.
- **Song change detection:** Tracks `currentTrackId`; only fetches lyrics and broadcasts SSE when the track ID changes.
- **Lyrics:** Fetched from `https://lrclib.net/api/get`. Returns `"Lyrics not found."` on 404 or any error — never throws.
- **SSE:** `/events` endpoint. Sends current state immediately on connect. Heartbeat comment every 30 seconds to keep the Tesla browser connection alive.

## Key frontend behaviour

- **Font sizing:** Binary search (up to 20 iterations) finds the largest font size between 11px and 28px where all lyrics fit in the container without scrolling. Runs on every SSE update and every `resize` event.
- **Wake Lock:** `navigator.wakeLock.request('screen')` called on load and re-acquired on `visibilitychange`.
- **SSE reconnect:** Auto-reconnects with 3-second backoff on error.
- **Auth check:** On load, calls `GET /api/status`. Shows a login banner if `authenticated` is false.

## Deployment (Synology NAS)

- NAS folder: `/volume1/docker/tesla-lyrics/`
- Bind mounts: `.env` → `/app/.env` (read-only), `tokens.json` → `/app/.tokens.json`
- Port mapping: `5011` → `5011`
- Restart policy: `unless-stopped`
- First-time auth: visit `http://<NAS_IP>:5011/login` once after container start

## What NOT to do

- Do not add a build step or TypeScript — the project is intentionally plain JS
- Do not add frontend dependencies — the Tesla browser has limited compatibility
- Do not add a `docker-compose.yml` — deployment is via Synology Container Manager directly
- Do not commit `.env` or `.tokens.json` — both are in `.gitignore`
- Do not suppress type errors with `as any` or `@ts-ignore`
- Do not change the port without updating `server.js`, `Dockerfile`, `.env`, `README.md`, and this file

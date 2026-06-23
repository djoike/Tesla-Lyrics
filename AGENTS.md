# AGENTS.md — Tesla Lyrics

Project context for AI agents working in this repository.

## What this project is

A self-hosted Node.js/Express app that displays Spotify lyrics on a Tesla Model 3 browser in real time, with a family voting system that lets passengers vote to skip the current song from their phones. It polls the Spotify API, fetches lyrics through a multi-step fallback chain, and pushes updates to the browser over Server-Sent Events.

## Stack

- **Runtime:** Node.js 20, plain JavaScript (no TypeScript, no build step)
- **Backend:** Express.js (`server.js` — single file, no src/ directory)
- **Frontend:** Vanilla HTML/CSS/JS (`public/index.html`, `public/remote.html` — single files)
- **Frontend dependency:** Twemoji (loaded via CDN script tag in both HTML files) — the only allowed frontend dependency
- **Communication:** Server-Sent Events (SSE) from server to browser
- **Container:** Docker, image published to `ghcr.io/djoike/tesla-lyrics` via GitHub Actions

## Project structure

```
server.js              # All backend logic: OAuth, SSE, polling, lyrics fetching, voting
public/index.html      # Main Tesla display: lyrics, controls, vote tally, toasts
public/remote.html     # Phone remote: emoji picker, Skip/Keep vote buttons, nav
Dockerfile             # Single-stage Node 20 Alpine, npm ci, EXPOSE 5011
.github/workflows/
  publish.yml          # Builds and pushes to GHCR on push to main/master
.env.example           # Environment variable template
package.json           # Dependencies: express, axios, dotenv, cheerio
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
| `PIN_CODE` | PIN to protect the main screen (default: `290585`) |
| `COOKIE_SECRET` | Secret for HMAC cookie signing — change from default |
| `GENIUS_ACCESS_TOKEN` | From genius.com/api-clients — optional, enables Genius lyrics fallback |
| `BRAVE_SEARCH_API_KEY` | Optional, enables Brave Search candidate lookup after LRCLIB and Genius miss |
| `GITHUB_TOKEN` | Optional, enables GitHub Models lyrics extraction for the final fallback step |
| `GITHUB_MODELS_MODEL` | Optional, defaults to `gpt-4.1-mini` |
| `BRAVE_SEARCH_API_BASE_URL` | Optional override for Brave Search API endpoint |
| `GITHUB_MODELS_API_BASE_URL` | Optional override for GitHub Models inference endpoint |
| `WEB_LYRICS_FETCH_TIMEOUT_MS` | Optional timeout for guarded web lyrics fetches |
| `WEB_LYRICS_MAX_BYTES` | Optional max response size for guarded web lyrics fetches |
| `WEB_LYRICS_MAX_REDIRECTS` | Optional redirect cap for guarded web lyrics fetches |
| `TESSIE_API_TOKEN` | Optional, from dash.tessie.com/settings/api — enables Tessie skip command |
| `TESSIE_VIN` | Optional, your Tesla VIN — required when TESSIE_API_TOKEN is set |

## Key backend behaviour

- **Token storage:** Spotify tokens are persisted to `.tokens.json` in the app root. This file must be bind-mounted on the host so tokens survive container restarts. It must be created (`touch`) before the container starts or Docker will create a directory instead.
- **Mode state:** Two independent boolean flags — `isPolling` (lyrics active) and `isVoting` (vote mode active). Toggled via `POST /api/lyrics` and `POST /api/vote-mode`. Any mode change broadcasts `{ type: 'state', isPolling, isVoting }` — this is the only SSE event that drives mode UI on clients. Auto-stops polling after 60 minutes.
- **Song change detection:** Tracks `currentTrackId`; only fetches lyrics and broadcasts SSE when the track ID changes. Resets all votes on track change.
- **Lyrics:** Fetched in this order: `https://lrclib.net/api/get`, Genius (`https://api.genius.com/search` + page scrape via cheerio), Brave Search deterministic page extraction, then Brave Search + GitHub Models extraction when configured. Returns `"Lyrics not found."` if every step fails, and includes `source` plus `usedAiExtraction` in the SSE payload for footer metadata.
- **SSE:** `/events` endpoint. On connect sends: `type:'state'` first, then current content payload, then current vote payload. Heartbeat comment every 30 seconds to keep the Tesla browser connection alive.
- **Voting:** Voters register via `POST /api/voter/register` with a UUID (generated client-side) and a single emoji as their name. Registration rejects with 409 if the emoji is already taken by another active voter. Votes (`skip`/`keep`/`null`) submitted via `POST /api/vote`. After any vote change, a 5-second countdown starts (reset on each new vote); when it fires, skip wins if `skipCount > keepCount`, ties keep playing. If `TESSIE_API_TOKEN` and `TESSIE_VIN` are set, skip uses `POST https://api.tessie.com/api/1/vehicles/{vin}/command/media_next_track`; otherwise falls back to Spotify `POST /v1/me/player/next`.
- **Voter lifecycle:** Each voter has a `lastSeen` timestamp updated on register, vote, and heartbeat. Voters inactive for 30 minutes are excluded from vote counts and cleaned up every 5 minutes. The remote page sends a heartbeat every 20 seconds.
- **PIN protection:** `POST /pin` validates the PIN and sets an HMAC-signed cookie. All API routes return `{ pinRequired: true }` on 401 when unauthenticated. The `/remote` page is served without PIN so passengers can access it, but all voter API calls return 401 if unauthenticated.

## Key frontend behaviour — main screen (index.html)

- **Controls:** Two circular icon buttons top-right — ♪ Lyrics (toggles polling) and ✌ Vote (toggles vote mode). Both independent. Buttons stay visible above the loading overlay.
- **Font sizing:** Binary search (up to 20 iterations) finds the largest font size between 11px and 28px where all lyrics fit in the container without scrolling. Runs on every SSE update and every `resize` event.
- **Wake Lock:** `navigator.wakeLock.request('screen')` called on load and re-acquired on `visibilitychange`.
- **SSE reconnect:** Auto-reconnects with 3-second backoff on error.
- **Auth check:** On load, calls `GET /api/status`. Shows a login banner if `authenticated` is false. Shows PIN overlay if `pinRequired` is true.
- **Footer metadata:** Bottom footer renders `Artist — Title · <source label>` and appends `· AI extracted` only when `usedAiExtraction` is true.
- **Vote tally:** Fixed bottom-left pill showing voter emojis split across a divider — keep voters (green tint) on the left, skip voters (red tint) on the right. Hidden when vote mode is off.
- **Vote toasts:** Stacking toast notifications for each vote event, each fading out independently after 3 seconds. Rendered above the loader overlay.
- **Skipping state:** When skip wins, tally shows a spinner and "Skipping" text while the API call fires.

## Key frontend behaviour — remote (remote.html)

- **Dark mode:** Always follows system `prefers-color-scheme` — no manual toggle, no localStorage persistence.
- **Emoji picker:** On first visit shows a categorised grid (~300 emoji, 6 categories, 6 columns) to pick an identity emoji. Taken emojis shown at 28% opacity with ✕. Rendered via Twemoji SVGs for consistent cross-platform display.
- **Voter identity:** UUID stored in `localStorage` as `voterSessionId`, emoji stored as `voterName`. Your chip shows large with a "You / Tap to change" label — tap to re-open the picker. Other voters shown as small chips below.
- **Voting:** Skip (✕) and Keep (♥) buttons fill the primary area. Tap again to toggle back to abstain. Buttons and "Voting not enabled" overlay shown when vote mode is off, controlled by `type:'state'` SSE events.
- **Nav:** Compact PREV/NEXT row at the bottom for lyrics page navigation.
- **Heartbeat:** `POST /api/voter/heartbeat` every 20 seconds; auto re-registers if server restarted (404 response).
- **SSE:** Connected to `/events` for live vote state, track title/artist, and mode changes.

## Deployment (Synology NAS)

- NAS folder: `/volume1/docker/tesla-lyrics/`
- Bind mounts: `.env` → `/app/.env` (read-only), `tokens.json` → `/app/.tokens.json`
- Port mapping: `5011` → `5011`
- Restart policy: `unless-stopped`
- First-time auth: visit `http://<NAS_IP>:5011/login` once after container start

### Update procedure

1. Push `master` — GitHub Actions builds and pushes the image to GHCR automatically. Wait for the workflow to go green before proceeding.
2. In Unifi router settings, activate port forward for port **25**.
3. In Synology DSM, enable SSH access.
4. Connect: `ssh MortenMonsted@ds.monsted.org -p 25`
5. Run the update command:
   ```
   sudo docker pull ghcr.io/djoike/tesla-lyrics:latest && sudo docker stop tesla-lyrics && sudo docker rm tesla-lyrics && sudo docker run -d --name tesla-lyrics --restart unless-stopped -p 5011:5011 -v /volume1/docker/tesla-lyrics/.env:/app/.env:ro -v /volume1/docker/tesla-lyrics/tokens.json:/app/.tokens.json ghcr.io/djoike/tesla-lyrics:latest
   ```
6. Disable SSH in DSM.
7. Disable the port 25 forward in the router.

## What NOT to do

- Do not add a build step or TypeScript — the project is intentionally plain JS
- Do not add frontend dependencies beyond Twemoji (CDN) — the Tesla browser has limited compatibility
- Do not add a `docker-compose.yml` — deployment is via Synology Container Manager directly
- Do not commit `.env` or `.tokens.json` — both are in `.gitignore`
- Do not suppress type errors with `as any` or `@ts-ignore`
- Do not change the port without updating `server.js`, `Dockerfile`, `.env`, `README.md`, and this file

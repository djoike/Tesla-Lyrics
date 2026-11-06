# AGENTS.md — Tesla Lyrics

Project context for AI agents working in this repository.

## What this project is

A self-hosted Node.js/Express app that displays Spotify lyrics on a Tesla Model 3 browser in real time, with a family voting system that lets passengers vote to skip the current song from their phones. It polls the Spotify API, fetches lyrics through a multi-step fallback chain, and pushes updates to the browser over Server-Sent Events.

## Stack

- **Runtime:** Node.js 24 (`.nvmrc`), plain JavaScript (no TypeScript, no build step)
- **Backend:** Express.js (`server.js` — single file, no src/ directory)
- **Frontend:** Vanilla HTML/CSS/JS (`public/index.html`, `public/remote.html` — single files)
- **Frontend dependency:** Twemoji (loaded via CDN script tag in both HTML files) — the only allowed frontend dependency
- **Communication:** Server-Sent Events (SSE) from server to browser
- **Container:** Docker image `ghcr.io/djoike/tesla-lyrics`, published by the manual `Release` workflow. It runs on the Synology NAS behind a Cloudflare Tunnel at `https://lyrics.monsted.org`. Same deploy pattern as the sibling projects Recipe, mikromagi.dk, SharedLogin and BudgetApp.

## Project structure

```
server.js              # All backend logic: OAuth, SSE, polling, lyrics fetching, voting
public/index.html      # Main Tesla display: lyrics, controls, vote tally, toasts
public/remote.html     # Phone remote: emoji picker, Skip/Keep vote buttons, nav
deploy/
  Dockerfile             # Node 24 deps stage → alpine + node binary + tini, user app (10001), HEALTHCHECK /api/health
  docker-compose.nas.yml # NAS stack: app (no host port) + cloudflared (profile "tunnel"), named volume "tokens"
  .env.example           # Template for the NAS .env (compose interpolation, never committed)
  deploy-nas.sh          # npm run deploy:nas — CI → Release → SSH pull/up → waits for /api/health version
  nas-env.sh             # npm run deploy:nas-env — fills the NAS .env over SSH, carries over the old setup's values
docs/runbooks/nas-deploy.md  # First-time setup, migration from the old container, update, rollback, logs
.github/workflows/
  ci.yml               # Every push: npm ci, node --check, smoke test of /api/health, bash -n on deploy scripts
  release.yml          # Manual (workflow_dispatch): builds deploy/Dockerfile, pushes latest + sha-*, prunes old versions
.dockerignore          # Keeps .env, .tokens.json and tool folders out of the image
.env.example           # Local development env template
package.json           # Dependencies: express, axios, dotenv, cheerio
package-lock.json      # Lockfile — always commit, used by npm ci in Docker
```

## Port

The app runs on **port 5011** (set via `PORT` env var, default `5011`). On the NAS the port is only exposed inside the compose network; the tunnel route is `http://app:5011`.

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
| `GITHUB_MODELS_MAX_PAGE_CHARS` | Optional, max page characters sent to the model (default `12000`) |
| `GITHUB_MODELS_MAX_RETRY_WAIT_SEC` | Optional, longest `Retry-After` a 429 is retried after, once (default `15`) |
| `WEB_LYRICS_FETCH_TIMEOUT_MS` | Optional timeout for guarded web lyrics fetches |
| `WEB_LYRICS_MAX_BYTES` | Optional max response size for guarded web lyrics fetches |
| `WEB_LYRICS_MAX_REDIRECTS` | Optional redirect cap for guarded web lyrics fetches |
| `TESSIE_API_TOKEN` | Optional, from dash.tessie.com/settings/api — enables Tessie skip command |
| `TESSIE_VIN` | Optional, your Tesla VIN — required when TESSIE_API_TOKEN is set |
| `TOKENS_FILE` | Optional, where Spotify tokens are stored (default `.tokens.json` in the app root; `/app/data/tokens.json` in the image) |
| `APP_VERSION` | Set at image build time to the commit SHA; reported by `/api/health` |
| `CLOUDFLARE_TUNNEL_TOKEN`, `IMAGE` | NAS `.env` only, used by the compose file |

## Key backend behaviour

- **Token storage:** Spotify tokens are persisted to `TOKENS_FILE` (default `.tokens.json`). In the image it is `/app/data/tokens.json`, and on the NAS `/app/data` is the named volume `tesla-lyrics_tokens`. If the volume is lost, visit `/login` once to link Spotify again.
- **Health:** `GET /api/health` returns `{ status: 'ok', version }` without a PIN. It is used by the Docker `HEALTHCHECK`, CI and `deploy-nas.sh`.
- **Mode state:** Two independent boolean flags — `isPolling` (lyrics active) and `isVoting` (vote mode active). Toggled via `POST /api/lyrics` and `POST /api/vote-mode`. Any mode change broadcasts `{ type: 'state', isPolling, isVoting }` — this is the only SSE event that drives mode UI on clients. Auto-stops polling after 60 minutes.
- **Song change detection:** Tracks `currentTrackId`; only fetches lyrics and broadcasts SSE when the track ID changes. Resets all votes on track change.
- **Lyrics:** Fetched in this order: `https://lrclib.net/api/get`, Genius (`https://api.genius.com/search` + page scrape via cheerio), Brave Search deterministic page extraction, then Brave Search + GitHub Models extraction when configured. Returns `"Lyrics not found."` if every step fails, and includes `source` plus `usedAiExtraction` in the SSE payload for footer metadata.
- **AI extraction (GitHub Models):** The model only cleans up a page the code already found; it never searches. Per Brave page:
  - The code's own extraction runs first, and a good result is returned directly.
  - The AI runs only when that extraction found nothing or something weak (`shouldUseAiExtraction`).
  - The prompt gets the page with chrome removed and `<br>` kept as line breaks, cut to `GITHUB_MODELS_MAX_PAGE_CHARS` around the first mention of the track name.
  - The answer must pass `validateAiExtractionOutput`.
  - On a 429, it retries once if `Retry-After` ≤ `GITHUB_MODELS_MAX_RETRY_WAIT_SEC`. Otherwise it skips the AI for the rest of that song, while the code's extraction still runs on later pages.
  - If no page yields a good result, the first weak result from the code is returned before giving up with "Lyrics not found."
  - Don't go back to "always use AI when a token is set": that discarded good results, and a long `Retry-After` stalled the song.
- **SSE:** `/events` endpoint. On connect sends: `type:'state'` first, then current content payload, then current vote payload. Heartbeat comment every 30 seconds to keep the Tesla browser connection alive.
- **Voting:** Voters register via `POST /api/voter/register` with a UUID (generated client-side) and a single emoji as their name. Registration rejects with 409 if the emoji is already taken by another active voter. Votes (`skip`/`keep`/`null`) submitted via `POST /api/vote`. After any vote change, a 5-second countdown starts (reset on each new vote); when it fires, skip wins if `skipCount > keepCount`, ties keep playing. If `TESSIE_API_TOKEN` and `TESSIE_VIN` are set, skip uses `POST https://api.tessie.com/api/1/vehicles/{vin}/command/media_next_track`; otherwise falls back to Spotify `POST /v1/me/player/next`.
- **Voter lifecycle:** Each voter has a `lastSeen` timestamp updated on register, vote, and heartbeat. Voters inactive for 30 minutes are excluded from vote counts and cleaned up every 5 minutes. The remote page sends a heartbeat every 20 seconds.
- **PIN protection:** `POST /pin` validates the PIN and sets an HMAC-signed cookie (`HttpOnly; SameSite=Lax`, plus `Secure` when `X-Forwarded-Proto` is https). Wrong PINs are limited to 10 per client per 15 minutes (key: `CF-Connecting-IP`, else the socket address); after that `/pin` returns 429. All API routes return `{ pinRequired: true }` on 401 when unauthenticated. `/login` and `/callback` redirect to `/` without the PIN: `/login` wipes the tokens and `/callback` stores whichever Spotify account returns. The `/remote` page is served without the PIN so passengers can access it, but all voter API calls return 401 if unauthenticated.

## Key frontend behaviour — main screen (index.html)

- **Controls:** Two circular icon buttons top-right — ♪ Lyrics (toggles polling) and ✌ Vote (toggles vote mode). Both independent. Buttons stay visible above the loading overlay.
- **Text sizing and pagination:** The lyrics font is **fixed** at `30px` on `#lyrics-inner`. Nothing searches for a font size. Instead `buildPages()` binary-searches how many *lines* fit per page, growing the slice while `lyricsInner.offsetHeight <= lyricsContainer.clientHeight`, then starts a new page. Songs with `>= 20` lines (`TWO_COL_THRESHOLD`) render in two columns. `LINES_PER_PAGE = 29` is only a fallback for when `clientHeight` is `0`. Pagination runs on SSE content updates; there is **no `resize` listener**.
- **Tesla browser scale compensation:** Tesla software `2026.26` (Summer Update, Chromium 140 → 148) raised the in-car browser's default zoom — `devicePixelRatio` went `1.0` → `~1.53` on the same 1920×1200 panel, shrinking the CSS canvas to `~1254×784` and painting every CSS pixel ~1.53× larger. Tesla exposes no user zoom control. An inline script in `<head>` undoes it: when `dpr > 1.01` **and** `screen.width/height × dpr` matches the 1920×1200 panel (±40px), it sets `zoom: 1/dpr` on `<html>`, gives the root an explicit `innerWidth × dpr` / `innerHeight × dpr` canvas, and repoints the `--vw` / `--vh` custom properties at that canvas. The explicit size and the custom properties are **required** — `zoom` alone leaves `height: 100%` and `vw`/`vh` resolving against the un-zoomed viewport, which collapses the layout into ~65% of the panel. Anything viewport-relative in the stylesheet must use `calc(var(--vw) * N)` / `calc(var(--vh) * N)` rather than `Nvw` / `Nvh`. The whole block is a no-op on phones, retina laptops and pre-update cars.
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

## Deployment (Synology NAS + Cloudflare Tunnel)

Full runbook: `docs/runbooks/nas-deploy.md`. When walking the owner through it, give **one step at a time**.

- **Site:** `https://lyrics.monsted.org` (remote: `/remote`). Cloudflare Tunnel `tesla-lyrics`, route `lyrics.monsted.org → http://app:5011`.
- **NAS folder:** `/volume1/docker/tesla-lyrics/compose`, holding `docker-compose.yml` (a copy of `deploy/docker-compose.nas.yml`) and `.env` (mode 600). Compose project: `tesla-lyrics`.
- **No host port.** The router's 5011 forward was closed for good in 2026-11, after the recently disclosed vulnerabilities. The old address `http://ds.monsted.org:5011` and the old single `docker run` container `tesla-lyrics` (with `.env` and `tokens.json` in `/volume1/docker/tesla-lyrics/`) are retired. `ds.monsted.org` still points at the home IP for SSH; don't route it through the tunnel.
- **Spotify redirect URI:** `https://lyrics.monsted.org/callback`. Spotify only accepts HTTPS or loopback, so use `http://127.0.0.1:5011/callback` for local development.
- **GitHub secrets for Release:** `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` (authenticated base-image pulls).

### Update procedure

1. Push `master`.
2. From the Mac, on the home network, with SSH enabled in DSM: `npm run deploy:nas`. It waits for CI, reuses or starts a Release, asks for the NAS password once, pulls, restarts and waits until `/api/health` reports the commit. `--prepare` does only the GitHub part.
3. If `deploy/docker-compose.nas.yml` changed, copy it to the NAS first (runbook "Update").

Rollback: pin `IMAGE=ghcr.io/djoike/tesla-lyrics:sha-<short7>` in the NAS `.env`, then `docker compose --profile tunnel up -d`.

## What NOT to do

- Do not add a build step or TypeScript — the project is intentionally plain JS
- Do not add frontend dependencies beyond Twemoji (CDN) — the Tesla browser has limited compatibility
- Do not publish a host port in `deploy/docker-compose.nas.yml`: the tunnel is the only way in
- Do not give `PIN_CODE` or `COOKIE_SECRET` defaults in the NAS compose file, and don't exempt `/login` or `/callback` from the PIN
- Do not commit `.env` or `.tokens.json` — both are in `.gitignore`
- Do not suppress type errors with `as any` or `@ts-ignore`
- Do not change the port without updating `server.js`, `deploy/Dockerfile` (`PORT`, `EXPOSE`, `HEALTHCHECK`), `deploy/docker-compose.nas.yml`, the tunnel route, `.github/workflows/ci.yml`, `.env`, `README.md`, the runbook, and this file

## Gotchas

- Copying files from macOS with `tar` adds `._*` files unless `COPYFILE_DISABLE=1`.
- Over a one-line `ssh host 'sudo docker …'`, Synology's sudo doesn't find `docker`. Run it in an interactive SSH session, or use `/usr/local/bin/docker`.
- Deleting and recreating a DNS record makes resolvers cache NXDOMAIN for 30 min (Cloudflare SOA minimum). Edit records in place instead.

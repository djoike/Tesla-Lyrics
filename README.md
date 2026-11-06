# Tesla Lyrics

A self-hosted Node.js app that displays Spotify lyrics on your Tesla Model 3 browser in real time.

## How it Works

The server polls Spotify every 5 seconds while active, fetches lyrics whenever the track changes, and pushes updates to the browser over Server-Sent Events. The fallback order is [LRCLIB](https://lrclib.net), Genius, Brave Search with deterministic page extraction, then Brave Search with GitHub Models extraction when configured. The frontend renders lyrics at a fixed size and splits them into full-screen pages so nothing ever scrolls — longer songs switch to two columns, and you page through them with PREV/NEXT on the remote. It also uses the Wake Lock API to prevent the Tesla display from sleeping, and shows the current artist, title, source label, and AI extraction status in the footer.

---

## Setup

### 1. Create a Spotify Developer App

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and create a new app.
2. In the app settings, add a **Redirect URI** for each place the app runs: `https://lyrics.monsted.org/callback` for the NAS, `http://127.0.0.1:5011/callback` for local development. Spotify only accepts HTTPS, or a loopback address.
3. Copy your **Client ID** and **Client Secret**.

> **Important:** The `REDIRECT_URI` in your `.env` must match exactly what you registered in the Spotify dashboard.

### 2. Get a Genius Access Token (optional but recommended)

Genius is used as a fallback when LRCLIB has no lyrics for a track, significantly improving coverage for mainstream music.

1. Go to [genius.com/api-clients](https://genius.com/api-clients) and create a new API client.
2. Copy the **Client Access Token**.
3. Add it to your `.env` as `GENIUS_ACCESS_TOKEN`.

If the token is not set, the app will still work with LRCLIB and any web fallback config you provide.

### 3. Add Brave Search and GitHub Models config (optional)

Brave Search powers the web fallback stages after LRCLIB and Genius miss. GitHub Models is only used for the final AI extraction step.

- `BRAVE_SEARCH_API_KEY` enables Brave Search candidate lookup.
- `GITHUB_TOKEN` enables GitHub Models extraction.
- `GITHUB_MODELS_MODEL` defaults to `gpt-4.1-mini` if you leave it unset.
- `BRAVE_SEARCH_API_BASE_URL` and `GITHUB_MODELS_API_BASE_URL` let you point at compatible endpoints for testing.
- `WEB_LYRICS_FETCH_TIMEOUT_MS`, `WEB_LYRICS_MAX_BYTES`, and `WEB_LYRICS_MAX_REDIRECTS` tune the guarded web fetch.

If `BRAVE_SEARCH_API_KEY` is missing, the app stops after the Genius fallback. If `GITHUB_TOKEN` is missing, the AI extraction step is skipped and only deterministic web extraction is used. When it is set, the AI only steps in for pages where the code's own extraction found nothing or something weak. It gets at most 12,000 characters of the page, and gives up for the song rather than wait out a long rate limit.

---

## Deployment (Synology NAS + Cloudflare Tunnel)

Same setup as the sibling projects (Recipe, mikromagi.dk, SharedLogin, BudgetApp):

- **Image:** [`deploy/Dockerfile`](deploy/Dockerfile) builds `ghcr.io/djoike/tesla-lyrics`. It runs as a non-root user and has a health check on `/api/health`.
- **CI:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs a syntax check and a smoke test on every push.
- **Release:** [`.github/workflows/release.yml`](.github/workflows/release.yml) publishes the image. It is started by hand or by the deploy script, never by a push. Tags: `latest`, `sha-<commit>`.
- **Stack:** [`deploy/docker-compose.nas.yml`](deploy/docker-compose.nas.yml) runs the app plus `cloudflared` in `/volume1/docker/tesla-lyrics/compose`. There is no host port; the site is `https://lyrics.monsted.org`. The Spotify tokens live in the Docker volume `tokens`.
- **Deploy:** push, then `npm run deploy:nas` ([`deploy/deploy-nas.sh`](deploy/deploy-nas.sh)). It waits for CI, builds a Release, pulls and restarts on the NAS, then waits until the site reports the new commit.
- **NAS `.env`:** `npm run deploy:nas-env` ([`deploy/nas-env.sh`](deploy/nas-env.sh)) fills it in over SSH.

First-time setup, moving over from the old `docker run` container, rollback and logs: [docs/runbooks/nas-deploy.md](docs/runbooks/nas-deploy.md).

---

## Running Locally (without Docker)

```bash
npm install
node server.js
```

Copy `.env.example` to `.env` and fill it in, with `REDIRECT_URI=http://127.0.0.1:5011/callback`. Open `http://127.0.0.1:5011`, enter the PIN, then visit `http://127.0.0.1:5011/login` to link Spotify. `/login` needs the PIN first.

---

## Usage

1. Open `https://lyrics.monsted.org` in your Tesla browser (or bookmark it) and enter the PIN once.
2. Tap the **♪ Lyrics** button to start polling. Play a song on Spotify — lyrics appear within 5 seconds.
3. Tap **♪ Lyrics** again to stop. Polling also auto-stops after 1 hour.
4. Tap the **✌ Vote** button to enable the family voting system independently of lyrics.

### Remote voting

Passengers open `https://lyrics.monsted.org/remote` on their phones. On first visit they pick an emoji as their identity. Once voting is enabled from the main screen, Skip and Keep buttons become active. After a 5-second countdown from the last vote, skip wins if more people voted skip than keep — otherwise the song plays on.

If `TESSIE_API_TOKEN` and `TESSIE_VIN` are set, the skip command goes directly to the car via Tessie. Otherwise it falls back to the Spotify API.

---

## Project Structure

```
.
├── server.js          # Express server: OAuth, SSE, Spotify polling, lyrics, voting
├── public/
│   ├── index.html     # Tesla display: lyrics, controls, vote tally, toasts
│   └── remote.html    # Phone remote: emoji picker, vote buttons, PREV/NEXT nav
├── deploy/
│   ├── Dockerfile               # Production image (non-root, health check)
│   ├── docker-compose.nas.yml   # NAS stack: app + cloudflared
│   ├── .env.example             # Template for the NAS .env
│   ├── deploy-nas.sh            # npm run deploy:nas
│   └── nas-env.sh               # npm run deploy:nas-env
├── docs/runbooks/nas-deploy.md  # Setup, update, rollback
├── .github/workflows/           # ci.yml, release.yml
├── package.json
├── .env.example
└── .gitignore
```

---

## Notes

- Tokens are stored in `TOKENS_FILE`, which defaults to `.tokens.json` locally (git-ignored, never commit it). On the NAS they are in the Docker volume `tokens`.
- The site is on the internet behind Cloudflare. `/login` and `/callback` need the PIN, and wrong PINs are limited to 10 per client per 15 minutes.
- Lyrics are fetched from [LRCLIB](https://lrclib.net) first, then Genius, Brave Search page extraction, and optional GitHub Models extraction. If every step misses, the UI shows "Lyrics not found."
- The Tesla Model 3 browser does not support all modern APIs. The app is intentionally built with minimal frontend dependencies (Twemoji via CDN only) to maximize compatibility.
- Tesla software `2026.26` (Summer Update) increased the in-car browser's default zoom, which made every website render about 50% larger with no way to zoom back out. The display page detects this and compensates automatically, so lyrics keep the same size and line count as before the update. Phones and desktop browsers are unaffected.
- The remote page (`/remote`) loads without the PIN, but all voter API routes still require it. Each phone has to enter the PIN once.
- `TESSIE_API_TOKEN` and `TESSIE_VIN` are optional. Without them the skip falls back to the Spotify API, which may not work when the Tesla is the active playback device.

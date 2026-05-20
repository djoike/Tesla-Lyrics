# Tesla Lyrics

A self-hosted Node.js app that displays Spotify lyrics on your Tesla Model 3 browser in real time.

## How it Works

The server polls Spotify every 5 seconds while active, fetches lyrics whenever the track changes, and pushes updates to the browser over Server-Sent Events. The fallback order is [LRCLIB](https://lrclib.net), Genius, Brave Search with deterministic page extraction, then Brave Search with GitHub Models extraction when configured. The frontend auto-sizes all the lyrics text to fill the screen without scrolling, uses the Wake Lock API to prevent the Tesla display from sleeping, and shows the current artist, title, source label, and AI extraction status in the footer.

---

## Setup

### 1. Create a Spotify Developer App

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and create a new app.
2. In the app settings, add a **Redirect URI** matching where you'll run the container, e.g. `http://<YOUR_NAS_IP>:5011/callback`.
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

If `BRAVE_SEARCH_API_KEY` is missing, the app stops after the Genius fallback. If `GITHUB_TOKEN` is missing, the AI extraction step is skipped and only deterministic web extraction is used.

---

## GitHub Actions image publish

This repository uses GitHub Actions to build and publish Docker images to GitHub Container Registry (GHCR).

- Workflow file: `.github/workflows/publish.yml`
- Trigger: push to `master`/`main` or manual dispatch
- Output image: `ghcr.io/<your-github-user>/tesla-lyrics`

After the first publish, open the package in GitHub and set visibility to **public** if Synology should pull without credentials.

## Synology Docker deployment (recommended)

### 1) Prepare NAS files

Create a folder, for example:

- `/volume1/docker/tesla-lyrics/`

Create `/volume1/docker/tesla-lyrics/.env` with:

```env
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
REDIRECT_URI=http://<YOUR_NAS_IP>:5011/callback
PORT=5011
GENIUS_ACCESS_TOKEN=your_genius_access_token
BRAVE_SEARCH_API_KEY=your_brave_search_api_key
GITHUB_TOKEN=your_github_token
GITHUB_MODELS_MODEL=gpt-4.1-mini
BRAVE_SEARCH_API_BASE_URL=https://api.search.brave.com/res/v1/web/search
GITHUB_MODELS_API_BASE_URL=https://models.github.ai/inference
WEB_LYRICS_FETCH_TIMEOUT_MS=10000
WEB_LYRICS_MAX_BYTES=1048576
WEB_LYRICS_MAX_REDIRECTS=3
```

Create the tokens file (must exist before the container starts):

```bash
touch /volume1/docker/tesla-lyrics/tokens.json
```

### 2) Publish image via GitHub Actions

Push to `master`/`main` and let the publish workflow create image tags in GHCR.

Default tags include:

- `latest`
- `sha-<commit>`

### 3) Pull and start the container via SSH

Synology Container Manager's UI cannot authenticate with GHCR directly. Use SSH instead:

```bash
sudo docker pull ghcr.io/djoike/tesla-lyrics:latest && sudo docker run -d \
  --name tesla-lyrics \
  --restart unless-stopped \
  -p 5011:5011 \
  -v /volume1/docker/tesla-lyrics/.env:/app/.env:ro \
  -v /volume1/docker/tesla-lyrics/tokens.json:/app/.tokens.json \
  ghcr.io/djoike/tesla-lyrics:latest
```

### 4) Authenticate with Spotify

Open `http://<YOUR_NAS_IP>:5011/login` in any browser and complete the Spotify login. Tokens are written to `tokens.json` on the NAS and persist across container restarts — you only need to do this once.

### 5) Verify

- Open container logs in Container Manager and confirm the server started on port 5011.
- Open `http://<YOUR_NAS_IP>:5011` in your Tesla browser, tap **Start**, and play a song.

### Updating

Synology's UI cannot pull updated images from GHCR. After pushing new code and the GitHub Actions workflow completes, run this single command via SSH to pull the new image and recreate the container:

```bash
sudo docker pull ghcr.io/djoike/tesla-lyrics:latest && sudo docker stop tesla-lyrics && sudo docker rm tesla-lyrics && sudo docker run -d \
  --name tesla-lyrics \
  --restart unless-stopped \
  -p 5011:5011 \
  -v /volume1/docker/tesla-lyrics/.env:/app/.env:ro \
  -v /volume1/docker/tesla-lyrics/tokens.json:/app/.tokens.json \
  ghcr.io/djoike/tesla-lyrics:latest
```

> Note: `docker restart` alone is not enough — the container must be recreated to pick up the new image.

Then in Container Manager, select the `tesla-lyrics` container → **Action → Restart**.

---

## Running Locally (without Docker)

```bash
npm install
node server.js
```

Then visit `http://localhost:5011/login` to authenticate.

---

## Usage

1. Open `http://<server-ip>:5011` in your Tesla browser (or bookmark it).
2. Tap **Start** to begin polling. Play a song on Spotify — the lyrics will appear within 5 seconds.
3. Tap **Stop** when you're done. Polling also auto-stops after 1 hour to avoid rate limits.
4. The green dot in the top-right indicates polling is active.

---

## Project Structure

```
.
├── server.js          # Express server: OAuth, SSE, Spotify polling, lyrics
├── public/
│   └── index.html     # Tesla-optimized frontend (vanilla HTML/CSS/JS)
├── Dockerfile
├── package.json
├── .env.example
└── .gitignore
```

---

## Notes

- Tokens are stored in `.tokens.json` — this file is git-ignored and must never be committed.
- Lyrics are fetched from [LRCLIB](https://lrclib.net) first, then Genius, Brave Search page extraction, and optional GitHub Models extraction. If every step misses, the UI shows "Lyrics not found."
- The Tesla Model 3 browser does not support all modern APIs. The app is intentionally built with zero frontend dependencies to maximize compatibility.

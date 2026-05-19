# Tesla Lyrics

A self-hosted Node.js app that displays Spotify lyrics on your Tesla Model 3 browser in real time.

## How it Works

The server polls Spotify every 5 seconds while active, fetches lyrics from [LRCLIB](https://lrclib.net) whenever the track changes, and pushes updates to the browser over Server-Sent Events. The frontend auto-sizes all the lyrics text to fill the screen without scrolling, and uses the Wake Lock API to prevent the Tesla display from sleeping.

---

## Setup

### 1. Create a Spotify Developer App

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and create a new app.
2. In the app settings, add a **Redirect URI** matching where you'll run the container, e.g. `http://<YOUR_NAS_IP>:5011/callback`.
3. Copy your **Client ID** and **Client Secret**.

> **Important:** The `REDIRECT_URI` in your `.env` must match exactly what you registered in the Spotify dashboard.

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

### 3) Create container in Synology Container Manager

- Image: `ghcr.io/<your-github-user>/tesla-lyrics:latest`
- Ports: `5011` → `5011`
- Mounts:
  - `/volume1/docker/tesla-lyrics/.env` → `/app/.env` (read-only)
  - `/volume1/docker/tesla-lyrics/tokens.json` → `/app/.tokens.json`
- Restart policy: `unless-stopped`

### 4) Authenticate with Spotify

Open `http://<YOUR_NAS_IP>:5011/login` in any browser and complete the Spotify login. Tokens are written to `tokens.json` on the NAS and persist across container restarts — you only need to do this once.

### 5) Verify

- Open container logs in Container Manager and confirm the server started on port 5011.
- Open `http://<YOUR_NAS_IP>:5011` in your Tesla browser, tap **Start**, and play a song.

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
- Lyrics are sourced from [LRCLIB](https://lrclib.net), a free, no-auth lyrics API. If a song has no lyrics entry, the UI shows "Lyrics not found."
- The Tesla Model 3 browser does not support all modern APIs. The app is intentionally built with zero frontend dependencies to maximize compatibility.

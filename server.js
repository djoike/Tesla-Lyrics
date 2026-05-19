'use strict';

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { URLSearchParams } = require('url');
const { load: cheerioLoad } = require('cheerio');

const app = express();
const PORT = process.env.PORT || 5011;

// ─── Token Store ────────────────────────────────────────────────────────────
const TOKEN_FILE = path.join(__dirname, '.tokens.json');

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    }
  } catch (_) {}
  return { access_token: null, refresh_token: null };
}

function saveTokens(tokens) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist tokens:', err.message);
  }
}

let tokens = loadTokens();

// ─── Polling State ───────────────────────────────────────────────────────────
let isPolling = false;
let pollingTimer = null;      // 1-hour auto-stop timeout
let pollInterval = null;      // setInterval handle
let currentTrackId = null;
let currentPayload = null;    // last broadcasted payload (for new SSE clients)

const ONE_HOUR_MS = 60 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

// ─── SSE Clients ─────────────────────────────────────────────────────────────
const sseClients = new Set();

function broadcast(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(message);
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

// ─── Spotify Helpers ─────────────────────────────────────────────────────────
async function refreshAccessToken() {
  if (!tokens.refresh_token) throw new Error('No refresh token available. Please log in.');

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  });

  const credentials = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString('base64');

  const response = await axios.post('https://accounts.spotify.com/api/token', params.toString(), {
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  tokens.access_token = response.data.access_token;
  if (response.data.refresh_token) {
    tokens.refresh_token = response.data.refresh_token;
  }
  saveTokens(tokens);
  console.log('Access token refreshed.');
}

async function spotifyGet(url) {
  if (!tokens.access_token) throw new Error('Not authenticated.');

  try {
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    return res;
  } catch (err) {
    if (err.response && err.response.status === 401) {
      await refreshAccessToken();
      return axios.get(url, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
    }
    throw err;
  }
}

// ─── Lyrics Fetching (LRCLIB → Genius fallback) ─────────────────────────────
async function fetchLyricsLrclib(trackName, artistName, albumName, durationSec) {
  try {
    const res = await axios.get('https://lrclib.net/api/get', {
      params: {
        track_name: trackName,
        artist_name: artistName,
        album_name: albumName,
        duration: durationSec,
      },
      timeout: 8000,
    });
    const plain = res.data.plainLyrics || null;
    if (plain) return plain;
  } catch (err) {
    if (!err.response || err.response.status !== 404) {
      console.error('LRCLIB error:', err.message);
    }
  }
  return null;
}

async function fetchLyricsGenius(trackName, artistName) {
  if (!process.env.GENIUS_ACCESS_TOKEN) return null;

  try {
    const searchRes = await axios.get('https://api.genius.com/search', {
      params: { q: `${trackName} ${artistName}` },
      headers: { Authorization: `Bearer ${process.env.GENIUS_ACCESS_TOKEN}` },
      timeout: 8000,
    });

    const hits = searchRes.data.response.hits;
    if (!hits || hits.length === 0) return null;

    const match = hits.find((h) => {
      const t = h.result;
      return (
        t.title.toLowerCase().includes(trackName.toLowerCase()) ||
        trackName.toLowerCase().includes(t.title.toLowerCase())
      );
    }) || hits[0];

    const pageUrl = match.result.url;

    const pageRes = await axios.get(pageUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; tesla-lyrics/1.0)',
      },
    });

    const $ = cheerioLoad(pageRes.data);

    $('script').remove();
    $('style').remove();

    const containers = $('[class*="Lyrics__Container"], [data-lyrics-container="true"]');
    if (containers.length === 0) return null;

    const lines = [];
    containers.each((_i, el) => {
      $(el).find('br').replaceWith('\n');
      const text = $(el).text().trim();
      if (text) lines.push(text);
    });

    const lyrics = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return lyrics || null;
  } catch (err) {
    console.error('Genius error:', err.message);
    return null;
  }
}

async function fetchLyrics(trackName, artistName, albumName, durationSec) {
  const lrclibResult = await fetchLyricsLrclib(trackName, artistName, albumName, durationSec);
  if (lrclibResult) {
    console.log(`Lyrics source: LRCLIB`);
    return { lyrics: lrclibResult, source: 'LRCLIB' };
  }

  console.log(`LRCLIB miss — trying Genius for: ${artistName} – ${trackName}`);
  const geniusResult = await fetchLyricsGenius(trackName, artistName);
  if (geniusResult) {
    console.log(`Lyrics source: Genius`);
    return { lyrics: geniusResult, source: 'Genius' };
  }

  return { lyrics: 'Lyrics not found.', source: null };
}

// ─── Core Poll Tick ──────────────────────────────────────────────────────────
async function pollSpotify() {
  try {
    const res = await spotifyGet('https://api.spotify.com/v1/me/player/currently-playing');

    // 204 = nothing playing, 200 = data
    if (res.status === 204 || !res.data || !res.data.item) {
      if (currentTrackId !== null) {
        currentTrackId = null;
        currentPayload = {
          status: 'idle',
          title: null,
          artist: null,
          album: null,
          albumArt: null,
          lyrics: 'Nothing is playing.',
          isPolling,
        };
        broadcast(currentPayload);
      }
      return;
    }

    const track = res.data.item;
    const trackId = track.id;

    if (trackId === currentTrackId) return; // Same song, no update needed

    currentTrackId = trackId;
    const trackName = track.name;
    const artistName = track.artists.map((a) => a.name).join(', ');
    const albumName = track.album ? track.album.name : '';
    const albumArt = track.album && track.album.images && track.album.images.length
      ? track.album.images[0].url
      : null;
    const durationSec = Math.round((track.duration_ms || 0) / 1000);

    console.log(`Now playing: ${artistName} – ${trackName}`);

    const { lyrics, source } = await fetchLyrics(trackName, artistName, albumName, durationSec);

    currentPayload = {
      status: 'playing',
      title: trackName,
      artist: artistName,
      album: albumName,
      albumArt,
      lyrics,
      source,
      isPolling,
    };
    broadcast(currentPayload);
  } catch (err) {
    // Don't crash the poller on transient errors
    console.error('Poll error:', err.message);
  }
}

// ─── Polling Control ─────────────────────────────────────────────────────────
function startPolling() {
  if (isPolling) return;
  isPolling = true;
  console.log('Polling started.');

  // Kick off immediately, then every 5 s
  pollSpotify();
  pollInterval = setInterval(pollSpotify, POLL_INTERVAL_MS);

  // Auto-stop after 1 hour
  pollingTimer = setTimeout(() => {
    console.log('1-hour timeout reached. Stopping polling automatically.');
    stopPolling();
    broadcast({ status: 'timeout', isPolling: false });
  }, ONE_HOUR_MS);
}

function stopPolling() {
  if (!isPolling) return;
  isPolling = false;
  clearInterval(pollInterval);
  clearTimeout(pollingTimer);
  pollInterval = null;
  pollingTimer = null;
  currentTrackId = null;
  console.log('Polling stopped.');
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// OAuth – Step 1: redirect to Spotify
app.get('/login', (_req, res) => {
  const scope = 'user-read-currently-playing';
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope,
    redirect_uri: process.env.REDIRECT_URI,
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

// OAuth – Step 2: handle callback
app.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.status(400).send(`Spotify auth error: ${error || 'No code returned.'}`);
  }

  const params = new URLSearchParams({
    code,
    redirect_uri: process.env.REDIRECT_URI,
    grant_type: 'authorization_code',
  });

  const credentials = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString('base64');

  try {
    const response = await axios.post('https://accounts.spotify.com/api/token', params.toString(), {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    tokens.access_token = response.data.access_token;
    tokens.refresh_token = response.data.refresh_token;
    saveTokens(tokens);

    console.log('Spotify authentication successful.');
    res.redirect('/');
  } catch (err) {
    console.error('Token exchange failed:', err.response?.data || err.message);
    res.status(500).send('Token exchange failed. Check server logs.');
  }
});

// SSE endpoint
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Important for nginx proxies
  res.flushHeaders();

  sseClients.add(res);

  // Send current state immediately to new client
  const initialPayload = currentPayload
    ? { ...currentPayload, isPolling }
    : { status: 'idle', title: null, artist: null, album: null, albumArt: null, lyrics: 'Start polling to load lyrics.', isPolling };
  res.write(`data: ${JSON.stringify(initialPayload)}\n\n`);

  // Heartbeat every 30 s to keep connection alive through Tesla's browser
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (_) {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// Start/Stop polling API
app.post('/api/start', (_req, res) => {
  if (!tokens.access_token && !tokens.refresh_token) {
    return res.status(401).json({ error: 'Not authenticated. Visit /login first.' });
  }
  startPolling();
  broadcast({ status: 'polling_started', isPolling: true });
  res.json({ isPolling: true });
});

app.post('/api/stop', (_req, res) => {
  stopPolling();
  broadcast({ status: 'polling_stopped', isPolling: false });
  res.json({ isPolling: false });
});

// Status endpoint
app.get('/api/status', (_req, res) => {
  res.json({
    isPolling,
    authenticated: !!(tokens.access_token || tokens.refresh_token),
    currentTrack: currentPayload
      ? { title: currentPayload.title, artist: currentPayload.artist }
      : null,
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Tesla Lyrics server running on http://localhost:${PORT}`);
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    console.warn('WARNING: SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET is not set. Check your .env file.');
  }
});

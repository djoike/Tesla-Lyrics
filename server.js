'use strict';

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const dns = require('dns').promises;
const { URL, URLSearchParams } = require('url');
const { load: cheerioLoad } = require('cheerio');

const app = express();
const PORT = process.env.PORT || 5011;
const PIN_CODE = process.env.PIN_CODE || '290585';
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'tesla-lyrics-secret';
const COOKIE_NAME = 'tl_auth';
const AUTH_COOKIE_MAX_AGE = 31536000;
const INDEX_FILE = path.join(__dirname, 'public/index.html');
const REMOTE_FILE = path.join(__dirname, 'public/remote.html');
const WEB_LYRICS_CONFIG = {
  braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY || null,
  githubToken: process.env.GITHUB_TOKEN || null,
  braveSearchApiBaseUrl: process.env.BRAVE_SEARCH_API_BASE_URL || 'https://api.search.brave.com/res/v1/web/search',
  githubModelsApiBaseUrl: process.env.GITHUB_MODELS_API_BASE_URL || 'https://models.github.ai/inference',
  fetchTimeoutMs: Number.parseInt(process.env.WEB_LYRICS_FETCH_TIMEOUT_MS || '10000', 10),
  aiTimeoutMs: Number.parseInt(process.env.GITHUB_MODELS_TIMEOUT_MS || '45000', 10),
  maxBytes: Number.parseInt(process.env.WEB_LYRICS_MAX_BYTES || '1048576', 10),
  maxRedirects: Number.parseInt(process.env.WEB_LYRICS_MAX_REDIRECTS || '3', 10),
};

function createAuthCookieValue() {
  return crypto.createHmac('sha256', COOKIE_SECRET).update('authenticated').digest('hex');
}

function parseCookies(cookieHeader) {
  return (cookieHeader || '').split(';').reduce((cookies, pair) => {
    const trimmedPair = pair.trim();
    if (!trimmedPair) return cookies;

    const separatorIndex = trimmedPair.indexOf('=');
    if (separatorIndex === -1) return cookies;

    const name = trimmedPair.slice(0, separatorIndex).trim();
    const value = trimmedPair.slice(separatorIndex + 1).trim();
    cookies[name] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function hasValidPinCookie(req) {
  const cookies = parseCookies(req.headers.cookie);
  const cookieValue = cookies[COOKIE_NAME];
  if (!cookieValue) return false;

  const expectedValue = createAuthCookieValue();
  const cookieBuffer = Buffer.from(cookieValue);
  const expectedBuffer = Buffer.from(expectedValue);

  if (cookieBuffer.length !== expectedBuffer.length) return false;

  try {
    return crypto.timingSafeEqual(cookieBuffer, expectedBuffer);
  } catch (_) {
    return false;
  }
}

function setAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${createAuthCookieValue()}; Path=/; HttpOnly; Max-Age=${AUTH_COOKIE_MAX_AGE}`);
}

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
let pollGeneration = 0;

// ─── Voter State ─────────────────────────────────────────────────────────────
const voters = new Map(); // id → { name, vote, lastSeen }
let skipCountdownTimer = null;
const SKIP_COUNTDOWN_MS = 5000;
const VOTER_INACTIVE_MS = 30 * 60 * 1000;   // 30 min
const VOTER_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

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

function broadcastLog(msg, level = 'ok') {
  broadcast({ type: 'log', level, msg });
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

async function spotifyPost(url, body = null) {
  if (!tokens.access_token) throw new Error('Not authenticated.');

  const makeConfig = () => ({
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      'Content-Type': 'application/json',
    },
  });

  try {
    const res = await axios.post(url, body, makeConfig());
    return res;
  } catch (err) {
    if (err.response && err.response.status === 401) {
      await refreshAccessToken();
      return axios.post(url, body, makeConfig());
    }
    throw err;
  }
}

// ─── Voter Helpers ────────────────────────────────────────────────────────────
function getActiveVoters() {
  const cutoff = Date.now() - VOTER_INACTIVE_MS;
  return [...voters.values()].filter((v) => v.lastSeen >= cutoff);
}

function buildVotePayload(toast = null) {
  const active = getActiveVoters();
  const skipCount = active.filter((v) => v.vote === 'skip').length;
  const keepCount = active.filter((v) => v.vote === 'keep').length;
  return {
    type: 'vote',
    voters: active.map((v) => ({ name: v.name, vote: v.vote })),
    skipCount,
    keepCount,
    toast,
  };
}

function broadcastVoteState(toast = null) {
  broadcast(buildVotePayload(toast));
}

function resetVotes() {
  clearTimeout(skipCountdownTimer);
  skipCountdownTimer = null;
  for (const v of voters.values()) {
    v.vote = null;
  }
}

async function evaluateAndSkip() {
  const active = getActiveVoters();
  const skipCount = active.filter((v) => v.vote === 'skip').length;
  const keepCount = active.filter((v) => v.vote === 'keep').length;
  if (skipCount > keepCount) {
    console.log(`Vote: skip wins ${skipCount}–${keepCount}. Skipping track.`);
    resetVotes();
    broadcastVoteState(null);
    try {
      await spotifyPost('https://api.spotify.com/v1/me/player/next');
    } catch (err) {
      console.error('Vote: skip API error:', err.message);
    }
  } else {
    console.log(`Vote: keep wins or tie ${keepCount}–${skipCount}. Song continues.`);
  }
}

function startSkipCountdown() {
  clearTimeout(skipCountdownTimer);
  skipCountdownTimer = setTimeout(evaluateAndSkip, SKIP_COUNTDOWN_MS);
}

setInterval(() => {
  const cutoff = Date.now() - VOTER_INACTIVE_MS;
  for (const [id, v] of voters.entries()) {
    if (v.lastSeen < cutoff) voters.delete(id);
  }
}, VOTER_CLEANUP_INTERVAL_MS);

// ─── Lyrics Fetching (LRCLIB → Genius fallback) ─────────────────────────────
function createLyricsResult(lyrics, source, usedAiExtraction = false) {
  return {
    lyrics,
    source,
    usedAiExtraction,
  };
}

function createSourceLabelFromUrl(rawUrl) {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
    return hostname ? hostname.slice(0, 48) : null;
  } catch (_) {
    return null;
  }
}

function isWeakDeterministicLyricsExtraction(lyrics) {
  if (typeof lyrics !== 'string') return true;

  const cleaned = normalizeLyricsCandidateText(lyrics);
  if (!cleaned) return true;

  const lines = cleaned.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return true;

  const charCount = cleaned.replace(/\s+/g, '').length;
  if (charCount < 40) return true;

  const avgLineLength = charCount / lines.length;
  if (avgLineLength > 220) return true;

  const boilerplatePatterns = [
    /^(lyrics|share|embed|read more|see all|translations?|contributors?|credits?)$/i,
    /^(written by|produced by|release date|track list|album|comments?)$/i,
  ];

  return lines.some((line) => boilerplatePatterns.some((pattern) => pattern.test(line)));
}

function normalizeLyricsCandidateText(text) {
  return normalizeCandidatePageText(String(text || ''));
}

function removeLyricsBoilerplate(text) {
  const boilerplatePatterns = [
    /^(you might also like|lyrics|share|embed|read more|see all|translations?|contributors?|credits?)$/i,
    /^(written by|produced by|release date|track list|album|comments?)$/i,
  ];

  const lines = normalizeLyricsCandidateText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !boilerplatePatterns.some((pattern) => pattern.test(line)));

  return normalizeLyricsCandidateText(lines.join('\n'));
}

function termIncluded(text, term) {
  const needle = String(term || '').toLowerCase().replace(/[^a-z\u00C0-\u024F0-9]+/g, ' ').trim();
  if (!needle) return false;
  return text.toLowerCase().includes(needle);
}

function scoreLyricsBlock(text, trackName, artistName, pageTitle) {
  const cleaned = removeLyricsBoilerplate(text);
  if (!cleaned) return null;

  const lines = cleaned.split('\n').map((line) => line.trim()).filter(Boolean);
  const lineCount = lines.length;
  const charCount = cleaned.replace(/\s+/g, '').length;

  if (lineCount < 4) return null;

  const shortLineCount = lines.filter((line) => line.length <= 80).length;
  if (charCount < 80 && shortLineCount / lineCount < 0.75) return null;

  const avgLineLength = charCount / lineCount;
  if (avgLineLength > 180) return null;

  const blankLineBlocks = cleaned.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const verseLikeLineCount = lines.filter((line) => /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(line) && line.length <= 110).length;
  const newlineDensity = (cleaned.match(/\n/g) || []).length / Math.max(charCount, 1);

  let score = 0;
  score += Math.min(lineCount, 40) * 2;
  score += Math.min(blankLineBlocks.length, 5) * 4;
  score += Math.min(newlineDensity * 1000, 20);
  score += Math.min(shortLineCount / lineCount, 1) * 10;
  score += Math.min(verseLikeLineCount / lineCount, 1) * 8;

  if (avgLineLength <= 45) score += 10;
  else if (avgLineLength <= 70) score += 7;
  else if (avgLineLength <= 100) score += 2;
  else score -= 8;

  if (lineCount >= 10) score += 4;
  if (lineCount >= 18) score += 4;
  if (lineCount > 80) score -= 6;

  if (trackName && termIncluded(cleaned, trackName)) score += 5;
  if (artistName && termIncluded(cleaned, artistName)) score += 5;
  if (pageTitle && termIncluded(pageTitle, trackName) && termIncluded(pageTitle, artistName)) score += 3;

  const noisyTokens = [
    'privacy policy',
    'terms of service',
    'cookie',
    'subscribe',
    'newsletter',
    'sign up',
    'follow us',
    'advertisement',
    'copyright',
  ];
  const noiseHits = noisyTokens.reduce((count, token) => count + (cleaned.toLowerCase().includes(token) ? 1 : 0), 0);
  score -= noiseHits * 10;

  return { cleaned, score };
}

function extractDeterministicLyricsFromPage(pageResult, trackName, artistName) {
  if (!pageResult || pageResult.status !== 'ok') return null;

  const $ = pageResult.document || cheerioLoad(pageResult.html || '');
  $('script, style, nav, footer, form, header, aside, noscript, iframe, svg, canvas, button, input, select, option').remove();

  const pageTitle = normalizeLyricsCandidateText(
    $('title').first().text() || $('meta[property="og:title"]').attr('content') || ''
  );

  const selectors = [
    '[class*="Lyrics__Container"]',
    '[data-lyrics-container="true"]',
    '[class*="lyrics"]',
    'article',
    'main',
    'section',
    'blockquote',
    'div',
    'p',
    'li',
  ];

  const seenTexts = new Set();
  let bestCandidate = null;

  for (const selector of selectors) {
    $(selector).each((_index, el) => {
      $(el).find('br').replaceWith('\n');
      const text = normalizeLyricsCandidateText($(el).text() || '');
      if (!text) return;

      const normalizedKey = text.toLowerCase();
      if (seenTexts.has(normalizedKey)) return;
      seenTexts.add(normalizedKey);

      const candidate = scoreLyricsBlock(text, trackName, artistName, pageTitle);
      if (!candidate || candidate.score < 30) return;

      if (!bestCandidate || candidate.score > bestCandidate.score) {
        bestCandidate = candidate;
      }
    });
  }

  if (!bestCandidate) return null;

  const source = createSourceLabelFromUrl(pageResult.url);
  if (!source) return null;

  return createLyricsResult(bestCandidate.cleaned, source, false);
}

function shouldUseAiExtraction(deterministicResult) {
  if (WEB_LYRICS_CONFIG.githubToken) return true;
  if (!deterministicResult) return true;
  return isWeakDeterministicLyricsExtraction(deterministicResult.lyrics);
}

function validateAiExtractionOutput(rawLyrics) {
  if (typeof rawLyrics !== 'string') return null;

  const normalized = rawLyrics
    .replace(/\r\n/g, '\n')
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (!normalized) return null;
  if (/^(lyrics not found|not enough information|i('?m)? sorry|cannot determine)/i.test(normalized)) {
    return null;
  }

  const lines = normalized.split('\n').map((line) => line.trimEnd());
  if (lines.length < 2) return null;
  if (lines.some((line) => line.length > 220)) return null;

  const candidate = lines.join('\n').trim();
  if (!candidate) return null;

  const nonEmptyLines = candidate.split('\n').map((line) => line.trim()).filter(Boolean);
  if (nonEmptyLines.length < 2) return null;

  const charCount = candidate.replace(/\s+/g, '').length;
  const lineCount = nonEmptyLines.length;
  if (lineCount === 2 && charCount < 20) return null;

  const boilerplatePatterns = [
    /^(lyrics|share|embed|read more|see all|translations?|contributors?|credits?)$/i,
    /^(written by|produced by|release date|track list|album|comments?)$/i,
  ];

  if (nonEmptyLines.some((line) => boilerplatePatterns.some((pattern) => pattern.test(line)))) return null;
  if (/^(lyrics not found|not enough information|i('?m)? sorry|cannot determine)/i.test(candidate)) return null;

  return candidate;
}

async function fetchLyricsGithubModels(pageResult, trackName, artistName, deterministicResult = null) {
  if (!WEB_LYRICS_CONFIG.githubToken) return { result: null, rateLimited: false };
  if (!shouldUseAiExtraction(deterministicResult)) return { result: deterministicResult, rateLimited: false };
  if (!pageResult || pageResult.status !== 'ok') return { result: null, rateLimited: false };

  const source = createSourceLabelFromUrl(pageResult.url);
  if (!source) return { result: null, rateLimited: false };

  const pageText = normalizeLyricsCandidateText(pageResult.text || pageResult.html || '');
  if (!pageText) return { result: null, rateLimited: false };

  const aiStart = Date.now();
  try {
    broadcastLog(`AI: extracting lyrics via GitHub Models (timeout ${WEB_LYRICS_CONFIG.aiTimeoutMs / 1000}s)…`, 'info');
    const response = await axios.post(
      `${WEB_LYRICS_CONFIG.githubModelsApiBaseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        model: process.env.GITHUB_MODELS_MODEL || 'gpt-4.1-mini',
        temperature: 0,
        top_p: 1,
        messages: [
          {
            role: 'system',
            content: 'Extract only song lyrics from the supplied webpage text. Preserve line breaks. Return only the lyrics. If uncertain, return an empty response.',
          },
          {
            role: 'user',
            content: [
              `Track: ${trackName}`,
              `Artist: ${artistName}`,
              `Source hostname: ${source}`,
              '',
              'Webpage text:',
              pageText,
            ].join('\n'),
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${WEB_LYRICS_CONFIG.githubToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        timeout: WEB_LYRICS_CONFIG.aiTimeoutMs,
        maxContentLength: WEB_LYRICS_CONFIG.maxBytes,
        maxBodyLength: WEB_LYRICS_CONFIG.maxBytes,
      }
    );

    const elapsed = ((Date.now() - aiStart) / 1000).toFixed(1);
    const rawLyrics = response.data?.choices?.[0]?.message?.content || '';
    const usage = response.data?.usage;
    const tokenInfo = usage ? ` (${usage.prompt_tokens}→${usage.completion_tokens} tokens)` : '';
    const validatedLyrics = validateAiExtractionOutput(rawLyrics);
    if (!validatedLyrics) {
      broadcastLog(`AI: extraction returned no usable lyrics in ${elapsed}s${tokenInfo}`, 'warn');
      return { result: null, rateLimited: false };
    }
    broadcastLog(`AI: extraction succeeded in ${elapsed}s${tokenInfo}`, 'ok');
    return { result: createLyricsResult(validatedLyrics, source, true), rateLimited: false };
  } catch (err) {
    const elapsed = ((Date.now() - aiStart) / 1000).toFixed(1);
    if (err.response?.status === 429) {
      const retryAfter = Number.parseInt(err.response.headers?.['retry-after'] || '0', 10);
      if (retryAfter > 0) {
        broadcastLog(`AI: rate limited — waiting ${retryAfter}s before retry…`, 'warn');
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        broadcastLog(`AI: retrying after rate limit wait…`, 'info');
        return fetchLyricsGithubModels(pageResult, trackName, artistName, deterministicResult);
      }
      broadcastLog(`AI: rate limited (no retry-after header) — skipping AI for this song`, 'warn');
      return { result: null, rateLimited: true };
    }
    broadcastLog(`AI: extraction failed after ${elapsed}s — ${err.message}`, 'err');
    console.error('GitHub Models extraction error:', err.message);
    return { result: null, rateLimited: false };
  }
}

function isPrivateIpv4Address(hostname) {
  const parts = hostname.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;

  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 0 && b === 0)
  );
}

function isPrivateIpv6Address(hostname) {
  const lower = hostname.toLowerCase();
  return (
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fe80:') ||
    lower.startsWith('fe90:') ||
    lower.startsWith('fea0:') ||
    lower.startsWith('feb0:') ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('::ffff:127.') ||
    lower.startsWith('::ffff:10.') ||
    lower.startsWith('::ffff:172.') ||
    lower.startsWith('::ffff:192.168.') ||
    lower.startsWith('::ffff:169.254.')
  );
}

function isUnsafeCandidateHostname(hostname) {
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower === 'local' ||
    lower.endsWith('.local')
  ) {
    return true;
  }

  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4) return isPrivateIpv4Address(hostname);
  if (ipVersion === 6) return isPrivateIpv6Address(hostname);

  return false;
}

function isUnsafeResolvedAddress(address) {
  return isUnsafeCandidateHostname(address);
}

async function validateCandidatePageTarget(candidateUrl) {
  const parsed = validateCandidatePageUrl(candidateUrl);
  if (!parsed.ok) return parsed;

  const hostname = parsed.url ? new URL(parsed.url).hostname : null;
  if (!hostname) return { ok: false, reason: 'missing hostname' };

  if (net.isIP(hostname)) {
    if (isUnsafeResolvedAddress(hostname)) {
      return { ok: false, reason: `unsafe host ${hostname}` };
    }
    return parsed;
  }

  try {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length) {
      return { ok: false, reason: 'host could not be resolved' };
    }

    for (const { address } of addresses) {
      if (isUnsafeResolvedAddress(address)) {
        return { ok: false, reason: `resolved to unsafe address ${address}` };
      }
    }
  } catch (err) {
    return { ok: false, reason: `DNS lookup failed: ${err.message}` };
  }

  return parsed;
}

function validateCandidatePageUrl(candidateUrl) {
  let parsed;

  try {
    parsed = new URL(candidateUrl);
  } catch (_) {
    return { ok: false, reason: 'invalid URL' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'embedded credentials are not allowed' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `unsupported protocol ${parsed.protocol}` };
  }

  if (!parsed.hostname || isUnsafeCandidateHostname(parsed.hostname)) {
    return { ok: false, reason: `unsafe host ${parsed.hostname || '(empty)'}` };
  }

  return { ok: true, url: parsed.toString() };
}

function normalizeCandidatePageText(text) {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function fetchSafeCandidatePage(candidateUrl) {
  const validation = await validateCandidatePageTarget(candidateUrl);
  if (!validation.ok) {
    console.warn(`Blocked candidate page fetch: ${validation.reason}`);
    return { status: 'blocked', reason: validation.reason, url: null };
  }

  let currentUrl = validation.url;

  for (let redirectCount = 0; redirectCount <= WEB_LYRICS_CONFIG.maxRedirects; redirectCount += 1) {
    try {
      const response = await axios.get(currentUrl, {
        timeout: WEB_LYRICS_CONFIG.fetchTimeoutMs,
        maxContentLength: WEB_LYRICS_CONFIG.maxBytes,
        maxBodyLength: WEB_LYRICS_CONFIG.maxBytes,
        maxRedirects: 0,
        responseType: 'text',
        decompress: true,
        validateStatus: (status) => status >= 200 && status < 400,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
          'Accept-Language': 'da-DK,da;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
        },
      });

      if (response.status >= 300 && response.status < 400 && response.headers.location) {
        if (redirectCount === WEB_LYRICS_CONFIG.maxRedirects) {
          console.warn(`Blocked candidate page fetch: redirect limit exceeded for ${new URL(currentUrl).hostname}`);
          return { status: 'blocked', reason: 'redirect limit exceeded', url: currentUrl };
        }

        const nextUrl = new URL(response.headers.location, currentUrl).toString();
        const nextValidation = await validateCandidatePageTarget(nextUrl);
        if (!nextValidation.ok) {
          console.warn(`Blocked candidate page redirect: ${nextValidation.reason}`);
          return { status: 'blocked', reason: nextValidation.reason, url: currentUrl };
        }

        currentUrl = nextValidation.url;
        continue;
      }

      const contentType = String(response.headers['content-type'] || '').toLowerCase();
      if (
        !contentType.includes('text/html') &&
        !contentType.includes('text/plain') &&
        !contentType.includes('application/xhtml+xml')
      ) {
        console.warn(`Blocked candidate page fetch: unsupported content-type ${contentType || '(missing)'}`);
        return { status: 'blocked', reason: 'unsupported content type', url: currentUrl };
      }

      const rawBody = typeof response.data === 'string' ? response.data : String(response.data || '');
      const $ = cheerioLoad(rawBody);

      $('script').remove();
      $('style').remove();

      const sanitizedHtml = $.html();
      const sanitizedText = normalizeCandidatePageText($('body').text() || $.text() || '');

      return {
        status: 'ok',
        url: currentUrl,
        contentType,
        text: sanitizedText,
        html: sanitizedHtml,
        document: $,
      };
    } catch (err) {
      console.warn(`Candidate page fetch failed for ${new URL(currentUrl).hostname}: ${err.message}`);
      return { status: 'error', reason: err.message, url: currentUrl };
    }
  }

  console.warn(`Blocked candidate page fetch: redirect limit exceeded for ${new URL(currentUrl).hostname}`);
  return { status: 'blocked', reason: 'redirect limit exceeded', url: currentUrl };
}

async function fetchLyricsLrclib(trackName, artistName, albumName, durationSec) {
  try {
    const res = await axios.get('https://lrclib.net/api/get', {
      params: {
        track_name: trackName,
        artist_name: artistName,
        album_name: albumName,
        duration: durationSec,
      },
      timeout: WEB_LYRICS_CONFIG.fetchTimeoutMs,
      maxContentLength: WEB_LYRICS_CONFIG.maxBytes,
    });
    const plain = res.data.plainLyrics || null;
    if (plain) return createLyricsResult(plain, 'LRCLIB');
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
      timeout: WEB_LYRICS_CONFIG.fetchTimeoutMs,
      maxContentLength: WEB_LYRICS_CONFIG.maxBytes,
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
      timeout: WEB_LYRICS_CONFIG.fetchTimeoutMs,
      maxContentLength: WEB_LYRICS_CONFIG.maxBytes,
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
    if (lyrics) return createLyricsResult(lyrics, 'Genius', false);
    return null;
  } catch (err) {
    console.error('Genius error:', err.message);
    return null;
  }
}

function normalizeBraveSearchUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;

  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol === 'http:') parsed.protocol = 'https:';
    return parsed.toString();
  } catch (_) {
    return null;
  }
}

function scoreBraveSearchCandidate(candidate, trackName, artistName) {
  const title = candidate.title.toLowerCase();
  const snippet = candidate.snippet.toLowerCase();
  const url = candidate.url.toLowerCase();
  const track = trackName.toLowerCase();
  const artist = artistName.toLowerCase();

  let score = 0;

  if (title.includes(track)) score += 6;
  else if (track.includes(title) && title) score += 4;

  if (title.includes(artist)) score += 4;
  else if (artist.includes(title) && title) score += 2;

  if (snippet.includes(track)) score += 2;
  if (snippet.includes(artist)) score += 2;

  if (url.includes('lyrics') || url.includes('tekst') || url.includes('sangtekst')) score += 1;
  if (candidate.url.startsWith('https://')) score += 1;

  return score;
}

function isBraveSearchJunkCandidate(candidate) {
  const text = `${candidate.title} ${candidate.snippet} ${candidate.url}`.toLowerCase();

  if (!candidate.title || !candidate.url) return true;
  if (/\.(?:pdf|jpg|jpeg|png|gif|webp|svg|mp3|mp4|m4a|wav)(?:$|[?#])/i.test(candidate.url)) return true;

  // Streaming and metadata sites — JS-rendered SPAs that never serve raw lyrics in HTML
  const nonLyricDomains = [
    'musixmatch.com', 'jiosaavn.com',
    'spotify.com', 'trackify.am', 'gaana.com', 'apple.com',
    'music.apple.com', 'deezer.com', 'tidal.com', 'youtube.com',
    'youtu.be', 'soundcloud.com', 'amazon.com', 'music.amazon',
    'pandora.com', 'napster.com', 'lastfm.com', 'last.fm',
    'shazam.com', 'musixmatch.com/embed', 'azlyrics.biz',
  ];
  try {
    const hostname = new URL(candidate.url).hostname.replace(/^www\./, '');
    if (nonLyricDomains.some((d) => hostname === d || hostname.endsWith('.' + d))) return true;
  } catch (_) {}

  return [
    'karaoke',
    'instrumental',
    'cover',
    'remix',
    'reaction',
    'tiktok',
    'instagram',
    'facebook',
    'midi',
    'sheet music',
  ].some((term) => text.includes(term));
}

function normalizeBraveSearchCandidates(rawResults, trackName, artistName) {
  const seenUrls = new Set();
  const candidates = [];

  for (const result of rawResults) {
    const url = normalizeBraveSearchUrl(result.url);
    const title = typeof result.title === 'string' ? result.title.trim() : '';
    const snippet = typeof result.description === 'string'
      ? result.description.trim()
      : typeof result.snippet === 'string'
        ? result.snippet.trim()
        : '';

    if (!url || !title || !snippet) continue;

    const candidate = { url, title, snippet };
    if (isBraveSearchJunkCandidate(candidate)) continue;

    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    candidates.push({
      ...candidate,
      score: scoreBraveSearchCandidate(candidate, trackName, artistName),
    });
  }

  return candidates
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.url.localeCompare(right.url);
    })
    .slice(0, 5)
    .map(({ score, ...candidate }) => candidate);
}

function buildBraveSearchQueries(trackName, artistName) {
  const primaryArtist = artistName.split(',')[0].trim();
  const queries = [
    { q: `"${primaryArtist}" "${trackName}" tekst`,  params: { country: 'DK', search_lang: 'da' } },
    { q: `${primaryArtist} ${trackName} tekst`,      params: { country: 'DK', search_lang: 'da' } },
    { q: `"${primaryArtist}" "${trackName}" lyrics`, params: {} },
    { q: `${primaryArtist} ${trackName} lyrics`,     params: {} },
    { q: `${artistName} ${trackName}`,               params: {} },
  ];
  const seen = new Set();
  return queries.filter(({ q }) => {
    if (seen.has(q)) return false;
    seen.add(q);
    return true;
  });
}

async function fetchBraveSearchCandidatesForQuery(query, extraParams, trackName, artistName) {
  broadcastLog(`Brave search: "${query}"${extraParams.country ? ` [${extraParams.country}/${extraParams.search_lang}]` : ''}`, 'info');
  try {
    const res = await axios.get(WEB_LYRICS_CONFIG.braveSearchApiBaseUrl, {
      params: { q: query, ...extraParams },
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': WEB_LYRICS_CONFIG.braveSearchApiKey,
      },
      timeout: WEB_LYRICS_CONFIG.fetchTimeoutMs,
      maxContentLength: WEB_LYRICS_CONFIG.maxBytes,
    });
    const rawResults = res.data?.web?.results || res.data?.results || [];
    broadcastLog(`Brave: ${rawResults.length} raw result(s) for "${query}"`, 'info');
    const candidates = normalizeBraveSearchCandidates(rawResults, trackName, artistName);
    if (candidates.length > 0) {
      broadcastLog(`Brave: ${candidates.length} usable candidate(s) from "${query}"`, 'ok');
      candidates.forEach((c, i) => broadcastLog(`Brave: candidate ${i + 1} — ${c.url}`, 'info'));
    } else {
      broadcastLog(`Brave: no usable candidates from "${query}"`, 'warn');
    }
    return candidates;
  } catch (err) {
    broadcastLog(`Brave: search error for "${query}" — ${err.message}`, 'err');
    return [];
  }
}

async function fetchLyrics(trackName, artistName, albumName, durationSec) {
  function broadcastProgress(stage, pct) {
    broadcast({ type: 'progress', stage, pct });
  }

  broadcastProgress('lrclib', 10);
  const lrclibResult = await fetchLyricsLrclib(trackName, artistName, albumName, durationSec);
  if (lrclibResult) {
    console.log(`Lyrics source: LRCLIB`);
    broadcastLog('Lyrics: found on LRCLIB', 'ok');
    broadcastProgress('done', 100);
    return lrclibResult;
  }

  console.log('Lyrics stage: LRCLIB miss');
  broadcastLog('Lyrics: LRCLIB miss, trying Genius…', 'info');
  broadcastProgress('genius', 30);
  const geniusResult = await fetchLyricsGenius(trackName, artistName);
  if (geniusResult) {
    console.log(`Lyrics source: ${geniusResult.source}`);
    broadcastLog(`Lyrics: found on Genius`, 'ok');
    broadcastProgress('done', 100);
    return geniusResult;
  }

  console.log('Lyrics stage: Genius miss');
  broadcastLog('Lyrics: Genius miss, trying Brave Search…', 'info');

  if (!WEB_LYRICS_CONFIG.braveSearchApiKey) {
    broadcastLog('Lyrics: Brave Search not configured — giving up', 'warn');
  } else {
    const seenUrls = new Set();
    const braveQueries = buildBraveSearchQueries(trackName, artistName);
    const BRAVE_START = 55;
    const BRAVE_END = 99;
    const querySlice = (BRAVE_END - BRAVE_START) / braveQueries.length;
    let aiAvailable = true;

    for (let qi = 0; qi < braveQueries.length; qi++) {
      const { q: query, params: extraParams } = braveQueries[qi];
      const queryPct = Math.round(BRAVE_START + qi * querySlice);
      broadcastProgress('brave', queryPct);

      const candidates = await fetchBraveSearchCandidatesForQuery(query, extraParams, trackName, artistName);
      const newCandidates = candidates.filter((c) => !seenUrls.has(c.url));
      newCandidates.forEach((c) => seenUrls.add(c.url));

      for (const candidate of newCandidates) {
        broadcastLog(`Brave: fetching page — ${candidate.url}`, 'info');
        const pageResult = await fetchSafeCandidatePage(candidate.url);
        if (!pageResult || pageResult.status !== 'ok') {
          if (pageResult && pageResult.status === 'blocked') {
            console.log(`Lyrics stage: blocked candidate (${pageResult.reason})`);
            broadcastLog(`Brave: page blocked — ${pageResult.reason} (${candidate.url})`, 'warn');
          } else {
            broadcastLog(`Brave: page fetch failed — ${candidate.url}`, 'warn');
          }
          continue;
        }
        broadcastLog(`Brave: page fetched OK (${pageResult.contentType || 'unknown type'}, ${Math.round((pageResult.text?.length || 0) / 1024)}KB) — ${candidate.url}`, 'ok');

        const deterministicResult = extractDeterministicLyricsFromPage(pageResult, trackName, artistName);
        if (deterministicResult && !shouldUseAiExtraction(deterministicResult)) {
          console.log('Lyrics stage: deterministic success');
          console.log(`Lyrics source: ${deterministicResult.source}`);
          broadcastLog(`Brave: deterministic extraction succeeded — source: ${deterministicResult.source}`, 'ok');
          broadcastProgress('done', 100);
          return deterministicResult;
        }

        if (deterministicResult) {
          console.log('Lyrics stage: deterministic candidate not strong enough for final use');
          broadcastLog(`Brave: deterministic result weak (${deterministicResult.lyrics?.split('\n').length ?? 0} lines), trying AI…`, 'warn');
        } else {
          console.log('Lyrics stage: deterministic miss');
          broadcastLog('Brave: deterministic extraction found nothing, trying AI…', 'warn');
        }

        if (!aiAvailable) {
          broadcastLog('Brave: skipping AI (rate limited earlier this song)', 'warn');
          continue;
        }

        broadcastProgress('ai', Math.min(Math.round(queryPct + querySlice * 0.6), 99));
        const { result: aiResult, rateLimited } = await fetchLyricsGithubModels(pageResult, trackName, artistName, deterministicResult);
        if (rateLimited) aiAvailable = false;
        if (aiResult) {
          console.log('Lyrics stage: AI success');
          console.log(`Lyrics source: ${aiResult.source}`);
          broadcastLog(`Brave: AI extraction succeeded — source: ${aiResult.source}`, 'ok');
          broadcastProgress('done', 100);
          return aiResult;
        }

        broadcastLog('Brave: extraction miss on this candidate, continuing…', 'warn');
      }
    }

    broadcastLog('Lyrics: all Brave queries and candidates exhausted', 'warn');
  }

  console.log('Lyrics stage: all fallbacks exhausted');
  broadcastLog('Lyrics: all fallbacks exhausted — lyrics not found', 'err');
  broadcastProgress('done', 100);
  return createLyricsResult('Lyrics not found.', null);
}

// ─── Core Poll Tick ──────────────────────────────────────────────────────────
async function pollSpotify() {
  const pollToken = ++pollGeneration;

  try {
    const res = await spotifyGet('https://api.spotify.com/v1/me/player/currently-playing');

    if (pollToken !== pollGeneration) return;

    // 204 = nothing playing, 200 = data
    if (res.status === 204 || !res.data || !res.data.item) {
      if (pollToken !== pollGeneration) return;
      if (currentTrackId !== null) {
        currentTrackId = null;
        currentPayload = {
          status: 'idle',
          title: null,
          artist: null,
          album: null,
          albumArt: null,
          lyrics: 'Nothing is playing.',
          source: null,
          usedAiExtraction: false,
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
    resetVotes();
    broadcastVoteState(null);
    const trackName = track.name;
    const artistName = track.artists.map((a) => a.name).join(', ');
    const albumName = track.album ? track.album.name : '';
    const albumArt = track.album && track.album.images && track.album.images.length
      ? track.album.images[0].url
      : null;
    const durationSec = Math.round((track.duration_ms || 0) / 1000);

    console.log(`Now playing: ${artistName} – ${trackName}`);

    broadcast({ type: 'loading', title: trackName, artist: artistName, albumArt });

    const { lyrics, source, usedAiExtraction } = await fetchLyrics(trackName, artistName, albumName, durationSec);

    if (trackId !== currentTrackId) return;

    currentPayload = {
      status: 'playing',
      title: trackName,
      artist: artistName,
      album: albumName,
      albumArt,
      lyrics,
      source,
      usedAiExtraction: !!usedAiExtraction,
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
  pollGeneration += 1;
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

app.use(express.json());

app.post('/pin', (req, res) => {
  if (req.body?.pin !== PIN_CODE) {
    return res.status(401).json({ ok: false });
  }

  setAuthCookie(res);
  return res.json({ ok: true });
});

app.use((req, res, next) => {
  if (hasValidPinCookie(req)) {
    return next();
  }

  if (req.path === '/login' || req.path === '/callback') {
    return next();
  }

  if (req.path === '/') {
    return res.sendFile(INDEX_FILE);
  }

  if (req.path === '/remote' || req.path === '/remote.html') {
    return res.sendFile(REMOTE_FILE);
  }

  if (req.path === '/api/status') {
    return res.status(401).json({ pinRequired: true });
  }

  return res.status(401).json({ error: 'unauthorized', pinRequired: true });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/remote', (_req, res) => res.sendFile(REMOTE_FILE));

// OAuth – Step 1: redirect to Spotify
app.get('/login', (_req, res) => {
  tokens = { access_token: null, refresh_token: null };
  saveTokens(tokens);

  const scope = 'user-read-currently-playing user-read-playback-state user-modify-playback-state';
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope,
    redirect_uri: process.env.REDIRECT_URI,
    show_dialog: 'true',
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
    ? { ...currentPayload, source: currentPayload.source ?? null, usedAiExtraction: !!currentPayload.usedAiExtraction, isPolling }
    : { status: 'idle', title: null, artist: null, album: null, albumArt: null, lyrics: 'Start polling to load lyrics.', source: null, usedAiExtraction: false, isPolling };
  res.write(`data: ${JSON.stringify(initialPayload)}\n\n`);
  res.write(`data: ${JSON.stringify(buildVotePayload())}\n\n`);

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
app.post('/api/page', (req, res) => {
  const { direction } = req.body || {};
  if (direction !== 'next' && direction !== 'prev') {
    return res.status(400).json({ error: 'direction must be "next" or "prev"' });
  }
  console.log(`Remote: page ${direction} pulse`);
  broadcastLog(`Remote: page ${direction}`, 'info');
  broadcast({ type: 'page', direction });
  res.json({ ok: true });
});

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

// ─── Voter Routes ─────────────────────────────────────────────────────────────
app.get('/api/voter/me', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });
  const voter = voters.get(id);
  if (!voter) return res.json({ registered: false });
  voter.lastSeen = Date.now();
  return res.json({ registered: true, name: voter.name });
});

app.post('/api/voter/register', (req, res) => {
  const { id, name } = req.body || {};
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id required' });
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name required' });
  const trimmedName = name.trim().slice(0, 32);
  voters.set(id, { name: trimmedName, vote: null, lastSeen: Date.now() });
  console.log(`Voter registered: "${trimmedName}" (${id.slice(0, 8)}…)`);
  broadcastVoteState(`${trimmedName} joined`);
  return res.json({ ok: true, name: trimmedName });
});

app.post('/api/vote', (req, res) => {
  const { id, vote } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  if (vote !== 'skip' && vote !== 'keep' && vote !== null) {
    return res.status(400).json({ error: 'vote must be "skip", "keep", or null' });
  }
  const voter = voters.get(id);
  if (!voter) return res.status(404).json({ error: 'voter not registered' });
  voter.vote = vote;
  voter.lastSeen = Date.now();
  const label = vote === 'skip' ? 'skip' : vote === 'keep' ? 'keep' : 'abstain';
  console.log(`Vote: ${voter.name} → ${label}`);
  broadcastVoteState(`${voter.name} voted ${label}`);
  startSkipCountdown();
  return res.json({ ok: true });
});

app.post('/api/voter/heartbeat', (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  const voter = voters.get(id);
  if (!voter) return res.status(404).json({ error: 'voter not registered' });
  voter.lastSeen = Date.now();
  return res.json({ ok: true });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Tesla Lyrics server running on http://localhost:${PORT}`);

  const missing = [];
  const degraded = [];

  if (!process.env.SPOTIFY_CLIENT_ID)     missing.push('SPOTIFY_CLIENT_ID');
  if (!process.env.SPOTIFY_CLIENT_SECRET) missing.push('SPOTIFY_CLIENT_SECRET');
  if (!process.env.REDIRECT_URI)          missing.push('REDIRECT_URI');

  if (!process.env.GENIUS_ACCESS_TOKEN)   degraded.push('GENIUS_ACCESS_TOKEN (Genius fallback disabled)');
  if (!process.env.BRAVE_SEARCH_API_KEY)  degraded.push('BRAVE_SEARCH_API_KEY (Brave Search fallback disabled)');
  if (!process.env.GITHUB_TOKEN)          degraded.push('GITHUB_TOKEN (AI extraction disabled)');

  if (missing.length > 0) {
    console.error('ERROR: Required environment variables are not set — the app will not function:');
    missing.forEach((k) => console.error(`  ✗ ${k}`));
  }
  if (degraded.length > 0) {
    console.warn('WARNING: Optional environment variables are not set — lyrics coverage will be reduced:');
    degraded.forEach((k) => console.warn(`  ⚠ ${k}`));
  }
  if (missing.length === 0 && degraded.length === 0) {
    console.log('All environment variables are set.');
  }
});

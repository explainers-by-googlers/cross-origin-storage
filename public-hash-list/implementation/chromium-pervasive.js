// Copyright 2026 Google LLC
// SPDX-License-Identifier: MPL-2.0

import axios from 'axios';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getSha256 } from './shared.js';

// Chromium's pervasive resource allowlist: concrete URLs observed across many sites.
// Source: services/network/pervasive_resources/shared_resource_checker_patterns.h
const SOURCE_URL =
  'https://chromium.googlesource.com/chromium/src/+/lkgr/services/network/pervasive_resources/shared_resource_checker_patterns.h?format=TEXT';
export const OUTPUT_CSV = 'data/chromium-pervasive-hashes.csv';
const HASHABLE = /\.(js|mjs|cjs|css|wasm|json|woff|woff2|ttf|otf|svg|gz)$/i;
const HAS_PATTERN = /[*]|:[a-z]/i;

// URL prefixes that identify each versioned service whose :v placeholders we can resolve.
const MAPS_PATTERN =
  /^https:\/\/maps(?:\.google\.com|\.googleapis\.com)\/maps-api-v3\/api\/js\//;
const YOUTUBE_PATTERN =
  /^https:\/\/www\.(youtube\.com|youtube-nocookie\.com)\/s\/player\//;

// reCAPTCHA patterns (/recaptcha/releases/:v/...) are intentionally NOT resolved here.
// styles__ltr.css is technically hashable but reCAPTCHA's release token rotates
// frequently and opaquely, so any cached hash becomes stale almost immediately.
// More importantly, the JS files (recaptcha__*.js) carry active bot-detection logic
// that Google deliberately rotates to stay ahead of adversaries — COS caching would
// undermine that. reCAPTCHA is not a suitable COS candidate.

// Hosts excluded from hashing, for two distinct reasons:
//
// 1. URL PATTERN RESOLUTION (the primary reason this list exists): the Chromium
//    pervasive list contains :v URL patterns for some tracking/ad hosts. Resolving
//    those patterns and adding the files to the COS allowlist would let them
//    persist in the cross-site shared cache, potentially undermining per-request
//    tracking protections. We refuse to fill in :v for these hosts at all.
//
// 2. CONCRETE URLS: a handful of these hosts also appear as concrete (non-pattern)
//    versioned URLs in the Chromium list (e.g. google-analytics.com/analytics.js).
//    These are excluded because their files are security-sensitive in the same way
//    as reCAPTCHA — they carry tracking/fingerprinting logic that the vendor
//    deliberately rotates, and COS caching would undermine that rotation.
//    This is NOT a general editorial stance on ad-tech: ubiquitous ad files from
//    other sources (e.g. jsDelivr top-100) are valid COS candidates and are
//    included without filtering.
//
// Must remain code-driven: the Chromium pattern list is auto-generated and evolves.
const BLOCKED_HOSTS = new Set([
  'a.amxrtb.com',                   // ad tech
  'analytics.tiktok.com',           // TikTok tracking pixel
  'cdn.brandmetrics.com',           // brand measurement tracking
  'cdn.id5-sync.com',               // cross-site identity tracking
  'connect.facebook.net',           // Facebook tracking pixel
  'pagead2.googlesyndication.com',  // Google Ads
  'platform-api.sharethis.com',     // social sharing + tracking
  's.yimg.jp',                      // Yahoo ad tracking
  'sc-static.net',                  // Snapchat pixel
  'script.crazyegg.com',            // analytics / heatmaps
  'securepubads.g.doubleclick.net', // DoubleClick / Google Ads
  'ssl.google-analytics.com',       // Google Analytics (legacy endpoint)
  'static.addtoany.com',            // social sharing + tracking
  'static.cloudflareinsights.com',  // Cloudflare analytics
  'static.criteo.net',              // Criteo retargeting
  'tags.crwdcntrl.net',             // Lotame DMP
  'tpc.googlesyndication.com',      // Google Ads
  'www.google-analytics.com',       // Google Analytics
  'www.redditstatic.com',           // Reddit tracking pixel
  'yastatic.net',                   // Yandex ads / SafeFrame
]);

// Returns true if a concrete URL is "stable": the same path will always serve
// the same bytes because a version number or content hash is embedded in it.
// This must remain a pure, code-driven function; it is applied to every concrete
// URL in the Chromium list each run so new entries are classified automatically.
//
// Heuristics checked against the URL pathname (except the @-version check):
//   semver           /3.7.1/ anywhere in path
//   major.minor      /1.6/ as its own path segment
//   npm @pin         @1.8.1/ or @11. in the full URL
//   /vN/ segment     /v19/
//   hex hash         .92255d46. — 8+ hex chars surrounded by . or -
//   alphanumeric hash  16+ [0-9a-z] chars in the filename component
//   hash path segment  entire path segment is 16+ [0-9a-z] chars (e.g. reCAPTCHA
//                      release tokens like /ne1iDVwClkE7nKD3uA9Vqsvl/)
//   long numeric ID  7+ consecutive digits followed by -, ., or /
function isStable(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  const segments = pathname.split('/').filter(Boolean);
  const filename = segments.at(-1) ?? '';
  return (
    /\d+\.\d+\.\d+/.test(pathname) ||
    /\/\d+\.\d+\//.test(pathname) ||
    /@\d+[\./]/.test(url) ||
    /\/v\d+\//.test(pathname) ||
    /[.-][0-9a-f]{8}[0-9a-f]*[.-]/i.test(pathname) ||
    /\b[0-9a-z]{16,}\b/i.test(filename) ||
    segments.some((s) => /^[0-9a-z]{16,}$/i.test(s)) ||
    /\/\d{7,}[-.\/]/.test(pathname)
  );
}

// Fetches the two version path components (:v1, :v2) from the Maps JS bootstrap.
// The bootstrap JS contains a self-reference like "maps-api-v3/api/js/65/3b".
async function getMapsVersions() {
  try {
    const { data } = await axios.get('https://maps.googleapis.com/maps/api/js', {
      responseType: 'text',
      timeout: 10000,
    });
    const match = data.match(/maps-api-v3\/api\/js\/(\d+)\/([^/"]+)/);
    return match ? { v1: match[1], v2: match[2] } : null;
  } catch {
    return null;
  }
}

// Discovers the current YouTube player ID from the iframe API bootstrap.
// The bootstrap JS contains an escaped URL like "...\/s\/player\/445213fb\/...".
async function getYouTubePlayerId() {
  try {
    const { data } = await axios.get('https://www.youtube.com/iframe_api', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      },
      responseType: 'text',
      timeout: 10000,
    });
    const match = data.match(/player\\\/([0-9a-f]+)\\\//);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Attempts to resolve a URL pattern containing :v placeholders to a concrete URL.
// Returns the resolved URL string, or null if no resolver handles this pattern.
//
// Resolved URLs are versioned by construction (the :v value IS the version), so
// callers should skip the isStable() check for them.
function tryResolve(pattern, { mapsVersions, youtubePlayerId }) {
  // Google Maps: :v1 = channel (e.g. "65"), :v2 = release (e.g. "3b")
  // Skip intl variants containing :v3 — those URLs return 404.
  if (MAPS_PATTERN.test(pattern) && mapsVersions && !pattern.includes(':v3')) {
    const url = pattern
      .replace(':v1', mapsVersions.v1)
      .replace(':v2', mapsVersions.v2);
    if (!HAS_PATTERN.test(url)) return url;
  }

  // YouTube: :v = player ID for single-variable patterns (www-player.css, widgetapi)
  //          :v1/:v2/:v3 = {player-id}/player_ias.vflset/en_US for multi-file patterns
  if (YOUTUBE_PATTERN.test(pattern) && youtubePlayerId) {
    const url = pattern.includes(':v1')
      ? pattern
          .replace(':v1', youtubePlayerId)
          .replace(':v2', 'player_ias.vflset')
          .replace(':v3', 'en_US')
      : pattern.replace(':v', youtubePlayerId);
    if (!HAS_PATTERN.test(url)) return url;
  }

  return null;
}

async function getAllUrls() {
  const { data } = await axios.get(SOURCE_URL, { responseType: 'text' });
  const text = Buffer.from(data, 'base64').toString('utf8');

  const rawPatterns = [];
  let inList = false;
  for (const line of text.split('\n')) {
    if (line.includes('// The uncompressed list of URL patterns is:')) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const match = line.match(/^\/\/ (https:\/\/.+)$/);
    if (!match) break;
    rawPatterns.push(match[1].trim());
  }

  const [mapsVersions, youtubePlayerId] = await Promise.all([
    getMapsVersions(),
    getYouTubePlayerId(),
  ]);

  if (mapsVersions) {
    console.log(`[chromium] Maps version: ${mapsVersions.v1}/${mapsVersions.v2}`);
  } else {
    console.log(`[chromium] Could not resolve Maps version; Maps patterns will be skipped`);
  }
  if (youtubePlayerId) {
    console.log(`[chromium] YouTube player ID: ${youtubePlayerId}`);
  } else {
    console.log(`[chromium] Could not resolve YouTube player ID; YouTube patterns will be skipped`);
  }

  const versions = { mapsVersions, youtubePlayerId };
  const urls = [];
  let resolvedCount = 0;
  let blockedCount = 0;
  let unstableCount = 0;
  let unresolvableCount = 0;

  for (const pattern of rawPatterns) {
    if (HAS_PATTERN.test(pattern)) {
      // Pattern URL — try to resolve to a concrete URL.
      // Resolved URLs skip the stability check: the :v value IS the version.
      const url = tryResolve(pattern, versions);
      if (!url) {
        unresolvableCount++;
        continue;
      }
      if (!HASHABLE.test(url)) continue;
      const { hostname } = new URL(url);
      if (BLOCKED_HOSTS.has(hostname)) {
        blockedCount++;
        continue;
      }
      urls.push(url);
      resolvedCount++;
      continue;
    }

    // Concrete URL — apply stability and blocklist filters.
    if (!HASHABLE.test(pattern)) continue;
    let hostname;
    try {
      hostname = new URL(pattern).hostname;
    } catch {
      continue;
    }
    if (BLOCKED_HOSTS.has(hostname)) {
      blockedCount++;
      continue;
    }
    if (!isStable(pattern)) {
      unstableCount++;
      continue;
    }
    urls.push(pattern);
  }

  console.log(
    `[chromium] ${urls.length} URLs to hash ` +
      `(${resolvedCount} resolved from patterns, ` +
      `${blockedCount} blocked, ${unstableCount} unstable, ` +
      `${unresolvableCount} unresolvable patterns skipped)`
  );
  return urls;
}

export async function run() {
  console.log(
    `[chromium] Fetching pervasive resource patterns from Chromium source...`
  );
  const urls = await getAllUrls();

  const records = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const sha256 = await getSha256(url);
    if (sha256) {
      records.push({ url, sha256 });
      console.log(`[chromium] [${i + 1}/${urls.length}] VALID: ${url}`);
    } else {
      console.log(`[chromium] [${i + 1}/${urls.length}] OMITTED: ${url}`);
    }
  }

  records.sort((a, b) => a.sha256.localeCompare(b.sha256));
  fs.mkdirSync('data', { recursive: true });
  const writeStream = fs.createWriteStream(OUTPUT_CSV, { encoding: 'utf8' });
  writeStream.write('sha256,url\n');
  for (const { url, sha256 } of records) {
    writeStream.write(`${sha256},${url}\n`);
  }
  writeStream.end();
  console.log(`[chromium] Saved ${records.length} records to '${OUTPUT_CSV}'.`);
  return records;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

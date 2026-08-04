// Copyright 2026 Google LLC
// SPDX-License-Identifier: MPL-2.0

// Load .env if present — native Node.js 20.12+, no package required.
try { process.loadEnvFile(); } catch {}

import axios from 'axios';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getSha256 } from './shared.js';

// Hashes every woff2 font file served by fonts.gstatic.com for all font
// families in the Google Fonts catalog, discovered via the CSS2 API.
//
// Each family × variant × Unicode subset yields a separate versioned woff2
// URL — these are the actual bytes browsers download and cache, so they are
// the right granularity for the PHL.
//
// Requires a free Google Fonts Developer API key in GOOGLE_FONTS_API_KEY.
// https://developers.google.com/fonts/docs/developer_api
//
// API endpoints used:
//   GET https://www.googleapis.com/webfonts/v1/webfonts?key=…&sort=popularity
//       — full font catalog with variant metadata
//   GET https://fonts.googleapis.com/css2?family=Name:ital,wght@…&display=swap
//       — CSS with @font-face blocks containing versioned fonts.gstatic.com URLs

export const OUTPUT_CSV = 'data/google-fonts-hashes.csv';

const FONTS_API = 'https://www.googleapis.com/webfonts/v1/webfonts';
const CSS2_API = 'https://fonts.googleapis.com/css2';
// A modern Chrome UA causes Google Fonts to serve woff2 (not ttf/woff).
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CSS_BATCH = 10; // font families per CSS2 request
const HASH_CONCURRENCY = 20; // parallel SHA-256 downloads

// Build the CSS2 `family` param value from a webfonts-API item.
// Google Fonts requires axes in alphabetical order (ital before wght) and
// axis values sorted ascending within each axis.
function buildFamilyParam({ family, variants }) {
  const normal = new Set();
  const italic = new Set();

  for (const v of variants) {
    if (v === 'regular') {
      normal.add(400);
    } else if (v === 'italic') {
      italic.add(400);
    } else if (v.endsWith('italic')) {
      const w = parseInt(v, 10);
      italic.add(w || 400);
    } else {
      const w = parseInt(v, 10);
      if (w) normal.add(w);
    }
  }

  // Fallback for unusual variant names (e.g. icon fonts).
  if (normal.size === 0 && italic.size === 0) normal.add(400);

  const name = family; // URLSearchParams encodes spaces as + automatically

  if (italic.size > 0) {
    const axes = [
      ...[...normal].sort((a, b) => a - b).map((w) => `0,${w}`),
      ...[...italic].sort((a, b) => a - b).map((w) => `1,${w}`),
    ].join(';');
    return `${name}:ital,wght@${axes}`;
  }

  return `${name}:wght@${[...normal].sort((a, b) => a - b).join(';')}`;
}

// Extract all fonts.gstatic.com woff2 URLs from a CSS2 response body.
function extractWoff2Urls(css) {
  const urls = new Set();
  for (const m of css.matchAll(
    /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/g,
  )) {
    urls.add(m[1]);
  }
  return [...urls];
}

// Fetch woff2 URLs for a batch of families in a single CSS2 request.
// When no `text` parameter is given, Google returns all available Unicode
// subsets (latin, latin-ext, cyrillic, greek, …) as separate @font-face blocks.
async function fetchBatchUrls(families) {
  const params = new URLSearchParams();
  for (const f of families) params.append('family', buildFamilyParam(f));
  params.set('display', 'swap');
  try {
    const { data } = await axios.get(`${CSS2_API}?${params}`, {
      headers: { 'User-Agent': UA },
      timeout: 15000,
    });
    return extractWoff2Urls(data);
  } catch {
    return [];
  }
}

// Hash all URLs with bounded concurrency. JS is single-threaded so `idx++`
// is safe without a mutex across async workers.
async function hashAll(urls) {
  const records = [];
  let idx = 0;

  async function worker() {
    while (idx < urls.length) {
      const i = idx++;
      const sha256 = await getSha256(urls[i]);
      if (sha256) records.push({ sha256, url: urls[i] });
      if ((i + 1) % 500 === 0 || i + 1 === urls.length) {
        console.log(`[google-fonts]   hashed ${i + 1}/${urls.length}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(HASH_CONCURRENCY, urls.length) }, worker),
  );
  return records;
}

export async function run() {
  const apiKey = process.env.GOOGLE_FONTS_API_KEY;
  if (!apiKey) {
    console.log('[google-fonts] SKIP: GOOGLE_FONTS_API_KEY env var not set.');
    return [];
  }

  console.log('[google-fonts] Fetching font catalog...');
  let families;
  try {
    const { data } = await axios.get(FONTS_API, {
      params: { key: apiKey, sort: 'popularity' },
      timeout: 10000,
    });
    families = data.items;
    console.log(`[google-fonts] ${families.length} font families in catalog.`);
  } catch (err) {
    console.log(`[google-fonts] SKIP: catalog fetch failed (${err.message}).`);
    return [];
  }

  // Discover all woff2 URLs via batched CSS2 requests.
  const allUrls = new Set();
  const totalBatches = Math.ceil(families.length / CSS_BATCH);
  for (let i = 0; i < families.length; i += CSS_BATCH) {
    const batch = families.slice(i, i + CSS_BATCH);
    const batchNum = Math.floor(i / CSS_BATCH) + 1;
    const urls = await fetchBatchUrls(batch);
    for (const u of urls) allUrls.add(u);
    console.log(
      `[google-fonts] CSS2 batch ${batchNum}/${totalBatches}: ` +
        `${urls.length} URLs (${allUrls.size} total unique)`,
    );
  }

  console.log(
    `[google-fonts] Hashing ${allUrls.size} font files ` +
      `(concurrency=${HASH_CONCURRENCY})...`,
  );
  const records = await hashAll([...allUrls]);

  records.sort((a, b) => a.sha256.localeCompare(b.sha256));
  fs.mkdirSync('data', { recursive: true });
  const ws = fs.createWriteStream(OUTPUT_CSV, { encoding: 'utf8' });
  ws.write('sha256,url\n');
  for (const { sha256, url } of records) ws.write(`${sha256},${url}\n`);
  ws.end();

  console.log(
    `[google-fonts] Saved ${records.length} records to '${OUTPUT_CSV}'.`,
  );
  return records;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

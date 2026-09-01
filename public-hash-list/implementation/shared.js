// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import { parse } from 'csv-parse/sync';

export async function getSha256(url) {
  try {
    const response = await axios({
      method: 'get',
      url,
      responseType: 'stream',
      timeout: 30000,
    });

    if (response.status !== 200) return null;

    return new Promise((resolve) => {
      const hash = crypto.createHash('sha256');
      response.data.on('data', (chunk) => hash.update(chunk));
      response.data.on('end', () => resolve(hash.digest('hex')));
      response.data.on('error', () => resolve(null));
    });
  } catch {
    return null;
  }
}

// Map `fn` over `items` with at most `limit` in flight. N workers share one
// cursor, so a slow item delays only its own worker rather than a whole batch —
// the difference from slicing the input into fixed batches and awaiting each.
// Results come back in input order regardless of completion order.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;

  // Single-threaded JS makes `idx++` atomic across async workers, so no mutex.
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// --- Downloaded-hash cache ---------------------------------------------------
// Most sources hash by downloading the file, and week after week the same bytes
// come back from URLs that never changed. Each such source keeps a record of
// what it has already hashed, as `key,tag,sha256,idle` sorted by key:
//
//   key   what identifies the bytes. A version-pinned CDN URL is its own key,
//         because the version is in the path and those paths do not get
//         rewritten. The model hub cannot use its URLs — they point at a moving
//         `main` ref — so it keys on the git blob oid its API reports instead.
//   tag   a second condition on the key, empty when the key alone settles it.
//         Otherwise a validator checked before the row is trusted: a file size,
//         or the `ETag` / `Last-Modified` the server reports for a URL that is
//         versioned but not contractually immutable.
//   idle  consecutive runs this row went untouched. Rows past CACHE_MAX_IDLE are
//         dropped on write, so a cache tracks what its source still hashes
//         rather than growing forever, while one bad run evicts nothing.
//
// Caches live in `hash-cache/`, one file per source, so running a single source
// cannot age out another's rows. That is outside `data/`, which the pipeline
// wipes at the start of every run and which Git LFS tracks; they are committed
// as plain text so the weekly workflow starts warm and a rebuilt cache diffs as
// the rows that actually changed. Deleting one forces that source to rehash from
// scratch.
export const CACHE_DIR = 'hash-cache';
const CACHE_MAX_IDLE = 4;

function cacheFile(source) {
  return `${CACHE_DIR}/${source}.csv`;
}

export function loadHashCache(source) {
  const cache = new Map();
  let rows;
  try {
    rows = parse(fs.readFileSync(cacheFile(source)), {
      columns: true,
      skip_empty_lines: true,
    });
  } catch {
    return cache; // first run, unreadable, or deleted to force a rehash
  }
  for (const row of rows) {
    // A malformed row is dropped rather than trusted: the cost is one download.
    if (!row.key || !/^[0-9a-f]{64}$/.test(row.sha256 || '')) continue;
    cache.set(row.key, {
      tag: row.tag ?? '',
      sha256: row.sha256,
      idle: Number(row.idle) || 0,
      used: false,
    });
  }
  return cache;
}

// A hit requires the tag to match too, which is what makes a stale or
// hand-edited row a miss rather than a wrong digest.
export function cacheLookup(cache, key, tag = '') {
  const entry = cache.get(key);
  if (!entry || entry.tag !== String(tag)) return null;
  entry.used = true;
  return entry.sha256;
}

export function cacheStore(cache, key, tag, sha256) {
  cache.set(key, { tag: String(tag ?? ''), sha256, idle: 0, used: true });
}

export function saveHashCache(source, cache) {
  const rows = [];
  for (const [key, entry] of cache) {
    const idle = entry.used ? 0 : entry.idle + 1;
    if (idle > CACHE_MAX_IDLE) continue;
    rows.push([key, entry.tag, entry.sha256, idle]);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const out = ['key,tag,sha256,idle', ...rows.map((r) => r.map(csvField).join(','))];
  fs.writeFileSync(cacheFile(source), out.join('\n') + '\n', 'utf8');
  return rows.length;
}

// Hash a URL whose bytes are settled by the URL alone — a CDN path with the
// version in it. The URL is the key and there is nothing further to check.
export async function getSha256Cached(cache, url) {
  const hit = cacheLookup(cache, url);
  if (hit) return hit;
  const sha256 = await getSha256(url);
  if (sha256) cacheStore(cache, url, '', sha256);
  return sha256;
}

// Hash a URL whose path carries a version but whose publisher could still
// republish behind it. A cached digest is reused only while the server reports
// the same validator, so a rewritten file is refetched instead of frozen at a
// digest for bytes that no longer exist. One HEAD stands in for a full download;
// a server offering no validator is always refetched.
export async function getSha256Revalidated(cache, url) {
  const validator = await getValidator(url);
  if (validator) {
    const hit = cacheLookup(cache, url, validator);
    if (hit) return hit;
  }
  const sha256 = await getSha256(url);
  if (sha256 && validator) cacheStore(cache, url, validator, sha256);
  return sha256;
}

// The strongest freshness token the server offers: an `ETag`, or `Last-Modified`
// where there is no `ETag` (Google's CDNs send the latter and not the former).
// Null when it offers neither or the HEAD fails — both mean "download it".
async function getValidator(url) {
  try {
    const { status, headers } = await axios.head(url, {
      timeout: 30000,
      validateStatus: () => true,
    });
    if (status !== 200) return null;
    return headers.etag || headers['last-modified'] || null;
  } catch {
    return null;
  }
}

// --- Web asset eligibility ---------------------------------------------------
// Which files the CDN-backed sources hash. The bar is "a page actually loads
// this": scripts, styles, fonts, images, wasm, and the data files pages fetch
// at runtime.
//
// `package.json` is the one name excluded rather than the one extension. It
// matches `json` and cdnjs does serve it, but it is npm packaging metadata that
// no page loads — it describes the package, it is not part of it. JSON in
// general stays eligible: locale bundles, map styles, and tokenizer configs are
// all fetched by real pages, so dropping the extension would cost more than it
// saves. `package-lock.json` is excluded on the same grounds.
const WEB_ASSET = /\.(js|mjs|cjs|css|wasm|json|woff|woff2|ttf|otf|svg|gz)$/i;
const PACKAGING_METADATA = /(^|\/)package(-lock)?\.json$/i;

// Accepts either a bare repo-relative path or a full URL; any query string or
// fragment is ignored so `foo.js?v=2` is judged on `foo.js`.
export function isWebAsset(pathOrUrl) {
  const path = String(pathOrUrl).split(/[?#]/)[0];
  return WEB_ASSET.test(path) && !PACKAGING_METADATA.test(path);
}

// --- Per-source CSV output ---------------------------------------------------
// Every source writes the same intermediate artifact: `sha256,url`, one record
// per line, sorted by hash. The url column is the reason this needs a real
// writer rather than string interpolation — it carries whatever the upstream
// publisher named the file, and those names contain commas (`it,en/` locale
// directories, quantization recipes like `8steps,CFG1,euler`), quotes, and
// stranger things. An unquoted comma silently splits a row into three fields
// and corrupts the record for anything that parses it.
//
// Fields are escaped per RFC 4180 §2: quote when the value contains a comma,
// a double quote, CR, or LF, and double any embedded quote. Records stay
// LF-terminated rather than the RFC's CRLF — every CSV parser accepts LF, these
// files are diffed and reviewed in git, and CRLF would rewrite all eleven of
// them for no reader's benefit.
export function csvField(value) {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

// Write a source's `{ sha256, url }` records to `path` as `sha256,url`.
// Callers sort before calling; this only formats and writes.
export function writeHashCsv(path, records) {
  const out = ['sha256,url'];
  for (const { sha256, url } of records) {
    out.push(`${csvField(sha256)},${csvField(url)}`);
  }
  fs.writeFileSync(path, out.join('\n') + '\n', 'utf8');
}

// --- Public Hash List (PHL) formatting ---------------------------------------
// The PHL is a flat, PSL-style text file: bare lowercase SHA-256 digests, one
// per line, grouped into structured sections, with `//` comment lines carrying
// provenance only. Parsers ignore comment lines. See README.md for rationale.

const SOURCE_LABELS = {
  'google-hosted-libraries': 'Google Hosted Libraries',
  'microsoft-ajax': 'Microsoft Ajax CDN',
  cdnjs: 'cdnjs (Cloudflare request rank)',
  'npm-popular': 'cdnjs (npm download rank)',
  jsdelivr: 'jsDelivr',
  'chromium-pervasive': 'Chromium pervasive',
  'youtube-player': 'YouTube player',
  'google-maps': 'Google Maps JS API',
  'google-fonts': 'Google Fonts',
  'http-archive': 'HTTP Archive',
  'nuxt-cos': 'nuxt-cos / vite-plugin-cross-origin-storage',
  huggingface: 'Hugging Face Hub',
  manual: 'Manual addition',
};

export function sourceLabel(key) {
  return SOURCE_LABELS[key] || key;
}

// Group tagged `{ sha256, url, source }` records into one entry per digest,
// collecting the set of vouching sources and a representative URL (shortest,
// then lexicographically smallest — tends to be the cleanest canonical URL).
export function groupRecords(records) {
  const byHash = new Map();
  for (const { sha256, url, source } of records) {
    let entry = byHash.get(sha256);
    if (!entry) {
      entry = { sha256, urls: new Set(), sources: new Set() };
      byHash.set(sha256, entry);
    }
    entry.urls.add(url);
    if (source) entry.sources.add(source);
  }
  const entries = [...byHash.values()].map((e) => {
    const representative = [...e.urls].sort(
      (a, b) => a.length - b.length || a.localeCompare(b)
    )[0];
    const sources = [...e.sources].sort();
    return { sha256: e.sha256, representative, sources };
  });
  entries.sort((a, b) => a.sha256.localeCompare(b.sha256));
  return entries;
}

function renderSection(entries) {
  const lines = [];
  for (const { sha256, representative, sources } of entries) {
    const vouchers = sources.map(sourceLabel).join(', ');
    if (vouchers) lines.push(`// ${vouchers} — e.g. ${representative}`);
    else if (representative) lines.push(`// e.g. ${representative}`);
    lines.push(sha256);
  }
  return lines.join('\n');
}

// Build the canonical PHL text file. `core`, `huggingface`, and `manual` are
// arrays of grouped entries (from `groupRecords`). The latter two may be empty.
export function formatHashList({ core, huggingface = [], manual = [], version, commit }) {
  const header = [
    '// Public Hash List (PHL)',
    '// Generated by public-hash-list',
    '// https://github.com/WICG/cross-origin-storage/tree/main/public-hash-list/implementation',
    '//',
    `// VERSION: ${version}`,
    `// COMMIT: ${commit}`,
    '// Algorithm: SHA-256 (lowercase hex, 64 chars)',
    '// License: Apache-2.0  https://www.apache.org/licenses/LICENSE-2.0',
    '//',
    '// Availability-gating allowlist for Cross-Origin Storage (COS):',
    '// https://wicg.github.io/cross-origin-storage/',
    '// Each significant line is a bare SHA-256 digest. Lines starting with `//`',
    '// are comments carrying provenance only and MUST be ignored by parsers.',
    '//',
  ];

  const coreBlock = [
    '// ===BEGIN SHA-256===',
    '// Ubiquitous, corroborated resources. User agents MUST treat these as eligible.',
    '//',
    renderSection(core),
    '// ===END SHA-256===',
  ];

  const hfBody = huggingface.length
    ? renderSection(huggingface)
    : '// (empty in this build: populating the model-hub section requires network\n' +
      '// access to the hub; run `npm run huggingface` in an unrestricted environment.)';

  const hfBlock = [
    '//',
    '// ===BEGIN SHA-256 HUGGING-FACE===',
    '// Hand-curated AI model resources from a recognized model hub (currently the',
    '// Hugging Face Hub). User agents SHOULD include this section; a UA MAY omit it.',
    '// Uneven adoption confers a competitive advantage contrary to the PHL\'s',
    '// purpose as a neutral, cross-vendor resource; full adoption is RECOMMENDED.',
    '//',
    hfBody,
    '// ===END SHA-256 HUGGING-FACE===',
  ];

  const manualBody = manual.length
    ? renderSection(manual)
    : '// (empty — add entries to manual-additions.json and open a pull request)';

  const manualBlock = [
    '//',
    '// ===BEGIN SHA-256 MANUAL===',
    '// Hand-curated additions reviewed and merged via pull request.',
    '// See manual-additions.json and .github/PULL_REQUEST_TEMPLATE.md.',
    '// User agents MUST treat these as eligible (same as the core section).',
    '//',
    manualBody,
    '// ===END SHA-256 MANUAL===',
  ];

  return [...header, ...coreBlock, ...hfBlock, ...manualBlock, ''].join('\n');
}

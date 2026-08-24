// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';

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

// Copyright 2026 Google LLC
// SPDX-License-Identifier: MPL-2.0

import axios from 'axios';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getSha256 } from './shared.js';

// Fetches all historically available Maps JavaScript API versions and hashes
// the JS files served for each. This is the Maps equivalent of youtube-player.js.
//
// Versioning scheme (https://developers.google.com/maps/documentation/javascript/versions):
//   - Quarterly versions: 3.NN, released mid-Feb/May/Aug/Nov each year
//   - Each version maps to an internal (channel, release) pair embedded in the
//     bootstrap JS, e.g. maps-api-v3/api/js/65/3b
//   - Google keeps the 4 most recent quarterly versions available; older ones
//     are deleted. We discover which versions are currently live by probing
//     https://maps.googleapis.com/maps/api/js?v=3.NN for each candidate.
//   - The bootstrap for each version self-references its internal (v1, v2) pair,
//     which we extract and use to construct the CDN asset URLs.
//
// File set: the same JS files Chromium tracks in its pervasive resource list
// (shared_resource_checker_patterns.h), for both the googleapis.com and
// google.com CDN mirrors. Chromium only resolves the *current* version via
// getMapsVersions(); this module covers the full available history.

export const OUTPUT_CSV = 'data/google-maps-hashes.csv';
const BOOTSTRAP_URL = 'https://maps.googleapis.com/maps/api/js';

// The files Chromium's pervasive resource list tracks per Maps version.
// Derived from the non-:v3 patterns in shared_resource_checker_patterns.h.
// The :v3 intl/* variants are omitted — they require a locale substitution
// that isn't resolved by getMapsVersions() and return 404 without an API key.
const MAPS_FILES = [
  // maps.google.com mirror (11 files)
  (v1, v2) => `https://maps.google.com/maps-api-v3/api/js/${v1}/${v2}/common.js`,
  (v1, v2) => `https://maps.google.com/maps-api-v3/api/js/${v1}/${v2}/directions.js`,
  (v1, v2) => `https://maps.google.com/maps-api-v3/api/js/${v1}/${v2}/drawing.js`,
  (v1, v2) => `https://maps.google.com/maps-api-v3/api/js/${v1}/${v2}/elevation.js`,
  (v1, v2) => `https://maps.google.com/maps-api-v3/api/js/${v1}/${v2}/overlay.js`,
  (v1, v2) => `https://maps.google.com/maps-api-v3/api/js/${v1}/${v2}/places.js`,
  (v1, v2) => `https://maps.google.com/maps-api-v3/api/js/${v1}/${v2}/poly.js`,
  (v1, v2) => `https://maps.google.com/maps-api-v3/api/js/${v1}/${v2}/streetview.js`,
  (v1, v2) => `https://maps.google.com/maps-api-v3/api/js/${v1}/${v2}/util.js`,
  (v1, v2) => `https://maps.google.com/maps-api-v3/api/js/${v1}/${v2}/visualization.js`,
  (v1, v2) => `https://maps.google.com/maps-api-v3/api/js/${v1}/${v2}/weather.js`,
  // maps.googleapis.com (23 files)
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/common.js`,
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/controls.js`,
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/directions.js`,
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/drawing.js`,
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/elevation.js`,
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/geocoder.js`,
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/geometry.js`,
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/infowindow.js`,
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/log.js`,
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/main.js`,
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/map.js`,
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/marker.js`,
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/onion.js`,
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/overlay.js`,
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/places.js`,
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/places_impl.js`,
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/poly.js`,
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/search.js`,
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/search_impl.js`,
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/streetview.js`,
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/util.js`,
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/visualization.js`,
  (v1, v2) => `https://maps.googleapis.com/maps-api-v3/api/js/${v1}/${v2}/weather.js`,
];

// Quarterly versions to probe. Google keeps the 4 most recent; we probe a
// narrow window around the estimated current version so new versions are
// picked up automatically without any code changes, and deleted ones are
// silently skipped (their bootstrap redirects to the default channel, whose
// URL doesn't match the CDN path pattern, so getVersionPair() returns null).
//
// Version numbering: 3.NN increments by 1 each quarter (mid-Feb/May/Aug/Nov).
// Anchor: 3.64 = Q2 2026 (verified). We derive the estimated current version
// from the date, then probe [current-5 .. current+6] — enough to cover
// versions Google keeps (4) plus headroom for timing skew at quarter boundaries.
function getCandidateVersions() {
  const base = { version: 64, year: 2026, quarter: 2 };
  const now = new Date();
  const currentQuarter = Math.floor(now.getMonth() / 3) + 1;
  const quartersElapsed =
    (now.getFullYear() - base.year) * 4 + (currentQuarter - base.quarter);
  const estimatedCurrent = base.version + quartersElapsed;

  const versions = [];
  // Start 5 back (covers any versions Google still serves) and go 6 ahead
  // (ensures the newly released version is probed even before this comment
  // is updated). Minimum floor of 3.50 — anything older is long deleted.
  const lo = Math.max(50, estimatedCurrent - 5);
  const hi = estimatedCurrent + 6;
  for (let minor = lo; minor <= hi; minor++) {
    versions.push(`3.${minor}`);
  }
  return versions;
}

// Fetches the bootstrap JS for a specific version string (e.g. "3.63") and
// extracts the internal (v1, v2) pair from the self-referencing CDN URL.
// Returns null if the version is not available (404 / no match).
async function getVersionPair(versionStr) {
  try {
    const { data, status } = await axios.get(BOOTSTRAP_URL, {
      params: { v: versionStr },
      responseType: 'text',
      timeout: 10000,
      validateStatus: (s) => s < 500,
    });
    if (status !== 200) return null;
    const match = data.match(/maps-api-v3\/api\/js\/(\d+)\/([^/"]+)/);
    if (!match) return null;
    return { v1: match[1], v2: match[2] };
  } catch {
    return null;
  }
}

export async function run() {
  const candidates = getCandidateVersions();
  console.log(
    `[google-maps] Probing ${candidates.length} candidate versions (${candidates[0]}–${candidates.at(-1)})...`
  );

  // Resolve (v1, v2) for each available version in parallel.
  const resolved = await Promise.all(
    candidates.map(async (v) => {
      const pair = await getVersionPair(v);
      if (pair) {
        console.log(
          `[google-maps] v${v} → channel ${pair.v1} / release ${pair.v2}`
        );
      }
      return pair ? { version: v, ...pair } : null;
    })
  );

  const available = resolved.filter(Boolean);
  console.log(
    `[google-maps] ${available.length} versions available: ${available.map((v) => `v${v.version}`).join(', ')}`
  );

  // Deduplicate by (v1, v2) — multiple version strings can point to the same
  // internal build during the transition window when channels overlap.
  const seen = new Set();
  const unique = available.filter(({ v1, v2 }) => {
    const key = `${v1}/${v2}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length < available.length) {
    console.log(
      `[google-maps] ${available.length - unique.length} duplicate (v1, v2) pairs removed`
    );
  }

  const totalUrls = unique.length * MAPS_FILES.length;
  console.log(
    `[google-maps] ${unique.length} unique builds × ${MAPS_FILES.length} file types = ${totalUrls} URLs to hash...`
  );

  const records = [];

  for (let i = 0; i < unique.length; i++) {
    const { version, v1, v2 } = unique[i];
    const results = await Promise.all(
      MAPS_FILES.map(async (fn) => {
        const url = fn(v1, v2);
        const sha256 = await getSha256(url);
        return sha256 ? { url, sha256 } : null;
      })
    );
    const valid = results.filter(Boolean);
    records.push(...valid);
    const baseIdx = i * MAPS_FILES.length + 1;
    const lastIdx = baseIdx + MAPS_FILES.length - 1;
    const omitted = MAPS_FILES.length - valid.length;
    console.log(
      `[google-maps] [${baseIdx}-${lastIdx}/${totalUrls}] v${version} (${v1}/${v2}): ${valid.length} valid` +
        (omitted ? `, ${omitted} omitted` : '')
    );
  }

  records.sort((a, b) => a.sha256.localeCompare(b.sha256));
  fs.mkdirSync('data', { recursive: true });
  const writeStream = fs.createWriteStream(OUTPUT_CSV, { encoding: 'utf8' });
  writeStream.write('sha256,url\n');
  for (const { url, sha256 } of records) {
    writeStream.write(`${sha256},${url}\n`);
  }
  writeStream.end();
  console.log(
    `[google-maps] Saved ${records.length} records to '${OUTPUT_CSV}'.`
  );
  return records;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

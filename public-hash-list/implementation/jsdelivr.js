// Copyright 2026 Google LLC
// SPDX-License-Identifier: MPL-2.0

import axios from 'axios';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getSha256 } from './shared.js';

// Ranks packages by actual jsDelivr CDN hit count and hashes their canonical
// files. This is the correct COS fitness signal: cross-origin CDN requests
// measure real cross-site sharing, not npm download counts which reflect
// bundled (non-CDN) usage and are therefore an inappropriate proxy.
//
// API: https://data.jsdelivr.com (free, no rate limits for reasonable use)
//   /v1/stats/packages          — top packages by CDN hits across npm + gh
//   /v1/packages/npm/:pkg/resolved — latest stable version
//   /v1/packages/npm/:pkg@:ver/entrypoints — canonical JS + CSS files

export const OUTPUT_CSV = 'data/jsdelivr-hashes.csv';
const JSDELIVR_API = 'https://data.jsdelivr.com/v1';
const JSDELIVR_CDN = 'https://cdn.jsdelivr.net/npm';
const TOP_N = 100;
const UA =
  'public-hash-list (https://github.com/WICG/cross-origin-storage/tree/main/public-hash-list/implementation)';
const HASHABLE = /\.(js|mjs|cjs|css|wasm|json|woff|woff2|ttf|otf|svg|gz)$/i;

// Fetches the top packages by CDN hits. Returns only npm-type entries
// (GitHub repos don't follow the stable semver CDN URL pattern we need).
async function getTopPackages() {
  const { data } = await axios.get(`${JSDELIVR_API}/stats/packages`, {
    params: { by: 'hits', type: 'npm', period: 'month', limit: TOP_N },
    headers: { 'User-Agent': UA },
  });

  return data.filter((p) => p.type === 'npm').slice(0, TOP_N);
}

// Returns the latest stable version for a package, or null.
async function resolveVersion(pkg) {
  try {
    const { data } = await axios.get(
      `${JSDELIVR_API}/packages/npm/${encodeURIComponent(pkg)}/resolved`,
      { headers: { 'User-Agent': UA }, timeout: 30000 }
    );
    return data.version ?? null;
  } catch {
    return null;
  }
}

// Returns the canonical JS and CSS entry point files for a package version.
// The entrypoints API uses jsDelivr's heuristics to pick the best file of
// each type — much more reliable than guessing from a raw file listing.
// Falls back to an empty array if the package has no recognised entrypoints.
async function getEntrypoints(pkg, version) {
  try {
    const encoded = encodeURIComponent(pkg);
    const { data } = await axios.get(
      `${JSDELIVR_API}/packages/npm/${encoded}@${version}/entrypoints`,
      { headers: { 'User-Agent': UA }, timeout: 30000 }
    );
    // Response: { entrypoints: { js: { file: '/dist/...' }, css: { file: '/dist/...' } } }
    return Object.values(data.entrypoints ?? data)
      .map((e) => e?.file)
      .filter((f) => f && HASHABLE.test(f));
  } catch {
    return [];
  }
}

export async function run() {
  console.log(`[jsdelivr] Fetching top ${TOP_N} npm packages by CDN hits...`);
  const packages = await getTopPackages();
  console.log(
    `[jsdelivr] Top ${packages.length} packages by jsDelivr CDN hit count (last month):`
  );
  packages.forEach(({ name, hits }, i) => {
    console.log(
      `  ${String(i + 1).padStart(3)}. ${name}: ${hits.toLocaleString()} hits`
    );
  });

  const records = [];

  for (let i = 0; i < packages.length; i++) {
    const { name } = packages[i];

    const version = await resolveVersion(name);
    if (!version) {
      console.log(`[jsdelivr] SKIP ${name}: could not resolve version`);
      continue;
    }

    const files = await getEntrypoints(name, version);
    if (!files.length) {
      console.log(`[jsdelivr] SKIP ${name}@${version}: no hashable entrypoints`);
      continue;
    }

    for (const file of files) {
      const url = `${JSDELIVR_CDN}/${name}@${version}${file}`;
      const sha256 = await getSha256(url);
      if (sha256) {
        records.push({ url, sha256 });
        console.log(`[jsdelivr] [${i + 1}/${packages.length}] VALID: ${url}`);
      } else {
        console.log(`[jsdelivr] [${i + 1}/${packages.length}] OMITTED: ${url}`);
      }
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
  console.log(
    `[jsdelivr] Saved ${records.length} records to '${OUTPUT_CSV}'.`
  );
  return records;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

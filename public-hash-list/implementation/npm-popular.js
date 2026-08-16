// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

import axios from 'axios';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getSha256 } from './shared.js';

export const OUTPUT_CSV = 'data/npm-popular-hashes.csv';
const CDNJS_API = 'https://api.cdnjs.com/libraries';
const CDNJS_PACKAGES_RAW =
  'https://raw.githubusercontent.com/cdnjs/packages/master/packages';
const NPM_DOWNLOADS_API = 'https://api.npmjs.org/downloads/point/last-month';
const CDNJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs';
const TOP_N = 100;
const NPM_BATCH = 100;
const PACKAGES_BATCH = 50;
const HASHABLE = /\.(js|mjs|cjs|css|wasm|json|woff|woff2|ttf|otf|svg|gz)$/i;

async function getCdnjsNames() {
  const { data } = await axios.get(`${CDNJS_API}?fields=name&limit=1000`);
  return data.results.map((p) => p.name);
}

// Fetches the cdnjs packages repo JSON for each library and extracts the
// canonical npm package name from autoupdate.target. Falls back to the
// cdnjs name for libraries that aren't npm-autoupdated.
async function buildNpmNameMap(cdnjsNames) {
  const map = {}; // cdnjsName → npmName
  for (let i = 0; i < cdnjsNames.length; i += PACKAGES_BATCH) {
    const batch = cdnjsNames.slice(i, i + PACKAGES_BATCH);
    await Promise.all(
      batch.map(async (name) => {
        const shard = name[0].toLowerCase();
        const url = `${CDNJS_PACKAGES_RAW}/${shard}/${name}.json`;
        try {
          const { data } = await axios.get(url);
          map[name] =
            data.autoupdate?.source === 'npm' && data.autoupdate?.target
              ? data.autoupdate.target
              : name;
        } catch {
          map[name] = name;
        }
      })
    );
  }
  return map;
}

async function getNpmDownloads(npmNames) {
  const downloads = {};
  const unique = [...new Set(npmNames)];

  // Scoped packages (e.g. @scope/pkg) contain a literal '/' that breaks the
  // comma-separated path format of the bulk endpoint — query them one by one.
  const bulk = unique.filter((n) => !n.startsWith('@'));
  const scoped = unique.filter((n) => n.startsWith('@'));

  for (let i = 0; i < bulk.length; i += NPM_BATCH) {
    const batch = bulk.slice(i, i + NPM_BATCH);
    try {
      const { data } = await axios.get(
        `${NPM_DOWNLOADS_API}/${batch.join(',')}`
      );
      for (const [name, info] of Object.entries(data)) {
        if (info?.downloads) downloads[name] = info.downloads;
      }
    } catch {
      // batch failed — skip silently
    }
  }

  for (const name of scoped) {
    try {
      const { data } = await axios.get(
        `${NPM_DOWNLOADS_API}/${encodeURIComponent(name)}`
      );
      if (data?.downloads) downloads[name] = data.downloads;
    } catch {
      // package not found on npm
    }
  }

  return downloads;
}

async function getCdnjsFiles(cdnjsName) {
  const { data: lib } = await axios.get(
    `${CDNJS_API}/${cdnjsName}?fields=version`
  );
  const version = lib.version;
  const { data: ver } = await axios.get(
    `${CDNJS_API}/${cdnjsName}/${version}?fields=files`
  );
  const files = (ver.files ?? []).filter((f) => HASHABLE.test(f));
  return { version, files };
}

export async function run() {
  console.log('[npm-popular] Fetching top 1000 cdnjs package names...');
  const cdnjsNames = await getCdnjsNames();

  console.log(
    `[npm-popular] Resolving npm package names from cdnjs/packages (${cdnjsNames.length} packages)...`
  );
  const npmNameMap = await buildNpmNameMap(cdnjsNames); // cdnjsName → npmName

  const renamed = Object.entries(npmNameMap).filter(([c, n]) => c !== n);
  console.log(
    `[npm-popular] ${renamed.length} name corrections (e.g. ${renamed
      .slice(0, 3)
      .map(([c, n]) => `${c} → ${n}`)
      .join(', ')})`
  );

  console.log(`[npm-popular] Querying npm download counts...`);
  const npmNames = cdnjsNames.map((n) => npmNameMap[n]);
  const downloads = await getNpmDownloads(npmNames); // npmName → count

  // Rank by npm downloads, keeping the cdnjs name for URL construction
  const ranked = cdnjsNames
    .map((cdnjsName) => ({
      cdnjsName,
      npmName: npmNameMap[cdnjsName],
      count: downloads[npmNameMap[cdnjsName]] ?? 0,
    }))
    .filter((p) => p.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_N);

  console.log(`[npm-popular] Top ${TOP_N} by npm downloads (last month):`);
  ranked.forEach(({ cdnjsName, npmName, count }, i) => {
    const label =
      cdnjsName !== npmName ? `${cdnjsName} (npm: ${npmName})` : cdnjsName;
    console.log(
      `  ${String(i + 1).padStart(3)}. ${label}: ${count.toLocaleString()}`
    );
  });

  const records = [];

  for (const { cdnjsName } of ranked) {
    let version, files;
    try {
      ({ version, files } = await getCdnjsFiles(cdnjsName));
    } catch {
      console.log(`[npm-popular] SKIP ${cdnjsName}: not found on cdnjs`);
      continue;
    }

    if (!files.length) {
      console.log(
        `[npm-popular] SKIP ${cdnjsName}@${version}: no hashable files`
      );
      continue;
    }

    for (const file of files) {
      const url = `${CDNJS_CDN}/${cdnjsName}/${version}/${file}`;
      const sha256 = await getSha256(url);
      if (sha256) {
        records.push({ url, sha256 });
        console.log(`[npm-popular] VALID: ${url}`);
      } else {
        console.log(`[npm-popular] OMITTED: ${url}`);
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
    `[npm-popular] Saved ${records.length} records to '${OUTPUT_CSV}'.`
  );
  return records;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

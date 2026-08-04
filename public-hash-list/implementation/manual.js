// Copyright 2026 Google LLC
// SPDX-License-Identifier: MPL-2.0

import fs from 'fs';
import { fileURLToPath } from 'url';

// Manual additions to the Public Hash List.
//
// Reads manual-additions.json — no network requests are made; the SHA-256
// hash IS the content identity, so re-downloading to re-verify on every run
// would defeat the purpose of content-addressing.
//
// To propose a new entry, open a pull request following the instructions in
// .github/PULL_REQUEST_TEMPLATE.md. Each entry must include an independently
// verifiable SHA-256 and a rationale explaining why the resource meets the
// ubiquity bar (cache presence reveals nothing specific about a user).

export const OUTPUT_CSV = 'data/manual-hashes.csv';
const INPUT_JSON = 'manual-additions.json';

export async function run() {
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(INPUT_JSON, 'utf8'));
  } catch (err) {
    console.log(`[manual] SKIP: could not read ${INPUT_JSON} (${err.message}).`);
    return [];
  }

  console.log(`[manual] ${entries.length} manual ${entries.length === 1 ? 'entry' : 'entries'} loaded.`);

  const records = entries
    .filter(({ url, sha256 }) => url && /^[0-9a-f]{64}$/.test(sha256))
    .map(({ url, sha256 }) => ({ url, sha256 }));

  if (records.length < entries.length) {
    console.log(`[manual] ${entries.length - records.length} entries skipped (missing url or invalid sha256).`);
  }

  records.sort((a, b) => a.sha256.localeCompare(b.sha256));
  fs.mkdirSync('data', { recursive: true });
  const ws = fs.createWriteStream(OUTPUT_CSV, { encoding: 'utf8' });
  ws.write('sha256,url\n');
  for (const { sha256, url } of records) ws.write(`${sha256},${url}\n`);
  ws.end();

  console.log(`[manual] Saved ${records.length} records to '${OUTPUT_CSV}'.`);
  return records;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

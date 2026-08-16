// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

import axios from 'axios';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getSha256 } from './shared.js';

const TARGET_URL = 'https://learn.microsoft.com/en-us/aspnet/ajax/cdn/overview';
export const OUTPUT_CSV = 'data/microsoft-ajax-hashes.csv';

const HASHABLE = /\.(js|mjs|cjs|css|wasm|json|woff|woff2|ttf|otf|svg|gz)$/i;

export async function run() {
  console.log(`[microsoft] Fetching page data from ${TARGET_URL}...`);

  const { data } = await axios.get(TARGET_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });

  const rawUrls = [
    ...data.matchAll(/https:\/\/ajax\.aspnetcdn\.com\/[^\s"'<>)]+/g),
  ].map((m) => m[0].replace(/[.,;]+$/, ''));
  const urls = [...new Set(rawUrls)].filter((url) => HASHABLE.test(url));

  console.log(`[microsoft] ${urls.length} hashable URLs. Hashing...`);

  const records = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const sha256 = await getSha256(url);
    if (sha256) {
      records.push({ url, sha256 });
      console.log(`[microsoft] [${i + 1}/${urls.length}] VALID: ${url}`);
    } else {
      console.log(`[microsoft] [${i + 1}/${urls.length}] OMITTED: ${url}`);
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
    `[microsoft] Saved ${records.length} records to '${OUTPUT_CSV}'.`
  );
  return records;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

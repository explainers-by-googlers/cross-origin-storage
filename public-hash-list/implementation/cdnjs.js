// Copyright 2026 Google LLC
// SPDX-License-Identifier: MPL-2.0

import axios from 'axios';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getSha256 } from './shared.js';

const STATS_REPO = 'cdnjs/cf-stats';
export const OUTPUT_CSV = 'data/cdnjs-hashes.csv';
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const HASHABLE = /\.(js|mjs|cjs|css|wasm|json|woff|woff2|ttf|otf|svg|gz)$/i;

function getLast12Months() {
  const result = [];
  const now = new Date();
  for (let i = 1; i <= 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    result.push({ year: d.getFullYear(), month: MONTHS[d.getMonth()] });
  }
  return result;
}

async function fetchMonthMarkdown(year, month) {
  const url = `https://raw.githubusercontent.com/${STATS_REPO}/master/${year}/cdnjs_${month}_${year}.md`;
  try {
    const { data } = await axios.get(url);
    return data;
  } catch {
    return null;
  }
}

function extractUrls(markdown) {
  return [
    ...markdown.matchAll(
      /https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/[^\s"'<>)\]]+/g
    ),
  ]
    .map((m) => m[0].replace(/[.,;]+$/, ''))
    .filter((url) => HASHABLE.test(url));
}

export async function run() {
  const months = getLast12Months();
  console.log(`[cdnjs] Fetching top-100 stats for last 12 months...`);

  const allUrls = new Set();
  for (const { year, month } of months) {
    const markdown = await fetchMonthMarkdown(year, month);
    if (!markdown) {
      console.log(`[cdnjs] ${month} ${year}: no file found, skipping`);
      continue;
    }
    const urls = extractUrls(markdown);
    urls.forEach((url) => allUrls.add(url));
    console.log(
      `[cdnjs] ${month} ${year}: ${urls.length} URLs → ${allUrls.size} unique so far`
    );
  }

  const urls = [...allUrls];
  console.log(`[cdnjs] ${urls.length} unique URLs to hash...`);

  const records = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const sha256 = await getSha256(url);
    if (sha256) {
      records.push({ url, sha256 });
      console.log(`[cdnjs] [${i + 1}/${urls.length}] VALID: ${url}`);
    } else {
      console.log(`[cdnjs] [${i + 1}/${urls.length}] OMITTED: ${url}`);
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
  console.log(`[cdnjs] Saved ${records.length} records to '${OUTPUT_CSV}'.`);
  return records;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

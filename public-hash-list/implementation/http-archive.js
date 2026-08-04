// Copyright 2026 Google LLC
// SPDX-License-Identifier: MPL-2.0

// HTTP Archive pipeline for the Public Hash List.
//
// The HTTP Archive monthly crawl records SHA-256 hashes of every response body
// via WebPageTest's payload._body_hash field. A BigQuery query
// (queries/http-archive.sql) identifies resources whose hash appears across ≥100
// independent origins — the k-anonymity privacy threshold — and ranks them by a
// traffic-weighted score (see query for the scoring formula).
//
// Unlike the other sources, hashes here are NOT computed by this pipeline:
// they come directly from the HTTP Archive. The ≥100-origins filter already
// applied in the query ensures every entry represents a resource so widespread
// that its presence in a shared cache reveals nothing specific about a user's
// browsing history.
//
// The query results are published directly by the HTTP Archive at a stable URL.

import axios from 'axios';
import fs from 'fs';
import { fileURLToPath } from 'url';

export const OUTPUT_CSV = 'data/http-archive-hashes.csv';
// Published HTTP Archive report. One JSON array of
// { body_hash, type, num_origins, traffic_weighted_score, sample_url }.
const REPORT_URL =
  'https://cdn.httparchive.org/v1/static/reports/public_hash_list.csv';

export async function run() {
  console.log('[http-archive] Fetching published report...');
  let entries;
  try {
    const { data } = await axios.get(REPORT_URL, {
      responseType: 'json',
      timeout: 30000,
    });
    entries = data;
  } catch (err) {
    console.log(`[http-archive] SKIP: could not fetch report (${err.message}).`);
    return [];
  }

  if (!Array.isArray(entries) || entries.length === 0) {
    console.log('[http-archive] SKIP: empty or unreadable report.');
    return [];
  }

  const records = [];
  let skipped = 0;
  for (const entry of entries) {
    const sha256 = (entry.body_hash ?? '').trim().toLowerCase();
    const url = (entry.sample_url ?? '').trim();
    if (!/^[0-9a-f]{64}$/.test(sha256) || !url) { skipped++; continue; }
    records.push({ sha256, url });
  }

  if (skipped) {
    console.log(`[http-archive] ${skipped} entries skipped (invalid hash or missing URL).`);
  }

  records.sort((a, b) => a.sha256.localeCompare(b.sha256));
  fs.mkdirSync('data', { recursive: true });
  const ws = fs.createWriteStream(OUTPUT_CSV, { encoding: 'utf8' });
  ws.write('sha256,url\n');
  for (const { sha256, url } of records) ws.write(`${sha256},${url}\n`);
  ws.end();
  console.log(`[http-archive] Saved ${records.length} records to '${OUTPUT_CSV}'.`);
  return records;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

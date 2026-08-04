// Copyright 2026 Google LLC
// SPDX-License-Identifier: MPL-2.0

import axios from 'axios';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getSha256 } from './shared.js';

// Primary: discovers the current player ID from the iframe API bootstrap, which
// contains an escaped URL like '...\/s\/player\/445213fb\/...'.
// Method adapted from https://codeberg.org/Fijxu/youtube-player-id-logger
//
// Historical seed: fetches all previously observed IDs from youtube-player-ids.nadeko.net,
// which tracks every player version rolled out. YouTube keeps all versions accessible
// indefinitely, so the full history can be hashed.
export const OUTPUT_CSV = 'data/youtube-player-hashes.csv';
const IFRAME_API_URL = 'https://www.youtube.com/iframe_api';
const PLAYER_LOG_URL = 'https://youtube-player-ids.nadeko.net/';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// All file types associated with each player version in the Chromium pervasive list.
// The five URLs below correspond to the five :v / :v1/:v2/:v3 patterns in
// shared_resource_checker_patterns.h. Hashing all of them per player ID ensures
// complete coverage and allows public-hash-list.dat to deduplicate against
// chromium-pervasive-hashes.csv (which only carries the current player version).
const PLAYER_FILES = [
  (id) => `https://www.youtube.com/s/player/${id}/player_ias.vflset/en_US/base.js`,
  (id) => `https://www.youtube.com/s/player/${id}/player_ias.vflset/en_US/captions.js`,
  (id) => `https://www.youtube.com/s/player/${id}/www-player.css`,
  (id) =>
    `https://www.youtube.com/s/player/${id}/www-widgetapi.vflset/www-widgetapi.js`,
  (id) => `https://www.youtube-nocookie.com/s/player/${id}/www-player.css`,
];

async function getCurrentPlayerId() {
  const { data } = await axios.get(IFRAME_API_URL, {
    headers: { 'User-Agent': UA },
    responseType: 'text',
    timeout: 10000,
  });
  const match = data.match(/player\\\/([0-9a-f]+)\\\//);
  if (!match)
    throw new Error('Could not find player ID in iframe_api response');
  return match[1];
}

async function getHistoricalPlayerIds() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { data } = await axios.get(PLAYER_LOG_URL, {
        headers: { 'User-Agent': UA },
        responseType: 'text',
        timeout: 15000,
      });
      // IDs appear in href attributes: /s/player/<8-hex-chars>/
      const ids = [...new Set(
        [...data.matchAll(/\/s\/player\/([0-9a-f]{8})\//g)].map((m) => m[1])
      )];
      console.log(`[youtube] ${ids.length} historical IDs found at ${PLAYER_LOG_URL}`);
      return ids;
    } catch (err) {
      const reason = err.message || err.code || 'unknown';
      if (attempt < 3) {
        console.log(`[youtube] Historical ID fetch attempt ${attempt} failed (${reason}), retrying in ${attempt * 2}s...`);
        await new Promise((r) => setTimeout(r, attempt * 2000));
      } else {
        console.log(`[youtube] Historical ID fetch failed after 3 attempts: ${reason}`);
      }
    }
  }
  return [];
}

export async function run() {
  console.log(`[youtube] Fetching current player ID from ${IFRAME_API_URL}...`);
  const currentId = await getCurrentPlayerId();
  console.log(`[youtube] Current player ID: ${currentId}`);

  console.log(
    `[youtube] Fetching historical player IDs from ${PLAYER_LOG_URL}...`
  );
  const historicalIds = await getHistoricalPlayerIds();

  const ids = [...new Set([currentId, ...historicalIds])];
  const totalUrls = ids.length * PLAYER_FILES.length;
  console.log(
    `[youtube] ${ids.length} unique player IDs × ${PLAYER_FILES.length} file types = ${totalUrls} URLs to hash...`
  );

  const records = [];

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    // Hash all file types for this player ID in parallel.
    const results = await Promise.all(
      PLAYER_FILES.map(async (fn) => {
        const url = fn(id);
        const sha256 = await getSha256(url);
        return sha256 ? { url, sha256 } : null;
      })
    );
    const valid = results.filter(Boolean);
    records.push(...valid);
    const baseIdx = i * PLAYER_FILES.length + 1;
    const lastIdx = baseIdx + PLAYER_FILES.length - 1;
    const omitted = PLAYER_FILES.length - valid.length;
    console.log(
      `[youtube] [${baseIdx}-${lastIdx}/${totalUrls}] ${id}: ${valid.length} valid` +
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
  console.log(`[youtube] Saved ${records.length} records to '${OUTPUT_CSV}'.`);
  return records;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

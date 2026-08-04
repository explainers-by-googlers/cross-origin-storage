// Copyright 2026 Google LLC
// SPDX-License-Identifier: MPL-2.0

import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getSha256 } from './shared.js';

const TARGET_URL = 'https://developers.google.com/speed/libraries';
export const OUTPUT_CSV = 'data/google-hosted-libraries-hashes.csv';

function getFallbackUrls(libName, version, scriptFilename) {
  const fallbacks = [];

  // Indefinite Observable legacy naming (.bundle.js -> .js)
  if (
    libName === 'indefinite-observable' &&
    scriptFilename.endsWith('.bundle.js')
  ) {
    fallbacks.push(
      `https://ajax.googleapis.com/ajax/libs/${libName}/${version}/indefinite-observable.js`
    );
  }

  // MooTools legacy naming (.min.js -> -yui-compressed.js)
  if (libName === 'mootools' && scriptFilename === 'mootools.min.js') {
    fallbacks.push(
      `https://ajax.googleapis.com/ajax/libs/${libName}/${version}/mootools-yui-compressed.js`
    );
  }

  // Generic fallback: minified -> unminified
  if (scriptFilename.includes('.min.js')) {
    fallbacks.push(
      `https://ajax.googleapis.com/ajax/libs/${libName}/${version}/${scriptFilename.replace('.min.js', '.js')}`
    );
  }

  return fallbacks;
}

export async function run() {
  console.log(`[google] Fetching page data from ${TARGET_URL}...`);

  const { data } = await axios.get(TARGET_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });

  const $ = cheerio.load(data);
  const candidateConfigs = [];

  $('h3[id]').each((_, element) => {
    const libId = $(element).attr('id');
    if (!libId) return;

    let libName = libId.trim();
    let scriptFilename = null;
    const versions = new Set();

    let sibling = $(element).next();
    while (sibling.length && sibling[0].name !== 'h3') {
      const text = sibling.text();

      if (sibling[0].name === 'pre' || sibling.find('code').length) {
        const match = text.match(
          /https:\/\/ajax\.googleapis\.com\/ajax\/libs\/([^/]+)\/[^/'"\s]+\/([^'"\s>]+)/
        );
        if (match) {
          libName = match[1];
          scriptFilename = match[2];
        }
      }

      if (
        text.toLowerCase().includes('version') ||
        ['ul', 'ol', 'p', 'table'].includes(sibling[0].name)
      ) {
        const foundVersions = text.match(/\b\d+\.\d+(?:\.\d+)?(?:[-\w.]+)?\b/g);
        if (foundVersions)
          foundVersions.forEach((v) => versions.add(v.replace(/\.+$/, '')));
      }

      sibling = sibling.next();
    }

    if (!scriptFilename) scriptFilename = `${libName}.js`;
    if (versions.size > 0)
      versions.forEach((version) =>
        candidateConfigs.push({ libName, version, scriptFilename })
      );
  });

  const total = candidateConfigs.length;
  console.log(`[google] ${total} candidate URLs. Hashing...`);

  const records = [];

  for (let i = 0; i < total; i++) {
    const { libName, version, scriptFilename } = candidateConfigs[i];
    const primaryUrl = `https://ajax.googleapis.com/ajax/libs/${libName}/${version}/${scriptFilename}`;

    let sha256 = await getSha256(primaryUrl);
    let finalUrl = primaryUrl;

    if (!sha256) {
      for (const fallback of getFallbackUrls(
        libName,
        version,
        scriptFilename
      )) {
        sha256 = await getSha256(fallback);
        if (sha256) {
          finalUrl = fallback;
          break;
        }
      }
    }

    if (sha256) {
      records.push({ url: finalUrl, sha256 });
      console.log(`[google] [${i + 1}/${total}] VALID: ${finalUrl}`);
    } else {
      console.log(`[google] [${i + 1}/${total}] OMITTED: ${primaryUrl}`);
    }
  }

  records.sort((a, b) => a.sha256.localeCompare(b.sha256));
  fs.mkdirSync('data', { recursive: true });
  const writeStream = fs.createWriteStream(OUTPUT_CSV, { encoding: 'utf8' });
  writeStream.write('sha256,url\n');
  for (const { url, sha256 } of records) {
    const escaped = url.includes(',') ? `"${url}"` : url;
    writeStream.write(`${sha256},${escaped}\n`);
  }
  writeStream.end();
  console.log(`[google] Saved ${records.length} records to '${OUTPUT_CSV}'.`);
  return records;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

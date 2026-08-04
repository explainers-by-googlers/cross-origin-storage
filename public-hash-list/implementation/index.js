// Copyright 2026 Google LLC
// SPDX-License-Identifier: MPL-2.0

// Load .env if present — native Node.js 20.12+, no package required.
try { process.loadEnvFile(); } catch {}

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { groupRecords, formatHashList } from './shared.js';
import { run as runChromium } from './chromium-pervasive.js';
import { run as runCdnjs } from './cdnjs.js';
import { run as runGoogle } from './google-hosted-libraries.js';
import { run as runGoogleMaps } from './google-maps.js';
import { run as runJsdelivr } from './jsdelivr.js';
import { run as runMicrosoft } from './microsoft-ajax.js';
import { run as runNpmPopular } from './npm-popular.js';
import { run as runYouTube } from './youtube-player.js';
import { run as runGoogleFonts } from './google-fonts.js';
import { run as runHuggingFace } from './huggingface.js';
import { run as runHttpArchive } from './http-archive.js';
import { run as runManual } from './manual.js';

const OUTPUT_DAT = 'data/public-hash-list.dat'; // canonical PHL output
const OUTPUT_SHA256 = 'data/public-hash-list.dat.sha256'; // integrity file for the above

// Core (objective, popularity-based) sources and the optional model-hub source.
const CORE_SOURCES = [
  ['google-hosted-libraries', runGoogle],
  ['microsoft-ajax', runMicrosoft],
  ['cdnjs', runCdnjs],
  ['jsdelivr', runJsdelivr],
  ['npm-popular', runNpmPopular],
  ['chromium-pervasive', runChromium],
  ['youtube-player', runYouTube],
  ['google-maps', runGoogleMaps],
  ['google-fonts', runGoogleFonts],
  ['http-archive', runHttpArchive],
];
const HUGGING_FACE_SOURCE = ['huggingface', runHuggingFace];
const MANUAL_SOURCE = ['manual', runManual];

async function collect([source, run]) {
  const records = await run();
  return records.map((r) => ({ ...r, source }));
}

function commitId() {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'uncommitted';
  }
}

async function main() {
  fs.rmSync('data', { recursive: true, force: true });
  fs.mkdirSync('data', { recursive: true });

  const coreTagged = (await Promise.all(CORE_SOURCES.map(collect))).flat();
  const hfTagged = await collect(HUGGING_FACE_SOURCE);
  const manualTagged = await collect(MANUAL_SOURCE);

  const core = groupRecords(coreTagged);
  const huggingface = groupRecords(hfTagged);
  const manual = groupRecords(manualTagged);

  const version = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const commit = commitId();

  // Canonical PHL flat file (the sole combined output).
  const datContent = formatHashList({ core, huggingface, manual, version, commit });
  fs.writeFileSync(OUTPUT_DAT, datContent, 'utf8');

  // Integrity file: SHA-256 of the canonical .dat, in standard shasum format.
  const datHash = crypto.createHash('sha256').update(datContent, 'utf8').digest('hex');
  fs.writeFileSync(OUTPUT_SHA256, `${datHash}  ${path.basename(OUTPUT_DAT)}\n`, 'utf8');

  console.log(
    `\nPHL written to '${OUTPUT_DAT}': ${core.length} core entries, ` +
      `${huggingface.length} model-hub entries, ${manual.length} manual entries.`
  );
  console.log(`SHA-256 integrity file written to '${OUTPUT_SHA256}'.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

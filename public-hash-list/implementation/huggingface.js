// Copyright 2026 Google LLC
// SPDX-License-Identifier: MPL-2.0

import axios from 'axios';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Hand-curated AI model source for the Public Hash List's optional model-hub
// section. Unlike the other sources, inclusion here is NOT gated on an objective
// cross-origin popularity signal: model weights are COS's headline use case yet a
// given build may be used on only a handful of sites, so it would never clear a
// popularity threshold. Eligibility is instead "published on a recognized public
// model hub." The hub is currently the Hugging Face Hub because it is today's
// de facto central hub for openly published models; the design is hub-agnostic,
// and additional hubs can be wired up the same way if the ecosystem shifts.
//
// User agents SHOULD include this section but MAY omit it (see README / design
// doc). It is emitted as a separate section in public-hash-list.dat.
//
// SHA-256 resolution: Hugging Face stores large files via Git LFS. The /raw/
// endpoint returns the tiny LFS pointer file rather than the actual bytes:
//   version https://git-lfs.github.com/spec/v1
//   oid sha256:<64-char hex>
//   size <bytes>
// Swapping /resolve/ → /raw/ in the download URL fetches this pointer (~100 B)
// and the oid IS the SHA-256 of the real file — no downloading GBs of weights.
//
// API: https://huggingface.co/api
//   /models?sort=downloads&full=true&limit=1000  — paginated (cursor via Link header);
//     full=true includes siblings so no per-model API call is needed
// Pointer: https://huggingface.co/:id/raw/:rev/:file   (replaces /resolve/)

export const OUTPUT_CSV = 'data/huggingface-hashes.csv';
const HF_API = 'https://huggingface.co/api';
const HF_HOST = 'https://huggingface.co';
const MAX_MODELS = 10_000;   // cap at 10K (top by downloads)
const PAGE_SIZE = 1_000;     // models per paginated request (HF API max)
const LFS_CONCURRENCY = 50;  // parallel LFS pointer fetches
const REVISION = 'main';
const UA =
  'public-hash-list (https://github.com/WICG/cross-origin-storage/tree/main/public-hash-list/implementation)';
// Large, byte-identical weight/asset formats worth deduplicating via COS.
const HASHABLE = /\.(safetensors|bin|gguf|onnx|tflite|task|pt|npz|model)$/i;

// Fetch up to MAX_MODELS model records (with siblings) via cursor pagination.
// Using full=true so siblings are included in the list response — avoids a
// separate per-model API call for every entry.
async function fetchModels() {
  const models = [];
  let nextUrl = `${HF_API}/models`;
  let params = { sort: 'downloads', direction: -1, limit: PAGE_SIZE, full: true };
  let page = 0;

  while (models.length < MAX_MODELS) {
    const { data, headers } = await axios.get(nextUrl, {
      params,
      headers: { 'User-Agent': UA },
      timeout: 30000,
    });
    models.push(...data);
    page++;
    console.log(`[huggingface] Page ${page}: ${data.length} models (${models.length} total)`);
    if (data.length < PAGE_SIZE) break;

    // Cursor URL from Link: <url>; rel="next"
    const cursor = headers.link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    if (!cursor) break;
    nextUrl = cursor;
    params = undefined; // cursor URL already encodes all params
  }

  return models.slice(0, MAX_MODELS);
}

// Fetch the Git LFS pointer for a /resolve/ URL and extract its SHA-256.
// The pointer is a ~100-byte text file — no model weights are downloaded.
async function lfsHash(resolveUrl) {
  const rawUrl = resolveUrl.replace('/resolve/', '/raw/');
  try {
    const { data } = await axios.get(rawUrl, {
      headers: { 'User-Agent': UA },
      timeout: 8000,
      responseType: 'text',
    });
    const m = data.match(/^oid sha256:([0-9a-f]{64})$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export async function run() {
  console.log(`[huggingface] Fetching up to ${MAX_MODELS.toLocaleString()} models by downloads...`);
  let models;
  try {
    models = await fetchModels();
  } catch (err) {
    console.log(`[huggingface] SKIP: hub unreachable (${err.message}).`);
    return [];
  }
  console.log(`[huggingface] ${models.length} models fetched.`);

  // Build the list of all (url) tuples to hash.
  const entries = [];
  let skipped = 0;
  for (const m of models) {
    const id = m.modelId || m.id;
    if (!id) continue;
    const files = (m.siblings || [])
      .map((s) => s.rfilename)
      .filter((f) => f && HASHABLE.test(f));
    if (!files.length) { skipped++; continue; }
    for (const file of files) {
      entries.push({ url: `${HF_HOST}/${id}/resolve/${REVISION}/${file}` });
    }
  }
  console.log(
    `[huggingface] ${entries.length} hashable files across ${models.length - skipped} models ` +
    `(${skipped} skipped — no weight files). Hashing with concurrency=${LFS_CONCURRENCY}...`
  );

  // Hash all LFS pointers with bounded concurrency.
  const records = [];
  let idx = 0;
  let valid = 0;
  let omitted = 0;

  async function worker() {
    while (idx < entries.length) {
      const i = idx++;
      const { url } = entries[i];
      const sha256 = await lfsHash(url);
      if (sha256) {
        records.push({ url, sha256 });
        valid++;
      } else {
        omitted++;
      }
      if ((i + 1) % 1000 === 0 || i + 1 === entries.length) {
        console.log(`[huggingface]   ${i + 1}/${entries.length} processed (${valid} valid, ${omitted} omitted)`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(LFS_CONCURRENCY, entries.length) }, worker)
  );

  records.sort((a, b) => a.sha256.localeCompare(b.sha256));
  fs.mkdirSync('data', { recursive: true });
  const writeStream = fs.createWriteStream(OUTPUT_CSV, { encoding: 'utf8' });
  writeStream.write('sha256,url\n');
  for (const { url, sha256 } of records) {
    writeStream.write(`${sha256},${url}\n`);
  }
  writeStream.end();
  console.log(`[huggingface] Saved ${records.length} records to '${OUTPUT_CSV}'.`);
  return records;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

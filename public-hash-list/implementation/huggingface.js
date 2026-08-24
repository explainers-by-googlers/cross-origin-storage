// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

// Load .env if present — native Node.js 20.12+, no package required.
try { process.loadEnvFile(); } catch {}

import axios from 'axios';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getSha256, mapLimit, writeHashCsv } from './shared.js';

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
// SCOPE — web-runnable builds only. COS dedupes bytes that browsers fetch, so a
// hash only earns its place here if some in-browser runtime can actually load
// the file. Server/Python-only artifacts (`.safetensors`, `.pt`, `.npz`,
// PyTorch `.bin`) are therefore excluded, which is most of the Hub by volume.
// Scoping happens on two axes at once, because either alone leaks the other's
// noise: a runtime TAG on the model (does a web runtime claim this model?) and
// a FILE FORMAT that that runtime loads (are these the bytes it loads?). A
// `transformers.js` model still ships `.safetensors` siblings for its Python
// users, and a stray `.onnx` file sits in plenty of server-only repos.
//
// API: https://huggingface.co/api
//   /models?filter=<tag>&sort=downloads&limit=1000  — paginated (cursor via Link
//     header). NOTE: `?library=<tag>` is silently IGNORED by the API — it returns
//     the unfiltered list. `filter=` (alias `other=`) is the working parameter,
//     and repeated `filter=` params compose as AND, so the union across runtimes
//     is built with one query per tag and merged here.
//   /models/:id/tree/:rev?recursive=true — every file in the repo with its
//     `size` and, for Git-LFS-backed files, `lfs.oid`, which IS the SHA-256 of
//     the real bytes. One request per model, no model weights downloaded.
//     Files below the Hub's LFS threshold are stored inline in git instead, so
//     they carry no `lfs.oid` (the bare `oid` is a git blob SHA-1, not a
//     SHA-256); those few are hashed by actually fetching the bytes.
// Download URL: https://huggingface.co/:id/resolve/:rev/:file

export const OUTPUT_CSV = 'data/huggingface-hashes.csv';
const HF_API = 'https://huggingface.co/api';
const HF_HOST = 'https://huggingface.co';
const PAGE_SIZE = 1_000;         // models per paginated request (HF API max)
const PER_TAG_MODELS = 2_000;    // top-N by downloads WITHIN each runtime tag
const MAX_MODELS = 10_000;       // overall cap after the union, by downloads
const REVISION = 'main';
const UA =
  'public-hash-list (https://github.com/WICG/cross-origin-storage/tree/main/public-hash-list/implementation)';

// The Hub rate-limits anonymous traffic by IP, and this source makes one request
// per model. An optional read token (free, from huggingface.co/settings/tokens)
// raises that ceiling substantially, so the fetch concurrency is chosen to match
// whichever budget is actually available. Without a token the source still runs
// to completion, just more slowly.
const HF_TOKEN = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || '';
const TREE_CONCURRENCY = HF_TOKEN ? 12 : 6; // parallel repo-tree fetches
const RETRY_CONCURRENCY = 3;                // second pass, for models lost to 429s
const MAX_RETRIES = 6;

// Per-file ceiling for GGUF. GGUF is the one format here that is not
// web-exclusive: it is overwhelmingly a desktop llama.cpp / Ollama format, and
// the `gguf` tag alone spans ~200K models — but wllama and the other
// llama.cpp-WASM builds do run it in a browser, so it belongs in scope. The
// ceiling keeps the section to shards a browser could plausibly fetch and cache
// rather than the datacenter-scale quantizations that share the same tag.
// Applied per file, not per model: large GGUF models ship as numbered shards.
const GGUF_MAX_BYTES = 20 * 1024 ** 3; // 20 GiB

// Files stored inline in git rather than LFS carry no SHA-256 in the tree
// listing, so they are hashed by download. The Hub's LFS threshold keeps these
// small; the cap is a belt-and-braces guard against a mis-configured repo.
const INLINE_MAX_BYTES = 25 * 1024 ** 2; // 25 MiB

// In-browser model runtimes: the Hub tag that marks a model as targeting that
// runtime, and the file formats that runtime actually loads.
// A note on the two narrow patterns: `.bin` is far too generic to allow on its
// own. WebLLM's weights are always `params_shard_<n>.bin`, so that exact shape is
// matched instead; and in LiteRT/TFLite repos a bare `.bin` is overwhelmingly
// CoreML (`coremldata.bin`), ncnn, PyTorch (`pytorch_model.bin`), or training
// leftovers, so `.bin` is not accepted for those runtimes at all.
const WEB_RUNTIMES = [
  { tag: 'transformers.js', ext: /\.onnx$/i },                      // Transformers.js
  { tag: 'onnx', ext: /\.onnx$/i },                                 // ONNX Runtime Web
  { tag: 'mlc-llm', ext: /(^|\/)params_shard_\d+\.bin$/i },         // WebLLM (MLC shards)
  { tag: 'litert', ext: /\.(tflite|task|litertlm)$/i },             // LiteRT.js / MediaPipe
  { tag: 'tflite', ext: /\.(tflite|task|litertlm)$/i },             // TensorFlow Lite / MediaPipe
  { tag: 'gguf', ext: /\.gguf$/i, maxBytes: GGUF_MAX_BYTES },       // wllama / llama.cpp-WASM
];

// Percent-encode a repo-relative path for use in a URL. Hub filenames are
// user-chosen and routinely contain spaces, commas, and `+` (quantization
// recipes baked into the filename, `it,en/` locale directories), none of which
// belong raw in a URL — and a raw comma additionally splits the `sha256,url`
// CSV row this source emits. Segments are encoded individually so the path
// separators survive.
function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

// GET with a bounded retry on rate limiting and transient upstream errors.
// A 429 carries the Hub's own `Retry-After` when it sets one; otherwise back off
// exponentially. Failures that survive the retries are re-thrown so the caller
// can count them rather than silently thinning the list.
async function hfGet(url, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await axios.get(url, {
        params,
        headers: {
          'User-Agent': UA,
          ...(HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {}),
        },
        timeout: 30000,
      });
    } catch (err) {
      const status = err.response?.status;
      const retryable = status === 429 || (status >= 500 && status < 600) || !status;
      if (!retryable || attempt >= MAX_RETRIES) throw err;
      const retryAfter = Number(err.response?.headers?.['retry-after']);
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(1000 * 2 ** attempt, 60_000);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

// Follow the API's `Link: <url>; rel="next"` cursor until `max` items or the
// listing runs out. The cursor URL already encodes every parameter, so params
// are sent on the first request only.
async function fetchPaged(url, params, max) {
  const items = [];
  let nextUrl = url;
  let nextParams = params;

  while (items.length < max) {
    const { data, headers } = await hfGet(nextUrl, nextParams);
    if (!Array.isArray(data)) break; // defensive: an error body is not a listing
    items.push(...data);

    // Stop on the absence of a next cursor rather than on a short page: the
    // models and tree endpoints do not share a page size, so "fewer than
    // PAGE_SIZE items" is not a reliable end-of-listing signal for both.
    const cursor = headers.link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    if (!cursor) break;
    nextUrl = cursor;
    nextParams = undefined;
  }

  return items.slice(0, max);
}

// Fetch the top models for each runtime tag and union them by model id.
// Paging *within* each tag rather than filtering a global top-N matters: the
// global most-downloaded list is dominated by server-side models, so filtering
// it after the fact would leave only a few hundred web-runnable models instead
// of the long tail that actually runs in a browser.
async function fetchWebRunnableModels() {
  const byId = new Map();

  for (const runtime of WEB_RUNTIMES) {
    const models = await fetchPaged(
      `${HF_API}/models`,
      { filter: runtime.tag, sort: 'downloads', direction: -1, limit: PAGE_SIZE },
      PER_TAG_MODELS,
    );
    let fresh = 0;
    for (const m of models) {
      const id = m.modelId || m.id;
      if (!id) continue;
      let entry = byId.get(id);
      if (!entry) {
        entry = { id, downloads: m.downloads || 0, runtimes: [] };
        byId.set(id, entry);
        fresh++;
      }
      if (!entry.runtimes.includes(runtime)) entry.runtimes.push(runtime);
    }
    console.log(
      `[huggingface] tag '${runtime.tag}': ${models.length} models (${fresh} new, ${byId.size} in union)`,
    );
  }

  return [...byId.values()]
    .sort((a, b) => b.downloads - a.downloads)
    .slice(0, MAX_MODELS);
}

// List a model repo's files with sizes and LFS digests. One request per model
// (plus cursor pages for repos with thousands of files). A repo can legitimately
// be gone or gated; a repo lost to rate limiting is a different problem, so the
// two are counted apart — a run that quietly drops half its models to 429s
// should look different from one that found a few dead links.
async function fetchTree(id, stats) {
  try {
    return await fetchPaged(
      `${HF_API}/models/${id}/tree/${REVISION}`,
      { recursive: true },
      Number.MAX_SAFE_INTEGER,
    );
  } catch (err) {
    if (err.response?.status === 429) stats.retry.push(id);
    else stats.unreachable++;
    return null;
  }
}

// Resolve one model repo to its web-runnable {url, sha256} records.
async function modelRecords(model, stats) {
  const tree = await fetchTree(model.id, stats);
  if (!tree) return [];

  const records = [];
  for (const entry of tree) {
    if (entry.type !== 'file' || !entry.path) continue;

    // Eligible if any runtime claiming this model loads this format, and the
    // file is within that runtime's size ceiling (currently GGUF only).
    const matches = model.runtimes.filter((r) => r.ext.test(entry.path));
    if (!matches.length) continue;
    const size = entry.size ?? entry.lfs?.size ?? 0;
    if (!matches.some((r) => !r.maxBytes || size <= r.maxBytes)) {
      stats.oversized++;
      continue;
    }

    const url = `${HF_HOST}/${model.id}/resolve/${REVISION}/${encodePath(entry.path)}`;
    const lfsOid = entry.lfs?.oid;
    if (lfsOid && /^[0-9a-f]{64}$/.test(lfsOid)) {
      records.push({ url, sha256: lfsOid });
      stats.fromLfs++;
      continue;
    }

    // No LFS pointer: the bytes live in git directly, so hash them for real.
    if (size > INLINE_MAX_BYTES) {
      stats.omitted++;
      continue;
    }
    const sha256 = await getSha256(url);
    if (sha256) {
      records.push({ url, sha256 });
      stats.fromDownload++;
    } else {
      stats.omitted++;
    }
  }
  return records;
}

export async function run() {
  console.log(
    `[huggingface] Fetching top ${PER_TAG_MODELS.toLocaleString()} models per web runtime ` +
    `(${WEB_RUNTIMES.map((r) => r.tag).join(', ')})` +
    `${HF_TOKEN ? '' : ' — no HF_TOKEN set, using the anonymous rate limit'}...`,
  );
  let models;
  try {
    models = await fetchWebRunnableModels();
  } catch (err) {
    console.log(`[huggingface] SKIP: hub unreachable (${err.message}).`);
    return [];
  }
  console.log(
    `[huggingface] ${models.length} web-runnable models. Reading repo trees with ` +
    `concurrency=${TREE_CONCURRENCY}...`,
  );

  const stats = { fromLfs: 0, fromDownload: 0, oversized: 0, omitted: 0, unreachable: 0, retry: [] };
  const perModel = await mapLimit(models, TREE_CONCURRENCY, async (model, i) => {
    const records = await modelRecords(model, stats);
    if ((i + 1) % 500 === 0 || i + 1 === models.length) {
      console.log(
        `[huggingface]   ${i + 1}/${models.length} models processed ` +
        `(${stats.fromLfs + stats.fromDownload} files hashed, ${stats.oversized} over size cap)`,
      );
    }
    return records;
  });
  const records = perModel.flat();

  // Even an authenticated run can trip the Hub's limiter on a burst. Those
  // models are not lost causes, just unlucky, so they get one more pass at a
  // gentler concurrency after the burst has drained — the difference between a
  // complete list and one that silently varies run to run.
  if (stats.retry.length) {
    const retrying = models.filter((m) => stats.retry.includes(m.id));
    stats.retry = [];
    console.log(
      `[huggingface] ${retrying.length} models hit the rate limiter; retrying at ` +
      `concurrency=${RETRY_CONCURRENCY} after a pause...`,
    );
    await new Promise((r) => setTimeout(r, 30_000));
    const recovered = await mapLimit(retrying, RETRY_CONCURRENCY, (m) => modelRecords(m, stats));
    const flat = recovered.flat();
    records.push(...flat);
    console.log(
      `[huggingface] Retry pass recovered ${flat.length} files from ` +
      `${retrying.length - stats.retry.length}/${retrying.length} models.`,
    );
  }

  console.log(
    `[huggingface] ${records.length} files hashed (${stats.fromLfs} via LFS pointer, ` +
    `${stats.fromDownload} downloaded); ${stats.oversized} skipped over the ` +
    `${(GGUF_MAX_BYTES / 1024 ** 3).toFixed(0)} GiB GGUF cap, ${stats.omitted} unhashable, ` +
    `${stats.unreachable} repos unreachable.`,
  );
  if (stats.retry.length) {
    console.log(
      `[huggingface] WARNING: ${stats.retry.length} models still dropped to rate ` +
      `limiting after the retry pass${HF_TOKEN ? '' : '. Set HF_TOKEN (free, ' +
      'huggingface.co/settings/tokens) for a complete run'}.`,
    );
  }

  records.sort((a, b) => a.sha256.localeCompare(b.sha256));
  fs.mkdirSync('data', { recursive: true });
  writeHashCsv(OUTPUT_CSV, records);
  console.log(`[huggingface] Saved ${records.length} records to '${OUTPUT_CSV}'.`);
  return records;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

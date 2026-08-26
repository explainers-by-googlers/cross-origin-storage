// Copyright 2026 Google LLC
// SPDX-License-Identifier: Apache-2.0

import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { writeHashCsv } from './shared.js';

// Build-tool source: content-addressed COS chunks emitted by the Nuxt/Vite
// integration at https://github.com/danielroe/cross-origin-storage.
//
//   nuxt-cos                          — thin Nuxt module
//   vite-plugin-cross-origin-storage  — the engine that actually emits chunks
//
// Unlike every other source, these hashes are not scraped from a CDN: no public
// URL serves them. They are *reproduced* by running the real published plugin,
// because the chunks are a pure function of a fixed build recipe:
//
//   chunk bytes = rolldown(resolved package entry, pinned options)
//                 with each dependency import rewritten to `cos1:<dep hash>`
//
// The plugin hashes bottom-up over the dependency DAG, so a chunk's bytes embed
// its dependencies' hashes. Nothing about the host application enters the chunk
// — not the app's own code, not its config, not the build directory — which is
// exactly what makes the artifact shareable across origins in the first place.
// Two independent sites building `vue@3.5.39` under the same recipe therefore
// emit byte-identical chunks, and we can regenerate them here.
//
// What pins the recipe
// --------------------
// The plugin embeds a `RECIPE` constant (currently `cos1`) in every specifier,
// but the constant alone does NOT capture everything: the emitted bytes also
// depend on the exact rolldown/oxc minifier build, whose whitespace choices
// differ between releases. Empirically, `vue@3.5.39` under rolldown 1.1.0,
// 1.1.4 and 1.2.0 all produce *different*, same-length chunks. This is not a
// problem here only because every published plugin version pins rolldown to an
// exact version (`"rolldown": "1.2.0"`, no range), so
//
//   (plugin version, package version) → chunk hash
//
// is a total, reproducible function. Enumerating published plugin versions is
// therefore enough to cover the recipes real sites can be shipping, and a new
// plugin release is picked up automatically on the next weekly run — which
// reports it, via the `--check-recipes` mode at the bottom of this file.
//
// Registry APIs used:
//   https://registry.npmjs.org/nuxt-cos
//   https://registry.npmjs.org/vite-plugin-cross-origin-storage
//   https://registry.npmjs.org/vue

export const OUTPUT_CSV = 'data/nuxt-cos-hashes.csv';
// Deliberately outside `data/`: that directory is the generated hash payload
// (per-source CSVs plus the canonical .dat) and is stored with Git LFS. This is
// a small, human-readable build record that wants a plain diff, and it must
// survive `index.js` clearing `data/` so `--check-recipes` can read it.
export const OUTPUT_RELEASES = 'nuxt-cos-releases.json';

const REGISTRY = 'https://registry.npmjs.org';
const PLUGIN_PKG = 'vite-plugin-cross-origin-storage';
const MODULE_PKG = 'nuxt-cos';
const SOURCE_PKG = 'vue';

// Vite is a peer dependency of the plugin and does not influence chunk bytes
// (the chunks are built by the plugin's own pinned rolldown, not by Vite), but
// it has to resolve `vue` to the same entry a real app would. Each recipe gets
// the newest major its own peer range allows — a fixed range would fail to
// install against older plugin releases, which predate the current Vite major.
// The resolved version is recorded in the recipes file for auditability.
const FALLBACK_VITE_RANGE = '^8';

function viteRangeFor(peerRange) {
  const majors = [...String(peerRange ?? '').matchAll(/\^(\d+)\./g)].map((m) => Number(m[1]));
  return majors.length ? `^${Math.max(...majors)}` : FALLBACK_VITE_RANGE;
}

// 2.0.3 is the first release whose COS manifest records which npm package
// emitted each chunk. Earlier ones can only be attributed by scraping the
// license banner out of the chunk bytes, and 2.0.1 additionally peers
// `vite@^5 || ^6 || ^7`, so under a current Vite it emits nothing at all.
// Starting here keeps attribution a plain manifest read.
const MIN_PLUGIN_VERSION = '2.0.3';

// The module's default managed set, i.e. what every nuxt-cos site emits unless
// it opts into more. Extending this would produce hashes almost no site ships,
// which is the opposite of the ubiquity the PHL is gating on.
const MANAGED_PACKAGES = '[/^(?:vue$|@vue\\/)/]';

// Most recent N releases of each, newest first. The product of the two is the
// number of builds a run performs, so the defaults are chosen to keep the full
// pipeline within its CI budget. Raising them via the env vars widens coverage
// backwards in time; both workflows deliberately use the defaults, because a
// narrower run would otherwise shrink the committed CSV a wider one produced.
const MAX_RECIPES = Number(process.env.NUXT_COS_MAX_RECIPES ?? 4);
const MAX_VUE_VERSIONS = Number(process.env.NUXT_COS_VUE_VERSIONS ?? 15);

// Optional end-to-end check that the Nuxt path agrees with the Vite path.
// Off by default: it installs the whole Nuxt toolchain for a single build.
const NUXT_CHECK = process.env.NUXT_COS_NUXT_CHECK === '1';

const CHUNK_FILE = /^[0-9a-f]{64}\.js$/;

// --- npm helpers -------------------------------------------------------------

function npm(args, cwd) {
  try {
    execFileSync('npm', [...args, '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 15 * 60 * 1000,
    });
  } catch (err) {
    // `execFileSync` reports only "Command failed", which says nothing about
    // *why* — and the interesting failures here (peer conflicts, malformed
    // published manifests) are all explained on npm's stderr.
    const stderr = (err.stderr?.toString() ?? '')
      .split('\n')
      .map((l) => l.replace(/^npm (error|warn) /, '').trim())
      .filter((l) => l && !l.startsWith('A complete log'))
      .slice(0, 3)
      .join('; ');
    throw new Error(stderr || err.message);
  }
}

async function packument(name) {
  const { data } = await axios.get(`${REGISTRY}/${encodeURIComponent(name)}`, {
    timeout: 60000,
  });
  return data;
}

function installedVersion(dir, name) {
  try {
    const pkg = path.join(dir, 'node_modules', ...name.split('/'), 'package.json');
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

// Compare `1.2.3`-style versions; prereleases are filtered out before this.
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

const isStable = (v) => /^\d+\.\d+\.\d+$/.test(v);

// --- recipe + version discovery ---------------------------------------------

// A recipe is one published plugin version. It carries the rolldown version it
// pins (the thing that actually decides the emitted bytes) and the nuxt-cos
// releases that depend on it, so the provenance record answers "which module
// version would have shipped this hash?".
async function getRecipes() {
  const [plugin, module_] = await Promise.all([
    packument(PLUGIN_PKG),
    packument(MODULE_PKG).catch(() => ({ versions: {} })),
  ]);

  // nuxt-cos pins the plugin exactly, so this inverts cleanly.
  const modulesByPlugin = new Map();
  for (const [version, meta] of Object.entries(module_.versions ?? {})) {
    const pinned = meta.dependencies?.[PLUGIN_PKG];
    if (!isStable(version) || !pinned || !isStable(pinned)) continue;
    if (!modulesByPlugin.has(pinned)) modulesByPlugin.set(pinned, []);
    modulesByPlugin.get(pinned).push(version);
  }

  const recipes = [];
  for (const [version, meta] of Object.entries(plugin.versions ?? {})) {
    if (!isStable(version) || compareVersions(version, MIN_PLUGIN_VERSION) < 0) continue;
    const rolldown = meta.dependencies?.rolldown;
    // An exact pin is what makes the recipe reproducible. A range would mean
    // the bytes depend on when the site happened to install, and we could not
    // enumerate the resulting hashes at all.
    if (!rolldown || !isStable(rolldown)) {
      console.log(
        `[nuxt-cos] SKIP ${PLUGIN_PKG}@${version}: rolldown is not pinned to an ` +
          `exact version (${rolldown ?? 'absent'}); its output is not reproducible.`
      );
      continue;
    }
    recipes.push({
      plugin: version,
      rolldown,
      viteRange: viteRangeFor(meta.peerDependencies?.vite),
      nuxtCos: (modulesByPlugin.get(version) ?? []).sort(compareVersions),
    });
  }

  recipes.sort((a, b) => compareVersions(b.plugin, a.plugin));
  return recipes.slice(0, MAX_RECIPES);
}

// Vue releases the whole `@vue/*` family in lockstep with exact interdependency
// pins, so installing `vue@X` pins the entire managed subgraph to X. That keeps
// the matrix linear in the number of versions rather than combinatorial.
async function getSourceVersions() {
  const doc = await packument(SOURCE_PKG);
  const times = doc.time ?? {};
  const versions = Object.entries(doc.versions ?? {})
    .filter(([v, meta]) => {
      if (!isStable(v) || meta.deprecated || Number(v.split('.')[0]) < 3) return false;
      // Some releases ship with their monorepo's `workspace:*` specifiers left
      // unreplaced (vue@3.5.36 is one), so npm cannot install them at all. They
      // are unbuildable rather than merely uninteresting — skip them here so a
      // botched upstream publish does not read as a failure of this source.
      const broken = Object.values(meta.dependencies ?? {}).some((r) =>
        String(r).startsWith('workspace:')
      );
      if (broken) {
        console.log(`[nuxt-cos] SKIP ${SOURCE_PKG}@${v}: published with unresolved workspace: ranges.`);
      }
      return !broken;
    })
    .map(([v]) => v);

  // Newest by publish date, not by semver: a late patch to an older minor is
  // still a version sites are installing today.
  versions.sort((a, b) => Date.parse(times[b] ?? 0) - Date.parse(times[a] ?? 0));
  return versions.slice(0, MAX_VUE_VERSIONS);
}

// --- the probe app -----------------------------------------------------------

// A minimal Vite app whose only job is to pull the managed packages into the
// module graph so the plugin's `resolveId` fires for them. The app's own code
// never reaches a COS chunk.
function scaffold(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!doctype html>\n<html>\n<head><title>cos probe</title></head>\n' +
      '<body><div id="app"></div><script type="module" src="/src/main.js"></script></body>\n</html>\n'
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'main.js'),
    "import { createApp, h } from 'vue';\n" +
      "createApp({ render: () => h('div', 'cos') }).mount('#app');\n"
  );
  fs.writeFileSync(
    path.join(dir, 'vite.config.js'),
    `import { cosPlugin } from '${PLUGIN_PKG}';\n` +
      `export default { logLevel: 'error', plugins: [cosPlugin({ packages: ${MANAGED_PACKAGES} })] };\n`
  );
}

function writeManifestJson(dir, deps) {
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'cos-probe', private: true, type: 'module', version: '0.0.0', dependencies: deps }, null, 2)}\n`
  );
}

// Pull the COS manifest out of the loader `<script>` the plugin injects into
// index.html. It is the plugin's own record of what it emitted, so it maps each
// hash to the npm package that produced it without us having to guess from
// file contents. Scanned with a brace counter because the manifest is inlined
// into minified JS and has no delimiter to anchor a regex on.
function extractManifest(html) {
  const start = html.indexOf('{"base":');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Build one (plugin version, vue version) pair and return its chunk records.
function buildOnce(dir, recipe, vueVersion) {
  writeManifestJson(dir, {
    vite: recipe.viteRange,
    [PLUGIN_PKG]: recipe.plugin,
    [SOURCE_PKG]: vueVersion,
  });
  npm(['install'], dir);

  fs.rmSync(path.join(dir, 'dist'), { recursive: true, force: true });
  execFileSync(process.execPath, [path.join('node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: dir,
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 10 * 60 * 1000,
  });

  const manifest = extractManifest(fs.readFileSync(path.join(dir, 'dist', 'index.html'), 'utf8'));
  if (!manifest?.chunks) {
    throw new Error('the build emitted no COS manifest');
  }

  const assetsDir = (manifest.base ?? '/assets/').replace(/^\/+/, '');
  const records = [];

  for (const chunk of Object.values(manifest.chunks)) {
    if (!CHUNK_FILE.test(chunk.file)) {
      throw new Error(`unexpected chunk file name '${chunk.file}'`);
    }
    const file = path.join(dir, 'dist', assetsDir, chunk.file);
    const bytes = fs.readFileSync(file);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    // The plugin names the file after the digest; recompute it from the bytes
    // rather than trusting the name, and treat a mismatch as fatal — it would
    // mean the artifact we are vouching for is not the one we hashed.
    if (sha256 !== chunk.hash) {
      throw new Error(`digest mismatch for ${chunk.file}: content hashes to ${sha256}`);
    }
    // In-scope releases always name the emitting package. The hash stays good
    // without it, but the representative URL would point at the wrong package,
    // so a future regression is worth saying out loud rather than guessing on.
    if (!chunk.name) {
      console.log(
        `[nuxt-cos] WARNING ${PLUGIN_PKG}@${recipe.plugin}: manifest carries no ` +
          `package name for ${chunk.file}; attributing it to ${SOURCE_PKG}.`
      );
    }
    const name = chunk.name ?? SOURCE_PKG;
    const version = installedVersion(dir, name) ?? vueVersion;
    records.push({
      sha256,
      // No public URL serves these bytes, so the representative identifies the
      // source package version the chunk was built from. See README.
      url: `https://www.npmjs.com/package/${name}/v/${version}`,
    });
  }

  return records;
}

// --- optional Nuxt conformance check ----------------------------------------

// Proves the claim the whole source rests on: that driving the real Nuxt module
// produces hashes we already cover. Any chunk it emits that we did not produce
// is a coverage gap worth seeing, so this reports rather than throws.
function nuxtCheck(root, recipe, vueVersion, covered) {
  const dir = path.join(root, 'nuxt-check');
  const nuxtCosVersion = recipe.nuxtCos.at(-1);
  if (!nuxtCosVersion) {
    console.log(`[nuxt-cos] Nuxt check: no nuxt-cos release pins plugin ${recipe.plugin}, skipping.`);
    return;
  }

  console.log(`[nuxt-cos] Nuxt check: building ${MODULE_PKG}@${nuxtCosVersion} with vue@${vueVersion}...`);
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'nuxt.config.ts'),
    'export default defineNuxtConfig({\n' +
      `  modules: ['${MODULE_PKG}'],\n` +
      "  compatibilityDate: '2025-01-01',\n" +
      `  cos: { packages: ${MANAGED_PACKAGES} },\n` +
      '})\n'
  );
  fs.writeFileSync(
    path.join(dir, 'app', 'app.vue'),
    '<template><main>{{ c }}</main></template>\n' +
      "<script setup>\nimport { ref } from 'vue'\nconst c = ref(0)\n</script>\n"
  );

  try {
    writeManifestJson(dir, { nuxt: '^4', [MODULE_PKG]: nuxtCosVersion, [SOURCE_PKG]: vueVersion });
    npm(['install'], dir);
    execFileSync(process.execPath, [path.join('node_modules', 'nuxt', 'bin', 'nuxt.mjs'), 'build'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 20 * 60 * 1000,
      env: { ...process.env, NUXT_TELEMETRY_DISABLED: '1' },
    });
  } catch (err) {
    console.log(`[nuxt-cos] Nuxt check: SKIP (build failed: ${err.message.split('\n')[0]}).`);
    return;
  }

  const outDir = path.join(dir, '.output', 'public', '_nuxt');
  const emitted = fs.readdirSync(outDir).filter((f) => CHUNK_FILE.test(f));
  const missing = emitted.map((f) => f.replace(/\.js$/, '')).filter((h) => !covered.has(h));

  console.log(
    `[nuxt-cos] Nuxt check: ${emitted.length} chunks emitted, ` +
      `${emitted.length - missing.length} already covered.`
  );
  for (const hash of missing) {
    console.log(`[nuxt-cos] Nuxt check: NOT COVERED ${hash} (widen NUXT_COS_VUE_VERSIONS?)`);
  }
}

// --- main --------------------------------------------------------------------

export async function run() {
  let recipes;
  let vueVersions;
  try {
    [recipes, vueVersions] = await Promise.all([getRecipes(), getSourceVersions()]);
  } catch (err) {
    console.log(`[nuxt-cos] SKIP: registry lookup failed (${err.message}).`);
    return [];
  }

  if (!recipes.length) {
    console.log(`[nuxt-cos] SKIP: no reproducible ${PLUGIN_PKG} release found.`);
    return [];
  }

  console.log(
    `[nuxt-cos] ${recipes.length} build ${recipes.length === 1 ? 'recipe' : 'recipes'} × ` +
      `${vueVersions.length} ${SOURCE_PKG} versions:`
  );
  for (const r of recipes) {
    console.log(
      `[nuxt-cos]   ${PLUGIN_PKG}@${r.plugin} (rolldown ${r.rolldown})` +
        (r.nuxtCos.length ? ` ← ${MODULE_PKG}@${r.nuxtCos.join(', ')}` : '')
    );
  }

  const previous = readExistingHashes();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phl-nuxt-cos-'));
  const records = [];

  try {
    for (const recipe of recipes) {
      const dir = path.join(root, `plugin-${recipe.plugin}`);
      scaffold(dir);
      const hashes = new Set();

      for (const vueVersion of vueVersions) {
        let built;
        try {
          built = buildOnce(dir, recipe, vueVersion);
        } catch (err) {
          console.log(
            `[nuxt-cos] OMITTED ${PLUGIN_PKG}@${recipe.plugin} × ${SOURCE_PKG}@${vueVersion}: ` +
              `${err.message.split('\n')[0]}`
          );
          continue;
        }
        for (const record of built) {
          records.push(record);
          hashes.add(record.sha256);
        }
        console.log(
          `[nuxt-cos] VALID ${PLUGIN_PKG}@${recipe.plugin} × ${SOURCE_PKG}@${vueVersion}: ` +
            `${built.length} chunks`
        );
      }

      recipe.chunkCount = hashes.size;
      recipe.vite = installedVersion(dir, 'vite');

      if (NUXT_CHECK) nuxtCheck(root, recipe, vueVersions[0], hashes);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // Recipes that pin the same rolldown and share the relevant plugin code emit
  // byte-identical chunks, so the same (hash, url) pair can arrive once per
  // recipe. Collapse them — which recipe emitted a hash is not something the
  // PHL carries. (No-op while only one release is in scope.)
  const seen = new Set();
  const rows = records.filter(({ sha256, url }) => {
    const key = `${sha256},${url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Every cell failing means the environment is broken (no npm, no registry),
  // not that the plugin stopped emitting chunks. Writing the empty result would
  // let the scheduled workflow commit away a good hash list, so bail instead.
  if (!rows.length) {
    console.log('[nuxt-cos] SKIP: no chunk was built successfully; leaving existing output untouched.');
    return [];
  }

  const unique = new Set(rows.map((r) => r.sha256));
  rows.sort((a, b) => a.sha256.localeCompare(b.sha256) || a.url.localeCompare(b.url));

  fs.mkdirSync('data', { recursive: true });
  writeHashCsv(OUTPUT_CSV, rows);

  // The build record: which recipes and which source versions this CSV came
  // from. Deliberately just the inputs, not a per-hash table — the CSV's `url`
  // column already names each chunk's package and version, so the only thing a
  // table would add is which recipe emitted a given hash, and there are few
  // enough recipes to simply try them. Keeping this small is the point: it is
  // read by `--check-recipes` and it should diff legibly, which a few hundred
  // rows rewritten on every `vue` release would not.
  fs.writeFileSync(
    OUTPUT_RELEASES,
    `${JSON.stringify(
      {
        source: 'https://github.com/danielroe/cross-origin-storage',
        recipes: recipes.map(({ plugin, rolldown, vite, nuxtCos, chunkCount }) => ({
          plugin,
          rolldown,
          vite,
          nuxtCos,
          chunkCount: chunkCount ?? 0,
        })),
        sourceVersions: vueVersions,
      },
      null,
      2
    )}\n`
  );

  console.log(
    `[nuxt-cos] Saved ${rows.length} rows (${unique.size} unique hashes, ` +
      `${records.length} chunks built) to '${OUTPUT_CSV}'.`
  );
  console.log(`[nuxt-cos] Release record written to '${OUTPUT_RELEASES}'.`);

  if (previous) {
    const added = [...unique].filter((h) => !previous.has(h));
    console.log(
      added.length
        ? `[nuxt-cos] ${added.length} new ${added.length === 1 ? 'hash' : 'hashes'} since the last run.`
        : '[nuxt-cos] No new hashes since the last run.'
    );
  }

  return records;
}

// Read the committed CSV before it is overwritten, so a standalone run can
// report what a new plugin release added. Absent when the full pipeline has
// already cleared `data/`, in which case the comparison is simply skipped.
function readExistingHashes() {
  try {
    const hashes = new Set();
    for (const line of fs.readFileSync(OUTPUT_CSV, 'utf8').split('\n')) {
      const [sha256] = line.split(',');
      if (/^[0-9a-f]{64}$/.test(sha256)) hashes.add(sha256);
    }
    return hashes;
  } catch {
    return null;
  }
}

// --- recipe drift check (`--check-recipes`) ----------------------------------

// Cheap "is a rebuild warranted?" probe for the notification workflow: compares
// the recipes the registry offers today against the ones the committed
// provenance file was built from. A new plugin release changes every chunk it
// emits, so this is the signal that new hashes exist — and it costs two
// registry requests instead of a full matrix rebuild.
async function checkRecipes() {
  const recipes = await getRecipes();
  const discovered = recipes.map((r) => r.plugin);

  let covered = [];
  try {
    covered = (JSON.parse(fs.readFileSync(OUTPUT_RELEASES, 'utf8')).recipes ?? []).map(
      (r) => r.plugin
    );
  } catch {
    console.log(`[nuxt-cos] No '${OUTPUT_RELEASES}' yet — treating every recipe as new.`);
  }

  const added = discovered.filter((v) => !covered.includes(v));
  const changed = added.length > 0;

  console.log(`[nuxt-cos] Published recipes: ${discovered.join(', ') || '(none)'}`);
  console.log(`[nuxt-cos] Covered recipes:   ${covered.join(', ') || '(none)'}`);
  console.log(
    changed
      ? `[nuxt-cos] New ${PLUGIN_PKG} ${added.length === 1 ? 'release' : 'releases'}: ${added.join(', ')}`
      : '[nuxt-cos] No new releases; the committed hashes are up to date.'
  );

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `changed=${changed}\nadded=${added.join(', ')}\n`
    );
  }
  return changed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const task = process.argv.includes('--check-recipes') ? checkRecipes : run;
  task().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

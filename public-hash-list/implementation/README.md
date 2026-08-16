<!--
  Copyright 2026 Google LLC
  SPDX-License-Identifier: Apache-2.0
-->

# Public Hash List

Scrapes popular CDN catalogs and npm popularity rankings, downloads web-relevant
files (`.js`, `.css`, `.wasm`, web fonts, `.json`, `.svg`, pre-compressed `.gz`),
and computes each file's SHA-256 hash. The output is the **Public Hash List
(PHL)** — a [Public Suffix List](https://github.com/publicsuffix/list)-style flat
file that serves as the availability-gating allowlist for the
[Cross-Origin Storage (COS) API](https://wicg.github.io/cross-origin-storage/),
a content-addressable cache for the web.

The hash algorithm is currently **SHA-256** (matching COS's requirement that a
hash value be a 64-character lowercase hex string), but the format carries the
algorithm explicitly so it can migrate later without a redesign — see
[Output format](#output-format).

## Relationship to the official PHL proposal

The design rationale, requirements, and governance model for the PHL are
formally written up in the [PHL explainer](../phl-explainer.md), the
companion document to the Cross-Origin Storage explainer/spec this repository
publishes. This directory is the proposal's **early implementation**.

The explainer's [Governance](../phl-explainer.md#governance) section describes
a target end state — a dedicated repository hosted under the WHATWG, with
editors from at least two browser vendors and a file signed with WHATWG
infrastructure keys — that this repository does not implement. Housing the
implementation here, alongside the spec and the explainer, is a pragmatic
interim step, not the destination: a single-vendor repository is exactly the
kind of arrangement the target governance model exists to move away from.
Until a dedicated, cross-vendor repository materializes, this directory is
maintained informally, following the explainer's methodology (source
selection, inclusion criteria, data format) as closely as practical.

## Why this matters for Cross-Origin Storage

COS lets browsers share cached files across origins by SHA-256 hash, so a large
library downloaded once on site A can be reused on site B without a second
download. The privacy challenge is that checking whether a file is cached can
act as a cross-site tracking signal: if a file is rare or unique to a small
number of sites, its presence in the cache reveals which sites a user has
visited.

The mitigation is an allowlist of _well-known_ resources — files so widely
deployed that their presence in the cache tells an attacker nothing specific
about a user's browsing history. This project generates that allowlist by
gathering SHA-256 hashes from hand-curated CDNs and ranking candidates by
real-world popularity. Revealing a file's presence only once it has been
encountered across a sufficiently large number of independent origins is a form
of **k-anonymity**: no resource in the list is associated with a small enough
set of sites to act as a cross-site identifier.

## This works today

The [vite-plugin-cross-origin-storage](https://github.com/tomayac/vite-plugin-cross-origin-storage)
plugin demonstrates the full pipeline in practice: it splits bundled
`node_modules` dependencies into per-package vendor chunks at build time,
computes their SHA-256 hashes, and uses COS at runtime to serve those chunks
from a shared cross-origin cache. Sites built with the plugin that share common
dependencies (React, lodash, etc.) will find those chunks already cached across
visits — no repeated downloads.

[`danielroe/cross-origin-storage`](https://github.com/danielroe/cross-origin-storage)
— the `nuxt-cos` Nuxt module and the Vite plugin it wraps — makes those chunks
*reproducible*: the filename and inter-chunk references derive from a SHA-256 of
the contents under a pinned build recipe, so two independent sites building the
same dependency at the same version emit the same chunk with no central registry.
That is what the [`nuxt-cos` source](#build-tool-source-nuxt-cos--vite-plugin-cross-origin-storage)
covers — the one source here whose hashes are regenerated rather than downloaded.

The allowlist this project generates is otherwise the complement: it covers files
loaded directly from public CDNs (as opposed to build-tool-generated chunks), and
seeds the well-known-resources list with packages that are candidates for
COS sharing regardless of how they are currently loaded.

## Supported sources

| Source | Method | Output |
| --- | --- | --- |
| [Google Hosted Libraries](https://developers.google.com/speed/libraries) | Scrapes the catalog page, reconstructs CDN URLs | [`data/google-hosted-libraries-hashes.csv`](https://github.com/WICG/cross-origin-storage/blob/main/public-hash-list/implementation/data/google-hosted-libraries-hashes.csv) |
| [Microsoft Ajax CDN](https://learn.microsoft.com/en-us/aspnet/ajax/cdn/overview) | Extracts URLs listed directly on the docs page | [`data/microsoft-ajax-hashes.csv`](https://github.com/WICG/cross-origin-storage/blob/main/public-hash-list/implementation/data/microsoft-ajax-hashes.csv) |
| [cdnjs](https://cdnjs.com) | Parses the top-100 most-requested resources from the last 12 months of [Cloudflare usage stats](https://github.com/cdnjs/cf-stats) | [`data/cdnjs-hashes.csv`](https://github.com/WICG/cross-origin-storage/blob/main/public-hash-list/implementation/data/cdnjs-hashes.csv) |
| [jsDelivr](https://www.jsdelivr.com) | Fetches the top 100 npm packages by actual jsDelivr CDN hit count (last month); resolves each to its latest stable version; hashes the canonical JS and CSS entry points identified by jsDelivr's entrypoints API | [`data/jsdelivr-hashes.csv`](https://github.com/WICG/cross-origin-storage/blob/main/public-hash-list/implementation/data/jsdelivr-hashes.csv) |
| [npm popularity](https://www.npmjs.com) | Ranks cdnjs-hosted packages by npm download count; hashes all web-relevant files for the top 100's latest version on cdnjs (see below) | [`data/npm-popular-hashes.csv`](https://github.com/WICG/cross-origin-storage/blob/main/public-hash-list/implementation/data/npm-popular-hashes.csv) |
| [Chromium pervasive resources](https://chromium.googlesource.com/chromium/src/+/lkgr/services/network/pervasive_resources/shared_resource_checker_patterns.h) | Reads Chromium's pervasive resource allowlist and hashes every concrete, versioned, non-rotating URL in it; resolves the current version of Google Maps and YouTube Player from their respective bootstrap endpoints; certain hosts are excluded from pattern resolution (see below) | [`data/chromium-pervasive-hashes.csv`](https://github.com/WICG/cross-origin-storage/blob/main/public-hash-list/implementation/data/chromium-pervasive-hashes.csv) |
| [YouTube Player](https://www.youtube.com/iframe_api) _(extends Chromium)_ | Discovers all historical player IDs from [nadeko.net](https://youtube-player-ids.nadeko.net/) in addition to the current one; hashes the same five file types per version that Chromium tracks (see below) | [`data/youtube-player-hashes.csv`](https://github.com/WICG/cross-origin-storage/blob/main/public-hash-list/implementation/data/youtube-player-hashes.csv) |
| [Google Maps JavaScript API](https://developers.google.com/maps/documentation/javascript) _(extends Chromium)_ | Probes all currently available quarterly versions (3.NN) via their versioned bootstrap URLs; hashes 34 JS files per version (23 on `maps.googleapis.com`, 11 on the `maps.google.com` mirror) including the files Chromium tracks plus additional API modules (see below) | [`data/google-maps-hashes.csv`](https://github.com/WICG/cross-origin-storage/blob/main/public-hash-list/implementation/data/google-maps-hashes.csv) |
| [Google Fonts](https://fonts.google.com) | Fetches all font families from the Google Fonts catalog (sorted by popularity); for each family, requests the CSS2 API with all weights and styles to discover versioned `fonts.gstatic.com` woff2 URLs; hashes every unique file. Requires `GOOGLE_FONTS_API_KEY` env var (free key from Google Cloud Console). | [`data/google-fonts-hashes.csv`](https://github.com/WICG/cross-origin-storage/blob/main/public-hash-list/implementation/data/google-fonts-hashes.csv) |
| [HTTP Archive](https://httparchive.org) | Reads the HTTP Archive's published query results (see [`queries/http-archive.sql`](queries/http-archive.sql)) directly from a stable HTTP Archive URL; takes hashes present on ≥100 independent origins (the k-anonymity gate is enforced in the query). No network downloads — the HTTP Archive crawl already provides the SHA-256 of every response body. | [`data/http-archive-hashes.csv`](https://github.com/WICG/cross-origin-storage/blob/main/public-hash-list/implementation/data/http-archive-hashes.csv) |
| [nuxt-cos / vite-plugin-cross-origin-storage](https://github.com/danielroe/cross-origin-storage) | Reproduces the content-addressed COS chunks the Nuxt/Vite integration emits, by running the real published plugin over a matrix of plugin releases × `vue` releases. No download: these bytes exist only in site builds, and are regenerated here from the pinned build recipe; see [Build-tool source](#build-tool-source-nuxt-cos--vite-plugin-cross-origin-storage) | [`data/nuxt-cos-hashes.csv`](https://github.com/WICG/cross-origin-storage/blob/main/public-hash-list/implementation/data/nuxt-cos-hashes.csv) |
| [Hugging Face Hub](https://huggingface.co) _(hand-curated, optional)_ | Lists the most-downloaded models and hashes their large weight/asset files (`.safetensors`, `.gguf`, `.onnx`, `.tflite`, `.task`, …); see [Model-hub source](#model-hub-source-hugging-face) | [`data/huggingface-hashes.csv`](https://github.com/WICG/cross-origin-storage/blob/main/public-hash-list/implementation/data/huggingface-hashes.csv) |
| Manual additions | Hand-curated entries proposed via pull request and reviewed against the ubiquity criteria; see [`manual-additions.json`](manual-additions.json) and [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) | [`data/manual-hashes.csv`](https://github.com/WICG/cross-origin-storage/blob/main/public-hash-list/implementation/data/manual-hashes.csv) |

The first ten sources are **objective**: a resource qualifies mechanically, with
no per-entry judgement — nine through a real-world popularity signal (CDN request
volume, npm downloads, cross-CDN byte-identity, or browser-vendor vetting), and
the tenth (`nuxt-cos`) through byte-for-byte reproducibility from a public,
pinned build recipe. The Hugging Face and manual sources
are different — **hand-curated** — and each land in their own section of the
output; see [Model-hub source](#model-hub-source-hugging-face) and
[Manual additions](#manual-additions). This source set is not fixed: unpkg and
additional web-font providers are obvious future additions, and adding one is a
governance action, not a format change.

## Output format

The canonical, continuously updated output is the Public Hash List at
[`data/public-hash-list.dat`](https://github.com/WICG/cross-origin-storage/blob/main/public-hash-list/implementation/data/public-hash-list.dat),
a flat text file modeled on the Public Suffix List. Everything under `data/`
is stored with [Git LFS](https://git-lfs.com/), so `raw.githubusercontent.com`
links resolve to an LFS pointer, not the file content; fetch the real bytes from
`media.githubusercontent.com` instead, e.g.
[`media.githubusercontent.com/media/WICG/cross-origin-storage/refs/heads/main/public-hash-list/implementation/data/public-hash-list.dat`](https://media.githubusercontent.com/media/WICG/cross-origin-storage/refs/heads/main/public-hash-list/implementation/data/public-hash-list.dat).

The design rationale: a user
agent needs exactly one thing at runtime — _given a hash, is it on the list?_ —
so the machine-readable payload is just bare lowercase SHA-256 digests, one per
line. Everything else (which source vouched for an entry, a representative URL)
is provenance for humans and auditors, carried in `//` comment lines that parsers
ignore. This is the same split the PSL uses, it diffs cleanly line-by-line, and
it deliberately drops the `sources`, `mirror_count`, and `first_seen` columns an
earlier CSV used: the first two are build-time inputs, and `first_seen` is
effectively unknowable from a snapshot scrape.

```
// Public Hash List (PHL)
// ...
// VERSION: 2026-06-19T13:20:00Z
// COMMIT: a8a680c
// Algorithm: SHA-256 (lowercase hex, 64 chars)
//
// ===BEGIN SHA-256===
// Popularity-corroborated resources. User agents MUST treat these as eligible.
//
// cdnjs (Cloudflare request rank), Chromium pervasive, Google Hosted Libraries, Microsoft Ajax CDN — e.g. https://code.jquery.com/jquery-3.4.1.min.js
0925e8ad7bd971391a8b1e98be8e87a6971919eb5b60c196485941c3c1df089a
// ===END SHA-256===
//
// ===BEGIN SHA-256 HUGGING-FACE===
// Hand-curated AI model resources. User agents SHOULD include this section; a UA MAY omit it.
// ===END SHA-256 HUGGING-FACE===
//
// ===BEGIN SHA-256 MANUAL===
// Hand-curated additions reviewed and merged via pull request.
// See manual-additions.json and .github/PULL_REQUEST_TEMPLATE.md.
// User agents MUST treat these as eligible (same as the core section).
//
6d567d7c2f46febcdeaf874614d63e3192ff3a844ee34f8bb63f4c5cf259f233
// ===END SHA-256 MANUAL===
```

Entries are sorted by hash, so all mirrors of one file collapse to a single
entry whose comment lists every source that vouched for it (the jQuery example
above is byte-identical across four independent catalogs). Keying by **content
hash rather than URL** is deliberate and is why those four mirrors are one row,
not four.

**Algorithm agility.** The algorithm is declared by the section delimiter
(`===BEGIN SHA-256===`) rather than per line, so a future migration is additive:
a parallel `===BEGIN SHA-384===` section can coexist during a transition and one
file serves both old and new user agents.

The per-source `*-hashes.csv` files are intermediate inputs to the combined list;
they remain CSV (`sha256,url`, sorted by hash) and are regenerated by running
each source.

### Model-hub source (Hugging Face)

The objective sources all rest on a measurable popularity signal. AI model
weights — COS's headline use case — do not fit that mold: a specific model build
may be hugely valuable to deduplicate yet appear on only a handful of sites, so
it would never clear a popularity threshold. The model-hub source therefore
qualifies entries on a different basis — _published on a recognized public model
hub_ — and places them in a separate, optional `===BEGIN SHA-256 HUGGING-FACE===`
section. The disclosure such an entry permits is coarse interest inference
("this user runs in-browser AI models"), not identification of a specific site,
because the artifacts are public hub downloads rather than site-unique secrets.

Because it departs from the objective bar, this section is **optional but
strongly encouraged**: user agents **SHOULD** include it and **MAY** omit it.
The catch is that the AI use case only pays off under uniform adoption — a user
agent that includes the section lets multi-gigabyte weights be downloaded once
and shared across origins, while one that omits it forces those downloads to
repeat per origin. Uneven adoption therefore hands a real performance advantage
to the including user agents, which runs against the PHL's whole purpose as a
neutral cross-vendor resource; full adoption is **RECOMMENDED**.

The hub is currently the Hugging Face Hub because it is today's de facto central
hub for openly published models. The design is hub-agnostic: the inclusion basis
is "a recognized public model hub," and additional hubs can be wired up the same
way if the ecosystem's center of gravity shifts.

### Manual additions

Unlike the pipeline sources, manual additions are proposed by contributors,
reviewed in a pull request against the same ubiquity bar the objective sources
use, and merged by a maintainer. Once merged, `manual.js` reads
[`manual-additions.json`](manual-additions.json) and writes
`data/manual-hashes.csv`; that CSV is woven into `public-hash-list.dat` by the
main pipeline under the `===BEGIN SHA-256 MANUAL===` section. User agents **MUST**
treat entries in this section as eligible — they carry the same semantics as the
core section.

Each entry in `manual-additions.json` follows this schema:

```json
{
  "url": "https://example.com/resource.js",
  "sha256": "<64-char lowercase hex>",
  "description": "Human-readable name and source",
  "rationale": "Why this resource meets the ubiquity bar",
  "added": "2026-06-24",
  "pr": 42
}
```

The `sha256` is the hash **of the file bytes at `url`** at time of submission.
It is **not re-verified at build time** — the hash _is_ the identity, and a
server changing the served bytes would produce a different hash that UAs would
reject anyway. The `pr` field is the GitHub PR number that introduced the entry,
or `null` before merge.

**Inclusion bar**: the resource must be deployed across so many independent sites
that its presence in a shared cache reveals nothing specific about a user's
browsing history — the same bar the objective sources apply. Concrete signals
help: estimated embedding count, CDN hit statistics, references in well-known
open-source projects.

To propose a new entry, open a pull request using the template at
[`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md), which
includes an independent verification command (`curl | sha256sum`) and a checklist
reviewers use to confirm ubiquity.

## Source details

### jsDelivr (CDN hit count)

jsDelivr's stats API ranks packages by actual CDN hit count — real browser
requests to `cdn.jsdelivr.net`. A file that gets billions of CDN hits per month
is loaded cross-origin by so many unrelated sites that its presence in cache
reveals nothing about a user's browsing history, which is the core COS fitness
criterion. This pipeline captures what is already being shared cross-origin
today.

The pipeline uses three API calls per package:

1. **Top packages** — `GET /v1/stats/packages?by=hits&type=npm&period=month&limit=200`
   returns the top npm packages by CDN hit count. GitHub-type packages are
   excluded (they don't follow stable semver CDN URL patterns).
2. **Version resolution** — `GET /v1/packages/npm/:pkg/resolved` returns the
   latest stable version, used to construct the pinned CDN URL.
3. **Entrypoints** — `GET /v1/packages/npm/:pkg@:version/entrypoints` returns
   the canonical JS and CSS file for the package, determined by jsDelivr's
   heuristics over package metadata and real usage patterns.

### npm popularity (forward-looking)

The npm pipeline is forward-looking: it seeds the allowlist with packages that
are universally used across the JS ecosystem today, whether or not they are
currently loaded from a CDN. The goal is to help shape a future where
frameworks and libraries that are today bundled into every app are instead
shared via COS — either loaded from public CDN URLs or, as the
[vite-plugin-cross-origin-storage](https://github.com/tomayac/vite-plugin-cross-origin-storage)
already demonstrates, via build-tool-generated vendor chunks whose hashes are
registered in the allowlist.

A package downloaded 50 million times a month by independent projects is a
strong candidate for cross-origin sharing, regardless of whether the ecosystem
has yet converged on loading it that way. React is the canonical example: it is
heavily bundled today, but a future version designed around COS-friendly loading
would benefit immediately from an allowlist that already contains its hashes.

The pipeline uses three steps:

1. **Seed** — fetch the top 1,000 packages from the
   [cdnjs API](https://api.cdnjs.com/libraries?fields=name&limit=1000).
   This constrains candidates to packages that already have a stable
   CDN-hosted artifact, which is the prerequisite for public CDN sharing.
2. **Name resolution** — for each cdnjs library, fetch its package config from
   the [cdnjs/packages](https://github.com/cdnjs/packages) repo and read
   `autoupdate.target` to get the canonical npm package name. Many cdnjs names
   differ from their npm equivalents (e.g. `three.js` → `three`, `moment.js` →
   `moment`); this step corrects ~140 of the 1,000 entries.
3. **Ranking** — batch-query the
   [npm downloads API](https://api.npmjs.org/downloads/point/last-month/) with
   the resolved npm names, sort descending, take the top 100, and hash all
   web-relevant files for each package's latest cdnjs version.

### Google Fonts

Google Fonts is the dominant public web-font CDN, serving fonts from
`fonts.gstatic.com` across a vast fraction of the Web. Font files are
versioned (e.g. `/s/roboto/v32/…`), so the same bytes are delivered to
every browser that requests a given family/weight/style/subset combination
— exactly the property that makes them safe COS candidates.

The pipeline has two stages:

1. **Catalog** — `GET /webfonts/v1/webfonts?key=…&sort=popularity` returns all
   ~1,500 font families with their variant lists (weights and italic flags).
2. **woff2 discovery** — families are batched (10 per request) into CSS2 API
   calls (`fonts.googleapis.com/css2?family=…`) with a modern Chrome
   `User-Agent`, which causes Google to return woff2 `@font-face` blocks.
   Without a `text=` parameter, all Unicode subsets (latin, latin-ext,
   cyrillic, greek, …) are included, one `@font-face` block each.
   The `fonts.gstatic.com/…woff2` URLs are extracted from the CSS.
3. **Hashing** — the discovered woff2 URLs are hashed concurrently (20
   parallel downloads).

The result is the SHA-256 of every woff2 file that a browser would download
when loading any Google Font in any weight, style, or script. Requires a
free `GOOGLE_FONTS_API_KEY` environment variable (obtainable from the Google
Cloud Console with the Web Fonts Developer API enabled).

### HTTP Archive

The [HTTP Archive](https://httparchive.org/) crawls millions of URLs monthly
using [WebPageTest](https://www.webpagetest.org/) and records the SHA-256 hash
of every response body in the `payload._body_hash` BigQuery field. Because the
HTTP Archive already computes these hashes from real browser crawl data, this
pipeline requires no network downloads of its own.

The eligibility criterion mirrors the rest of the PHL: a resource qualifies if
its hash appears across **≥100 independent origins** (`NET.HOST(url)`) in the
crawl data. This is the k-anonymity privacy gate — a file that widespread cannot
serve as a cross-site identifier. The query also applies a traffic-weighted score
(`SUM(100_000 / min_rank)`) so that resources carried by high-traffic pages rank
highest. Only `script`, `css`, `font`, and `wasm` response types are included.

The BigQuery query is stored in [`queries/http-archive.sql`](queries/http-archive.sql)
and is run monthly against `httparchive.crawl.requests` at
`date = DATE_TRUNC(CURRENT_DATE(), MONTH)`. Results are published directly by
the HTTP Archive at a stable URL:

- **Report**: <https://cdn.httparchive.org/v1/static/reports/public_hash_list.csv>

`http-archive.js` fetches that report, validates that each `body_hash` is a
well-formed 64-character lowercase hex string, and writes
`data/http-archive-hashes.csv`. No API key is required.

### Build-tool source (nuxt-cos / vite-plugin-cross-origin-storage)

Every other source scrapes bytes that a public URL already serves. This one
cannot: the artifacts it covers are produced *inside site builds* by
[`nuxt-cos`](https://github.com/danielroe/cross-origin-storage/tree/main/packages/nuxt-cos)
and the Vite plugin it wraps, and no CDN hosts them. `nuxt-cos.js` therefore
**reproduces** them, by installing the real published plugin and running it.

That works because the plugin's output is a pure function of its inputs. It
extracts each managed package into a standalone chunk, rewrites every dependency
import to `cos1:<dependency hash>`, and names the file after the SHA-256 of the
result — hashing bottom-up over the dependency graph. Nothing from the host
application enters a chunk: not the app's code, not its config, not the build
directory. That is precisely what makes the chunk shareable across origins, and
it is also what lets this pipeline regenerate it. Two unrelated sites building
`vue@3.5.39` under the same recipe emit byte-identical chunks; so do we.

**What pins the recipe.** The plugin embeds a `RECIPE` constant (`cos1`) in every
specifier, but that constant alone is not the whole story: the emitted bytes also
depend on the exact rolldown/oxc minifier build. Empirically, `vue@3.5.39` under
rolldown 1.1.0, 1.1.4 and 1.2.0 yields three *different* chunks, differing only in
minifier whitespace. This is tractable only because every published plugin version
pins rolldown to an exact version (`"rolldown": "1.2.0"`, no range), which makes

    (plugin version, package version) → chunk hash

a total, reproducible function. The pipeline enumerates published plugin releases
from the npm registry rather than hard-coding them, so a new release is picked up
on the next run — and skips any release whose rolldown dependency is a *range*,
since such a release produces bytes that depend on when a site happened to
install and cannot be enumerated at all.

**Which releases are in scope.** Releases from 2.0.3 onwards. That is the first
one whose COS manifest records which npm package emitted each chunk; attributing
earlier chunks means scraping the license banner out of the chunk bytes instead,
which is worth neither the code nor the fragility. Releases before 2.0.0 are not
candidates at all — they bundled with esbuild and emitted no `cos1:` chunks, a
different artifact rather than an older recipe for the same one. Of the two
releases in between, 2.0.1 peers `vite@^5 || ^6 || ^7` and so emits nothing under
a current Vite, and 2.0.2 pins the same rolldown as 2.0.1 and produces chunks
byte-identical to it.

**Coverage.** The managed set is the module's default, `[/^(?:vue$|@vue\/)/]` —
what every `nuxt-cos` site emits unless it opts into more. Widening it here would
produce hashes almost no site ships. Because Vue releases the whole `@vue/*`
family in lockstep with exact interdependency pins, installing `vue@X` pins the
entire managed subgraph to `X`, so the matrix stays linear in the number of
versions instead of combinatorial. Defaults cover the 4 most recent plugin
releases × 15 most recent `vue` releases; see [Environment variables](#environment-variables).

**Verification.** The Nuxt module contributes nothing to chunk *content* — it is
a thin wrapper that passes `packages` and `base` through — so the matrix is built
with plain Vite, which is an order of magnitude cheaper than a Nuxt build. Set
`NUXT_COS_NUXT_CHECK=1` to prove that: it builds a real Nuxt app with the actual
`nuxt-cos` module and reports whether every chunk it emits is already covered.
Each chunk is also re-hashed from its bytes rather than trusting the plugin's
filename, and a mismatch is fatal.

Running that check confirms the equivalence: a real Nuxt build with
`nuxt-cos@2.0.3` emits 5 chunks, all 5 already covered. Running it against
`nuxt-cos@2.0.1` is also what established that release emits nothing at all under
a current Nuxt.

**Representative URLs.** Since no URL serves these bytes, the `url` column
identifies the *source package version* the chunk was built from
(`https://www.npmjs.com/package/@vue/shared/v/3.5.39`) rather than a download
location. That is enough to reproduce an entry: install the named package version
alongside one of the recipes in
[`nuxt-cos-releases.json`](nuxt-cos-releases.json) and run a
one-file Vite build. That file records the *inputs* a run used — the recipes and
the source versions — rather than a per-hash table, since the CSV already names
each chunk's package and version and there are few enough recipes to just try
them. It is kept out of `data/` deliberately: that directory is the generated hash
payload and is stored with Git LFS, whereas this is a small build record that
wants a plain, legible diff — and it has to survive `index.js` clearing `data/`,
because the automation below reads it.

**Automation.** This source has no schedule of its own — it runs with the weekly
[`.github/workflows/public-hash-list.yml`](../../.github/workflows/public-hash-list.yml)
pipeline, since checking more often than the PHL is published would not get a new
hash onto the list any sooner. A new plugin release invalidates every hash the
previous one produced, so the pipeline runs `node nuxt-cos.js --check-recipes`
first (two registry requests, before the rebuild overwrites the file it compares
against) and names any new release in the run summary. The commit is the
notification; `nuxt-cos-releases.json` is committed next to the CSV so that
change is legible, which an LFS-stored CSV would not be.

**Caveat: ubiquity.** These entries are objectively derived but, unlike the
popularity-ranked sources, they carry no evidence of *deployment* — the
integration is experimental and adoption today is minimal, so a chunk's presence
in a cache is not yet the non-signal the k-anonymity bar asks for. They are
included in the core section as a deliberate seeding decision: the artifacts are
deterministically reproducible by anyone from public inputs, they are exactly the
resources COS sharing is meant to cover, and the integration's own roadmap has
gating chunk sharing on this list as an open item — which cannot happen while the
list is empty of them. If that trade is judged wrong, moving them out is a
one-line change to `CORE_SOURCES` in [`index.js`](index.js).

### Chromium-extended pipelines

Chromium's pervasive resource list
([`shared_resource_checker_patterns.h`](https://chromium.googlesource.com/chromium/src/+/lkgr/services/network/pervasive_resources/shared_resource_checker_patterns.h))
contains URL patterns for resources observed across many sites, with `:v`
placeholders for version components. The `chromium-pervasive` scraper resolves
these to the **current** version at run time. YouTube and Google Maps have
a meaningful history of versions still actively served and cached, so two
dedicated scrapers extend that coverage with historical versions.

**YouTube Player** (`youtube-player.js`): Chromium tracks five URL patterns per
player version (`base.js`, `captions.js`, `www-player.css`,
`www-widgetapi.js`, and the `youtube-nocookie.com` mirror of `www-player.css`).
`youtube-player.js` fetches all historical player IDs from
[nadeko.net](https://youtube-player-ids.nadeko.net/) and hashes the same five
files for each. The current version's URLs appear in both outputs and are
deduplicated in `public-hash-list.dat`.

**Google Maps JavaScript API** (`google-maps.js`): The pipeline probes 34 JS
files per Maps version — 23 on `maps.googleapis.com` (the 14 files Chromium
tracks: `common.js`, `controls.js`, `geocoder.js`, `geometry.js`,
`infowindow.js`, `log.js`, `main.js`, `map.js`, `marker.js`, `onion.js`,
`places_impl.js`, `search.js`, `search_impl.js`, `util.js`; plus 9 additional
API modules: `directions.js`, `drawing.js`, `elevation.js`, `overlay.js`,
`places.js`, `poly.js`, `streetview.js`, `visualization.js`, `weather.js`) and
11 on the `maps.google.com` mirror (those same 9 additional modules plus
`common.js` and `util.js`). `google-maps.js` probes a rolling window of quarterly
versions (3.NN) derived from the current date, extracts each version's internal
`(channel, release)` pair from the bootstrap self-reference, and hashes all 34
files. The version window updates automatically so no manual changes are needed
as new versions ship.

### URL pattern resolution: excluded hosts

Some hosts in the Chromium pervasive list are excluded from URL pattern
resolution. This is not a COS fitness judgment — ubiquitous files from any
domain are valid COS candidates. The exclusion exists because resolving a
versioned `:v` pattern for a tracking or ad domain and adding it to the
allowlist could undermine per-request tracking protections by allowing those
files to persist in a shared cross-origin cache. Concrete versioned URLs from
those hosts that appear directly in the Chromium list (without `:v` placeholders)
are not blocked — they are stable, widely cached, and appropriate COS candidates.

**reCAPTCHA** (`recaptcha/releases/:v/...`) is also excluded, for a different
reason: the release token rotates frequently and opaquely with no public version
log, so hashes go stale almost immediately. More fundamentally, the
`recaptcha__*.js` files carry active bot-detection logic that Google deliberately
rotates to stay ahead of adversaries; COS caching would directly undermine that.
The `styles__ltr.css` file is technically hashable but not worth including given
how short-lived each token is.

## Environment variables

Some sources require API keys. Keys are loaded automatically from a `.env`
file in the repository root using Node.js's built-in
[`process.loadEnvFile()`](https://nodejs.org/api/process.html#processloadenvfilepath)
(Node.js 20.12+, no package required).

```bash
cp .env.example .env   # then fill in your keys
```

| Variable | Required by | How to obtain |
| --- | --- | --- |
| `GOOGLE_FONTS_API_KEY` | `npm run google-fonts` | [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials; enable the **Web Fonts Developer API** (free quota is sufficient) |

Sources without an API key in `.env` are skipped gracefully with a log
message; they do not abort the full pipeline.

The `nuxt-cos` source takes no API key, but has three optional knobs. It needs
`npm` on `PATH` and network access to the registry, since it installs and builds
the real plugin.

| Variable | Default | Effect |
| --- | --- | --- |
| `NUXT_COS_MAX_RECIPES` | `4` | Plugin releases to cover, newest first |
| `NUXT_COS_VUE_VERSIONS` | `15` | `vue` releases to cover, newest first |
| `NUXT_COS_NUXT_CHECK` | unset | `1` additionally builds a real Nuxt app with `nuxt-cos` and reports whether every chunk it emits is already covered |

The product of the first two is the number of builds a run performs, so raising
them widens coverage backwards in time at a roughly linear cost. Both workflows
deliberately run with the defaults: a narrower run would otherwise shrink the
committed CSV that a wider one produced.

## Usage

Requires [Git LFS](https://git-lfs.com/) (`brew install git-lfs` or see the
[install docs](https://git-lfs.com/)) — everything under `data/` is stored
with it, so run `git lfs install` once per machine before cloning, or run
`git lfs pull` after a clone that predates having it installed. All commands
below are run from this directory (`public-hash-list/implementation/`), not
the repository root.

```bash
npm install

# Run all sources and produce the Public Hash List and its SHA-256 integrity file
# Outputs: data/public-hash-list.dat  data/public-hash-list.dat.sha256
npm start

# Run a single source only
npm run google
npm run google-maps
npm run microsoft
npm run cdnjs
npm run jsdelivr
npm run npm-popular
npm run chromium
npm run youtube
npm run google-fonts   # requires GOOGLE_FONTS_API_KEY in .env
npm run http-archive  # reads the BigQuery results published directly by the HTTP Archive
npm run nuxt-cos      # rebuilds the COS chunk matrix (installs and runs the real plugin)
npm run huggingface   # optional model-hub section
npm run manual        # process manual-additions.json → data/manual-hashes.csv

# Cheap probe: has a new plugin release appeared since the committed hashes?
# Exits 0 either way and prints the answer; the weekly workflow runs this first
node nuxt-cos.js --check-recipes
```

Any URL that returns a non-200 status or times out after 30 seconds is silently
omitted. For the Google Hosted Libraries CDN, known historical filename changes
(MooTools, Indefinite Observable) are handled via fallback URL resolution.

## Acknowledgements

Thanks to [Max Ostapenko](https://github.com/max-ostapenko) for the HTTP Archive
BigQuery query that powers the `http-archive` pipeline.

## License

This directory — both the **tooling** (scrapers, `index.js`) and the
**generated data file** (`data/public-hash-list.dat`) — is licensed under
**[Apache-2.0](LICENSE)**, via this directory's own `LICENSE` file. This is
distinct from the rest of the
[WICG/cross-origin-storage](https://github.com/WICG/cross-origin-storage)
repository, which is under the
[W3C Software and Document License](https://www.w3.org/copyright/software-license/)
(see the repository root [`LICENSE.md`](../../LICENSE.md)) — Apache-2.0 applies
only to this `public-hash-list/implementation/` subtree, not to the sibling
[explainer](../phl-explainer.md), which is a report.

Apache-2.0 is permissive and carries an explicit patent grant. It replaces an
earlier MPL-2.0 choice made to mirror the Public Suffix List: browsers vendor
the PHL as third-party data, and on that path neither MPL-2.0 nor the W3C
license is on the allowlists engines apply to bundled dependencies, whereas
Apache-2.0 is. See the [PHL explainer](../phl-explainer.md) for the full
reasoning.

A note on what is being licensed: the individual entries are _facts_ (a file has
a given hash), which attract no copyright in the US, though a curated compilation
can attract a thin compilation copyright and, in the EU, a separate _sui generis_
database right. An explicit license places both beyond doubt. The list contains
**hashes and (in comments) example URLs only — never the resource bytes**, so it
redistributes no library, font, or model, and inherits none of those resources'
own licenses.

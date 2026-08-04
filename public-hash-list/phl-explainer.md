# The Public Hash List (PHL): an availability-gating allowlist for Cross-Origin Storage

**Status of this document.** This design document, and the [early implementation](#early-implementation)
described below, currently live in the
[WICG/cross-origin-storage](https://github.com/WICG/cross-origin-storage) repository, alongside
the Cross-Origin Storage explainer and spec this document serves as a companion artifact to. The
[Governance](#governance) section below describes this proposal's target end state — hosting
under the WHATWG, with a dedicated, cross-vendor repository, editors, and a signing key of its
own — which has not happened yet. Housing both the design document and its implementation in a
single vendor's spec repository is a pragmatic interim step, not the destination: nothing in the
Governance section is settled, and a dedicated repository remains the goal for both.

**Why "Public Hash List"?** The name is a deliberate echo of the [**Public Suffix List**](https://publicsuffix.org/) **(PSL)**. The PSL is a single, openly licensed, cross-vendor data file that every browser consults to make a privacy-sensitive boundary decision. The PHL is the analogous artifact for Cross-Origin Storage: a single, openly licensed, cross-vendor data file that every browser consults to decide which cached bytes are *safe to admit exist*. "Public Suffix List" → "Public Hash List" is intended to make the analogy, and the freely-reusable intent, obvious on first read.

# Authors

- [Thomas Steiner](mailto:tomac@google.com), Google Chrome

# Early implementation

An early implementation of the Public Hash List proposal is maintained at
[`public-hash-list/implementation/`](https://github.com/WICG/cross-origin-storage/tree/main/public-hash-list/implementation)
in this repository. Housing it here, alongside this design document (see "Status of this
document" above), is a pragmatic interim step — the goal remains a dedicated, cross-vendor
repository, not permanent co-location with the spec of a single implementer.

To keep the list evergreen, it automatically ingests "top" resources from ten sources (Google Hosted Libraries, Microsoft Ajax CDN, cdnjs, jsDelivr, npm popular packages, Chromium pervasive resources, the YouTube player, Google Maps JS API, Google Fonts, and the HTTP Archive) plus a hand-curated AI model-hub section drawn from the most-downloaded models on the Hugging Face Hub (currently capped at the top 10,000 by download count). Like the PSL, it also supports [manual additions](#manual-additions): contributors propose entries via pull request against a reviewed JSON schema (URL, hash, description, rationale, and submission date), evaluated against the same ubiquity bar the automated sources apply. The canonical [Public Hash List](https://media.githubusercontent.com/media/WICG/cross-origin-storage/refs/heads/main/public-hash-list/implementation/data/public-hash-list.dat) flat file and [its SHA-256 integrity file](https://media.githubusercontent.com/media/WICG/cross-origin-storage/refs/heads/main/public-hash-list/implementation/data/public-hash-list.dat.sha256) are published in the [data/](https://github.com/WICG/cross-origin-storage/tree/main/public-hash-list/implementation/data) directory (stored with [Git LFS](https://git-lfs.com/); `media.githubusercontent.com`, not `raw.githubusercontent.com`, serves the actual file content).

# Objective

Define a vendor-neutral, openly licensed, continuously updated list of content hashes for resources so widely deployed that confirming their presence in a shared cache reveals nothing specific about a user, so that any user agent can unconditionally answer Cross-Origin Storage availability queries for those hashes, while every other resource stays gated by default.

# Background

## Motivation: from implementation-defined to interoperable

Some browsers already maintain their own implementation-defined lists of resources that receive special cache-sharing treatment. For example, Chromium ships an internal [pervasive-resources list](https://docs.google.com/document/d/1xaoF9iSOojrlPrHZaKIJMK4iRZKA3AD6pQvbSy4ueUQ/edit?tab=t.0#heading=h.gr2pf675zemq) that exempts certain widely-used assets from its HTTP cache-partitioning policy. This creates a performance observation that is not intentionally exposed as a Web API: there is no mechanism for a resource to opt in, and there is no API for script to query which resources receive the special treatment. The list is internal to the browser, opaque to the Web, and differs across vendors.

COS changes this fundamentally. It makes the sharing relationship explicit: resources can be registered by hash, and `requestFileHandle()` provides a standard API for script to query the cache. The performance benefit of cross-origin cache sharing is therefore no longer a side-effect of an invisible, vendor-specific heuristic; it is a first-class, queryable capability. But this also means that the *set of resources eligible for sharing* becomes observable to the Web, and its composition directly determines whether the capability is interoperable. If each browser keeps its own private list, developers cannot rely on cross-origin cache hits being consistent across browsers, and the performance win is fragmented along vendor lines. The PHL is the mechanism that makes the allowlist cross-browser and openly auditable: a single, vendor-neutral data file that every conforming user agent consults, so the eligibility decision is the same everywhere.

## COS and content-addressable sharing

[**Cross-Origin Storage**](https://wicg.github.io/cross-origin-storage/) **(COS)** lets a user agent share a single cached copy of a large, content-addressed file across unrelated origins. A file is keyed by its hash, so a 50 MB Wasm resource fetched once on `site-a.example` can be reused by `site-b.example` with no second download. The current hash algorithm is **SHA-256** (matching the Web Crypto API's implementers' recommendations and COS's requirement that `hash.value` be a 64-character lowercase hex string), but COS carries the algorithm explicitly as a [`HashAlgorithmIdentifier`](https://w3c.github.io/webcrypto/#dom-hashalgorithmidentifier) precisely so it can migrate later; the list described here is designed to migrate with it (see *Data format*). The cross-origin win is real: `jquery-3.7.1.min.js` is served bit-for-bit identically from `ajax.googleapis.com`, `cdnjs.cloudflare.com`, `code.jquery.com`, and `ajax.aspnetcdn.com`, which is exactly the duplication COS removes. At the scale the early implementation now operates — hundreds of thousands of hashes once the k-anonymity-gated long tail described in *Scaling parameters* is included — this kind of exact duplication is common enough to be worth removing structurally, not just for a handful of hand-picked libraries.

The privacy hazard is equally real, and is the subject of the explainer's [**Availability gating**](https://wicg.github.io/cross-origin-storage/#availability-gating) and [**Cross-site probing**](https://wicg.github.io/cross-origin-storage/#cross-site-probing) sections. Because any origin can call `requestFileHandle(hash)` and learn whether that hash is cached, cache presence becomes an oracle. If a hash is rare, that is, is used by only a handful of sites, a positive answer tells a probing attacker which of those sites the user has visited. This is the same class of attack the PSL was created to mitigate for cookies (so-called "supercookies"); COS needs its own structural mitigation. The explainer's answer is an **allowlist** of resources that are unconditionally eligible for cross-origin availability disclosure. Such resources are *(i)* either so widely deployed that disclosing their cache presence is uninformative about any individual or *(ii)* are part of an agreed-on set of well-known resources, like AI model weights. **This document designs that allowlist.**

The governance and distribution precedent is the [**Public Suffix List**](https://github.com/publicsuffix/list): a community-maintained data file pulled from a single canonical URL, split into structured sections, carrying `VERSION`/`COMMIT` headers, updated continuously, used cross-vendor by browsers, CAs, and CDNs, and explicitly outside any single vendor's control. The PHL adopts that model wholesale.

### **Glossary**

* **COS** — Cross-Origin Storage; content-addressed, cross-origin shared file cache.  
* **Availability gating** — a user agent possibly suppressing the *existence* of a cached file when confirming it would be a privacy risk, regardless of whether the file is physically present.  
* **Allowlist (PHL)** — the curated set of hashes a user agent will unconditionally disclose because they are known to be ubiquitous.  
* **GREASE'ing** — deliberately returning occasional false negatives to obscure true cache state (per the explainer; named after the TLS technique).

# Requirements

Any successful solution must:

* **Be vendor-neutral and freely usable by all browser vendors.** A single shared list, not per-vendor lists, so the privacy guarantee is identical across browsers.  
* **Key entries by content hash, not URL**, matching COS's content-addressing, so all mirrors of one file collapse to one entry.  
* **Be algorithm-agile.** SHA-256 today, but the format must carry the algorithm and survive a future migration without a redesign, mirroring the COS `hash.algorithm` field.  
* **Admit only genuinely ubiquitous, non-identifying public resources**, backed by reproducible evidence of ubiquity; anything user-specific, versionless, tracking-oriented, or rare must be excluded.  
* **Be reproducibly generated and auditable.** A third party must be able to regenerate every hash from public sources and get the same result.  
* **Carry no PII and no per-user data.** The artifact is a list of public facts, never anything tied to a person or a session.  
* **Be compact and fast to consult**, supporting an effectively O(1) membership test on the hot path of `requestFileHandle()` and fitting comfortably in browser memory.  
* **Be versioned, signed, and updated continuously** out-of-band from the browser release cycle, so vendors never ship a stale copy.  
* **Preserve, not weaken, COS privacy.** Presence on the list authorizes availability disclosure for that hash *only*; it must not switch off a user agent's other privacy protections like probe-rate limiting, fingerprinting detection, or size-proportionate GREASE'ing. The list must never *force* disclosure.  
* **Not regress performance or correctness of COS.** A list miss must leave the resource gated exactly as it would be without the list (and ultimately fetched over the network), and must never cause a spurious positive.  
* **Have neutral, transparent governance** for additions and removals, so no single vendor or CDN can unilaterally seed or suppress entries.

# Proposal

We propose the **Public Hash List (PHL)**: a single, openly licensed, cross-vendor data file listing the content hashes of ubiquitous and well-known Web resources. A hash present in the PHL is *unconditionally eligible* for COS availability disclosure; every other hash stays gated by default. The PHL's sole job is to enumerate exactly those resources whose ubiquity makes disclosing their cache presence safe.

## Data format

The **user agent** needs exactly one thing at runtime: *given a hash, is it on the list?* That is a set-membership test, and the only data it requires is the algorithm and the digest. Everything else, like which CDN vouched for the file, how many mirrors it has, or when it first appeared, is **curation and audit metadata** for maintainers and reviewers, not lookup payload. The PSL solved precisely this split: its machine-readable payload is bare suffix lines, and all provenance ("confirmed by…", source URLs, dates) lives in `//` comments that parsers skip. The PHL should do the same: a **flat text list with structured comments**.

Concretely:

```
// Public Hash List (PHL)
// VERSION: 2026-06-19T18:30:00Z
// COMMIT: 9f3c…
// License: MPL-2.0  https://mozilla.org/MPL/2.0/
//
// ===BEGIN SHA-256===
// Ubiquitous, corroborated resources. User agents MUST treat these as eligible.
// jQuery 3.7.1 — corroborated by Google Hosted Libraries, cdnjs, Microsoft Ajax, code.jquery.com
// e.g. https://ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js
fc9a93dd241f6b04...
// D3 7.9.0 — Google Hosted Libraries, cdnjs
// e.g. https://ajax.googleapis.com/ajax/libs/d3js/7.9.0/d3.min.js
f2094bbf6141b359...
// ===END SHA-256===
//
// ===BEGIN SHA-256 HUGGING-FACE===
// Hand-curated AI resources from a recognized model hub (see Sources).
// User agents SHOULD include this section; a user agent MAY omit it.
// gemma-2-2b-it (int4 .task) — e.g. https://huggingface.co/.../g-2b-it-gpu-int4.bin
1a2b3c4d5e6f7a8b...
// ===END SHA-256 HUGGING-FACE===
```

Each significant line is a bare lowercase hex digest, trivially parsed (`^[0-9a-f]{64}$`), trivially grepped, and diff-friendly so additions and removals are reviewable line-by-line.

* **Algorithm.** Not a per-line field. It is declared once via the section delimiter (`===BEGIN SHA-256 …===`), keeping the entry lines as pure digests. A future migration is purely additive: a parallel `===BEGIN SHA-384 …===` section coexists during the transition, and the same file serves both old and new user agents. (An SRI-style per-line prefix such as `sha256-…` was considered; section delimiters won for being the closer PSL echo and for keeping each entry a bare digest.)  
* **Sources (e.g. "cdnjs").** Not a machine field. Which catalog vouched for an entry is audit information, so it moves into the `//` comment above the digest. It's the direct analogue of the PSL's per-entry "Confirmed by…" comments. Parsers ignore it; reviewers rely on it.  
* **Raw URLs.** Never the key. The key must be the hash, which is the entire point of content-addressing and the reason the four jQuery mirrors are one entry, not four. But **one representative URL per entry is worth keeping, in the comment**, because it lets a human reviewer see at a glance what the hash *is*, and lets anyone re-fetch and re-verify the digest (the reproducibility requirement). One example suffices; the full mirror set is regenerable by the build and need not bloat the published file.

The published artifact is therefore just: a header, section delimiters, and bare digests, with human-readable provenance in comments. A user agent can additionally compile it into a compact probabilistic membership filter (cuckoo or bloom) for the hot path; the text file remains the canonical, auditable source.

## Sources and why they were chosen

### **Popularity-based sources**

The candidate hashes are produced by a build pipeline that scrapes several popularity-based catalogs, downloads each listed `.js`/`.css`/`.wasm`/`…` asset, hashes it, dedupes exact `(hash, URL)` pairs, and merges mirrors of the same file. The specific sources were chosen to **triangulate ubiquity from independent angles**, because no single signal is trustworthy on its own:

* **Google Hosted Libraries** and **Microsoft Ajax CDN** — long-standing, hand-curated catalogs of major open-source libraries on stable, versioned URLs. Their *overlap* is a feature, not redundancy: when both serve a byte-identical jQuery, that cross-CDN identity is itself strong evidence of ubiquity.  
* **cdnjs, top resources by Cloudflare request volume** — ranked by real request data over the trailing twelve months. This is the strongest *empirical* ubiquity signal in the set: what the Web actually fetches.  
* **jsDelivr, top packages by CDN hit count** — ranked by actual browser requests to `cdn.jsdelivr.net` over the trailing month. An independent CDN-traffic signal that corroborates cdnjs request-volume rankings from a different infrastructure, and catches popular packages that are well-represented on jsDelivr but under-represented on cdnjs.  
* **cdnjs, ranked by npm download count** — a second, *independent* axis of ubiquity. It uses cdnjs as the hosting layer but ranks by developer adoption (npm installs), correcting for the request-volume bias of the previous source and resolving the \~14% of catalog names that differ between cdnjs and npm.  
* **Chromium pervasive resources** — Chrome's existing, vetted list of resources deemed pervasive enough to warrant HTTP-cache-partitioning exceptions. This is the closest existing prior art for "safe to treat as shared," which the pipeline preserves and formalizes. Apart from concrete versioned resources, there are also URL patterned evergreen resources. They represent the "ubiquitous embedded widget" category that pure library catalogs miss entirely:  
  * **YouTube player files** — extremely high-volume resources embedded across an enormous number of unrelated third-party sites (every embedded video), on versioned player builds.  
  * **Google Maps API files** — extremely high-volume resources embedded across an enormous number of unrelated third-party sites (every Google Maps integration), on versioned Maps API builds.  
* **Google Fonts** — the dominant public web-font CDN, serving fonts from `fonts.gstatic.com` across a vast fraction of the Web. Font files are versioned and content-stable: the same woff2 bytes are delivered to every browser requesting a given family/weight/style/Unicode-subset combination, making cache presence uninformative about any individual site. The pipeline uses the Google Fonts CSS2 API (with a modern browser User-Agent to receive woff2 responses) to discover all per-subset woff2 URLs for every family in the catalog, then hashes each. This covers COS [use case 5](https://wicg.github.io/cross-origin-storage/#use-case-5-large-web-fonts) directly.  
* **HTTP Archive** — The HTTP Archive crawls millions of URLs monthly using WebPageTest and records the SHA-256 hash of every response body in the `payload._body_hash` BigQuery field. The eligibility criterion mirrors the rest of the PHL: a resource qualifies if its hash appears across ≥100 independent origins in the crawl data, which acts as the k-anonymity privacy gate. Only `script`, `css`, `font`, and `wasm` response types are included.

Collectively, these span curated catalogs, real request volume, developer adoption, browser-vendor vetting, embedded-widget reach, and web fonts. A resource that clears *several* of these independent measures is ubiquitous in a way that makes its cache presence uninformative about any individual, which is exactly the privacy property the allowlist needs.

**This source set is explicitly not set in stone.** It reflects today's and the existing long-tail Web; the durable part of the design is the *methodology*, not the particular catalogs. Sources will be added or retired as the ecosystem shifts: obvious near-term candidates include other general CDNs (unpkg) and other Web-font providers. Adding a source is a governance action, not a format change.

Critically, the list of intake vendors is not predetermined or controlled by any single party. The initial set above is a draft, subject to neutral editorial review by the WHATWG-hosted group that governs the PHL. Any proposed addition or retirement must clear the thirty-day public comment period and unanimous editor approval described in *Change process* below. Objective criteria drive source selection: independence from existing sources, a verifiable and reproducible methodology for determining which assets to include, and an empirical ubiquity signal (e.g., request volume, download count, or cross-CDN corroboration). Sources that duplicate an existing signal without adding independent evidence are unlikely to be approved. This process ensures that the intake vendor set reflects the breadth of the Web rather than the preferences of any particular browser vendor or CDN operator.

### **A hand-curated source: a recognized AI model hub**

The sources above all rest on an *objective* signal of ubiquity: request volume, download counts, cross-CDN identity. AI model weights, which are one of COS's core use cases (the explainer opens with multi-gigabyte Gemma and Llama models), do not fit that mold. A specific model build may be enormously valuable to deduplicate yet appear on only a handful of sites, so it would never qualify under those objective signals, and most of them do not catalog models at all. To unlock the AI use case we therefore add a **hand-curated source: the public catalog of a recognized model hub (e.g., the Hugging Face Hub).** Inclusion here is justified not by a measured ubiquity signal but by membership in a recognized, openly browsable hub where the weights are publicly published and content-addressed; the disclosure such an entry permits is coarse interest inference ("this user runs in-browser AI models") rather than identification of a specific site, because the artifacts are public hub downloads, not site-unique secrets. The only remaining issue is how to handle rather unique, custom models posted to public hubs. We can control this risk by focusing our efforts solely on models that reach a given download threshold, which hubs like Hugging Face track independently.

Because this source departs from the objective bar, it is **optional but strongly encouraged**, in normative terms:

User agents **SHOULD** include the hand-curated model-hub section of the PHL. The AI model use case delivers its benefit only when adoption is uniform: a user agent that includes the section lets large model weights be shared cross-origin and downloaded once, while omission forces those same multi-gigabyte downloads to repeat per origin. Uneven adoption confers a material performance advantage directly contrary to the PHL's purpose as a neutral, cross-vendor resource. Because at least one major user agent is already expected to ship this section, this risk is concrete, and deviation from this recommendation should only be decided under exceptional circumstances.

The Hugging Face Hub is named here because it is, at present, the de facto central hub for openly published AI models, which makes it the natural seed for this source today. The design is not bound to it, though: the inclusion basis is "a recognized public model hub," not Hugging Face specifically. Should the center of gravity shift to a different hub, or should the ecosystem fragment across several, additional hubs can be added (or the seed retired) by the same governance process that adds any other source. The model-hub *section* is the durable construct, the particular hub behind it is not.

### **Manual additions** {#manual-additions}

Anyone can manually submit a PR for inclusion if they can demonstrate the ubiquity required. Submissions will be reviewed by a process similar to [that of the PSL](https://github.com/publicsuffix/list/wiki/guidelines) but adjusted to the specific needs of the PHL.

## Scaling parameters

The corpus has two tiers with different growth dynamics. The curated-catalog sources (Google Hosted Libraries, Microsoft Ajax CDN, cdnjs, jsDelivr, npm popularity, Chromium pervasive resources, YouTube Player, Google Maps JS API, Google Fonts) draw from a small, stable set of roughly **16 known CDN hostnames** and grow slowly: the dominant driver there is new *versions* of already-listed resources (dozens of historical jQuery builds, hundreds of versioned YouTube `player_ias` files), so that tier grows roughly with release cadence, not with the size of the Web.

The HTTP Archive source is structurally different: rather than trusting a curated host list, it admits a hash once it is independently observed on **≥100 distinct origins** in monthly crawl data — a k-anonymity gate on origin diversity rather than a host allowlist. That tier now accounts for the majority of entries. Combined, the early implementation's current candidate set is **301,618 distinct hashes**. Storage remains manageable at this scale: a SHA-256 digest is 32 bytes, so the full list is under 10 MB of raw digests, and a probabilistic membership filter shrinks the hot-path structure to a few megabytes at a tunable false-positive rate — still comfortably within browser memory. Lookups remain local set-membership tests with no network dependency; query volume is bounded by `requestFileHandle()` calls. Should the k-anonymity-gated tier continue to dominate growth, the governance process (see *Change process*) is the mechanism for revisiting parameters such as the origin threshold or response-type filter that bound its size.

## Rollout: continuous, like the PSL

There is no phased launch. The PHL follows the PSL's **rolling-release** model end to end:

1. The build re-scrapes the curated catalogs on a schedule, re-hashes new and changed files, and proposes additions/removals.  
2. Human-submitted and automated changes to the catalogs land via pull request against the canonical repository, subject to the governance and exclusion rules below.  
3. The canonical signed file at a single stable URL always reflects the latest state, with `VERSION`/`COMMIT` headers so consumers can detect changes.  
4. User agents pull and cache the file on their own cadence (with a small embedded fallback for offline first-run) and recompile their membership filter, exactly how mature PSL consumers refresh.

A safety property holds throughout: because every entry is a public, demonstrably ubiquitous resource, the worst a bad entry can do is over-disclose a file that was already safe to disclose, never a private one.

## Privacy, security, and legal

The PHL contains only hashes and public provenance, never user data, so the list itself leaks nothing. The core section's safety rests on its inclusion bar: a file is listed only after clearing multiple independent signals of ubiquity, which is precisely the property that makes its cache presence uninformative about an individual. The hand-curated model-hub section relaxes that bar deliberately for the AI use case, and accepts a different, bounded guarantee: coarse interest inference from public hub artifacts. This is why it is a separate, optional section rather than mixed into the core list. In both cases, presence on the PHL authorizes availability disclosure for that hash *and nothing else*: user agents remain free, and expected, to apply probe-rate limiting, on-device fingerprinting detection, and size-proportionate GREASE'ing per the explainer. The file is signed so consumers can verify integrity and provenance before trusting it, and the reproducible build lets any party independently re-derive and challenge any entry.

**License.** To match the PSL and keep cross-vendor adoption frictionless, the PHL is published under the **Mozilla Public License 2.0 (MPL-2.0)**,  the same license the PSL itself uses. MPL-2.0 is OSI- and FSF-approved, weak (file-based) copyleft, and explicitly permits embedding MPL-licensed components into proprietary codebases (such as a closed-source browser binary) provided the MPL components remain available under the MPL. Using the same license as the precedent the PHL is modeled on minimizes legal review for any vendor that has already cleared the PSL.

A note on what is being licensed: the individual entries are *facts* (a file has a given hash), and facts attract no copyright in the US; a curated compilation can nonetheless attract a thin compilation copyright and, in the EU, a separate *sui generis* database right. Publishing the whole list under MPL-2.0 places both beyond doubt for downstream users. Crucially, the PHL distributes **hashes and (in comments) example URLs only, never the resource bytes**, so it never redistributes jQuery, a font, or a model, and therefore inherits none of those resources' own licenses. It is a list *about* files, not a copy *of* them.

## Governance

The PHL is governed by the WHATWG.

### **Why the WHATWG**

The WHATWG is the natural home for the PHL for the same reasons it hosts the Living Standards that define the APIs the PHL serves: it operates by consensus among major browser vendors, its process is openly documented, and its output carries the cross-vendor legitimacy that a privacy-boundary artifact requires. The PSL predates modern standards governance and is informally maintained by the Mozilla community; the PHL, coming later, can do better. Hosting under the WHATWG means:

* **Vendor neutrality is structural, not merely aspirational.** No single browser vendor controls the repository, the review queue, or the signing key. Decisions that affect the privacy boundary for all browsers cannot be made unilaterally.  
* **The process is legible.** The WHATWG [Contributor and Workstream Participant Agreement](https://participate.whatwg.org/) and [Working Mode](https://whatwg.org/working-mode) are public, legally reviewed documents. Browser vendors, CDN operators, and Web developers already operate inside this framework.  
* **Objections have a defined path.** Disputes over inclusions, exclusions, or methodology escalate through a known governance chain rather than being resolved informally by whoever holds commit rights.

### **Repository and canonical artifact**

The PHL lives in a public repository under the WHATWG GitHub organization. The repository contains:

* The **build pipeline** — the scripts that scrape each curated source, hash assets, merge mirrors, apply exclusion filters, and emit the candidate list. The pipeline is the specification of "how a hash earns inclusion"; it must be runnable by any third party with public Internet access (though API keys may need to be obtained for certain pipelines).  
* The **canonical data file** at a stable URL, signed by the WHATWG's infrastructure key. The `VERSION` and `COMMIT` headers in the file tie every published snapshot to a reproducible pipeline run.  
* The **governance log** — a human-readable record of every source addition, source retirement, and policy change, with the rationale and the identities of the participants who approved each change. This log could be just the GitHub Pull Request comment thread.

### **Roles**

**Editors** hold merge rights and are responsible for the correctness of the list and the integrity of the build pipeline. They are appointed by the WHATWG Steering Group and must represent at least two distinct browser-vendor affiliations at all times, so that no single vendor can merge changes unilaterally. The minimum viable editorial group is therefore two editors from two different vendors; in practice, broader representation across the major shipping browsers is expected and encouraged.

**Contributors** are any individuals or organizations that open Pull Requests. Contribution is open to everyone; no affiliation is required. A contributor who proposes a new source, a manual addition, or a policy change must provide evidence sufficient for the inclusion criteria to be evaluated by someone who has never seen the proposal before. Editors are not expected to take claims on trust.

**Consumers** — browser vendors and other user agents — are not required yet highly encouraged to adopt the PHL, but the cross-vendor privacy guarantee only holds when adoption is uniform. The WHATWG process provides the venue for consumer vendors to raise compatibility or security concerns about a proposed change before it lands rather than after, which is preferable for all parties.

### **Inclusion criteria and exclusion filters**

#### General eligibility criteria

**All** resources must meet the following eligibility criteria:

1. **Content stability.** The URL (or URL pattern) that delivers this hash is versioned or otherwise content-stable. A resource served from a URL like `latest.min.js` that silently changes bytes over time is ineligible, because today's hash maps to a specific byte sequence and a future byte sequence at the same URL would be a distinct, un-listed hash.  
2. **Public availability.** The resource is freely fetchable without authentication, region restriction, or paywalling. A hash that a reviewer cannot independently re-derive from public sources cannot be audited and therefore cannot be listed.  
3. **No tracking or fingerprinting purpose.** Any resource whose primary design purpose is to identify individual users, track behavior, or serve as a fingerprinting vector is excluded, regardless of how widely deployed it is. Detection is necessarily judgement-based; the editors are the arbiters, with appeal to the WHATWG Steering Group.  
4. **No compression, encoding, or transport-layer variation.** The hash is computed over the canonical, identity-encoded response body. A resource that is byte-for-byte different depending on whether the server applies Brotli compression does not have a single canonical hash and cannot be listed. Pipeline documentation must specify the exact fetch and decoding steps used.

Entries that fail any criterion must be removed, regardless of how long they have been on the list. The automated pipeline enforces criteria 1–3 and 5 mechanically; criterion 4 may require human review.

#### Eligibility for the `===BEGIN SHA-256===` `section`

A hash is eligible for the core `===BEGIN SHA-256===` section (or any of the future hash algorithm sections) if and only if it clears **all** of the following:

* **Resource ubiquity.** The asset appears, byte-for-byte identical, in at least two *independent* sources from the source set above, or it appears in a single source but ranks highly enough on an independent popularity signal (e.g., it is in the top 50 by Cloudflare request volume and independently confirmed by an HTTP Archive k-anonymity gate of ≥100 origins).

#### Eligibility for the `===BEGIN SHA-256 HUGGING-FACE===` section

A hash is eligible for the `===BEGIN SHA-256 HUGGING-FACE===` (or equivalent model-hub) section if and only if it clears **all** of the following criteria:

* **Hub membership.** The artifact is listed in the public catalog of a recognized model hub approved by the editors.  
* **Download threshold.** The model repository to which the artifact belongs has reached a minimum download count, currently **10,000 downloads** in the trailing thirty days as reported by the hub's public metrics. This threshold is a governance parameter, not a format parameter; it can be adjusted by the editors without a spec change and is documented in the governance log.

#### Eligibility for the `===BEGIN SHA-256 MANUAL===` section

A hash is eligible for the `===BEGIN SHA-256 MANUAL===` section if and only if it meets **all** of the following:

* **Demonstrated ubiquity.** Because the automated pipeline has not independently confirmed the hash, the submitter must supply substitute evidence of ubiquity. Accepted forms include: a verifiable statement from the resource's publisher attesting to a deployment scale comparable to the automated sources; or documented presence on at least two independently operated distribution points that are not already in the automated source set. Evidence must be reproducible by a reviewer at the time of submission, not merely historical.  
* **Gap justification.** The submitter must explain why the resource does not already qualify via the automated pipeline. A resource that *would* qualify if the relevant CDN were added as a source should be proposed as a source addition instead of a manual entry, since a recurring source is more maintainable than a one-off hash.

Manual entries do not inherit the automated pipeline's continuous update cycle. The submitter is responsible for filing a follow-up PR when a new version of the resource is released and for requesting removal when a version falls out of widespread use. Editors may remove a stale manual entry at their discretion if it no longer plausibly meets the ubiquity requirement.

### **Change process**

**Automated additions.** The build pipeline runs on a scheduled cadence (currently weekly) against all active sources. New hashes that pass all automated criteria are batched into a pull request. The PR includes a machine-generated diff summary showing how many hashes are added or removed, which sources corroborate each addition, and a reproducibility manifest (a record of the exact fetch timestamps, response headers, and computed digests used to produce the diff). An automated addition PR requires approval from **at least one editor** before merging.

**Automated removals.** A hash is removed automatically when it no longer appears in any active source, subject to a **grace period of two consecutive pipeline runs** to absorb transient scraping failures. Removals are less sensitive than additions (removing a hash can only make COS more conservative, never less), so an automated removal PR may be merged by a single editor without a waiting period.

**Manual addition proposals.** A human contributor who believes a resource meets the inclusion criteria opens a pull request following the manual additions template. The PR must include:

* The proposed hash (bare hex digest, lowercase).  
* A representative, publicly accessible URL from which the hash can be independently verified.  
* Evidence of corroboration: at minimum, a second independently operated distribution point serving the same bytes.  
* For model-hub entries: the hub URL, current download count, and the date it was sampled.

Manual addition PRs require approval from **at least two editors from at least two distinct organizations** before merging, to prevent any single vendor or CDN operator from self-advantaging. The review window is **fourteen calendar days** from the date of the last substantive change to the PR; editors may close a PR for inactivity after ninety days without response from the submitter.

**Source additions and retirements.** Adding a new source to the pipeline (e.g., a new CDN or a second model hub) or retiring an existing one is a larger governance action. It requires a written proposal in the repository's issue tracker explaining the source's independence from existing sources, the methodology for determining which assets to include, and the anticipated effect on list size and composition. Source proposals require approval from **all editors** and a **thirty-day public comment period**. This higher bar reflects the fact that source changes affect the entire list composition, not a single entry.

**Policy changes.** Changes to the exclusion criteria, the download threshold, or other governance parameters follow the same process as source additions.

### **Handling disputes**

If a contributor or consumer disputes an inclusion or exclusion decision made by the editors, they may escalate to the **WHATWG Steering Group** following the standard WHATWG escalation path. The Steering Group's decision is final. Editors are expected to document the reasoning behind non-obvious decisions in the governance log so that disputes can be evaluated against a clear record rather than reconstructed from memory.

### **Signing and integrity**

The canonical data file is signed using an infrastructure key held by the WHATWG, separate from any individual editor's credentials. The signing key's public half is published in the repository and in the WHATWG's key registry. User agents that verify the signature before trusting the file are protected against: a compromised CDN edge that serves a modified file, a DNS hijack redirecting the canonical URL, and a compromised editor account that pushes an unsigned build. Signing does not, by itself, protect against a compromise of the WHATWG's signing infrastructure; the reproducible build and the public audit log are the backstop for that scenario.

### **Relationship to the COS specification**

The PHL is a **normatively referenced companion artifact**, not a normative part of the COS specification itself. The COS spec defines the *interface contract* ("user agents MUST treat hashes on the PHL as unconditionally eligible"), and the PHL is the live data artifact that satisfies that contract. This mirrors the relationship between the HTML spec and the MIME type registry, or between the Fetch spec and the WHATWG URL parser: the spec defines the semantics, the companion artifact is the authoritative instance. Concretely, the COS spec will point to the canonical PHL URL and specify the retrieval and verification protocol; the PHL governance document (this document) specifies what goes into the file and why.

# Alternatives considered

**Per-vendor proprietary allowlists.** Each browser could curate its own list, maximizing control and shipping cadence. But it fragments the privacy guarantee (a resource shareable in one browser, gated in another), duplicates an expensive curation effort, is unauditable by outsiders, and carries obvious anti-competitive optics if a dominant vendor's list favors its own CDNs. The PSL is the existence proof that a single cross-vendor list is both feasible and preferable for exactly this kind of privacy-boundary decision.

**Hardcode the list into each browser binary.** Simpler than an update channel, but it ties freshness to the release cadence, and the PSL ecosystem has repeatedly shown that stale embedded copies are a leading source of bugs and privacy regressions. A continuously updated, signed file (with a small hardcoded fallback for offline first-run) avoids this while keeping a safe default; and is the reason the rollout above is rolling rather than phased.

**Key the registry by URL (SRI/import-map style) instead of by content hash.** Familiar from Subresource Integrity and import maps, but it breaks the moment the same bytes appear at a different URL, forcing one logical resource into many entries and undercounting its true ubiquity. COS is content-addressed by design; the list must be too. (URLs still appear *as provenance* in comments, just not as the key.)

**Reuse a single existing list, e.g. Chromium's pervasive-resources list alone.** It already exists and is already consulted by a shipping browser. The PHL instead *aggregates* it as one corroborating source among several, runs it through published exclusion filters, and cross-checks it against independent signals of ubiquity, using the prior art without inheriting its single-vendor scope.

# Possible future directions

**Further sources.** As noted under *Sources*, unpkg and other Web-font providers are the obvious next additions, each gated by the same corroboration-and-exclusion methodology.

# Acknowledgements

Many thanks to the following people, in alphabetical order, whose feedback and ideas have helped shape this proposal:

- Tab Atkins-Bittner
- Rick Byers
- Dominic Farolino
- Deepti Gandluri
- Thomas Nattestad
- Hannes Payer
- Barry Pollard
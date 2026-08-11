# Firefox: Cross-Origin Storage (COS) — Implementation Plan

## Context

Cross-Origin Storage (COS) is a new WICG API: a content-addressable file cache, keyed by
cryptographic hash rather than by origin, that lets independent sites share one stored copy of a
large, byte-identical resource (AI model weights, Wasm modules, popular JS libraries, fonts)
instead of each downloading and storing it separately. The full spec (draft at
`/Users/tsteiner/Documents/javascript/cross-origin-storage/index.bs`) defines the
`navigator.crossOriginStorage.requestFileHandle()` entry point; a registry of hash-keyed entries
with a pending→written lifecycle; three disclosure scopes (same-site-only, an explicit origin
list, or a PHL/GREASE-gated wildcard); storage-budget and eviction rules; and rate-limiting/probing
defenses. WPTs exist at `/Volumes/120GB_SSD/Documents/wpt/cross-origin-storage`
(github.com/web-platform-tests/wpt/pull/61811).

Two independent implementations (Servo, Ladybird) had already shipped this and left detailed
engineering notes at
`/Users/tsteiner/Documents/javascript/cross-origin-storage/browsers/cross-origin-storage-implementation-notes.md`,
which catch several real bugs (unbounded `truncate()` DoS, path traversal via unvalidated
per-algorithm hash values, entry-cleanup races between concurrent writers) that a naive first pass
would miss; both were used as prior art the way Ladybird's own plan used Servo's.

This document covers Firefox's Phase 1: the WebIDL surface, actor plumbing, and a correct read/write
round trip (disk-persisted, budget-accounted, PHL/GREASE-gated, and rate-limited) across all
three disclosure scopes. `dom.crossOriginStorage.enabled` defaults to `true` on this branch —
this is a personal-fork testing branch, not a real Firefox release channel, so "on by default"
here means "on for anyone who downloads a build from this branch's own release workflow," nothing
more. Work happened on a `cross-origin-storage` branch off `main` in `tomayac/firefox`.

## Key architectural decisions

1. **The registry is a new, dedicated PBackground singleton service in a new
   `dom/crossoriginstorage/` directory — not folded into `QuotaManager`/`dom/fs`.** COS's registry
   is deliberately *not* per-origin storage, so it must not register as a `quota::Client`
   (`dom/quota/Client.h`) — that would force it into QuotaManager's origin-partitioned
   directory-lock model. Instead, this mirrors `PIdleScheduler`, a flat, non-origin-scoped
   singleton actor pair managed directly by `PBackground`: one `CrossOriginStorageParent`/`Child`
   pair per content process (`PCrossOriginStorage.ipdl`, registered in `PBackground.ipdl` and
   `BackgroundParentImpl`/`BackgroundChildImpl`). The parent-side actor delegates to a
   `CrossOriginStorageRegistry` singleton (`dom/crossoriginstorage/CrossOriginStorageRegistry.h`)
   holding the actual entry map (`nsClassHashtable<nsCStringHashKey, Entry>`) — in-memory only for
   Phase 1, living on the PBackground thread in the parent process.
2. **`FileSystemFileHandle` is reused by construction for the read path; a new class stands in for
   `FileSystemWritableFileStream` on the write path.** The WPT suite asserts
   `assert_true(handle instanceof FileSystemFileHandle)`, matching the spec's literal "creating a
   new `FileSystemFileHandle`" step. `CrossOriginStorageRequestHandler`
   (`dom/crossoriginstorage/CrossOriginStorageRequestHandler.{h,cpp}`) subclasses
   `fs::FileSystemRequestHandler` and is handed to a genuine `dom::FileSystemFileHandle`
   constructed with a null `FileSystemManager`, satisfying `instanceof` without touching `dom/fs`'s
   QuotaManager-backed OPFS internals at all. The write path could not reuse
   `FileSystemWritableFileStream` the same way: that class couples tightly to
   `PFileSystemManager`'s fd-passing, and `createWritable()` only needs a `WritableStream` with a
   real `.write()` method. `CrossOriginStorageWritableFileStream`
   (`dom/crossoriginstorage/CrossOriginStorageWritableFileStream.{h,cpp}`) — a plain
   `WritableStream` subclass, deliberately not `dom/fs`'s class — implements
   `write()`/`seek()`/`truncate()` the same way the File System Standard defines them (acquire a
   writer, write, release the writer) on top of the base `WritableStream`'s native
   `UnderlyingSinkAlgorithmsWrapper` machinery (`CrossOriginStorageSinkAlgorithms`).
3. **`seek()`/`truncate()` are synthesized command objects routed through the same write-sink
   queue as real data, not a separate WebIDL dictionary or a second wire channel.** Each is built
   as a plain `{type: "seek"|"truncate", position|size}` JS object via raw JSAPI
   (`JS_NewPlainObject`/`JS_DefineProperty` in `CrossOriginStorageWritableFileStream.cpp`) — not
   the File System Standard's own `WriteParams` dictionary, whose nullable
   `(BufferSource or Blob or UTF8String)` `data` field reintroduces the same broken-union-type
   problem noted in decision 4 below — and pushed through `Write()`'s existing acquire/write/release
   path. This keeps `seek()`/`truncate()` correctly serialized relative to interleaved `write()`
   calls for free, since they all share one underlying queue. On the other end,
   `CrossOriginStorageSinkAlgorithms::WriteCallbackImpl` checks, in order: Blob (`UNWRAP_OBJECT`),
   ArrayBuffer (`JS::GetObjectAsArrayBuffer`), ArrayBufferView (`JS_GetObjectAsArrayBufferView`),
   the synthesized command object (a `"type"` property read — checked last among object shapes
   since, unlike the three exact-class checks before it, this is just a property read), then
   string. Parent-side, `WriteSession` (`CrossOriginStorageParent.h`) tracks a byte cursor
   (`mPosition`): `WriteChunk` performs a positioned write, zero-extending via `nsTArray::SetLength`
   when the cursor sits past the current end; `Seek` moves the cursor without resizing; `Truncate`
   resizes (`SetLength`, which also zero-fills on grow) and clamps the cursor if it now exceeds the
   new size.
4. **Chunk bytes are extracted with raw JSAPI calls, not a generated WebIDL `BufferSource` union
   type.** There is no working generated binding for the plain (non-`AllowShared`) `BufferSource`
   typedef in this configuration, so accepting raw bytes directly through one goes unused; chunk
   bytes are instead extracted with the same raw JSAPI calls named in decision 3
   (`JS::GetObjectAsArrayBuffer`/`JS_GetObjectAsArrayBufferView`), which unwrap cross-compartment
   wrappers internally and need no prior manual unwrap step.
5. **Hashing/same-site/Permissions Policy/Navigator wiring all reuse existing Gecko primitives**
   rather than reinventing them:
   - SHA-256 (and the other WebCrypto-recognized algorithms): NSS `PK11_HashBuf`
     (`CrossOriginStorageUtils.cpp:76`), the same primitive `DigestTask` uses for
     `crypto.subtle.digest()`, called directly in C++ with no round-trip through JS Web Crypto.
   - Same-site/origin comparison: computed directly off `mozilla::ipc::PrincipalInfo` on the
     PBackground thread (`GetOrigin()`/`GetSite()`, `CrossOriginStorageRegistry.cpp:30-70`), using
     `ContentPrincipalInfo`'s `originNoSuffix()`/`baseDomain()` fields directly — no real
     main-thread `nsIPrincipal` or `nsIEffectiveTLDService` round trip needed.
   - Permissions Policy: a `{"cross-origin-storage", FeaturePolicyValue::eSelf}` entry in
     `sSupportedFeatures[]` (`dom/security/featurepolicy/FeaturePolicyUtils.cpp:49`), checked via
     `FeaturePolicyUtils::IsFeatureAllowed` before validation, per spec step ordering.
   - Navigator wiring: `NavigatorCrossOriginStorage` mixin (`dom/webidl/CrossOriginStorage.webidl`)
     included from both `Navigator.webidl` and `WorkerNavigator.webidl`, with lazily-constructed
     `CrossOriginStorageManager* CrossOriginStorage()` accessors (`Navigator.cpp:567`,
     `WorkerNavigator.cpp:260`) mirroring the existing `Storage()`/`StorageManager` pattern exactly.
6. **Pref-gated throughout.** `dom.crossOriginStorage.enabled`
   (`modules/libpref/init/StaticPrefList.yaml:5395`), `RelaxedAtomicBool`, default `false` — gates
   every new WebIDL exposure (`[Pref="dom.crossOriginStorage.enabled"]`).
7. **Three disclosure scopes**, matching the spec exactly, on the registry `Entry`: `SameSiteOnly`
   (default), `List` (LRU-ordered, capped at `kMaxOriginsListLength = 100` — matching both Servo's
   and Ladybird's own chosen cap), and `Wildcard`. `CompleteReadRequest` checks the storing-origin
   bypass first, then branches on scope kind; a successful `List`-scope read refreshes that
   origin's LRU recency (move to the most-recently-used end) — merely being re-declared in a later
   write does not. `UpgradeResourceVisibility` implements the spec's monotonic
   same-site<list<wildcard upgrade, with list-merges silently capped at the same 100-entry limit
   (excess candidates dropped, not erroring — the write has already succeeded by that point).
   Wildcard-scope disclosure is additionally gated by the Public Hash List and GREASE'ing — see
   decision 12 below.
8. **Write-session lifecycle**: `BeginWrite`/`WriteChunk`/`Seek`/`Truncate`/`FinishWrite`/
   `AbortWrite` actor messages (`PCrossOriginStorage.ipdl`) drive a `pending`→`written` entry state
   machine gated by an outstanding-writer count (incremented by `CompleteCreateRequest`,
   decremented on `FinishWrite` failure or `AbortWrite`; an entry is only removed once the count
   reaches zero *and* it was never `written` — protects a genuinely concurrent sibling writer from
   having its entry deleted out from under it). A lazily-checked 5-minute staleness timeout
   (`Entry::IsStale()`, `kPendingStalenessTimeout`) reclaims pending entries whose writer never
   called `close()`/`abort()`; `CrossOriginStorageParent::ActorDestroy` additionally releases any
   in-flight write sessions immediately on content-process teardown, rather than waiting for that
   timeout.
9. **A flat 4 GiB write-target ceiling** (`kMaxCOSWriteBytes`, `CrossOriginStorageParent.cpp`),
   matching Servo's `MAX_COS_WRITE_FILE_BYTES` and Ladybird's own placeholder starting point:
   `WriteChunk`/`Truncate` check the resulting size against the cap *before* ever growing
   `WriteSession::mBytes`, so the oversized allocation itself never happens — a session that trips
   the cap just stops accepting further chunks. `FinishWrite` checks this flag first and fails
   `close()` with `DataError`, running the same outstanding-writer-release cleanup the hash-mismatch
   path already uses. This bounds one in-flight write's worst-case memory use; it is not the real
   per-origin/global storage-budget accounting decision 13 below adds on top.
10. **Persistence is content-addressed flat files under `<profile>/cross-origin-storage/`, not a
    database.** New `CrossOriginStoragePersistence` class:
    `<profile>/cross-origin-storage/<algorithm>/<value>.bytes` +
    `<value>.meta` (mirrors Ladybird's own chosen on-disk layout), each written via a hand-rolled
    atomic tmp-then-rename (`AtomicWriteFile`, not `NS_NewAtomicFileOutputStream` — that helper's
    `CreateUnique()`-based temp naming isn't predictable enough to reliably identify orphaned temp
    files at startup, which a hand-rolled `<name>.tmp` sibling is). `.meta` is a small hand-rolled
    binary format via `nsIBinaryOutputStream`/`nsIBinaryInputStream` (version tag, algorithm, value,
    scope, storing origins/sites, byte size, last-read time) — deliberately not JSON/SQLite, since
    Gecko's binary stream primitives already give a compact, dependency-free format. Only `written`
    entries are ever persisted; a `pending` write session's bytes stay solely in
    `CrossOriginStorageParent::WriteSession` (in memory) until `VerifyAndStore` succeeds, so losing
    an in-flight write across a crash/restart is acceptable by design, matching every other
    implementation's own choice — this also means no crash-recovery logic is needed for partial
    writes at all, only for a partial *rename* (an orphaned `.tmp` file, cleaned up at the next
    startup scan). The registry's `Entry` struct no longer keeps a persisted entry's bytes resident
    (`mBytesOnDisk = true`, `mBytes` cleared) — `GetFileBytes` reads them back from disk per request
    instead; a real in-memory LRU cache on top is future work, not built here. If persistence is
    unavailable in this process (no profile, e.g. certain test harnesses), the registry silently
    falls back to keeping bytes resident in memory (`mBytesOnDisk = false`), exactly as Phase 1
    originally worked, rather than failing the feature outright.
11. **`nsIBinaryInputStream::ReadCString()` needs a buffered underlying stream, not a raw file
    stream.** `ReadCString()` internally calls `ReadSegments()`, and a raw local-file input stream
    (`NS_NewLocalFileInputStream`) unconditionally returns `NS_ERROR_NOT_IMPLEMENTED` for
    `ReadSegments()` (`nsFileStreamBase::ReadSegments`, `netwerk/base/nsFileStreams.cpp`) — wrap it
    in a buffered stream (`NS_NewBufferedInputStream`) instead, which is what `ReadMetaFile` does.
    This is deterministic, not a race: it affects every metadata read, not just one after a restart
    (the write path uses `WriteBytes`/`Write()`, not `WriteSegments`, so only reading is affected).
    Persistence code needs a test that spans a real process restart against real on-disk state, not
    just a passing build and in-process test suite — see the Verification plan below.
12. **Public Hash List + GREASE'ing gate wildcard-scope disclosure, matching the spec's
    `#availability-gating` two-part design.** New `CrossOriginStoragePublicHashList` (binary-search
    lookup against the real upstream snapshot described in decision 16 below) and
    `CrossOriginStorageGrease` (1% probability, 500 KiB size ceiling, matching Servo's and
    Ladybird's own chosen constants, rolled via `mozilla::RandomUint64OrDie()` — a
    cryptographically-sourced RNG, not a fast/predictable one, since this feeds a privacy-relevant
    decision). `CompleteReadRequest`'s `Wildcard` branch checks PHL-membership OR a GREASE roll
    before disclosing.
13. **Storage-budget eviction is disk-capacity-based and two-tier, matching Ladybird's chosen
    split**: a global budget of 60% of the persistence directory's disk capacity (`nsIFile::
    GetDiskCapacity`, the same primitive `dom/quota/ActorsParent.cpp` uses for its own budget,
    including a 100 GiB sanity ceiling mirroring QuotaManager's own defensive cap against a
    misreported capacity), and a per-origin share of 20% of *that* global budget (not of raw disk
    capacity). `EnforceStorageBudget` runs after every successful `VerifyAndStore`: if the writing
    origin now exceeds its own share, its own sole-owned entries are evicted oldest-`mLastReadTime`-
    first before touching anyone else's; if the registry is still over the global cap afterward, any
    entry (regardless of owner) is evicted the same way. Eviction removes the on-disk files too
    (`CrossOriginStoragePersistence::DeleteEntry`), not just the in-memory `Entry`. `mLastReadTime`
    itself is updated in memory on every disclosed read but *not* flushed to disk per read (that
    would mean a disk write on every read) — a crash loses only some recency precision, not
    correctness. Deliberately a full-entry-list scan-and-sort on every budget-relevant write, not
    the incremental O(1) usage-tracking / O(log n) eviction-index a real implementation needs at
    scale (see Deferred work below).
14. **Rate limiting is per-origin token buckets, checked before any entry lookup, so a
    rate-limited request is indistinguishable from a genuine miss.** New
    `CrossOriginStorageRateLimiter`: burst 2000/refill 20 per second for reads, burst 200/refill 2
    per second for writes — Servo's own chosen constants, copied rather than independently tuned.
    `CompleteReadRequest` checks-and-consumes a read token *before* the registry lookup, returning
    `NotFound` on rejection (identical to a genuine miss, by design — the spec's own security
    considerations flag hash-guessing/timing attacks, and a distinguishable "rate limited" response
    would itself leak information). `CompleteCreateRequest` checks-and-consumes a write token before
    touching any entry; on rejection it returns `false` (identical to an ordinary fresh pending
    creation's return value) without creating an entry, so the eventual `close()` for that write
    later fails generically (no entry to verify against) rather than surfacing a distinguishable
    signal at request time. The origin-keyed bucket map itself is bounded (LRU-evicted past 10,000
    tracked origins) — a distinct concern from the registry's own entry eviction, called out
    separately since an unbounded rate-limiter map would itself be a memory-exhaustion vector.
15. **`nsIClearDataService` integration uses "revoke-and-GC" semantics for site-scoped clearing,
    not "delete by ownership."** COS entries aren't per-origin storage — several origins can
    legitimately store the identical bytes under the same hash — so the usual "delete everything
    this principal/site owns" a `Cleaner` normally does doesn't fit cleanly; deleting outright
    wherever the target site was *ever* involved would mean clearing one site's data can silently
    delete a *different*, uncleared site's data as a side effect. New `nsICrossOriginStorageService`
    (`dom/crossoriginstorage/nsICrossOriginStorageService.idl`, a `[scriptable]` singleton
    reachable from chrome JS, registered via `components.conf`) exposes `clear()` (full wipe,
    unambiguous) and `clearBySite(schemelessSite)`; both dispatch to the PBackground thread (via
    `mozilla::ipc::BackgroundParent::GetBackgroundThread()`, resolving immediately as a no-op if
    that thread was never started — nothing was ever stored) and return a `Promise` resolved once
    the registry operation completes, mirroring `AboutThirdParty::CollectSystemInfo()`'s own
    `[implicit_jscontext] Promise` pattern. `CrossOriginStorageRegistry::RemoveSite()` strips the
    target site (matched by host suffix, the same convention `nsIClearDataService::deleteBySite()`
    itself uses, not a real public-suffix-list eTLD+1 computation) from every entry's storing
    origins/sites and any explicit `origins`-list scope, deleting an entry outright only if that
    leaves it with no storing origin left. A new `CLEAR_CROSS_ORIGIN_STORAGE` flag
    (`nsIClearDataService.idl`) is folded into the existing `CLEAR_DOM_STORAGES` composite, so
    "Forget about this site" and "Clear cookies and site data" sweep it in automatically — no new
    dedicated UI checkbox needed. Known, documented limitation: storage-budget usage
    (`mOriginUsage`) is attributed only to an entry's first storing origin; if partial (not full)
    revocation removes specifically that origin while others remain, its usage credit goes stale
    rather than being reattributed — rare (needs multiple origins to have genuinely stored
    byte-identical content) and bounded (can't grow, only go stale), not fixed here.
16. **The Public Hash List is a real upstream snapshot, shipped as a plain data file, not a
    compiled-in array.** `WICG/cross-origin-storage` has its own actively-maintained
    `public-hash-list/implementation/` pipeline (scrapers for cdnjs,
    jsDelivr, Google Fonts, Chromium's pervasive-resource list, npm popularity, HTTP Archive, Hugging
    Face, and manual additions, gated by real-world k-anonymity thresholds), regenerated on a
    schedule and published at `public-hash-list/implementation/data/public-hash-list.dat` (a
    PSL-style flat file — fetch the real bytes from `media.githubusercontent.com`, not
    `raw.githubusercontent.com`, which serves only a Git LFS pointer for that path). New
    `generate_public_hash_list.py` parses that file's three MUST/SHOULD-adopt sections (core,
    Hugging Face, manual — see that repository's own README for the exact semantics of each),
    validates/dedups/sorts ~295k SHA-256 digests, and packs them as raw 32-byte values (not hex
    text — half the size, and the format `CrossOriginStoragePublicHashList::Contains()` already
    binary-searches). The packed result (`data/public-hash-list.bin`, 9.45 MiB) is **not** compiled
    into a C++ array — embedding that much high-entropy (hence uncompressible) data as string/array
    literals would bloat both the translation unit and compile time for no benefit — it ships as a
    plain file via `FINAL_TARGET_FILES.crossoriginstorage`, landing alongside the GRE, and
    `CrossOriginStoragePublicHashList` loads it lazily (one `NS_GetSpecialDirectory(NS_GRE_DIR, ...)`
    main-thread round trip, mirroring `CrossOriginStoragePersistence`'s own pattern, then a single
    file read) and holds it resident for the process lifetime. A load failure of any kind (missing
    file, wrong size) fails safe to "nothing loaded," identical to the old empty seed's behavior,
    never a crash. New gtest (`dom/crossoriginstorage/gtest/`) exercises real first/middle/last
    entries pulled directly from the shipped file, plus absent/malformed/wrong-algorithm rejection
    — the first unit test in this feature's history, and a real regression check: a broken load
    path degrades every wildcard-scope read to GREASE-only without any test noticing otherwise.

## Implementation plan

### Build order

Recommended order to build this feature in Firefox specifically, on a `cross-origin-storage`
branch off `main`:

1. **WebIDL surface + Navigator/WorkerNavigator wiring**, pref-gated
   (`dom.crossOriginStorage.enabled`): `CrossOriginStorageManager` interface,
   `CrossOriginStorageRequestFileHandleHash`/`Options` dictionaries transcribed from the spec's IDL
   block, in a new `dom/crossoriginstorage/` directory. Methods reject with a placeholder error
   until the actor exists.
2. **Request validation + Permissions Policy gating**: per-algorithm hash-shape checks for every
   WebCrypto-recognized algorithm, not just SHA-256 (see decision 5); register `cross-origin-storage`
   in `sSupportedFeatures[]` and check via `FeaturePolicyUtils::IsFeatureAllowed` before validation.
3. **`PCrossOriginStorage` actor + in-memory `CrossOriginStorageRegistry` singleton** on the
   PBackground thread (decisions 1, 7, 8).
4. **Wire `CrossOriginStorageManager::RequestFileHandle()` to the actor** for both read and create
   requests, constructing a real `dom::FileSystemFileHandle` (decision 2) and
   `CrossOriginStorageWritableFileStream` (decisions 2–4) for the write path.
5. **Import and run the COS WPT suite** (`testing/web-platform/tests/cross-origin-storage/`, plus
   the separately-located `interfaces/cross-origin-storage.idl` that `idlharness.js` needs) to
   validate the round trip end to end — this validates the core round trip before layering more
   scopes and persistence on top.
6. **List- and wildcard-scoped disclosure and the monotonic visibility-upgrade rule** (decision 7).
7. **Persistence (decision 10), real storage-budget eviction (decision 13), Public Hash List +
   GREASE'ing (decisions 12, 16), and rate limiting (decision 14)** — these are naturally bundled
   since they all touch the same registry/write-path surface.
8. **`nsIClearDataService` integration** with revoke-and-GC semantics (decision 15).
9. **gtest coverage** for the registry, utils, and rate limiter, directly against the
   PBackground-thread singletons (no script/IPC) — see the Verification plan below.
10. **CI**: a `workflow_dispatch`-only GitHub Actions workflow building and publishing
    macOS/Linux/Windows builds to a rolling release tag, so testers can try the feature without
    building from source.

## Deferred / follow-up work

What's still open, beyond the architecture described above:

- **Real streaming writes**: a write session's bytes are still fully memory-resident during the
  write itself (bounded by the 4 GiB cap, decision 9), only reaching disk once `close()`'s
  `VerifyAndStore` succeeds (decision 10). Real streaming (a disk-backed temp file, chunked
  transfer without holding the full payload in either process's memory) is what would let that
  ceiling be raised or removed safely.
- **A real I/O thread for persistence**: `CrossOriginStoragePersistence` (and
  `CrossOriginStoragePublicHashList`'s own lazy load) does synchronous file I/O directly on the
  PBackground thread (documented in `CrossOriginStoragePersistence`'s own header comment) rather
  than dispatching to a dedicated thread the way QuotaManager does — correct but not necessarily
  fast under load. The PHL load is a one-time ~9 MiB read, not a per-request cost, so lower
  priority than persistence's own per-write I/O.
- **A real eviction index**: `EnforceStorageBudget` does a full-entry-list scan-and-sort on every
  budget-relevant write (documented in the registry header's Phase 1 limitations note), not the
  incremental O(1) usage-tracking / O(log n) eviction-index a real implementation needs at scale.
- **Keeping the Public Hash List snapshot current**: `data/public-hash-list.bin` is a one-time
  snapshot; the upstream `.dat` file is regenerated on its own schedule, and nothing here re-runs
  `generate_public_hash_list.py` automatically. A real implementation would need either a periodic
  re-embed (rebuild-triggered, matching the etld_data.inc-style "checked-in generated file,
  manually refreshed" precedent this mirrors) or a genuine runtime update mechanism — out of scope
  for a first real pass.
- **Dedicated security review pass**: per-algorithm path-safety validation reaching the trusted
  process, resource caps on `seek()`/`truncate()` once real disk backing exists.
- **Settings UI**: inspect/delete individual entries from `about:preferences` or similar — the
  clear-data integration (decision 15) covers bulk/site-scoped clearing, not a per-entry browser.
- **Reattributing storage-budget usage on partial site-clear**: decision 15's own documented
  limitation — if `clearBySite()` removes specifically an entry's *first* storing origin (the one
  `mOriginUsage` attributes bytes to) while other storing origins remain, that usage credit goes
  stale rather than transferring to the entry's new first storing origin. Rare, bounded, not fixed.
- **Declarative integrations** (HTML `crossoriginstorage` attribute, JS import attribute, CSS
  `cross-origin-storage()`): each belongs to its own host-language spec, out of scope here. WPT
  subtests for all three currently fail for this reason.
- **Firefox's lack of `Permissions-Policy` HTTP header support**: a pre-existing platform gap
  (`grep -rln "\"Permissions-Policy\""` across `dom/`/`netwerk/` returns nothing, vs. the legacy
  `Feature-Policy` header, which is supported), not something to fix as part of COS. Two WPT
  subtests that rely on the header-based (not `allow=`-attribute-based) restriction form currently
  fail for this reason.
- **Dedicated regression tests for the persistence/budget code paths**: the registry's full
  lifecycle, disclosure scoping, `RemoveSite`'s partial-revoke branch against two genuinely
  distinct sites, and the rate limiter (including exhausting a write burst to a denial) all have
  checked-in gtest coverage. What's still uncovered: **persistence**
  (`CrossOriginStoragePersistence`'s disk read/write/scan path — the current gtest suite exercises
  only the in-memory fallback, none force a real `WriteEntry`/`ScanPersistedEntries` round trip)
  and **storage-budget eviction** (`EnforceStorageBudget` actually evicting an entry under a
  constrained budget) — both still verified only via ad hoc marionette scripts (not checked into
  the tree) and a full WPT re-run.

## Risks

**Biggest open risk: the write path is still fully memory-resident, capped at a flat 4 GiB
ceiling (decision 9), not genuinely streaming to disk.** This bounds worst-case memory correctly,
but it's a hard ceiling on how large a single write can ever be, and one in-flight write can hold
up to 4 GiB resident in the parent process. Removing or raising that ceiling safely needs real
disk-backed streaming (see Deferred work above) — not a purely mechanical swap, since the
integrity-ordering constraint the shared cross-vendor engineering notes describe (hash only the
complete, final content, never incrementally) applies regardless of backing store.

**Second risk: storage-budget eviction and PHL-membership disclosure have no dedicated regression
test yet** (see Deferred work and Verification plan below) — they're exercised only incidentally
through manual/WPT runs that don't generate enough traffic to trip an eviction or land on a real
PHL-listed hash. A regression in either would likely go unnoticed until it surfaced as a real,
user-visible failure.

## Verification plan

- **Build after every WebIDL/IPDL/XPIDL-touching change.** New bindings and actor code need a real
  `./mach build`, not `build faster`.
- **Manual smoke testing** via `./mach run --setpref dom.crossOriginStorage.enabled=true` against a
  real page exercising the API. This catches runtime-only failures — a Permissions Policy allowlist
  miss, a missing prototype method — that don't show up as compile errors and that WPT or
  type-checking alone won't surface.
- **Run the imported WPT suite**: `./mach wpt --headless --setpref
  dom.crossOriginStorage.enabled=true testing/web-platform/tests/cross-origin-storage/`. Expected
  current state: `filesystemwritablefilestream-verify.tentative.https.any.js` and
  `requestFileHandle-create-and-read.tentative.https.any.js` pass in full across all 4 globals; the
  declarative HTML/CSS/import-attribute integration tests and two `Permissions-Policy`-header tests
  are expected to fail (out of scope / pre-existing platform gap — see Deferred work above).
- **Persistence needs verification via a real cross-process restart, not just WPT** — a WPT run
  never spans a process restart, so it structurally cannot exercise the reload-from-disk path.
  Recommended technique: a `marionette_driver`-scripted Python harness launches the built Firefox
  against a persistent (not auto-deleted) profile, writes an entry, confirms the `.bytes`/`.meta`
  pair on disk, force-quits the browser, relaunches against the *same* profile, and confirms
  `requestFileHandle()` (no `create`) + `getFile()` still returns the original content.
- **The write-size cap (4 GiB)** doesn't yet have a dedicated boundary test; worth adding as a
  regression test that seeks to just past 4 GiB and writes one byte, expecting `close()` to fail
  with `DataError` — not a test that actually writes 4 GiB.
- **The concurrent-writers-one-fails-one-succeeds invariant** the outstanding-writer-count design
  (decision 8) exists to handle is covered by the imported WPT suite's own test for it
  (`requestFileHandle-create-and-read.tentative.https.any.js`, "a failed write does not disrupt a
  concurrent, still-outstanding write for the same hash that succeeds") — no separate WPT-level
  test is needed for this, though the gtest suite (below) also covers it directly for speed.
- **Storage-budget eviction, rate limiting, and GREASE'ing**: the gtest suite covers rate-limiter
  burst exhaustion; storage-budget eviction and PHL-membership disclosure (which needs a real
  preimage, not fabricatable) are not yet covered — see the matching item under Deferred work
  above.
- **The Public Hash List**: recommended verification technique for this kind of shipped-data-file
  testing is a gtest that extracts real first/middle/last entries from the shipped
  `data/public-hash-list.bin` at generation time and asserts `Contains()` finds them, plus rejects
  an absent (all-zeros) digest, malformed input, and a real digest tagged with the wrong algorithm
  (`dom/crossoriginstorage/gtest/TestCrossOriginStoragePublicHashList.cpp`,
  `./mach gtest "CrossOriginStoragePublicHashList.*"`). This exercises the full path
  (`FINAL_TARGET_FILES` packaging, `NS_GRE_DIR` resolution at runtime, the actual file read, and the
  binary search), not just the parsing logic in isolation. It does not cover an end-to-end
  wildcard-scope disclosure decision actually driven by real PHL membership (as opposed to GREASE)
  — that would need real content bytes matching one of the listed hashes, which by construction
  (pre-image resistance) aren't available to fabricate for a test.
- **The gtest suite as a whole** (`./mach gtest "CrossOriginStorage*"`) covers the registry
  lifecycle, disclosure scoping, the monotonic upgrade rule, the `RemoveSite`/`ClearAll` clear-data
  paths (including the partial-revoke branch against two genuinely distinct sites), and the
  rate limiter's burst exhaustion. Raw NSS calls (`ComputeHashValueHex` → `PK11_HashBuf`) need an
  explicit `NSS_NoDB_Init(nullptr)` call in a bare gtest process, since nothing there triggers the
  platform's normal crypto-subsystem startup path — this matches
  `security/manager/ssl/tests/gtest/HMACTest.cpp`'s own precedent.
- **`nsIClearDataService` integration**: the recommended verification technique for chrome-only
  surfaces WPT can't reach is a marionette script that writes entries, calls `clear()` directly and
  via the real `Services.clearData.deleteData()` path, and confirms both are unreadable afterward.
  The full-wipe path is straightforward to verify this way. The partial-revoke branch's actor/IPC
  plumbing (as opposed to the underlying `RemoveSite()` registry logic, which the gtest suite
  covers directly) needs real distinct-origin content-page navigation, which a chrome-context
  script can't produce on its own.

## Rollout

The GitHub Actions release workflow is manual-dispatch only (`workflow_dispatch`, not on every
push, to avoid paying for a full clean multi-platform build on every commit) and publishes macOS
arm64, Linux x86_64, and Windows x86_64 builds to a rolling `cross-origin-storage-latest` release
tag on the same fork, so testers can download a build without compiling locally — all three legs
(macOS arm64, Linux x86_64, Windows x86_64) have been run and confirmed working. Those builds
have the feature enabled by default, so there's nothing left for a tester to configure. Nothing
has been proposed upstream to
`mozilla-central` — this is a personal-fork feature branch for as long as Deferred work above
remains open (default-enabled on this fork's own testing builds is not the same claim as "ready to
ship").

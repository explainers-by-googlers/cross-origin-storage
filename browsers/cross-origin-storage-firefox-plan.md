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

This document covers Firefox's Phase 1: the WebIDL surface, actor plumbing, and a correct (if
in-memory-only) read/write round trip across all three disclosure scopes, behind a
disabled-by-default pref — plus a follow-up fix (this document's last implementation step) that
closes a `filesystemwritablefilestream-verify` WPT gap found once the WPT suite was imported and
run for real. Work happened on a `cross-origin-storage` branch off `main` in
`tomayac/firefox`, committing at each step below.

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
4. **A generated WebIDL `BufferSource` union type turned out not to be usable** for accepting raw
   bytes directly — exhaustive header search found no working generated binding for the plain
   (non-`AllowShared`) `BufferSource` typedef in this configuration. Chunk bytes are instead
   extracted with the same raw JSAPI calls named in decision 3
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
   Wildcard's Public Hash List gate and GREASE'ing are explicitly not implemented (see Deferred
   work below).
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
11. **A real, non-obvious Gecko footgun found via end-to-end testing, not code review:**
    `nsIBinaryInputStream::ReadCString()` internally calls `ReadSegments()`, and a raw local-file
    input stream (`NS_NewLocalFileInputStream`) unconditionally returns `NS_ERROR_NOT_IMPLEMENTED`
    for `ReadSegments()` (`nsFileStreamBase::ReadSegments`, `netwerk/base/nsFileStreams.cpp`) — its
    own comment says to wrap it in a buffered stream instead, which is what `ReadMetaFile` now does
    via `NS_NewBufferedInputStream`. This is deterministic, not a race: it would have failed on
    *every* metadata read, not just after a restart, and static analysis / code review alone
    wouldn't have caught it (the write path uses `WriteBytes`/`Write()`, not `WriteSegments`, so
    only reading was ever affected) — found only by actually writing an entry, restarting the
    browser via a real marionette-driven process relaunch against a persistent profile, and
    confirming the read-back failed. See the Verification plan below.
12. **Public Hash List + GREASE'ing gate wildcard-scope disclosure, matching the spec's
    `#availability-gating` two-part design.** New `CrossOriginStoragePublicHashList` (a
    linear-scanned compiled-in list of known-public SHA-256 hashes — trivial complexity-wise
    while the list is empty, deliberately not a fabricated/placeholder dataset; see the class's own
    header comment for why real population is separate, later work no implementer has a live feed
    for yet) and `CrossOriginStorageGrease` (1% probability, 500 KiB size ceiling, matching Servo's
    and Ladybird's own chosen constants, rolled via `mozilla::RandomUint64OrDie()` — a
    cryptographically-sourced RNG, not a fast/predictable one, since this feeds a privacy-relevant
    decision). `CompleteReadRequest`'s `Wildcard` branch now checks PHL-membership OR a GREASE roll
    before disclosing, instead of unconditionally disclosing.
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

## Implementation plan

### Steps

1. **Branch**: create `cross-origin-storage` off `main`.
2. **WebIDL surface + Navigator/WorkerNavigator wiring** (`af78acbd1d`) — `CrossOriginStorageManager`
   interface, `CrossOriginStorageRequestFileHandleHash`/`Options` dictionaries transcribed from the
   spec's IDL block; `dom.crossOriginStorage.enabled` static pref; new `dom/crossoriginstorage/`
   directory and `moz.build`.
3. **Request validation + Permissions Policy gating** (`fb736fe732`) — recognized-algorithm check
   plus per-algorithm hex-length validation for every WebCrypto-recognized algorithm, not just
   SHA-256 (closing the path-traversal-shaped footgun both Servo's and Ladybird's own notes flag);
   `origins` option normalization capped at 100 entries; `FeaturePolicyUtils::IsFeatureAllowed`
   check before validation; all rejections queued as a task per spec, never a synchronous throw.
4. **`PCrossOriginStorage` actor + in-memory registry singleton** (`8b3fc546b8`) — protocol
   registration in `PBackground.ipdl`/`BackgroundParentImpl`/`BackgroundChildImpl`;
   `CrossOriginStorageRegistry` singleton with the state machine and outstanding-writer-count
   cleanup from decision 8.
5. **Wire `CrossOriginStorageManager::RequestFileHandle()` to the actor** for both read and create
   requests (`d1ea9f6d7a`), constructing a real `dom::FileSystemFileHandle` per decision 2.
6. **Fix: register `cross-origin-storage` as a recognized Permissions Policy feature**
   (`d70f3fb446`) — found via manual testing against a public COS test page
   (`web-ai-community.github.io/cross-origin-storage-extension/test.html`): `sSupportedFeatures[]`
   had never been given an entry, so `DefaultAllowListFeature` fell through to deny-all for every
   request, surfacing as `NotAllowedError` regardless of caller.
7. **Fix: add `CrossOriginStorageWritableFileStream` for a real `write()` method**
   (`5399bc79ad`) — also found via manual testing: `createWritable()` had been resolving with a
   plain `WritableStream` (via `WritableStream::CreateNative`), which per WHATWG Streams has no
   `.write()` method at all; decision 2 above covers the class actually built to fix this.
8. **Implement list- and wildcard-scoped disclosure and visibility upgrades** (`ccc8e52764`) — the
   `origins` option, previously rejected outright as "not yet supported by this implementation".
9. **Import the COS WPT suite from `wpt#61811` and run it against the local build**
   (`7ecf94fba7`) — copying both `cross-origin-storage/` and the separately-located
   `interfaces/cross-origin-storage.idl` (`idlharness.js` fetches it independently; missing it
   broke every worker-global test with a fetch error, not a real failure).
10. **Add a GitHub Actions workflow** building macOS arm64 and publishing to GitHub Releases on
    push to this branch (`e410108b1f`) —
    `.github/workflows/cross-origin-storage-build.yml`, so testers can try the feature without
    building from source; publishes to a rolling `cross-origin-storage-latest` release tag.
11. **Fix: implement `seek()`/`truncate()` and ArrayBuffer/ArrayBufferView `write()` chunks**
    (`92ecd41594`) — found via the imported `filesystemwritablefilestream-verify` WPT subtest,
    which calls `.seek()`/`.truncate()` directly and separately pipes a `Blob.stream()`
    `ReadableStream` (which yields `Uint8Array` chunks, not a `Blob` or a string) into the writable
    stream. See decisions 3 and 4.
12. **Fix: cap a write session's in-memory buffer at 4 GiB** (`f3ced467e1`) — closed the
    allocation-DoS gap flagged below, matching Servo's/Ladybird's own placeholder ceiling; see
    decision 9.
13. **Add persistence, real storage-budget eviction, PHL/GREASE'ing, and rate limiting**
    (`21e4491f24`) — a self-audit surfaced five remaining gaps (grep for `TODO`/`FIXME`/documented
    "Phase 1 limitations" comments across the tree, cross-checked against the Deferred work list
    below); this step closes four of them (persistence, storage budget, wildcard PHL/GREASE, rate
    limiting) plus the write-size cap's own remaining "not per-origin/global budget" gap from step
    12. See decisions 10–14. Verified with a real marionette-driven process restart (write, quit,
    relaunch, read back against a persistent profile), which also found and fixed a genuine Gecko
    footgun (decision 11) that a full COS WPT re-run alone would not have caught, since WPT test
    runs don't span a process restart.
14. **Rework the release workflow: manual dispatch only, macOS + Linux + Windows**
    (`0c546f8d19`) — previously ran (and rebuilt macOS-only) on every push, which is wasteful for a
    full clean multi-platform build with no incremental caching; switched to `workflow_dispatch`
    only, and matrixed the existing bootstrap/build/package steps across `macos-14`, `ubuntu-22.04`,
    and `windows-2022`. Only the macOS leg has actually been run; see that step's own note in
    Verification plan below.

## Deferred / follow-up work

Narrowed twice now from the original Phase 1 scoping: list/wildcard-scope and the write-size cap
landed in steps 8 and 12; persistence, real storage-budget eviction, PHL/GREASE'ing, and rate
limiting all landed in step 13. What's left:

- **Real streaming writes**: a write session's bytes are still fully memory-resident during the
  write itself (step 12's 4 GiB cap), only reaching disk once `close()`'s `VerifyAndStore` succeeds
  (decision 10). Real streaming (a disk-backed temp file, chunked transfer without holding the full
  payload in either process's memory) is what would let that ceiling be raised or removed safely.
- **A real I/O thread for persistence**: `CrossOriginStoragePersistence` does synchronous file I/O
  directly on the PBackground thread (documented in its own header comment) rather than dispatching
  to a dedicated thread the way QuotaManager does — correct but not necessarily fast under load.
- **A real eviction index**: `EnforceStorageBudget` does a full-entry-list scan-and-sort on every
  budget-relevant write (documented in the registry header's Phase 1 limitations note), not the
  incremental O(1) usage-tracking / O(log n) eviction-index a real implementation needs at scale.
- **Populating the Public Hash List**: the gating mechanism (decision 12) is real; the list itself
  ships with an empty seed. Populating it with real, independently-verifiable public hashes is a
  fetch/verify/build-time-embed pipeline no implementer (including this one) has built yet.
- **Dedicated security review pass**: per-algorithm path-safety validation reaching the trusted
  process, resource caps on `seek()`/`truncate()` once real disk backing exists.
- **Settings UI**: inspect/delete entries, clear-site-data integration.
- **Declarative integrations** (HTML `crossoriginstorage` attribute, JS import attribute, CSS
  `cross-origin-storage()`): each belongs to its own host-language spec, out of scope here. WPT
  subtests for all three currently fail for this reason, confirmed on the latest full-suite run.
- **Firefox's lack of `Permissions-Policy` HTTP header support**: a pre-existing platform gap
  (`grep -rln "\"Permissions-Policy\""` across `dom/`/`netwerk/` returns nothing, vs. the legacy
  `Feature-Policy` header, which is supported), not something to fix as part of COS. Two WPT
  subtests that rely on the header-based (not `allow=`-attribute-based) restriction form currently
  fail for this reason.
- **Dedicated regression tests for the persistence/budget/PHL/rate-limiting code paths**: all four
  were verified via a real marionette-driven restart script and a full WPT re-run (no regressions),
  not via a checked-in, repeatable automated test targeting each mechanism directly (e.g. a test
  that actually exhausts a rate-limit bucket, or forces a budget-triggered eviction). Worth building
  before this goes further, same rationale as the concurrent-writers-race item resolved below.

## Verification plan

- `./mach build` after every WebIDL/IPDL-touching step (2, 3, 4, 5, 6, 7, 8, 11, 12, 13) — new
  bindings and actor code need a real build, not `build faster`.
- Manual smoke testing via `./mach run --setpref dom.crossOriginStorage.enabled=true` against a
  public COS test page after each user-visible step — this is what actually caught the two real
  bugs fixed in steps 6 and 7; type-checking and WPT alone would not have caught either, since
  both were runtime-only failures (a feature-policy allowlist miss, and a missing prototype
  method) that don't show up as compile errors.
- `./mach wpt --headless --setpref dom.crossOriginStorage.enabled=true
  testing/web-platform/tests/cross-origin-storage/` after every step from 9 onward. Current state
  (post step 13): `filesystemwritablefilestream-verify.tentative.https.any.js` passes 16/16
  subtests across all 4 globals; `requestFileHandle-create-and-read.tentative.https.any.js`
  (including its concurrent-writers subtest, see below) passes 12/12 across all 4 globals; the only
  remaining failures across the full suite are the pre-existing, explicitly out-of-scope gaps
  listed under Deferred work above (declarative HTML/CSS/import-attribute integrations, and the
  `Permissions-Policy` header) — unchanged in count and identity across every re-run since step 9,
  confirming none of steps 10–14 regressed anything.
- **Persistence (step 13) was verified with a real cross-process restart**, not just WPT (a single
  WPT run never spans a process restart, so it structurally cannot exercise the
  reload-from-disk path): a `marionette_driver`-scripted Python harness launches the built Firefox
  against a persistent (not auto-deleted) profile with a `.bytes`/`.meta` pair confirmed on disk
  after the write, force-quits it, relaunches against the *same* profile, and confirms
  `requestFileHandle()` (no `create`) + `getFile()` still returns the original content. This is
  what actually caught decision 11's `ReadSegments()` bug — every earlier verification pass
  (build succeeding, full WPT suite passing) had missed it, since the write path never exercises
  `ReadCString()` at all and nothing else in this feature restarts the browser mid-test.
- The write-size cap from step 12 has **still not** been exercised end to end at the exact 4 GiB
  boundary (WPT has no dedicated coverage since the spec doesn't mandate an exact ceiling, and
  writing 4 GiB in a quick manual/scripted test isn't practical). A session whose `WriteChunk`/
  `Truncate` calls would grow `WriteSession::mBytes` past 4 GiB is expected to fail `close()` with
  `DataError`; worth an actual regression test (e.g. seeking to just past 4 GiB and writing one
  byte, rather than writing the full 4 GiB) before relying on this.
- The two-concurrent-writers-one-fails-one-succeeds scenario the outstanding-writer-count design
  (decision 8) exists to handle is **covered**: it turned out to already be a test case in the
  imported `wpt#61811` suite (`requestFileHandle-create-and-read.tentative.https.any.js`, "a failed
  write does not disrupt a concurrent, still-outstanding write for the same hash that succeeds") —
  missed on an earlier read-through of the suite, found on a closer look, confirmed passing 12/12
  across all 4 globals post step 13. No new test was needed.
- Storage-budget eviction, rate limiting, and PHL/GREASE'ing (step 13) do **not** have a dedicated
  regression test yet — see the matching item under Deferred work above. They were exercised only
  incidentally (a handful of ordinary requests during WPT/manual runs, never enough traffic to
  actually trip a rate limit or a budget eviction) and are unverified in the specific failure modes
  they exist to handle.

## Rollout

Every step above was committed individually to `tomayac/firefox`'s `cross-origin-storage` branch
and pushed after local verification passed; no step was squashed or amended. The GitHub Actions
release workflow (step 10, reworked in step 14) is now manual-dispatch only (`workflow_dispatch`,
not on every push, to avoid paying for a full clean multi-platform build on every commit) and
publishes macOS arm64, Linux x86_64, and Windows x86_64 builds to a rolling
`cross-origin-storage-latest` release tag on the same fork, so testers can download a build without
compiling locally — though only the macOS leg has actually been run and confirmed working; Linux
and Windows are best-effort until someone triggers the workflow and checks. Nothing has been
proposed upstream to `mozilla-central` — this is a disabled-by-default, personal-fork feature
branch for as long as Deferred work above remains open.

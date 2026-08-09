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
   path already uses. This is a stopgap bounding worst-case memory use, not real per-origin/global
   storage-budget accounting (still Deferred, below).

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

## Deferred / follow-up work

Carried forward, largely unchanged, from the original Phase 1 scoping (a few items below are now
narrower than originally planned, since list/wildcard-scope and the write-size cap landed in
steps 8 and 12 above):

- **Persistence**: on-disk registry (per-entry files or SQLite-backed metadata), atomic
  rename-into-place writes, crash-safe startup scan. Currently fully in-memory; lost on restart.
- **Real storage-budget/eviction accounting**: step 12's flat 4 GiB write-session cap only bounds
  worst-case memory use for a *single* in-flight write; it is not per-origin/global budget
  tracking or eviction (that's the separate item below). Real streaming writes (also below) would
  let this ceiling be raised well past what's safe to hold in memory today.
- **Wildcard scope**: Public Hash List fetch/verify/build-time-embed pipeline, then GREASE'ing on
  top of it. Currently, any wildcard-scoped entry discloses to every requesting origin
  unconditionally — acceptable only for a disabled-by-default, unshipped local build.
- **Rate limiting**: per-origin token buckets for reads and writes, bounded rate-limiter memory
  (LRU-capped origin map).
- **Storage budget & eviction**: two-tier global/per-origin budget based on total (not free) disk
  capacity, LRU eviction by last-read time, incremental usage totals and eviction index.
- **Real streaming writes**: disk-backed temp file instead of the current in-memory buffer,
  chunked transfer without holding full payloads in either process's memory — this is what would
  let step 12's flat 4 GiB ceiling be raised (or removed) safely.
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

## Verification plan

- `./mach build` after every WebIDL/IPDL-touching step (2, 3, 4, 5, 6, 7, 8, 11, 12) — new
  bindings and actor code need a real build, not `build faster`.
- Manual smoke testing via `./mach run --setpref dom.crossOriginStorage.enabled=true` against a
  public COS test page after each user-visible step — this is what actually caught the two real
  bugs fixed in steps 6 and 7; type-checking and WPT alone would not have caught either, since
  both were runtime-only failures (a feature-policy allowlist miss, and a missing prototype
  method) that don't show up as compile errors.
- `./mach wpt --headless --setpref dom.crossOriginStorage.enabled=true
  testing/web-platform/tests/cross-origin-storage/` after step 9 and again after step 11.
  Current state (post step 11): `filesystemwritablefilestream-verify.tentative.https.any.js`
  passes 16/16 subtests across all 4 globals (window/worker/sharedworker/serviceworker); the only
  remaining failures across the full suite are the pre-existing, explicitly out-of-scope gaps
  listed under Deferred work above (declarative HTML/CSS/import-attribute integrations, and the
  `Permissions-Policy` header). Re-run again after step 12 with identical results — the write-size
  cap has no dedicated WPT coverage (the spec doesn't mandate an exact ceiling), so this only
  confirms no regression, not the cap's own behavior.
- The write-size cap from step 12 has **not** been exercised end to end (neither by WPT, which has
  no dedicated coverage since the spec doesn't mandate an exact ceiling, nor manually — writing
  4 GiB in a quick manual console test isn't practical either). Verification so far is limited to
  a successful build and no WPT regression. A session whose `WriteChunk`/`Truncate` calls would
  grow `WriteSession::mBytes` past 4 GiB is expected to fail `close()` with `DataError`; worth an
  actual regression test (e.g. seeking to just past 4 GiB and writing one byte, rather than
  writing the full 4 GiB) before relying on this.
- The two-concurrent-writers-one-fails-one-succeeds scenario the outstanding-writer-count design
  (decision 8) exists to handle has not yet been exercised by a dedicated regression test — the
  general WPT suite doesn't target it directly, and both Servo and Ladybird's own notes flag this
  exact race as the single most likely bug real implementations ship. Worth a dedicated test before
  this goes further.

## Rollout

Every step above was committed individually to `tomayac/firefox`'s `cross-origin-storage` branch
and pushed after local verification passed; no step was squashed or amended. The GitHub Actions
release workflow (step 10) runs on every push to this branch and publishes to a rolling
`cross-origin-storage-latest` release tag on the same fork, so testers can download a build without
compiling locally. Nothing has been proposed upstream to `mozilla-central` — this is a disabled-by-
default, personal-fork feature branch for as long as Deferred work above remains open, in
particular the write-size cap and the Public Hash List/GREASE'ing gate.

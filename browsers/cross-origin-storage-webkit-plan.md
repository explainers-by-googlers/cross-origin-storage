# WebKit: Cross-Origin Storage (COS) — Implementation Plan

## Context

Cross-Origin Storage (COS) is a new WICG API: a content-addressable file cache, keyed by
cryptographic hash rather than by origin, that lets independent sites share one stored copy of a
large, byte-identical resource (AI model weights, Wasm modules, popular JS libraries, fonts)
instead of each downloading and storing it separately. The spec draft defines the
`navigator.crossOriginStorage.requestFileHandle()` entry point; a registry of hash-keyed entries
with a pending→written lifecycle; three disclosure scopes (same-site-only, an explicit origin
list, or a PHL/GREASE-gated wildcard); storage-budget and eviction rules; and
rate-limiting/probing defenses. WPTs exist at
[web-platform-tests/wpt#61811](https://github.com/web-platform-tests/wpt/pull/61811).

Three independent implementations (Servo, Ladybird, Gecko) had already shipped this and left
detailed engineering notes at
[`cross-origin-storage-implementation-notes.md`](./cross-origin-storage-implementation-notes.md),
which catch several real bugs a naive first pass would miss — unbounded `truncate()` resource
claims, path traversal via unvalidated per-algorithm hash values, entry-cleanup races between
concurrent writers, and a silent-corruption window between hashing and publishing. All three were
used as prior art here the way Gecko's plan used Servo's and Ladybird's.

WebKit starts from an unusually favorable position for this feature, and the whole plan is shaped
by that: it already has a mature, disk-backed File System Access implementation with a real
`FileSystemFileHandle` and `FileSystemWritableFileStream`, already living in a shared, persistent,
IPC-reachable service (the network process). The central architectural question was therefore not
"what do we build" but "how much of what already exists can be reused unchanged," and the answer
turned out to be: almost all of it.

This document covers the initial implementation: the WebIDL surface, IPC plumbing, and a correct
read/write round trip (disk-persisted, budget-accounted, PHL/GREASE-gated, and rate-limited)
across all three disclosure scopes, plus a real Public Hash List with an automated refresh.
`CrossOriginStorageEnabled` is `status: testable` — off in shipping builds, on under the test
runner. Work happened on a `cross-origin-storage` branch in `tomayac/WebKit`.

## Key architectural decisions

1. **The registry lives in the network process, alongside the cookie jar, HSTS store, and every
   other shared persistent service — but deliberately *outside* the per-origin storage tree.**
   WebKit's `NetworkStorageManager` (`Source/WebKit/NetworkProcess/storage/`) is exactly the
   "shared, persistent, IPC-reachable service" the notes call for, and it already owns the bucket
   file system, IndexedDB, local storage, and Cache Storage. The temptation is to hang COS off
   `OriginStorageManager`, since that is where `FileSystemStorageManager` normally comes from. That
   would be a mistake for the same reason Gecko's notes give for not extending `PQuota`: that tree
   assumes per-origin partitioning as a load-bearing property, and content-addressable sharing is
   precisely the case where the same bytes have several owners and no single owning origin. Instead
   a new `CrossOriginStorageRegistry`
   (`Source/WebKit/NetworkProcess/storage/CrossOriginStorageRegistry.{h,cpp}`) is a flat,
   session-scoped singleton hanging directly off `NetworkStorageManager`, created lazily on first
   use, rooted at `<session storage path>/CrossOriginStorage`. Session-scoped, not
   process-global: a private browsing session must never share entries with a persistent one.

2. **The registry owns its own `FileSystemStorageManager`, which is what makes the entire
   post-authorization API surface free.** This is the decision the rest of the implementation
   falls out of. `FileSystemStorageManager` is not inherently origin-scoped — it is a
   path-rooted manager that mints `FileSystemStorageHandle`s and registers them in the process-wide
   `FileSystemStorageHandleRegistry`. Giving the COS registry one of its own, rooted at
   `<registry>/files`, means a handle it hands out is indistinguishable, from every downstream
   message's point of view, from a bucket file system handle. `GetFile`, `CreateWritable`,
   `ExecuteCommandForWritable`, `CloseWritable`, and `CloseHandle` all already look handles up by
   identifier in that shared registry, so `getFile()`, `createWritable()`, `write()`, `seek()`,
   `truncate()`, and `close()` work on a COS handle with **zero** new IPC messages and no new
   WebCore classes. Exactly one new message exists in the whole feature:
   `CrossOriginStorageRequestFileHandle`. Everything else is interception, described next.

   This is a genuinely different shape from Gecko's, which had to build
   `CrossOriginStorageRequestHandler` and `CrossOriginStorageWritableFileStream` from scratch
   because `dom/fs`'s equivalents couple tightly to `PFileSystemManager`'s fd-passing. **The
   transferable lesson is the inverse of that one:** before writing a parallel implementation of
   your engine's writable-stream machinery, check whether the class you want to reuse is coupled to
   *origin partitioning* or merely to *a path root*. If it is the latter, handing it a different
   root is all the reuse costs, and the saving is most of the feature.

3. **Verify-and-store is implemented by interception in `NetworkStorageManager`, not by a
   parallel write path.** Three handlers gained a COS branch, each guarded by
   `m_crossOriginStorageRegistry->ownsHandle(identifier)`:
   - `getFile()` consults `prepareGetFile()`, which rejects with `NotAllowedError` while the entry
     is still `pending` — even for the caller that requested the handle, which must not observe an
     unverified placeholder as the file's contents — and refreshes the entry's last-read time.
   - `executeCommandForWritable()` consults `checkWriteCommand()` *before* the resize or write is
     attempted (see decision 6).
   - `closeWritable()` delegates entirely to the registry, which hashes and then decides.

   The interception point matters, and it is the reason this design is safe on a rewrite.
   WebKit's `FileSystemStorageHandle::createWritable()` accumulates into a sibling temporary file
   and `closeWritable(Completed)` copies that file into the handle's real path. The registry hashes
   the **temporary** file and only calls `closeWritable(Completed)` once the digest matches and the
   budget clears; a mismatch calls `closeWritable(Aborted)` instead, which deletes the temporary
   file and leaves the destination untouched. An origin that requests a create handle for a hash
   another origin already stored correctly, and then writes garbage, therefore cannot corrupt what
   is already there — the bad bytes never reach the entry's path at all. Getting this ordering
   backwards (publish, then verify) would be a silent violation of the one guarantee the entire
   feature exists to provide.

4. **`FileSystemStorageError` gained two values rather than a parallel COS error enum.** The
   authorized handle flows into the same `FileSystemFileHandle` machinery, whose later calls
   already return `FileSystemStorageError` across IPC, so `getFile()` rejecting with
   `NotAllowedError` and `close()` rejecting with `DataError` have to travel on that enum whatever
   else is done. Adding `NotAllowed` and `DataMismatch` to it, plus the two lines in
   `FileSystemStorageError.serialization.in`, was strictly less machinery than a second enum that
   would have had to be converted into the first one anyway.

5. **Hash-shape validation is written once, in WebCore, and run twice — on both sides of the
   process boundary.** `isValidCrossOriginStorageHash()` in
   `Source/WebCore/Modules/cross-origin-storage/CrossOriginStorageRequestData.h` carries the table
   of recognized WebCrypto algorithms with each one's expected hex digest length (SHA-1/40,
   SHA-256/64, SHA-384/96, SHA-512/128). The WebIDL layer uses it to turn a malformed request into
   a `TypeError`; `NetworkStorageManager::crossOriginStorageRequestFileHandle()` uses it again
   under `MESSAGE_CHECK_COMPLETION`, because a compromised or simply buggy WebContent process can
   speak the IPC protocol directly and the hash value becomes a path component in the network
   process. Validating *every* recognized algorithm rather than only SHA-256 — the only one the
   spec normatively constrains, and the only one any test exercises — is what closes the path
   traversal the notes describe: a `value` of `../../etc/whatever` declared as SHA-512 would
   otherwise sail through a SHA-256-only check.

6. **The streaming-time size cap is tracked per write session in the registry, not inside the
   quota-check callback.** `FileSystemStorageManager`'s `QuotaCheckFunction` receives only a
   requested-space delta, with no way to tell which write session is asking, so it cannot enforce
   a per-session ceiling. `checkWriteCommand()` runs one level up, in
   `NetworkStorageManager::executeCommandForWritable()`, where the stream identifier is in hand: it
   maintains the session's tracked size (a `truncate()` sets it, a `write()` grows it to its
   resulting end position) and fails the session at 4 GiB before the operation is attempted. The
   quota callback is kept as a coarse global backstop. This closes the gap the notes flag: nothing
   crosses the wire for `truncate(hugeNumber)`, so without a check here a single script call could
   claim arbitrary disk long before the authoritative budget check at `close()` ever runs.

7. **Every terminal failure funnels into one cleanup path, and an explicit `abort()` resolves.**
   `CrossOriginStorageRegistry::closeWritable()` has a single `failWrite()` lambda used by the
   hash mismatch, the read failure, the quota rejection, and the explicit abort. It aborts the
   writable, decrements the entry's outstanding-writer count, and removes the entry **only if**
   the count reached zero **and** the entry was never `written`. Both qualifiers earn their keep,
   for different reasons — the zero-count one protects a concurrent sibling writer for the same
   hash, and the never-written one stops any origin from deleting what another origin correctly
   stored by deliberately writing garbage. `abort()` takes the same path but returns no error, so
   a well-behaved abandonment reclaims immediately instead of waiting out the five-minute
   staleness timeout that exists for the crash case.

8. **The Public Hash List ships as an external data file next to the framework, refreshed
   weekly by a scheduled job.** `Tools/Scripts/update-cross-origin-storage-public-hash-list`
   fetches the list from GitHub's LFS **media** endpoint (`raw.githubusercontent.com` serves only
   a few hundred bytes of pointer text), pins the download against the published companion
   `.sha256` *before* trusting it, parses the three sections, and writes sorted, packed 32-byte
   digests to `Source/WebKit/Resources/CrossOriginStoragePublicHashList.dat`. The current snapshot
   is 295,448 digests, 9,454,336 bytes. `CrossOriginStoragePublicHashList` loads it lazily on the
   first lookup and answers with an O(log n) binary search; any read failure fails safe to an
   empty list, which behaves exactly like a genuinely empty one rather than like "everything is
   allowed."

   Shipping it as a resource rather than compiling it in sidesteps the "tens of millions of
   characters of source" problem entirely, at the cost of a fallible runtime read. A
   `.github/workflows/` job re-runs the script weekly and commits the result — Servo's approach,
   chosen over Ladybird's build-configure-time fetch because WebKit builds are not routinely
   re-configured from clean, and explicitly *not* the one-time manual snapshot Gecko's notes name
   as the inadequate option.

9. **The Hugging Face section is adopted.** The spec makes it a SHOULD, and the notes ask
   implementers to make the call consciously rather than by concatenating every digest line
   without noticing the distinction. Adopting it is the right answer for WebKit specifically:
   large model weights are the content this feature exists for, and the notes' own argument
   settles it — adoption only pays off if it is uniform, since an implementation that omits the
   section forces those downloads to repeat per origin while one that includes it does not,
   handing out a real and uneven performance advantage. The script takes
   `--skip-model-hub-section` so the decision stays visible and reversible rather than buried.

10. **GREASE'ing uses `cryptographicallyRandomNumber`, and never applies to a storing origin's own
    read.** A predictable roll is not a roll: if an adversary can anticipate which requests get
    GREASEd, the "found" signal becomes reliable again through the gaps, and a fast PRNG looks
    statistically fine in every ordinary test while failing exactly that property. Entries at or
    above 500 KiB are never GREASEd, because a false negative there forces an observable, costly
    re-download — and the *latency difference* between a GREASEd hit and a genuine miss is itself
    a signal, which would undo the point. An origin reading back its own write is also exempt:
    there is nothing to conceal from it, and a false negative there would break the feature for
    its own writer.

11. **Site-scoped clearing is revoke-and-GC.** `deleteDataForOrigins()` strips the cleared
    origin from every entry's storing-origins set and from any explicit origins-list grant naming
    it, and deletes the entry outright only when that leaves it with no storing origin at all.
    Neither the spec nor the explainer decides this; the reasoning is that surprising an
    *uncleared* site by deleting data it still depends on, purely as a side effect of an action it
    was never part of, is a worse failure mode than a cleared site's bytes persisting under a
    different, legitimate owner's storing relationship. This hangs off the existing
    `WebsiteDataType::FileSystem` deletion path, so "Clear website data" reaches it with no new
    UI-process plumbing.

12. **No locking.** The registry is only ever touched from `NetworkStorageManager`'s work queue,
    which handles one message to completion before starting the next. Per Ladybird's lesson, that
    is genuinely single-threaded access rather than single-threaded-by-convention, so a lock would
    be pure overhead and would misdirect effort. The class asserts `!RunLoop::isMain()` at its
    entry points instead.

## Implementation plan

### Build order

Following the notes' suggested ordering, adapted to what WebKit already had:

1. **Data model, persistence, and the pending/written state machine.** Per-entry files, matching
   Servo's and Gecko's shape rather than Ladybird's SQLite one, since no embedded database was
   already in use anywhere convenient: `<registry>/files/<algorithm>/<hex>` for bytes and
   `<registry>/metadata/<algorithm>/<hex>.meta` for metadata, so a metadata-only mutation — a
   read-recency timestamp update on every single read — never rewrites anything proportional to
   the rest of the registry. Metadata is a small line-oriented text format; every write goes to a
   `<final name>.tmp` sibling and is renamed into place, with a deliberately *predictable*
   temporary name so the startup scan can recognize and discard an orphan a crash left behind.
   Only `written` entries are persisted; an in-flight write's bytes live in the writable stream's
   own temporary file, and losing one across a crash is accepted rather than recovered.
2. **The WebIDL surface and same-site-only disclosure**, end to end through the real IPC and
   binding layers before anything else was added.
3. **Rate limiting**, both budgets, bounded from day one rather than retrofitted — including the
   10,000-origin LRU cap on the limiter's own map, which is not a spec concern at all but is a
   genuine unbounded leak over a long session that visits many sites.
4. **Storage budget and eviction**, with running totals maintained incrementally at every mutation
   site rather than recomputed by scanning, since the check runs on every write.
5. **List scope**, including the LRU merge behavior and its two different treatments of the
   maximum length — a `TypeError` for a single over-long call, silent truncation for a merge.
6. **Wildcard scope**: the PHL fetch/verify/pack/refresh pipeline first, then GREASE'ing.
7. **A security review pass** for the three categories the notes name.

### What is where

| Piece | Location |
|---|---|
| `CrossOriginStorageManager`, validation, normalization | `Source/WebCore/Modules/cross-origin-storage/` |
| Shared request struct, hash-shape validation, constants | `Source/WebCore/Modules/cross-origin-storage/CrossOriginStorage{RequestData,Limits}.h` |
| `crossOriginStorage` on `Navigator`/`WorkerNavigator` | `NavigatorCrossOriginStorage.idl`, `NavigatorBase::crossOriginStorage()` |
| `cross-origin-storage` policy-controlled feature | `Source/WebCore/html/PermissionsPolicy.{h,cpp}` |
| Connection abstraction, worker thread hop | `Source/WebCore/Modules/storage/{Storage,WorkerStorage}Connection.{h,cpp}` |
| WebContent-side IPC client | `Source/WebKit/WebProcess/WebCoreSupport/WebStorageConnection.cpp` |
| Registry, rate limiter, PHL | `Source/WebKit/NetworkProcess/storage/CrossOriginStorage*.{h,cpp}` |
| Interception points | `Source/WebKit/NetworkProcess/storage/NetworkStorageManager.cpp` |
| PHL snapshot and refresh | `Source/WebKit/Resources/`, `Tools/Scripts/`, `.github/workflows/` |

## Deferred / follow-up work

Named here rather than left as `FIXME`s, because a deferral note nothing forces anyone to revisit
is not a plan.

- **Hashing blocks the storage work queue.** `closeWritable()` reads and digests the finished
  temporary file synchronously, in 1 MiB chunks, on `NetworkStorageManager`'s work queue. This
  matches what the surrounding code already does — the existing `closeWritable()` copies the whole
  file synchronously on that same queue — but it is the wrong shape for the multi-hundred-MiB
  payloads this feature targets, and it should move to a dedicated queue with the result posted
  back.
- **No streamed transfer to the registry.** The notes' three-message
  `begin`/`chunk`×N/`finish` protocol is unnecessary here, because the bytes never travel to the
  registry as a payload at all — they are already in a disk-backed temporary file that the
  registry reads directly. The related concern that *does* still apply is the one above.
- **Eviction is a collect-and-sort, O(n log n) per pass.** Running totals are incremental, as the
  notes ask, but the eviction candidate list is not backed by an ordered index yet. Same known gap
  Gecko's implementation has.
- **Shared-entry budget attribution.** An entry's full byte cost is charged to whichever origin's
  write first transitioned it to `written`. A second origin independently storing the identical
  bytes is not charged again (correct — the bytes are genuinely shared) but also gets nothing
  charged against its own share (arguably less correct). A site-scoped revoke that removes
  specifically the attributed origin leaves that credit stale. This is the same unresolved
  modeling gap the notes describe; it is bounded rather than harmful, and it is a conscious
  simplification here rather than a surprise.
- **In-memory read cache.** Every `getFile()` hands back a path the WebContent process reads
  directly, so this matters less than it does for an implementation that copies bytes across IPC,
  but repeated reads of the same entry still re-open the file each time.
- **The PHL data path is Cocoa-plus-environment-variable.** `defaultDataPath()` resolves the file
  from the WebKit framework's own resources on Cocoa, and honors
  `WEBKIT_CROSS_ORIGIN_STORAGE_PUBLIC_HASH_LIST` everywhere. GTK and WPE need their own install
  location and a `WEBKIT_CROSS_ORIGIN_STORAGE_PUBLIC_HASH_LIST_PATH` build definition before the
  gate does anything on those ports; until then wildcard scope fails closed there, which is the
  safe direction but not the useful one.
- **A restart-spanning persistence test.** The notes are emphatic that a passing build and a
  passing in-process suite can both stay green while the reload-from-disk path is completely
  broken, since a conformance run never restarts the browser. WebKit's API test infrastructure can
  drive a real process against a fixed data store directory; that test does not exist yet.
- **Manually added entries.** The settings-UI path for seeding a file the user already has on
  disk (defaulting to `"*"` scope, with empty storing origins) is not implemented.

## Risks

- **Reusing `FileSystemStorageHandle` couples COS to OPFS's write mechanics.** The verification
  ordering in decision 3 depends on `createWritable()` accumulating into a temporary file and
  `closeWritable(Completed)` publishing it. A future refactor that made writes land in place
  would silently turn hash verification into a check performed *after* the entry was already
  overwritten. The `activeWritablePath()` accessor added for this is the visible seam; it deserves
  a comment on the OPFS side too, and ideally a test that fails loudly if the invariant moves.
- **Adding a value to `PermissionsPolicy::Feature` renumbers the enum**, which is serialized over
  IPC. Both sides are built together so this is safe in-tree, but it is the kind of change that
  breaks a mixed-version pairing, and the corresponding entry in
  `WebCoreArgumentCoders.serialization.in` has to move in lockstep.
- **`status: testable` turns the API on for every layout test**, so the global-object interface
  listings need rebaselining. That is routine for a new API but it is a large, noisy diff that can
  hide a real change.
- **The 9.4 MiB resource is now part of the framework**, and the weekly job will churn it. It
  compresses poorly (it is packed digests), so repository growth over time is real and worth
  watching.

## Verification plan

Following the notes' split between what belongs in the shared conformance suite, what belongs in
direct unit tests, and what needs a real browser with two real origins:

- **Spec conformance: the WPT suite, not a reimplementation of it.** The suite in
  [wpt#61811](https://github.com/web-platform-tests/wpt/pull/61811) is vendored into a local WPT
  checkout for validation — both the `cross-origin-storage/` directory and the separately located
  `interfaces/cross-origin-storage.idl`, whose absence breaks every worker-global test with a
  fetch error that looks like a real failure. It is deliberately *not* copied into
  `LayoutTests/imported/`, so that WebKit's normal WPT sync supersedes it cleanly once the PR
  merges.
- **Cross-origin disclosure: a real two-origin layout test.**
  `LayoutTests/http/tests/cross-origin-storage/disclosure-scopes.html` exercises what a
  single-origin suite structurally cannot: same-site-but-different-port disclosure, cross-site
  refusal, listed versus unlisted origins, wildcard failing closed for a hash that cannot be on
  the PHL, and a storing origin always reading back its own write. It uses `127.0.0.1` and
  `localhost` on two ports — different origins, and (since neither has a registrable domain)
  different sites — and needs no TLS, because loopback is a secure context. The cross-origin
  frames carry `allow="cross-origin-storage"`, which incidentally covers the policy-controlled
  feature's `self` default.
- **PHL membership with a known preimage.** You cannot construct bytes that hash to an arbitrary
  target, so this needs a real listed resource. The manual-additions section carries exactly one
  entry with documented provenance and a fetchable source URL, which is the right anchor for this
  test. Not yet written.
- **Registry logic directly.** Rate-limiter burst exhaustion, eviction ordering, the
  concurrent-writer race, and staleness are all far easier to drive against the registry's own
  functions than through a browser — and, per Ladybird's experience, loop-shaped scenarios can be
  outright unreliable through a test harness whose idle heuristics were not designed for a script
  still legitimately working. Assert the *shape* of rate-limiter behavior (denial eventually
  happens; successes fall in `[capacity, capacity + slack]`), never an exact boundary count, since
  a refill tick landing between two consumes will let one extra request through
  non-deterministically. These tests are not written yet.

## Rollout

`CrossOriginStorageEnabled` is `status: testable`: enabled under the test runner, off in shipping
builds, and `disableInLockdownMode: true`. It is a `sharedPreferenceForWebProcess`, which is what
lets `[EnabledBy=CrossOriginStorageEnabled]` gate the IPC message itself — a WebContent process
without the preference cannot reach the registry at all, rather than being stopped only at the
binding layer.

This is a personal-fork branch, not a WebKit release channel. "Enabled" here means "enabled for
anyone who builds this branch," nothing more.

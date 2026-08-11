# Ladybird: Cross-Origin Storage (COS) — Implementation Plan

## Context

Cross-Origin Storage is a new Web Platform API (WICG explainer + draft spec at
`wicg.github.io/cross-origin-storage`) that lets independent origins share a single
content-addressable file cache — primarily aimed at large AI-model-weight files that many
unrelated sites currently each re-download separately. The user asked to implement this in
Ladybird, using engineering notes from the Servo team's own implementation (already built on
`tomayac/servo`'s `cross-origin-storage` branch) as a guide, adapted to Ladybird's real
architecture.

This is a large, multi-week-scale feature (Servo's reference implementation is ~6,200 lines
across 34 files). The plan below sequences it into independently buildable/testable phases,
each ending in a concrete, manually-verifiable milestone, so the feature is demoable long
before every hardening concern (rate limiting, the Public Hash List, GREASE'ing, quota
eviction, a full test suite) lands. Phases 1–6 are the target for this initial push; Phase 7–8
(hardening + tests) are real requirements for a launch-quality implementation but are
correctly deferred, matching Servo's own commit sequence (their hardening commits all landed
after the feature already worked end to end).

## Key architectural decisions

Key architectural facts already verified against this exact checkout
(`/Volumes/120GB_SSD/Documents/ladybird`, branch `cross-origin-storage`) and cited by file path
throughout:

1. **New subsystem directory: `Libraries/LibWeb/CrossOriginStorage/`** (mirrors the `WebLocks/`
   precedent — one directory bundling `CrossOriginStorageManager`, `NavigatorCrossOriginStorage`,
   `FileSystemHandle`, `FileSystemFileHandle`, `FileSystemWritableFileStream`, plus non-IDL
   helpers). Deliberately not a generic `FileSystemAccess/` name — these `FileSystem*` classes are
   minimal COS-scoped stand-ins, not a real File System Access API implementation; a future real
   OPFS effort gets its own directory later.
2. **No File System Access API / OPFS exists in LibWeb at all.** We build minimal, COS-scoped
   `FileSystemHandle`/`FileSystemFileHandle`/`FileSystemWritableFileStream` classes from scratch,
   disk-backed via `Core::File` — mirroring what Servo itself had to do for the same reason.
3. Ladybird's persistent, cross-process shared state (cookies, HSTS, localStorage, history,
   bookmarks) lives in **`Libraries/LibWebView`**, owned by the UI/Chrome process's `Application`,
   backed by SQLite via `Libraries/LibDatabase/Database.h`. The COS registry belongs here too, as
   a new sibling of `CookieJar`/`StorageJar`/`HSTSStore`.
4. WebContent ↔ UI-process IPC already has two directly reusable precedents: the synchronous
   cookie-lookup round trip (`did_request_cookie` in `Services/WebContent/WebContentClient.ipc`),
   and a chunked-streaming-upload shape already in production for downloads
   (`did_start_download`/`did_receive_download_data`/`did_finish_download` in the same file,
   backed by `Libraries/LibWebView/FileDownloader.{h,cpp}`).
5. `URL::Origin::is_same_site()` (`Libraries/LibURL/Origin.cpp`) already implements correct
   eTLD+1/PSL-based same-site comparison — reuse directly, never reimplement.
6. Permissions Policy in this codebase is a deliberate stub (`DOM::PolicyControlledFeature` enum
   in `Document.h`, hardcoded `true` per case in `Document::is_allowed_to_use_feature()`,
   `Document.cpp:5859`) — COS's policy gate follows this same stub pattern, not a real allowlist
   engine.
7. `[Experimental]` IDL extended attribute + `--expose-experimental-interfaces` is the established
   idiom for in-progress specs (e.g. `OffscreenCanvas.idl`) — used to gate all new COS interfaces.

**Deviations from Servo's approach** (identified during planning):

1. `WritableStream` `final` → non-final (one-line), building `FileSystemWritableFileStream` via
   the already-existing native-construction path (`set_up_writable_stream_default_controller`,
   already used for transferable streams) rather than needing new streams-machinery.
2. SQLite-for-metadata (via the existing `LibDatabase`/`CookieJar` pattern) instead of Servo's
   bespoke per-entry-JSON-file scheme — Ladybird already has the better-suited tool for this.
3. The streaming-write IPC protocol is modeled directly on the existing download-streaming
   precedent (`FileDownloader`/`did_receive_download_data`), not invented from scratch.
4. Disk-backed writable stream from Phase 4 onward, not memory-buffered-then-migrated (no
   in-memory legacy reason to build the stopgap Servo needed first).

## Implementation plan

### Phase 1 — IDL/JS skeleton, no registry, no IPC

**Goal:** `navigator.crossOriginStorage` exists and returns a real `CrossOriginStorageManager`;
`requestFileHandle()` exists and always rejects. Establishes all build-system wiring.

New files:
- `Libraries/LibWeb/CrossOriginStorage/CrossOriginStorageManager.{h,cpp,idl}`
- `Libraries/LibWeb/CrossOriginStorage/NavigatorCrossOriginStorage.{h,cpp,idl}`

`CrossOriginStorageManager.idl` (mirrors `Libraries/LibWeb/StorageAPI/StorageManager.idl`):
```webidl
[Exposed=(Window,Worker), SecureContext, Experimental]
interface CrossOriginStorageManager {
    Promise<FileSystemFileHandle> requestFileHandle(
        CrossOriginStorageRequestFileHandleHash hash,
        optional CrossOriginStorageRequestFileHandleOptions options = {});
};

dictionary CrossOriginStorageRequestFileHandleHash {
    required DOMString value;
    required DOMString algorithm;
};

dictionary CrossOriginStorageRequestFileHandleOptions {
    boolean create = false;
    (DOMString or sequence<DOMString>) origins;
};
```

`NavigatorCrossOriginStorage.idl` (mirrors `NavigatorStorage.idl` exactly):
```webidl
[SecureContext, Experimental]
interface mixin NavigatorCrossOriginStorage {
    [SameObject, SecureContext] readonly attribute CrossOriginStorageManager crossOriginStorage;
};
```

`NavigatorCrossOriginStorage.h/.cpp` — copy `Libraries/LibWeb/StorageAPI/NavigatorStorage.{h,cpp}`
verbatim, renamed:
```cpp
class NavigatorCrossOriginStorage {
public:
    virtual ~NavigatorCrossOriginStorage() = default;
    GC::Ref<CrossOriginStorageManager> cross_origin_storage();
protected:
    virtual Bindings::PlatformObject const& this_navigator_cross_origin_storage_object() const = 0;
};
```
`.cpp`: `return HTML::relevant_settings_object(this_navigator_cross_origin_storage_object()).cross_origin_storage_manager();`

`CrossOriginStorageManager.h/.cpp` — copy `StorageManager`'s `PlatformObject` shape. Phase 1 body
of `request_file_handle()`: create promise, immediately reject with `TypeError`/placeholder,
return promise.

Existing files to edit:
- `Libraries/LibWeb/HTML/Scripting/Environments.h`/`.cpp` — add `cross_origin_storage_manager()` +
  `m_cross_origin_storage_manager`, following `storage_manager()`/`m_storage_manager` exactly
  (`Environments.h:136-137`, `Environments.cpp:551-562`), including the `visit_edges` line
  (`Environments.cpp:73-74`).
- `Libraries/LibWeb/HTML/Navigator.h` — include the new header, add
  `public CrossOriginStorage::NavigatorCrossOriginStorage` to the inheritance list, add
  `this_navigator_cross_origin_storage_object()` override next to the existing
  `this_navigator_storage_object()`.
- `Libraries/LibWeb/HTML/Navigator.idl` — add `Navigator includes NavigatorCrossOriginStorage;`.
- `Libraries/LibWeb/HTML/WorkerNavigator.h`/`.idl` — same two edits (spec exposes this on
  `WorkerNavigator` too).
- `Libraries/LibWeb/Forward.h` — add a `namespace Web::CrossOriginStorage { ... }` forward-decl
  block (alphabetically placed, matching the existing `Web::WebLocks` block).
- `Libraries/LibWeb/CMakeLists.txt` — add the two new `.cpp` files.
- `Libraries/LibWeb/idl_files.cmake` — add `libweb_js_bindings(CrossOriginStorage/CrossOriginStorageManager)`
  and `libweb_js_bindings(CrossOriginStorage/NavigatorCrossOriginStorage)`.

**Done when:** build succeeds; launched with `--expose-experimental-interfaces`,
`typeof navigator.crossOriginStorage === "object"` in the console; without the flag,
`navigator.crossOriginStorage` is `undefined`.

---

### Phase 2 — Synchronous validation contract

**Goal:** `requestFileHandle()` performs all spec-mandated synchronous validation before any
async work. Still no registry — async tail unconditionally rejects `NotFoundError`.

New file: `Libraries/LibWeb/CrossOriginStorage/AbstractOperations.{h,cpp}` (mirrors
`WebLocks/AbstractOperations.{h,cpp}`):
- `validate_cos_hash(...)` — validate `algorithm` against the WebCrypto-recognized name set
  (reuse the string-dispatch pattern already in `Libraries/LibWeb/Crypto/CryptoAlgorithms.cpp`
  for `"SHA-1"/"SHA-256"/"SHA-384"/"SHA-512"`), then validate `value`'s hex length **per
  algorithm's own exact digest size** (SHA-1→40 hex chars, SHA-256→64, SHA-384→96, SHA-512→128)
  — bake this in from day one: validating only SHA-256's shape (and accepting other algorithms'
  `value` at that length) is an exploitable path-traversal bug once the hash `value` is used to
  build an on-disk path in Phase 5.
- `validate_cos_origins(...)` — parse each string via `URL::Origin`, reject opaque origins,
  enforce a max list length of **100** (matches Servo's own choice) with `TypeError` at this
  single-call site.

`CrossOriginStorageManager::request_file_handle()`: run both validators synchronously (return an
already-rejected promise on failure — WebIDL requires this be synchronous, not deferred); check
`document.is_allowed_to_use_feature(PolicyControlledFeature::CrossOriginStorage)`, reject
`NotAllowedError` if false; otherwise reject `NotFoundError` (placeholder).

Existing files to edit:
- `Libraries/LibWeb/DOM/Document.h` — add `CrossOriginStorage` to `enum class PolicyControlledFeature : u8` (`Document.h:220-229`).
- `Libraries/LibWeb/DOM/Document.cpp` — add a `case PolicyControlledFeature::CrossOriginStorage: return true; // FIXME: Implement allowlist for this.` arm in `is_allowed_to_use_feature()` (`Document.cpp:5859`), matching every existing arm exactly.
- `Libraries/LibWeb/CMakeLists.txt` — add `CrossOriginStorage/AbstractOperations.cpp`.

**Done when:** console tests confirm exact error behavior with no registry involved:
bad hex → `TypeError`; bad origin string → `TypeError`; valid input → `NotFoundError`.

---

### Phase 3 — Real IPC round trip to an in-memory LibWebView registry

**Goal:** Stand up the actual cross-process registry skeleton and both `requestFileHandle` code
paths hitting it over real IPC — fully in-memory (no persistence, no disk blobs yet). Proves the
IPC shape before layering persistence/streaming on top.

New files:
- `Libraries/LibWebView/CrossOriginStorageRegistry.{h,cpp}` — owns `HashMap<CosHash, CosEntry>`:
  ```cpp
  struct CosHash { String algorithm; String value; };
  enum class CosEntryState { Pending, Written };
  // Variant<SameSiteOnly, Vector<String> /*serialized origins*/, Wildcard>
  struct CosDisclosureScope { ... };
  struct CosEntry {
      CosHash hash;
      CosEntryState state { CosEntryState::Pending };
      CosDisclosureScope origins;
      HashTable<String> storing_origins;
      Optional<ByteBuffer> bytes; // in-memory in this phase only
  };
  class CrossOriginStorageRegistry {
  public:
      static NonnullOwnPtr<CrossOriginStorageRegistry> create();
      /* "complete a read request" */
      CosReadResult complete_a_read_request(CosHash const&, String const& requesting_origin);
      /* "complete a create request" */
      CosCreateResult complete_a_create_request(CosHash const&, CosDisclosureScope requested_origins, String const& requesting_origin);
  private:
      HashMap<CosHash, CosEntry> m_entries;
  };
  ```
  Keep disclosure matching (`determine COS disclosure`) as a **stub** this phase (storing-origin
  → always allow; else → always deny) — the full same-site/list/wildcard algorithm is Phase 6.

New IPC messages in `Services/WebContent/WebContentClient.ipc` (sync round trip, following the
cookie precedent — `did_request_cookie` at line ~"did_request_cookie" in that file):
```
did_request_cos_read(String origin, String hash_algorithm, String hash_value) => (CrossOriginStorage::CosReadResult result)
did_request_cos_create(String origin, String hash_algorithm, String hash_value, CrossOriginStorage::CosRequestedOrigins requested_origins) => (u64 cos_handle_token)
```
Define `CosReadResult`/`CosRequestedOrigins` as plain IPC-codable structs in a new
`Libraries/LibWebView/CrossOriginStorageTypes.h` (mirrors `HTTP::Cookie::VersionedCookie`'s
pattern of a plain struct shared across the IPC boundary).

Existing files to edit:
- `Libraries/LibWeb/Page/Page.h` — add default-no-op virtual `PageClient` hooks
  `page_did_request_cos_read(...)` / `page_did_request_cos_create(...)`.
- `Services/WebContent/PageClient.h/.cpp` — real impl using
  `send_sync_but_allow_failure<Messages::WebContentClient::DidRequestCosRead>(...)` /
  `DidRequestCosCreate`, matching `page_did_request_cookie()` (`PageClient.cpp:973-981`) exactly.
- `Libraries/LibWebView/WebContentClient.h/.cpp` — handlers delegating to
  `Application::cross_origin_storage_registry().complete_a_read_request(...)` /
  `complete_a_create_request(...)`, matching `WebContentClient::did_request_cookie()`
  (`WebContentClient.cpp:1340-1350`).
- `Libraries/LibWebView/Application.h/.cpp` — add `OwnPtr<CrossOriginStorageRegistry> m_cos_registry;`
  + `static CrossOriginStorageRegistry& cross_origin_storage_registry();`, constructed
  unconditionally alongside `m_cookie_jar`.
- `Libraries/LibWeb/CrossOriginStorage/CrossOriginStorageManager.cpp` — async tail now performs
  the real IPC round trip via the page/browsing-context's client accessor, constructing a
  placeholder response object (not yet a real `FileSystemFileHandle` — Phase 4).
- `Libraries/LibWebView/CMakeLists.txt` — add `CrossOriginStorageRegistry.cpp`.

**Done when:** `requestFileHandle(hash, {create:true})` then `requestFileHandle(hash)` (read, same
hash, same session) shows the registry created a `Pending` entry and the read path sees it —
correctly rejecting per spec (pending → `NotAllowedError`, not `NotFoundError`; this distinction
is the phase's correctness check). Verify via dbgln traces correlating the hash across the IPC hop.

---

### Phase 4 — FileSystem* classes, real disk-backed writes, verify-and-store

**Goal:** The largest phase. Same-origin create→write→close→read→getFile() round trip works
end to end with real bytes on real disk. **Treat this phase's milestone as "correct but
possibly slow," not "done"** — see Risks below; making the write path properly non-blocking
under large payloads is explicitly Phase 7 work.

New files:
- `Libraries/LibWeb/CrossOriginStorage/FileSystemHandle.{h,cpp,idl}` — base class:
  ```webidl
  [Exposed=(Window,Worker), SecureContext, Experimental]
  interface FileSystemHandle {
      readonly attribute FileSystemHandleKind kind;
      readonly attribute USVString name;
  };
  enum FileSystemHandleKind { "file", "directory" };
  ```
- `Libraries/LibWeb/CrossOriginStorage/FileSystemFileHandle.{h,cpp,idl}`:
  ```webidl
  [Exposed=(Window,Worker), SecureContext, Experimental]
  interface FileSystemFileHandle : FileSystemHandle {
      Promise<File> getFile();
      Promise<FileSystemWritableFileStream> createWritable(optional FileSystemCreateWritableOptions options = {});
  };
  dictionary FileSystemCreateWritableOptions { boolean keepExistingData = false; };
  ```
  C++: carries the COS hash + `cos_handle_token` from Phase 3 as private state. `getFile()` does
  an IPC round trip re-checking entry state (`NotAllowedError` if still `Pending`), returns a
  `FileAPI::File` over bytes fetched in one `ByteBuffer` IPC response (reading isn't the
  streaming-sensitive path; writing is).
- `Libraries/LibWeb/CrossOriginStorage/FileSystemWritableFileStream.{h,cpp,idl}`:
  ```webidl
  [Exposed=(Window,Worker), SecureContext, Experimental]
  interface FileSystemWritableFileStream : WritableStream {
      Promise<undefined> write(FileSystemWriteChunkType data);
      Promise<undefined> seek(unsigned long long position);
      Promise<undefined> truncate(unsigned long long size);
  };
  typedef (BufferSource or Blob or USVString or WriteParams) FileSystemWriteChunkType;
  dictionary WriteParams {
      required WriteCommandType type;
      unsigned long long size;
      unsigned long long position;
      (BufferSource or Blob or USVString) data;
  };
  enum WriteCommandType { "write", "seek", "truncate" };
  ```

**Required base-class edit:** `Libraries/LibWeb/Streams/WritableStream.h` — remove `final` from
`class WritableStream final` (confirmed still present as of this plan). Low-risk, one-line
change; `WritableStreamDefaultController` stays untouched and `final`.

C++ shape:
```cpp
class FileSystemWritableFileStream final : public Streams::WritableStream {
    WEB_PLATFORM_OBJECT(FileSystemWritableFileStream, Streams::WritableStream);
    GC_DECLARE_ALLOCATOR(FileSystemWritableFileStream);
public:
    static WebIDL::ExceptionOr<GC::Ref<FileSystemWritableFileStream>> create(JS::Realm&, u64 cos_handle_token);
    GC::Ref<WebIDL::Promise> write(FileSystemWriteChunkType data);
    GC::Ref<WebIDL::Promise> seek(WebIDL::UnsignedLongLong position);
    GC::Ref<WebIDL::Promise> truncate(WebIDL::UnsignedLongLong size);
private:
    u64 m_cos_handle_token { 0 };
};
```
Construct natively via `Streams::set_up_writable_stream_default_controller`, following the exact
precedent at `Libraries/LibWeb/Streams/AbstractOperations.cpp:263`/`:418`
(`set_up_cross_realm_transform_writable`) — **do not** subclass or modify
`WritableStreamDefaultController`. `write()`/`seek()`/`truncate()` are all thin wrappers that
build a tagged chunk (`{type, data?, position?, size?}`) and go through the standard
write-a-chunk path; the native `write_algorithm` C++ lambda is where real IPC happens and where
`type` gets dispatched. `close_algorithm` is where "verify and store" runs (see below).
`FileSystemWritableFileStream.idl` is not `[Transferable]` — omit that attribute, no override needed.

Streaming IPC protocol, modeled directly on the already-existing download-streaming precedent
(`did_start_download`/`did_receive_download_data`/`did_finish_download`/`did_fail_download` in
`WebContentClient.ipc`, backed by `Libraries/LibWebView/FileDownloader.{h,cpp}`):
```
did_start_cos_write(u64 cos_handle_token) => (u64 write_session_id)
did_write_cos_chunk(u64 write_session_id, WriteCommandType type, u64 position_or_size, ByteBuffer data) => (bool accepted)
did_finish_cos_write(u64 write_session_id) => (CrossOriginStorage::CosVerifyResult result)
did_abort_cos_write(u64 write_session_id) =|
```
Use the synchronous `=>` form for `did_write_cos_chunk` in this phase (blocks the renderer per
chunk, same as `did_request_cookie`) — deliberately the simple-but-correct first cut; converting
to async is Phase 7.

`CrossOriginStorageRegistry` gains a write-session table:
`HashMap<u64, WriteSession>` where `WriteSession { CosHash hash; NonnullOwnPtr<Core::File> temp_file; Crypto::Hash::Manager hasher; bool disk_write_failed = false; }`.
**Security-critical ordering:** each chunk write must call
`temp_file->write_until_depleted(data)` (or seek+write for seek/truncate command types)
**first**, and only feed the hasher **after** that succeeds — never update the running
hash/byte-count before the fallible disk write is confirmed. `did_finish_cos_write`
closes the temp file, compares the derived digest case-insensitively to `entry.hash.value`; on
success, transitions `Pending`→`Written`, appends to `storing_origins`, runs a stubbed (no-op)
"upgrade resource visibility" (real algorithm is Phase 6); on mismatch, deletes the temp file,
leaves the entry `Pending`, returns `DataError` up through the IPC response into the
`FileSystemWritableFileStream` close-promise rejection. Temp files live in a scratch subdirectory
under the profile data path this phase; the final content-addressed layout is formalized in Phase 5.

Existing files to edit: same set as Phase 3 (`WebContentClient.ipc`, `PageClient.{h,cpp}`,
`LibWebView/WebContentClient.{h,cpp}`, `Application.{h,cpp}`) plus `Libraries/LibWeb/CMakeLists.txt`
and `idl_files.cmake` for the three new IDL-bearing classes.

**Done when:** this exact console script round-trips real bytes end to end:
```js
const enc = new TextEncoder().encode("hello cos");
const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc))]
  .map(b => b.toString(16).padStart(2,'0')).join('');
const h = await navigator.crossOriginStorage.requestFileHandle({value: digest, algorithm: "SHA-256"}, {create: true});
const w = await h.createWritable();
await w.write(enc);
await w.close();
const h2 = await navigator.crossOriginStorage.requestFileHandle({value: digest, algorithm: "SHA-256"});
const f = await h2.getFile();
console.log(await f.text()); // "hello cos"
```

---

### Phase 5 — Persistence (survive process restart)

**Goal:** Registry metadata + blob bytes survive a UI-process restart.

Converts `CrossOriginStorageRegistry` to the `TransientStorage`/`PersistedStorage` split, per
`CookieJar.h`'s exact shape (`migrate_schema(Database&, MigrationMode)`, `create(Database&)`).
**Deviation from Servo's per-entry-JSON-file scheme:** use one SQLite table for metadata
(mirroring `CookieJar.cpp`'s `CREATE TABLE IF NOT EXISTS Cookies (...)`), since Ladybird already
has this pattern proven — SQLite gives atomic, O(1)-per-row updates for free (e.g. touching
read-recency on every read is just `UPDATE ... WHERE hash = ?`), satisfying the notes' "avoid
rewriting a monolithic file" goal without reinventing per-entry file I/O:
```sql
CREATE TABLE IF NOT EXISTS CosEntries (
    hash_algorithm TEXT NOT NULL,
    hash_value TEXT NOT NULL,
    state INTEGER NOT NULL,
    disclosure_scope INTEGER NOT NULL,
    disclosure_list TEXT,
    storing_origins TEXT NOT NULL,
    byte_size INTEGER,
    last_read_time INTEGER,
    created_time INTEGER,
    PRIMARY KEY (hash_algorithm, hash_value)
);
```
Blob bytes still live as real files (not in SQLite) at
`<profile_data_dir>/CrossOriginStorage/blobs/<algorithm>/<value>` — a content-addressed path
derived directly from the already-validated hash (safe by construction, since Phase 2 enforces
exact per-algorithm hex-charset/length — this is what closes the path-traversal risk the notes
flag). Atomic commit: write to `<path>.tmp`, `rename()` into place. On `Application` startup,
scan `blobs/` for orphaned `.tmp` files (crash mid-write) and delete them.

Existing files to edit:
- `Libraries/LibWebView/Application.h/.cpp` — wire `CrossOriginStorageRegistry::migrate_schema`/`create`
  into the same startup sequence as `m_cookie_jar` (copy the "CheckOnly then Apply" migration dance).

**Done when:** repeat the Phase 4 script, fully quit and relaunch the browser, then run only the
read half — it still succeeds with correct bytes.

---

### Phase 6 — Real disclosure algorithm

**Goal:** Actual cross-origin sharing semantics: same-site-only / explicit list / wildcard
scopes, storing-origin bypass, upgrade-only visibility.

Purely `Libraries/LibWebView/CrossOriginStorageRegistry.{h,cpp}` — no IPC/IDL shape changes.
- `determine_cos_disclosure(entry, requesting_origin)`: storing-origin bypass first; else
  wildcard → stub-always-false until Phase 7's PHL exists (correctly *unusable-by-non-storers*
  rather than silently over-permissive in the interim); list → exact serialized-origin
  membership; same-site-only → `URL::Origin::is_same_site()` against every storing origin
  (reuse directly).
- `apply_availability_gating(...)` = disclosure check + storing-origin GREASE-bypass (GREASE
  itself stubbed to never-fire until Phase 7).
- `upgrade_resource_visibility(entry, requested_origins)`: monotonic same-site<list<wildcard
  upgrade, list-merge with max-length-100 cap and silent truncation on overflow.

**Done when:** a genuine two-origin test — for a real cross-*site* negative case, use two
different eTLD+1s via `/etc/hosts` aliases (e.g. `a.test`/`b.test`) during manual testing, not
just two ports on `127.0.0.1` (which are same-site) — confirms: origin A creates+writes with
`options.origins` omitted → same-site origin B can read it, genuinely different-site origin C
gets `NotFoundError` (indistinguishable from a true miss).

### Phase 7 — Hardening pass

Real requirements for a launch-quality implementation, correctly sequenced after the feature
already works end to end (Phases 1–6 above) — matching Servo's own commit sequence, whose
hardening commits all landed after their feature worked end to end too.

Bundle rate limiting, PHL, GREASE'ing, quota/eviction, and the security-fix double-check
together, since they're all additive to the same registry/write-path surface — mirrors Servo's
own sequencing (their hardening commits landed after the feature already worked end to end).

- **Rate limiting**: per-origin token buckets in `CrossOriginStorageRegistry` (start from Servo's
  constants — burst 2000/refill 20/s reads, burst 200/refill 2/s writes — tune later), with
  their own bounded/LRU-evicted map (a distinct bug from registry eviction, per the notes).
  Over-budget responses must be indistinguishable in shape/timing-class from a genuine miss.
- **PHL**: new `Libraries/LibWebView/PublicHashList.{h,cpp}` — sorted packed binary SHA-256
  digest array + `binary_search`, loaded from a bundled seed resource at startup (a periodic CI
  refresh job is out of scope for this plan). Gates the wildcard branch Phase 6 stubbed.
- **GREASE'ing**: 1% probability / 500 KiB size ceiling (Servo's own choices, not spec-mandated),
  applied only to the wildcard+PHL-cleared+non-storing-origin branch.
- **Quota/eviction**: two-tier budget (60% total-disk global / 20%-of-global per-origin share),
  computed from total capacity (never free space) for the surfaced number, with an internal
  free-space safety-net check before actually committing a write. Oldest-read-first LRU using
  the `last_read_time` column from Phase 5. Per-origin overflow evicts only that origin's
  sole-owned entries; cross-origin eviction only when both origins are within-share yet globally
  over cap.
- **Security-fix double-check** (already front-loaded into earlier phases — verify here):
  per-algorithm digest format validation (Phase 2), disk-write-failure-before-hash-update
  ordering (Phase 4), resize-target cap before seek/truncate checked against real free disk
  space before honoring it (Phase 4), crash-atomic persistence (Phase 5).
- **5-minute pending-entry staleness timeout + abort() fast path**: a `Core::Timer`-driven sweep
  (matches `CookieJar`'s existing `synchronization_timer` pattern) plus wiring
  `FileSystemWritableFileStream`'s abort algorithm to send `did_abort_cos_write` immediately.
- **Make writes non-blocking**: convert `did_write_cos_chunk` to async request/response, resolving
  `write()`'s promise from the response callback. Worth a short spike at the start of this item
  to confirm the exact generated-method shape the IPC compiler produces before committing.

**Done when:** unit tests (Phase 8) cover budget exhaustion/eviction order, PHL hit/miss,
rate-limit-looks-like-miss, and GREASE probability/size-ceiling behavior against the registry's
internal API directly.

---

### Phase 8 — Testing pass + cleanup

- Unit tests under `Tests/LibWebView/` (check for an existing `CookieJar`-style test file to
  mirror) exercising `CrossOriginStorageRegistry` directly: concurrent-write races, staleness
  sweep, budget exhaustion, eviction order, PHL hit/miss, GREASE probability-and-size-ceiling,
  and the full disclosure-scope matrix (same-site-different-origin / different-site / listed /
  unlisted × writer-vs-reader).
- One genuine two-origin browser-level test (check `Tests/LibWeb/Text/input/` for the closest
  existing cross-origin test as a template) using a real PHL-listed resource with a documented,
  known preimage — never fabricate bytes to hit an arbitrary target hash.
- Sweep the `// FIXME` markers deliberately left in earlier phases (the
  `PolicyControlledFeature::CrossOriginStorage` stub, the seed-only PHL, tunable
  rate-limit/quota constants) into tracked follow-ups.

## Deferred / follow-up work

What's still open beyond Phase 8:

- **Keeping the Public Hash List current**: Phase 7's PHL loads from a bundled seed resource at
  startup; a periodic refresh (a scheduled job re-fetching and re-embedding the upstream list, or
  fetching directly at build-configure time) is explicitly out of scope for this plan. A build's
  PHL is only ever as current as whenever that seed resource was last regenerated by hand.
  See the shared cross-vendor engineering notes' "Keep it current" guidance for the two adequate
  approaches.
- **A real eviction index**: this plan's quota/eviction design (Phase 7) doesn't specify an
  incremental, O(log n) eviction-candidate index — a straightforward full-scan-and-sort
  implementation is the natural first cut, but won't hold up once the registry grows to the scale
  this feature targets (hundreds of thousands of entries). Worth a dedicated pass before
  considering storage-budget code done.
- **Declarative integrations** (HTML `crossoriginstorage` attribute, JS import attribute, CSS
  `cross-origin-storage()`): each belongs to its own host-language spec, out of scope here.
- **Clear-data integration**: this plan doesn't cover wiring COS into Ladybird's own "Forget About
  This Site"/clear-browsing-data machinery — see the shared cross-vendor engineering notes' §16
  for the design question this surfaces (COS entries aren't per-site, so a naive "delete
  everything this site owns" port breaks the moment two sites have legitimately stored the same
  bytes) and one browser's chosen resolution.
- **A per-entry settings-UI browser**: inspecting or deleting individual entries from a settings
  page, as opposed to the bulk/site-scoped operations above.

## Risks

**Biggest technical risk:** Not the streams machinery itself (solid existing native-construction
prior art, see Deviations from Servo's approach above). The real risk is **the synchronous,
per-chunk, cross-process write path under real multi-GB payloads** — exactly the class of file
this API targets. Phase 4's simplest-correct implementation blocks the WebContent renderer once
per chunk; making it properly async while correctly handling backpressure, partial-chunk
failure/retry, and cancellation (navigation away, tab close, or `abort()` racing an in-flight
chunk) across the IPC boundary is where subtle bugs will actually live — Servo needed four
separate follow-up commits after their initial "complete write path" commit for exactly this
reason. Budget real time for Phase 7's non-blocking conversion specifically.

## Verification plan

Each phase's "Done when" is a manual smoke test via the built browser's JS console
(`./Meta/ladybird.py run --gui=AppKit` or equivalent, launched with
`--expose-experimental-interfaces`), building on the prior phase's script. Phase 6 additionally
needs two real distinct origins (different `/etc/hosts` aliases, not just ports, for a genuine
cross-site negative case). Phase 8 formalizes ad-hoc console testing into a real automated test
suite. Build after every phase with `./Meta/ladybird.py build` before moving on — don't let
compile errors accumulate across phases.

## Rollout

Work happens on a `cross-origin-storage` branch off `master` in `tomayac/ladybird`, committing
after each phase's own "Done when" verification passes — don't let more than one phase's worth of
unverified change accumulate before committing. Phases 1–6 get this feature working end to end;
Phase 7–8 are real requirements for a launch-quality implementation and should land before this is
considered for anything beyond local testing.

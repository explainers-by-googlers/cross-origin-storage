# Implementing Cross-Origin Storage (COS): Engineering Notes

> [!NOTE]
> These notes are based on Thomas Steiner's (@tomayac) personal implementation experiments and are not an official position of either browser project or the WICG.

**Sources:** two independent implementations of the [WICG Cross-Origin Storage explainer](https://github.com/WICG/cross-origin-storage) and [spec draft](https://wicg.github.io/cross-origin-storage/) — Servo's, on the `cross-origin-storage` branch of [tomayac/servo](https://github.com/tomayac/servo) (Rust), and Ladybird's, on the `cross-origin-storage` branch of [tomayac/ladybird](https://github.com/tomayac/ladybird) (C++). Points specific to one are marked **Servo:** or **Ladybird:**; everything else applies regardless of what you're building on.

**How to use this document:** read it alongside the spec and explainer, not instead of them. This captures the parts the spec deliberately leaves to implementations ("an implementation-defined maximum length", "could delete files ... based on, for example, a least recently used approach"), real mistakes made and caught across two independent implementations (several of them security bugs), and the performance work that turned out to matter once a registry grows to the scale this feature targets — many AI-model shards, potentially multi-hundred-MiB each. Every numeric constant below is an implementation choice, not the spec's; pick your own based on your own browser's precedent, but don't skip picking one — several of these gaps are exploitable if left unbounded.

This document doesn't try to be a step-by-step tutorial. It's organized by concern, so you can jump to the part you're currently implementing.

---

## Glossary

Terms as used in this document — some are spec terms, some are implementation vocabulary for things the spec leaves unnamed. Alphabetical; each points at the section with the full explanation.

- **Atomic write** — writing to a sibling temp file first, then `rename()`-ing it into place, so a reader can never observe a half-written file. Relies on `rename()` being atomic on the same filesystem. See [§7](#sec-7).
- **Availability gating** — the read-time decision of whether a given requesting origin is allowed to see a particular entry, based on its disclosure scope. See [§4](#sec-4).
- **Content-addressable (storage)** — a storage scheme where the key *is* a cryptographic hash of the content itself, rather than an arbitrary name the writer chose. Two writers storing byte-identical content always land on the same entry — that's what lets independent origins "share" a resource without either being able to overwrite or corrupt what the other wrote. See [§2](#sec-2).
- **Disclosure scope** — which requesting origins, besides the storing origins themselves, are allowed to read a given entry: same-site-only (default), an explicit origin allowlist, or wildcard (`'*'`, gated by the PHL + GREASE'ing). See [§4](#sec-4).
- **Entry** — one row of the registry: a single stored resource, keyed by its hash, together with its state (pending or written), its storing origins, and its disclosure scope. See [§2](#sec-2).
- **eTLD+1 / registrable domain** — "effective top-level-domain plus one label" — e.g. `example.com`, or `example.co.uk` (where `.co.uk` is the *effective* TLD per the Public Suffix List, not a literal one). This is the unit same-site comparisons are made against; you cannot compute it correctly by just counting dots, which is why you need the Public Suffix List (or your engine's equivalent) rather than writing new logic. See [§4](#sec-4).
- **Fingerprinting oracle / side channel** — any observable signal (a response, a specific error type, a timing difference) that lets a page infer something about the user it otherwise has no business knowing — e.g. "was this specific resource ever cross-origin-cached" as an implicit proxy for "has this user visited some other site." Much of this feature's design (GREASE'ing, budget-based-on-total-not-free-disk-space, rate-limit denials that look identical to genuine misses) exists specifically to avoid creating one. See [§4](#sec-4)–[§6](#sec-6).
- **GREASE / GREASE'ing** — deliberately, randomly reporting a resource as absent even though it's genuinely cached and would otherwise be disclosed, for wildcard-scoped entries that already passed the PHL check. Stops a caller from treating a "found" response as a *reliable* signal. Name borrowed from the unrelated TLS GREASE mechanism (same "deliberately inject noise so nobody can rely on a signal that shouldn't be relied on" idea). See [§4](#sec-4).
- **Origin vs. site** — an *origin* is scheme + host + port (`https://a.example.com:443`); a *site* (for same-site purposes) is scheme + eTLD+1 (`https://example.com`). Two different origins can be same-site (different subdomains or ports of the same registrable domain); same-origin implies same-site, not the reverse.
- **PHL (Public Hash List)** — a curated, cross-vendor, rolling-release allowlist of resource digests confirmed "ubiquitous" and "corroborated" enough that disclosing their cross-origin presence doesn't leak anything meaningful about one specific user. The gate that makes wildcard-scoped disclosure safe at all. See [§4](#sec-4).
- **Probe** — the spec's own framing for a `requestFileHandle()` read call: since its outcome (found, not found, or still pending) is directly observable by the calling script, every read is implicitly an attempt to learn something about cross-origin state, and has to be rate-limited accordingly, not treated as a free query. See [§5](#sec-5).
- **Quota exceeded** — the rejection outcome when a write can't be accommodated within the storage budget even after every eviction it's entitled to. See [§6](#sec-6).
- **Registry** — this document's name for the whole in-memory-plus-persisted structure mapping hashes to entries, plus the logic operating on it. Not a spec term — the spec only describes the algorithms; "registry" is just a convenient implementation-side name for "the thing that stores and answers questions about entries." See [§1](#sec-1).
- **Resource thread** — **Servo:** the thread/process that already owns other shared, persistent browser state (cookies, HTTP cache, HSTS) and that Servo's implementation also hosts the COS registry in. Your engine's equivalent may have a different name and shape (a shared network service, a browser/UI process, a storage broker — see [§1](#sec-1)) — the point is putting the registry wherever your engine's analogous shared, persistent, non-script-thread service already lives, not the specific name.
- **Secure context** — the Web Platform concept of an origin considered safe enough (HTTPS, or a recognized local exception like `localhost`/loopback IPs) to expose powerful APIs to. COS is `[SecureContext]`-gated in its WebIDL, so it's unavailable from a plain non-loopback `http://` page. See [§12](#sec-12).
- **Sole-owned (entry)** — an entry with exactly one storing origin, as opposed to a *shared* entry that multiple independent origins have each written/verified. An origin hitting its own storage share is only ever allowed to evict its own sole-owned entries to make room — never a shared entry, even one it co-owns. See [§6](#sec-6).
- **Storing origin(s)** — the set of origins that have each independently completed a successful write (`close()`) for a given hash. Distinct from disclosure scope: a storing origin can always read its own write regardless of scope; disclosure scope governs everyone *else*. See [§2](#sec-2).
- **Streaming (write)** — sending a large write's bytes to the registry in a sequence of smaller chunks rather than one giant message, so the registry never holds an entire large payload in memory at once. Independent of whether the writable stream's own buffer (the thing being streamed *from*) is backed by memory or disk — see [§3](#sec-3).
- **Token bucket** — a standard rate-limiting algorithm: a per-key counter that holds up to some maximum number of "tokens," refills continuously over time, and is decremented by one on each allowed action; once empty, further actions are denied until enough time passes to refill at least one token. Used here per requesting origin, separately for reads and writes. See [§5](#sec-5).

---

<a id="sec-1"></a>

## 1. Architecture: where the registry lives

COS's registry (the mapping from hash → stored bytes + metadata + disclosure state) needs to be:
- Shared across every tab/worker/process using it (it's cross-origin by definition).
- Persisted to disk across restarts.
- Reachable from script without blocking the calling thread on disk I/O.

**Put it in whatever your engine's existing shared, persistent, IPC-reachable service is** — the thing that already owns cookies, HSTS state, and disk caches. Script-side code is a **thin IPC client only**: it does not own any state, does not implement any spec algorithm, and every function in it sends a message and returns immediately. All the real algorithms — entry state machine, origin-scoping decisions, availability gating, hash verification, quota enforcement — live in that shared service.

**Servo:** this shared service is the *resource thread* — the same process/thread that owns the HTTP cache and the cookie jar, among other shared file-backed state.
**Ladybird:** this is the UI/browser process — the same process that already owns the cookie jar, HSTS store, and other shared persistent state, reached over IPC from each content/worker process.

Why this split matters in practice: a Worker has exactly one script thread. If verifying and storing a write blocked that thread for the duration of writing a multi-hundred-MiB file to disk, nothing else on that worker could run for the whole write. **Servo:** on Servo's desktop port, a similar block on a Window's script thread freezes scroll input handling too, because wheel events are dispatched synchronously and are cancelable by script. **Don't put a synchronous, disk-touching operation on any thread that also has to stay responsive to input or other script.**

A workable IPC shape (see [§9](#sec-9) for why "IPC" doesn't necessarily mean serialization overhead):

- Script thread sends a message carrying a callback handle.
- The registry-owning service processes it and invokes the callback (on its own thread, or an IPC router thread in true multi-process mode — never the original calling thread).
- The callback's only job is to queue a task back onto the *correct* script thread to resolve/reject the promise.

**If your engine is multi-process rather than (or in addition to) multi-threaded**, "put the registry on the shared service" understates the work by one layer. A Worker in a multi-process engine doesn't just run on a different thread — it runs in an entirely separate OS process from the main renderer, with its own IPC connection (or lack of one) to wherever the registry lives. **Ladybird:** the Window path was built and verified first; adding Worker/SharedWorker support afterward turned out to be cheap specifically because a per-worker-process IPC connection to the registry's host process *already existed*, for cookies and HSTS — COS's messages just needed to go on that existing wire. If your engine doesn't already have a route like that for something else, budget real time for building one; don't assume "Window vs. Worker" is only a script-level/JS-binding distinction once process boundaries are real.

---

<a id="sec-2"></a>

## 2. Data model & entry lifecycle

One entry per hash. Two states:

```
pending  --(the write verifies and is stored)-->  written
pending  --(a failed write, an abort(), or a staleness timeout)-->  (removed)
```

- **Pending** is created when a create-backed handle is requested (`requestFileHandle(hash, {create: true})`) *before* any bytes have arrived. It exists so a second `requestFileHandle()` call for the same hash — from the same origin or another — can observe "still pending" instead of "not found", per the spec's read algorithm.
- **Written** is set atomically together with the entry's bytes, once the write verifies successfully (`close()` on the writable stream).

**A failure mode worth designing against from the start: a *failed* write is not the same thing as an *abandoned* one, and it's easy for a first pass to treat it as neither.** If `verify-and-store`'s mismatch branch rejects the caller's `close()` with `DataError` and otherwise does nothing at all, the entry is left exactly as `complete_a_create_request` had left it: `Pending`, forever, for that hash. That's a quietly bad failure mode: a single caller supplying wrong bytes once — through an ordinary bug, not malice — permanently wedges that hash for *every* origin, since a plain (non-`create`) `requestFileHandle()` for a `Pending` entry rejects with `NotAllowedError`, not `NotFoundError` (see below). A staleness timeout (next paragraph) does eventually reclaim it, but only after a full timeout window, and only for that one specific failure mode — there's no reason a *definite*, already-known failure should have to wait one out at all.

**Servo:** this is a bug Servo's implementation actually shipped in its first pass, caught via spec review prompted by a WPT conformance test.

**The fix: track a per-entry outstanding-writer count, and clean up immediately once it reaches zero.** Every handle returned by a create request increments it; every failed `close()` (or explicit `abort()` — see below) decrements it and removes the entry *if and only if* the count is now zero *and* the entry never reached `Written`. The "and only if" qualifiers both matter, for different reasons:
- **The zero-count qualifier** protects a genuinely concurrent sibling write for the same hash (two tabs racing, one with wrong bytes and one with correct ones — see the next section) from having its entry deleted out from under it by the *other* tab's failure, regardless of which one finishes first.
- **The never-`Written` qualifier** protects against a much sharper problem: without it, any origin could delete an entry some other origin already correctly stored, just by requesting a handle for its hash and deliberately writing garbage. Immediate cleanup must only ever apply to a hash nobody has *ever* successfully written — never to one that has.

This is why the count has to be tracked at all rather than just "always delete on failure if not yet written": naively doing that (no count, unconditional removal on any failure) still passes single-writer tests fine, but silently breaks the two-concurrent-writers case, since the failing writer's cleanup would delete the registry entry the successful writer's *already in-flight* `close()` is about to update — and once that mapping is gone, nothing can ever look the successful write up by hash again, even though it genuinely finished correctly. **Write a test for the two-concurrent-writers-one-fails-one-succeeds case specifically** — it's exactly the kind of interaction a single-writer-focused test suite won't catch on its own.

**A pending entry can also go stale**, independent of the count above. The spec's write path is `create()` → `createWritable()` → write → `close()`, and there is no guarantee `close()` (or `abort()`) is ever called — a page can navigate away, crash, or simply never finish, and in that case no message ever reaches the registry to decrement anything. Use a wall-clock staleness timeout (five minutes is a reasonable starting point; not spec-mandated, pick your own) as the fallback of last resort for exactly this case:
- A stale pending entry reads as not found, not still pending — a reader must not get stuck behind an abandoned write.
- A stale pending entry is silently replaced by a fresh one on the next `create()` for the same hash — a new writer must not be permanently blocked either. (This also means a fresh replacement entry's outstanding-writer count restarts at zero, discarding whatever the abandoned entry's count had accumulated, along with the rest of its now-irrelevant state.)
- A pending entry *within* the staleness window is left alone by both paths. This is also the ordinary shape of two genuinely concurrent legitimate writes for the same hash racing each other — don't special-case "abandoned" vs. "in-flight-but-slow"; you can't tell them apart, and you shouldn't try to.
- Also implement an explicit abandonment signal (the writable stream's `abort()` → a message to the registry) as a fast path — most abandonment is an explicit `abort()`, not a crash, and there's no reason to make a well-behaved abort wait out the full timeout. **This needs the same outstanding-writer-count gating as a failed `close()`, for the same concurrent-sibling reason.** **Servo:** Servo's first pass here had the identical latent bug (unconditional removal of any `Pending` entry on `abort()`, never actually exercised by a test with two concurrent writers) as the `close()`-failure case above — caught and fixed at the same time.

Net effect: three genuinely different signals (a failed `close()`, an explicit `abort()`, and silent staleness) all funnel into reclaiming a stuck `Pending` entry, at different speeds (immediate, immediate, a timeout) for different reasons (a known definite failure, an explicit signal, no signal at all) — but only the first two need the outstanding-writer count, since only they can fire while a genuinely concurrent sibling write is still known to be in progress.

**Extend this to your own equivalent terminal failure modes, not just the spec's literal case.** The spec's own text only names one definite-failure case (a hash-mismatched `close()`). A real implementation likely has several other equally-terminal failure modes the spec doesn't enumerate — a disk I/O failure partway through a write, an unrecognized algorithm, a quota-exceeded rejection at `close()` time. **Ladybird:** extends the identical outstanding-writer-count cleanup to all of these, not just the literal spec case, on the reasoning that they're morally the same "this write will never succeed, and nobody else should be blocked behind it" situation — reusing the one mechanism was simpler and safer than inventing a parallel cleanup path per failure type.

**Storing origins vs. disclosure scope are two different things.** An entry tracks:
- **A set of storing origins** — every origin that has independently written/verified this exact hash. (Content-addressability means two unrelated origins can both "write" the same bytes; this is not a copy, it's the same entry gaining a second storing origin. See [§4](#sec-4).)
- A disclosure scope (same-site-only / an explicit list / wildcard) — who, *besides* the storing origins (who can always read their own writes), gets to read it.

---

<a id="sec-3"></a>

## 3. Content-addressable integrity: the seek()/truncate() ordering constraint

`FileSystemWritableFileStream` (the write side, inherited from the File System Access API/OPFS shape) supports `seek()` and `truncate()` — genuine random-access edits to the in-progress write, at any point before `close()`. A COS hash, meanwhile, can only ever be verified against the **complete, final** byte sequence.

**The one universal consequence, regardless of implementation maturity: you cannot incrementally verify a hash as `write()` calls arrive.** A later `seek()`/`truncate()` can still invalidate content you've already seen, so hashing has to happen once, after `close()`, over the final state — not streamed/accumulated chunk-by-chunk *during* the writes themselves.

What that final state is backed by — and therefore whether "waiting for the final state" costs you application memory or not — depends on what your engine already has and what you choose to build:

- **If you already have a mature, disk-backed `FileSystemWritableFileStream`/`FileSystemFileHandle` implementation** (i.e. real OPFS support, which already needs genuine random-access disk I/O for its own non-COS use cases), you very likely don't have a memory problem at all: back COS's writable stream with that same real, disk-backed temp file, let the OS handle random access, and only read/hash it once, sequentially, at `close()` time.
- **If you're building `FileSystemWritableFileStream` from scratch for COS**, with no OPFS to lean on, build it on a real disk-backed temp file from the start rather than an in-memory buffer (`seek()`/`write()`/`truncate()` all operate on it directly via ordinary file I/O). This sidesteps the entire unbounded-allocation-DoS category in [§10](#sec-10) at the design level, rather than needing a runtime cap on it, and keeps this feature's characteristically large payloads (multi-hundred-MiB to multi-GB) off script-process memory for the duration of the write, not just at the moment they're finally handed to the registry. It isn't entirely free: a temp file opened write-only for streaming needs to be re-opened, or rewound and read, once `close()` needs to hash the final content — a small, one-time cost against avoiding a whole class of bug.

The ordering constraint above (hash only after `close()`) applies either way — it's a property of the spec, not of any particular backing store.

Separately from *that* question — once `close()` is called and the final content is known (in memory or on disk, either way) — you still don't want to send it to your shared registry service as one giant message, nor have that service hold the whole payload in memory either. That transfer is worth streaming in chunks regardless of how the writable stream itself was backed, since the registry service is shared across every tab and origin using the feature, making it the more valuable place to economize regardless. A workable shape is a three-message protocol:

```
begin(session_id, hash, origin, declared_total_bytes)   // no response
chunk(session_id, bytes)   × N                            // no response
finish(session_id, type_string, requested_origins) -> outcome
```

`session_id` is a random client-generated token (not spec-visible; purely an implementation detail for correlating chunks). The begin and chunk messages have no response — only the finish message does, and only it needs to. Chunks arrive in order because they're sent on the same underlying ordered channel, so no sequence numbers are needed. On the receiving side: hash incrementally (update a running digest per chunk) and, if config allows, write each chunk straight to a temp file rather than accumulating in memory; on finish, compare the final digest, and if it matches, atomically publish (rename the temp file into place).

**A bug worth designing against explicitly: the temp-file write for an incoming chunk can fail** (disk fills up mid-write — genuinely realistic for this feature, since it targets multi-GB downloads that can plausibly run right up against free disk space). If a running hash and byte-count get updated *unconditionally*, before attempting the fallible disk write, and a failed write only logs a warning, the finish step's hash check can still pass — it was checking the *intended* bytes' hash, not what actually landed on disk — and the implementation would happily rename a truncated/corrupt temp file into place, mark the entry written, and serve it to every future reader under a hash that no longer matched its real content. That's a silent violation of the one guarantee this entire feature exists to provide.

**Fix:** track write failures explicitly on the session (a simple flag set by the fallible chunk-write step), and check that flag *first* when finishing, before trusting the byte-count or digest checks — neither of those can detect this failure mode on their own, because they're both computed from data that was already accepted into memory *before* the disk write was attempted.

**Servo:** shipped the unconditional-update version first and caught this in a dedicated fresh review pass, not on first implementation — it's the kind of bug that's easy to miss because the happy path looks completely correct.
**Ladybird:** built the flag-and-check-first guard in from the start, having this exact writeup as a design reference before implementing the write path.

**Lesson for other implementers:** if your streaming design reads back from disk to populate any in-memory cache (Servo's implementation does, for its `Arc<Vec<u8>>` read-path cache — see [§9](#sec-9)), that read-back is trusting the disk, and a partial/failed write anywhere upstream of it will silently propagate. Either (a) track and check write failures explicitly, as above, or (b) re-verify size/hash against what you actually read back before trusting it, or both.

---

<a id="sec-4"></a>

## 4. The three disclosure scopes

An entry's disclosure scope is set by the *first* successful write, and only ever **upgraded**, never downgraded, by subsequent writes of the same hash by other origins (a later writer requesting a narrower scope than what's already granted is a no-op for scope purposes — see the spec's "upgrade resource visibility" step). Implement scope comparison as a strict ordering, each strictly broader than the last: same-site-only, then an explicit list, then wildcard.

### Same-site-only (the default, when `options.origins` is omitted)

Disclosed to any origin **same-site** with *any* storing origin — not same-*origin*. Use the same same-site logic your cookie jar already has for `SameSite=Lax/Strict` (Public Suffix List-backed eTLD+1 comparison): `https://a.example.com` and `https://b.example.com` are same-site (same registrable domain, different origins); `https://example.com` and `https://example.co.uk` are not, despite the superficially similar names. **Reuse your existing same-site helper rather than writing a new one** — this is exactly the same computation your cookie implementation already needs to get right.

### An explicit list — `options.origins` is an array of origin strings

- The list has an **implementation-defined maximum length** (the spec explicitly calls this out, precisely so a list can't function as an undeclared substitute for `'*'`). 100 is a reasonable choice — both Servo's and Ladybird's implementations use it. Enforce this in *two* different places, because the spec treats them differently:
  1. A single `requestFileHandle()` call whose own `options.origins` already exceeds the max: throw `TypeError` synchronously, before attempting any write.
  2. *Merging* a new call's origins into an already-list-scoped entry (a second, independent writer declaring more origins) exceeding the max: **not an error** — per spec, silently evict the least-recently-used excess origins instead. This can happen with zero misbehavior from any single caller: independent origins can each write the same byte-identical resource (e.g. a shared open-source library) with their own small `origins` list, and those lists organically merge over multiple write events.
- Track the list as an **LRU structure**: a plain ordered list where position *is* the recency signal (front = least-recently-used) is enough — you don't need separate timestamps per listed origin. A successful *read* by a listed origin moves it to the back. Merging a *re-declaration* of an already-present origin does **not** move it — only an actual read refreshes recency, otherwise a writer could keep a dormant origin artificially "alive" forever just by repeatedly re-declaring it in new writes without it ever actually being used.

### Wildcard (`options.origins === '*'`) — the interesting one

A wildcard-scoped entry is **not** disclosed to everyone unconditionally. Two independent gates both have to pass:

**Gate 1 — the Public Hash List (PHL).** This is the load-bearing privacy mechanism of the whole feature. Without it, `'*'` disclosure would be a trivial cross-site tracking/probing oracle: site A writes `sha256(some-value-only-known-if-you-visited-site-B)`, wildcard-scoped; site A later probes for that exact hash from any other context and learns whether the user visited site B. The PHL closes this by only ever disclosing a wildcard-scoped entry if its hash is **independently confirmed present on a curated, cross-vendor, rolling-release allowlist** of "ubiquitous, corroborated" resource digests — modeled directly on the Public Suffix List's own governance precedent (per the spec/explainer's framing: cross-vendor governance, not any single browser's list). A hash not on the list **fails closed**: it's simply not disclosed, indistinguishable from a genuine miss. The PHL only lists SHA-256 digests, so a wildcard-scoped entry hashed with any other recognized algorithm (SHA-1/384/512) can never pass this gate — check the algorithm before even attempting the lookup.

  Implementation-wise, the pipeline below is now validated by two independent implementations, not just one browser's particular choice:
  - The PHL is generated and published in the spec's own repo: `WICG/cross-origin-storage`, under `public-hash-list/implementation/`.
  - **It's tracked via Git LFS.** `raw.githubusercontent.com` only serves the LFS *pointer* text (a few hundred bytes: `version .../oid sha256:.../size ...`), not the actual multi-tens-of-MB file. You need `media.githubusercontent.com/media/<owner>/<repo>/<ref>/<path>` (GitHub's LFS media endpoint) to get the real content for a public repo.
  - **Verify a checksum after downloading it.** The PHL repo publishes a companion `<file>.sha256` (standard `sha256sum`-compatible format, itself LFS-tracked too — fetch it the same way) right next to the data file. Fetch that first, then pin the big file's download against the hash it gives you, rather than checking it as an afterthought — this guards against a corrupted/truncated transfer or a compromised LFS response landing in something that ships to every user, and turns a bad transfer into a loud build failure instead of silently-wrong compiled-in data.
  - The raw `.dat` format is line-oriented: `//`-prefixed comment lines (provenance annotations, safe to ignore) and bare lowercase-hex SHA-256 digest lines. Re-encode this at build time into **sorted, packed 32-byte binary digests with no delimiters**, purely to keep the compiled-in resource compact and to enable `binary_search` (O(log n)) at lookup time instead of needing a `HashSet` (a `HashSet<[u8; 32]>` of hundreds of thousands of entries costs meaningfully more memory for the same guarantee, and the list is read-only after load, so a sorted array is strictly better here). Sort once, at generation time, so nothing needs to re-sort it again every process startup.
  - **A resource this size can be a compile-time problem in its own right, independent of everything above.** At real scale (the published list is on the order of 300,000 entries), spelling it out as a source-level array literal is tens of millions of characters of text for the compiler to parse, just for this one file — slow at best, and a real risk of hitting a compiler/tooling limit at worst. Prefer whatever raw-binary-embed facility your toolchain has instead of a literal: C23's `#embed`, a linker/assembler `incbin`-style directive, or your language's equivalent — the generated source stays small and fast to compile no matter how large the list gets, since the bytes are pulled in directly rather than spelled out as syntax.
  - **Keep it current** — it's an explicitly rolling-release list, not a one-time snapshot; the spec's governance model depends on it being kept current. Two genuinely different, both-valid ways to do this:
    - **Servo:** a scheduled CI job re-runs the fetch/verify/re-encode pipeline periodically (weekly) and commits the refreshed, compiled-in snapshot into the browser's own repository — whatever a given build embeds is exactly whatever was last committed, reviewable like any other change.
    - **Ladybird:** fetches and verifies directly from the upstream source at build-configure time instead, with no separate scheduled job of its own — a given build is always as current as upstream's default branch was at the moment it was configured.
    - The tradeoff to know about either way: neither approach continuously refreshes an *already-configured* build tree. A build-time-fetch design like Ladybird's still needs a clean checkout or a cleared build cache to actually pick up a newer list, not just a recompile; a checked-in-snapshot design like Servo's is only as current as the last time its scheduled job actually ran and its commit actually merged. "Automatic" doesn't mean "instant" under either design — budget for that when reasoning about how stale a given user's compiled-in list could plausibly be.

**Gate 2 — GREASE'ing.** Even *after* an entry passes the PHL check, occasionally lie and report it as absent anyway, chosen at random per read. (GREASE: "Generate Random Extensions And Sustain Extensibility" — the spec's own term, borrowed from TLS.) The point: a caller must never be able to treat a reliable "found" response as *proof* a resource is cached, because that itself would be a timing/existence oracle for whatever content the caller is probing for. If "found" is always 100% reliable when it's true, an attacker can use presence/absence as a precise signal; occasional false negatives break that guarantee without breaking the feature's main performance benefit (which only needs "found" to be *usually* reliable to be worthwhile).

The spec constrains this qualitatively: **"must NOT GREASE responses for files whose size makes a spurious re-download clearly disproportionate to the privacy benefit."** A numeric threshold (500 KiB) below which GREASE'ing is eligible, and a probability (1%) for eligible entries, is one reasonable choice — used by both Servo's and Ladybird's implementations. The spec gives no numbers, only the size-proportionality constraint. Get the *reasoning* right even if you pick different numbers: a false negative on a small file just costs a cheap re-fetch; on a large one (the spec's own example is gigabyte-scale AI model weights) it would impose a real, observable bandwidth/latency cost — and that cost difference is itself observable (a "found but GREASEd" response is distinguishable from a genuine miss by its retry latency), which would undermine the whole point of GREASE'ing. **Never GREASE large entries.**

---

<a id="sec-5"></a>

## 5. Rate limiting / abuse resistance

**Every read is a probe.** The explainer says this explicitly: "each call to `requestFileHandle()` can be considered a probe." A found/not-found/still-pending outcome is directly observable by the calling script, so an origin could otherwise brute-force many hashes to fingerprint what's cross-origin-cached (i.e., infer what sites a user has visited, indirectly, via what shared resources are present). **Rate-limit reads per requesting origin** with a token bucket. Reasonable starting values (used by both Servo's and Ladybird's implementations):
- Burst capacity: 2000 (sized around large sharded-AI-model loading — some architectures ship weights as ~25 MiB shards, so 2000 covers roughly a 50 GiB model's worth of shards in one burst — comfortably past any realistic model size, while still bounding worst-case memory for the token-bucket map).
- Steady-state refill: 20/second (fast enough that a legitimate page's staggered probes never notice it even after exhausting a burst; slow enough that an attacker enumerating hashes to fingerprint a victim is throttled to a trickle indefinitely, not just made to wait out one cooldown).
- **When over budget, respond exactly as if the entry were absent (a genuine miss), not with a distinct "rate limited" signal.** Hitting the limit must not itself be an observable, distinguishable event — otherwise the rate limiter becomes its own oracle (a caller could binary-search for the limit itself, or use "am I being rate-limited yet" as a side channel).

**Writes need their own, separate, smaller/slower budget.** A `create()` call has no return value at all (per spec — it's fire-and-forget from script's perspective), so it isn't a *fingerprinting* oracle the way reads are. But it's still real, unbounded registry churn and disk I/O if flooded — every `create()` that needs a fresh pending entry persists a file. Share one write-probe budget between `create()` and the eventual write-verification step (`close()`), since `create()` is just the first step of a write attempt: spending the budget on `create()` calls correspondingly reduces what's left for the write that would normally follow, so the abuse is still bounded either way without needing two separate counters.
- 200 capacity, 2/second refill is a reasonable choice — smaller and slower than the read budget, because a write is inherently more expensive for a caller to mount (it has to actually transmit and hash real bytes), and a legitimate cold-cache load only needs to write each missing shard *once*, not repeatedly.

**Cap the rate-limiter's own memory.** This is the kind of thing that's easy to miss on a first pass, because it's not part of the spec at all — it's purely an implementation detail that can still become a real, unbounded memory leak. If your token-bucket map is keyed by requesting origin with no eviction, a long-running browser session that visits many different sites will grow that map by one entry per distinct origin **forever**, for the life of the process — unlike the registry itself, which the spec-mandated (and self-imposed budget) caps already bound. Cap the map at some generous-but-bounded number of distinct origins (10,000 is a reasonable choice), and when a genuinely new origin arrives at capacity, evict whichever bucket was least recently touched (a bucket's own "last refill" timestamp already doubles as a recency signal for free, since every consumption attempt — success or denial — updates it). Worst case for an evicted origin is a reset burst, equivalent to what it'd see after a process restart — not a correctness problem, just a memory bound. **Servo:** caught this in a dedicated review pass, not on the first implementation.

---

<a id="sec-6"></a>

## 6. Storage budget & eviction

Not spec-mandated in any specific numeric shape — the explainer only mentions LRU-based eviction under storage pressure as *one possible* approach. Real browser precedent for the Storage API generally (per [MDN's storage-quotas page](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)) is a reasonable anchor: Chromium/Safari allow up to ~60% of **total disk capacity**; Firefox is more conservative (10%, capped at a fixed group limit). The more generous figure fits COS well, since it explicitly targets much larger content (multi-GB AI model weights) than typical Storage API usage — both Servo's and Ladybird's implementations use 60%/20% (see the two-tier breakdown below).

**Base the budget on total disk capacity, not currently-available free space.** This matters for two independent reasons:
1. **Fingerprinting.** Free space changes as *other, unrelated* things fill up the disk. If the budget (and therefore what gets reported in a `QuotaExceededError`) tracked free space, a page could infer real-time free-disk-space information it otherwise has no business knowing, just by triggering deliberate over-quota writes and reading the reported number. Total capacity is stable and reveals nothing about current disk state.
2. **Self-cannibalizing feedback loop.** If the budget were based on free space, COS's own growth would shrink its own future budget, compounding.

Still check **real, currently-available** free space too, as an **internal-only safety net** — the nominal total-capacity-based budget can still nominally "allow" a write that genuinely won't fit right now. But: **never surface the real free-space number to script**, for the exact fingerprinting reason above — report the same stable nominal budget on rejection either way, so a rejection caused by genuinely low disk space is indistinguishable from an ordinary nominal-budget rejection.

**Two-tier budget, not one:**
- **Global cap**: a stable fraction of total disk capacity (60% is a reasonable choice).
- **Per-origin share**: a fraction of the *current* global budget that any single origin's own storing-origin usage may occupy (20% is a reasonable choice, meaning up to 5 origins can each hold a full share before the global cap itself becomes the binding constraint). This exists so **one origin writing a lot can never force eviction of a *different* origin's data** merely by being more recent. Once an origin hits its own share, further writes only ever evict that *same* origin's own **sole-owned** entries (never a shared entry, even one it's a co-owner of, and never another origin's entry) — if that's not enough to make room, the write is rejected with `QuotaExceededError` rather than reaching into someone else's data.
- Only when several *different* origins, each individually within their own share, collectively still exceed the global cap does eviction fall back to plain **cross-origin LRU** — fair in that case, since it reflects genuine multi-tenant demand rather than one origin crowding out another.

**Eviction order** is oldest-*read*-first (not oldest-*written*-first): track a per-entry "last successfully read" timestamp, updated on every genuine cache-hit read (not on a write, and not on a write that merely re-verifies already-stored content) — an entry a writer keeps re-verifying but nobody ever reads should still be evicted before one that's actively serving readers. Persist this timestamp so eviction order survives a restart accurately.

**The streaming-time quota gap is bigger than it looks.** The budget check above only runs once, at `close()`. But nothing stops a script from calling `truncate(hugeNumber)` *during* streaming — no bytes need to cross the wire at all ([§3](#sec-3)) — growing the real on-disk temp file arbitrarily before that check ever fires. You can't just call the real quota-check/eviction function per chunk to guard against this either: that function can evict *other, already-verified* entries to make room, which is wrong to do on behalf of a write that's still unverified and might yet fail its own hash check at `close()`.

**Fix this with a separate, cheap, read-only bound, distinct from the real budget check:** computed once at write-session start (so it's not a syscall per chunk), then compared against the temp file's actual size after every `write()`/`truncate()` (a `truncate()` sets the tracked size directly; a `write()` only ever grows it up to the resulting stream position). A breach fails the session the same way a disk I/O failure already does ([§3](#sec-3)), reusing the existing cleanup path rather than inventing a new one. The bound itself can be as simple as a flat, generous ceiling (chosen well above any real individual shard size your other budget constants are sized around), or as precise as the live per-origin budget fraction the real check uses — the latter catches an over-quota write sooner, at the cost of needing that fraction available at write-session start rather than only at the authoritative check. This specific gap applies most directly to a disk-backed writable stream; a memory-backed one is already covered by whatever cap you put on `seek()`/`truncate()`-triggered allocation ([§10](#sec-10)).

**Performance, at scale.** Two mistakes that are invisible at unit-test scale and become real bottlenecks once the registry grows to hundreds of thousands of entries (this feature's actual target scale):
- **Don't compute total-bytes-used or per-origin-bytes-used by scanning every entry.** It's the obvious first implementation, and it's an O(n) scan on *every single write*. Maintain running totals instead, updated incrementally at every mutation site (write, evict). O(1) read on every check. Only recompute from scratch once, at startup, when loading persisted entries from disk. **Servo:** did the O(n) version first, in production.
- **Don't collect-and-sort every candidate entry on every eviction pass.** Also the obvious first implementation, and O(n log n) per eviction with no incremental structure. Maintain an ordered index (a sorted set keyed by `(last_read_timestamp, hash)` — the hash breaks ties when your timestamp resolution is coarser than your write rate, which it usually is) that eviction can just walk from the front. O(log n) per removal instead of O(n log n) per pass. **Servo:** also did this the slow way first, for the same reason.

---

<a id="sec-7"></a>

## 7. Persistence design

Whatever mechanism you pick, the property you're chasing is the same: **a metadata-only mutation should cost O(1) relative to registry size, not O(n)** — you never want to be rewriting something proportional to everything else stored just to persist one entry's state change or read-recency timestamp. Two real approaches:

**Servo: per-entry files, not one big registry file.** Two sibling files per entry, both named after a filesystem-safe form of the registry key (`"ALGORITHM:hex_value"` with `:` replaced): `<key>.json` (metadata: state, disclosure scope, storing origins, timestamps) and `<key>.bin` (raw bytes, only once written). This gets the O(1)-relative-to-registry-size property directly: a metadata-only mutation (e.g. a fresh pending entry) never has to touch — or rewrite — any entry's bytes, and vice versa. It's also what makes it *affordable* to persist the read-recency timestamp ([§6](#sec-6)) on every single read, which you want for accurate eviction order across restarts but would be far too expensive if every read required rewriting the whole registry. Load at startup by scanning the directory for metadata files; a missing/corrupt bytes file for an otherwise-valid metadata entry should degrade gracefully (treat as absent), not crash the browser.

**Ladybird: SQLite-backed metadata**, since an embedded SQL database was already in use for other shared, persistent browser state (cookies, history). An ordinary indexed `UPDATE`/`INSERT` gets you the same O(1)-relative-to-registry-size mutation cost, without needing to invent your own crash-safe metadata file format or directory-scan-based startup loading logic — the database already gives you both. Blob *bytes* still live as real files on disk either way (don't put large binary content in the SQL database itself). This is a genuine tradeoff, not a strictly better approach: it only makes sense if that database tool already exists in your engine for something else — it's not worth standing up a database dependency just for this.

**Atomic writes**, regardless of which metadata approach you use. Every persisted file — metadata, and (for a non-streamed write) entry bytes — must survive a crash or power loss without ever being observed half-written by a reader. Standard pattern: write to a sibling temp file first, then `rename()` into place. `rename()` on the same filesystem is atomic on every platform that matters, so a reader always sees either the complete old content or the complete new content, never a torn write. Name the temp file uniquely enough that two different entries' writes can never collide (e.g. based on the final filename), and — separately — clean up any leftover `.tmp` files found during the startup directory scan (a session that begins a streamed write, per [§3](#sec-3), and then crashes before finishing leaves exactly this kind of orphan behind; it's always safe to discard on next launch, since the finish step never happened to publish it).

---

<a id="sec-8"></a>

## 8. Concurrency & locking

Match your locking strategy — or lack of one — to your actual concurrency model; don't default to one out of habit.

**Servo:** the registry lives behind a single shared reader-writer lock, matching the shape of its other existing shared, persistent services. An early version reflexively took the exclusive/write lock for every operation just because some paths need to mutate. That's genuinely harmless if you truly have only one thread ever calling into the registry (contention-free either way) — but it's silently wrong in the sense that the lock type no longer means what it says, and it becomes a real bottleneck the moment registry message handling is ever parallelized for throughput. The fix: try a shared/read lock first for any branch that doesn't end up mutating anything (not-found, still-pending, denied-by-disclosure-gating, or an idempotent no-op create for an already-fresh entry), and only escalate to the exclusive lock on the specific branch that actually needs to write. Re-decide from scratch under the escalated lock rather than trusting what the shared-lock read observed — the two lock acquisitions aren't atomic together, so treat it as a genuine check-then-act race even if, in your current architecture, nothing can actually race in practice yet.

**Ladybird:** check whether you actually have the concurrency problem above before solving it. Its registry lives in a single process whose access to it is all dispatched synchronously on one event loop (every IPC message is handled to completion before the next one starts) — genuinely single-threaded access, not just single-threaded *today by convention*. No locking scheme was added at all. Servo's advice above is about real concurrent access; a lock that's never actually contended is pure overhead, and — more to the point — building one you don't need can misdirect where you spend implementation effort that would matter more elsewhere.

---

<a id="sec-9"></a>

## 9. IPC/transfer efficiency

If your engine's script-to-shared-service transport can distinguish "same process" from "true multi-process," take advantage of it for read results: wrap the returned bytes in a reference-counted handle rather than a deep copy, for the in-process case. In true multi-process mode this is never worse (crossing a real process boundary requires copying the bytes somewhere regardless), but in-process it turns every cache hit's transfer into a cheap pointer/refcount bump instead of a full byte-for-byte copy of a potentially multi-hundred-MiB payload. You still need one genuine owned copy eventually, once you actually construct a `File`/`Blob` object from the bytes for script to consume — but that's one copy, on the far side of the transfer, not one copy *per hop*.

**Servo:** does this with `Arc<Vec<u8>>` for its in-process read-path cache. Watch for a specific footgun if your language has both a cheap "clone the smart pointer" and an expensive "clone the underlying data" operation with easily-confusable names/syntax: `Arc<Vec<u8>>::clone()` clones the `Arc`, not the `Vec`, and the two are trivially easy to write by accident where you meant the other. Audit every call site that needs a genuinely independent, mutable, owned copy versus one that just needs to hold a reference a bit longer.

**Ladybird:** this optimization doesn't apply — its architecture is always genuinely multi-process, with no same-process embedding mode at all. Every read result crosses a real process boundary regardless, and needs a real copy/serialize either way, so there's no in-process fast path to build in the first place.

---

<a id="sec-10"></a>

## 10. Security pitfalls

Worth a dedicated security-focused review pass specifically for these — normal development is not reliably going to surface them on its own.

1. **Path traversal via an unvalidated hash for non-default algorithms.** If your hash-shape validation only fully validates the *default/most-common* algorithm's value format (e.g. only checking that a SHA-256 value is exactly 64 lowercase-hex characters, because that's the algorithm your own test suite happens to exercise), and you use the hash `value` string as part of an on-disk file path for *any* recognized algorithm, an attacker can supply a `value` containing path traversal sequences (`../../etc/whatever`) for one of the *other* recognized algorithms and have it read from or written to outside your intended storage directory. **Validate the exact expected digest-length-and-hex-charset shape for every single algorithm your implementation recognizes, not just the one you tested against.** **Servo:** caught this in a dedicated security review pass, after it had already shipped. **Ladybird:** built full per-algorithm validation in from the start, using this exact writeup as a design reference.

2. **Unbounded resource claim via `seek()`/`truncate()`.** Because random-access edits are allowed before `close()` ([§3](#sec-3)), a page can call `truncate(hugeNumber)` — or `seek(hugeNumber)` followed by any `write()` — and have the writable-stream sink claim an arbitrarily large amount of whatever resource backs it *immediately*, synchronously, from a single script call, long before your registry's own storage-budget check ever gets a chance to reject anything at `close()` time. A memory-backed sink turns this into an immediate allocate-and-zero-fill of an arbitrary size — a straightforward out-of-memory denial of service. A disk-backed sink ([§3](#sec-3)) turns it into unbounded disk space claimed ahead of the real budget check instead (see [§6](#sec-6)'s streaming-time quota gap) — a strictly less severe failure mode, but still one that needs its own guard. Either way: **cap whatever resource a single `seek()`/`truncate()` call can claim, and check that cap *before* attempting the resize/write, not after.** A flat, generous ceiling (e.g. 4 GiB, well above any real individual shard size this feature's other budget constants are sized around) is the simplest version of this cap; tying it to the live per-origin budget fraction instead ([§6](#sec-6)) is more precise but requires that fraction to already be available wherever the write session starts.

3. **Validate at the boundary that's actually trusted, not the one that's convenient to code at.** This is a different bug from #1 above, not a restatement of it: #1 is about validating some algorithms but not all of them, in one place. This one is about validating *correctly, for every algorithm* — but only in a less-trusted renderer/content process, never re-validated in the more-privileged process that actually owns the registry and builds filesystem paths from the hash. If your engine has a real trust asymmetry between a content/renderer process and a more-privileged coordinating process, and your registry lives in the privileged one, a compromised or simply buggy renderer can speak your IPC protocol directly — bypassing whatever validation lives in your WebIDL/script-binding layer entirely, in as few IPC calls as it takes to reach a create request. **Never assume a message reaching your trusted-side registry handler already passed validation somewhere upstream; re-validate anything used for filesystem-path construction at the point it actually crosses into the trusted process.**

   **Ladybird:** found this via code review, through its own entry-cleanup/eviction mechanism ([§2](#sec-2)): the *successful*-write path indirectly self-validates the hash shape as a side effect (it has to match a genuinely-computed digest at `close()`), but the *failure* and staleness-eviction paths never reach that comparison at all, and happily built an on-disk path from whatever the caller sent. That asymmetry — success path accidentally validates for you, failure paths don't — is easy to miss, since the happy path looks completely safe on its own. This finding doesn't apply to Servo's architecture in the same shape, since Servo's resource thread is not separated from script by the kind of renderer/privileged-process trust boundary this bug depends on — but it's a real risk for any multi-process engine with that boundary.

---

<a id="sec-11"></a>

## 11. GC/memory-safety pitfalls specific to embedding in a JS engine

**The transferable lesson, regardless of engine:** if your browser embeds a JS engine with its own GC and your native/host-language code ever constructs values that reference GC-managed JS objects (a JS value, a rooted handle, anything the GC needs to trace), find out early what your engine's equivalent safety mechanism is — and **make sure your normal local development build configuration actually exercises it**, not just CI. A GC-safety bug that only gets caught in CI, after a whole feature is otherwise "done" locally, costs much more to fix than one caught at the point it was introduced.

**Servo** (Rust/SpiderMonkey) uses a custom Rust lint (`crown`) enforcing that any value containing a raw, unrooted handle to a GC-managed JS object is never held in a way the garbage collector can't see and potentially invalidate out from under you. Critically, its local development builds had this lint disabled (a deliberate speed tradeoff — it requires a separately-installed compiler plugin), so a genuine class of GC-safety violations in the COS write path (constructing certain JS-adjacent dictionary/enum values and holding them in a named local variable, rather than constructing-and-immediately-consuming them as part of one expression) compiled and worked fine locally for an entire implementation pass, and were only caught later, in CI, which does run the lint. The fix in every case was mechanical once understood: never bind the flagged value to a `let`/function-parameter; construct it inline as part of the expression that immediately consumes it (a direct function-call argument, or a receiver for an immediate method call). (V8 has its own equivalent rules and lint tooling around `HandleScope`/`Local<>`; SpiderMonkey embeddings elsewhere typically use `Rooted<T>`/tracing conventions — the general shape of this hazard is common to any GC'd-engine embedding, not just Servo's specific setup.)

**Ladybird** (C++, its own custom GC) didn't hit a comparable bug during COS's implementation. That's less a demonstrated advantage than a case of following an already-established construction pattern for GC-tracked objects elsewhere in the codebase (native construction via a precedent function, capturing `GC::Ref`s by value in lambdas) rather than inventing a new one — the same "find your engine's rooting convention early" lesson above, just paid for with precedent-following instead of a dedicated lint catching a violation.

---

<a id="sec-12"></a>

## 12. Testing strategy

**Unit-test the registry logic directly, without going through script/IPC at all** — call your registry service's internal functions directly with different origin values, hash values, and disclosure scopes. This is where the bulk of your test coverage should live; it's fast, deterministic, and can exercise edge cases (concurrent-write races, staleness timeouts, budget exhaustion, eviction ordering) that are awkward to trigger reliably through a real browser instance. Concretely, make sure you have real coverage for:
- A hash confirmed present on your bundled PHL snapshot *is* disclosed wildcard-scoped to a different origin; a hash *not* present is *not*, even though both are genuinely wildcard-scoped by their storing origin.
- Actual different origin values for writer vs. reader in every disclosure-scope test — same-site-but-different-origin, genuinely-different-site, listed vs. not-listed, etc. — not just single-origin round-trips.
- GREASE'ing: an eligible small entry is *sometimes* GREASEd; a large entry is *never* GREASEd, regardless of how many trials you run.
- Every rejection path reports the *stable nominal* quota number, never a number that varies with real disk state.
- A failed write for a hash nobody has ever written removes that entry (a later plain read gets `NotFoundError`, not a permanent `NotAllowedError`) — **and, separately, a failed write for a hash a *concurrent, still-outstanding* sibling writer is also writing does not remove the entry**, whether that sibling later succeeds or is still in flight. Both halves matter; see [§2](#sec-2)'s bug writeup. Test the same pairing for an explicit `abort()`, not just a `close()` failure — they need the identical guard, and it's easy to fix one call site and forget the other.

**Three lessons on testing time- and resource-bounded logic** — **Ladybird:**
- **A real wall-clock token bucket is flakier to assert exactly than it looks.** In a tight loop, a refill tick can land between two consumes and let one extra request through non-deterministically. Assert the *shape* of the behavior (denial eventually happens; success count falls within `[capacity, capacity + small slack]`), not an exact boundary count — an exact-count assertion will intermittently fail for reasons that have nothing to do with a real bug.
- **Bulk/loop-shaped scenarios (rate-limit exhaustion, quota exhaustion via many writes) can be outright unreliable through a real browser-automation harness, not just slow.** A headless test harness's "is this page idle yet" heuristic isn't designed for a long-running script loop still legitimately working, and can tear the page down mid-test. This sharpens the "unit-test the registry directly" advice above with a concrete reason beyond speed: for scenarios shaped like this, going through full browser automation may not even be reliable, independent of how fast it runs.
- **Resource-limit tests usually don't need mocking.** Testing "an absurdly large `truncate()` gets correctly capped" doesn't necessarily need a dependency-injection seam for the limit, to avoid actually doing something slow or dangerous. A sparse `truncate()` to well beyond any realistic per-origin budget is typically a same-millisecond, metadata-only operation on a real filesystem. Verify your specific "huge size" operation is actually cheap on your target filesystems, then pick a size safely beyond any plausible real machine's limit, and test against the real thing.

**Also test at least one real, genuinely cross-origin scenario through the actual browser**, not just unit tests. It's easy to build an entire browser-level smoke-test suite (write/read round-trips, `seek()`/`truncate()` correctness, oversized-buffer rejection, large streamed writes) that never once exercises actual cross-origin disclosure or the PHL, because every test happens to write and read from the same origin/session for convenience. Unit tests proving the *logic* is correct are not the same as proof it works end-to-end through your real IPC boundary and JS bindings with two genuinely different origins. Concretely:
- Stand up two actually-different origins (different port is enough — same-origin policy is scheme+host+port; two different ports on `127.0.0.1` are two different origins, and loopback addresses are treated as secure contexts by every major browser's Secure Contexts implementation, so you don't need real TLS certs for this).
- Use a **real** PHL-listed resource with a **known preimage** — you cannot construct arbitrary bytes that hash to an arbitrary target value, so pick a hash from your PHL's "manually curated" entries (ones with documented provenance/source URLs in the PHL data itself), fetch the real content, and verify its digest matches before you build a test around it.
- From origin A: store that resource wildcard-scoped, and *also* store some arbitrary (definitely-not-listed) content wildcard-scoped, as a paired positive/negative case.
- From origin B (a genuinely different origin — reload/navigate, don't just call from a different script context on the same page): confirm the PHL-listed resource is readable and byte-for-byte correct, and confirm the non-listed one correctly fails closed (and check the *specific* rejection reason your implementation actually uses — don't assume; verify against your own source rather than guessing the DOMException name).

---

<a id="sec-13"></a>

## 13. Complexity/scale summary

| Operation | Naive complexity | Better approach | Why it matters |
|---|---|---|---|
| Total bytes used / per-origin bytes used | O(n) scan, on every write | O(1), incrementally maintained | Called on every single write |
| Eviction candidate selection | O(n log n) collect+sort, every eviction pass | O(log n) per removal, via an ordered index | Eviction is not rare at scale |
| PHL membership lookup | O(n) or O(1) hash set (memory-heavy) | O(log n) binary search over a sorted packed array | Hundreds of thousands of entries, read-only after load |
| Cross-process read-result transfer, in-process case *(Servo only — see [§9](#sec-9))* | O(bytes) copy per hop | O(1) refcount bump, one real copy only at final materialization | Payloads can be multi-hundred-MiB |
| Rate-limiter memory | O(distinct origins ever seen), unbounded | O(1) bounded (LRU-capped map) | Long-running sessions visiting many sites |

---

<a id="sec-14"></a>

## 14. Constants reference (all implementation choices, not spec-mandated)

| Constant | Reasonable value | Purpose |
|---|---|---|
| Pending-entry staleness timeout | 5 minutes | When an unfinished write is treated as abandoned |
| Read-probe burst capacity | 2000 tokens | Per-origin read rate limit burst |
| Read-probe refill rate | 20/second | Per-origin read rate limit steady-state |
| Write-probe burst capacity | 200 tokens | Per-origin write rate limit burst (shared by `create()` + `close()`) |
| Write-probe refill rate | 2/second | Per-origin write rate limit steady-state |
| Rate-limiter map cap | 10,000 distinct origins | Bounds rate-limiter memory over a long session |
| List-scope max length | 100 origins | Both single-call rejection and merge-time silent truncation |
| GREASE probability | 1% | Chance an eligible found entry is reported absent anyway |
| GREASE size ceiling | 500 KiB | Entries at/above this are never GREASEd |
| Global storage budget | 60% of total disk capacity | Matches Chromium/Safari precedent; not free-space-based |
| Per-origin storage share | 20% of current global budget | Prevents one origin evicting another's data |
| Streaming-time size cap (disk-backed writable stream; see [§3](#sec-3)/[§6](#sec-6)) | A flat generous ceiling (e.g. 4 GiB) or the live per-origin budget fraction | Caps `seek()`/`truncate()`-triggered disk-space growth, checked before every resize/write, distinct from the authoritative budget check at `close()` |
| PHL refresh cadence | Weekly | Keeps the rolling-release allowlist current — via a scheduled CI commit (Servo) or simply by being re-fetched at build-configure time (Ladybird); see [§4](#sec-4) |

---

<a id="sec-15"></a>

## 15. Suggested implementation order

1. Data model + persistence (per-entry files or equivalent, atomic writes) + the pending/written state machine, with staleness handling. Get this solid before anything else — everything builds on it.
2. Same-site-only disclosure only (simplest scope, reuses existing same-site logic). Full read/write round-trip, single-origin, working end to end through your real IPC/script boundary before adding anything else. **If your engine has genuinely separate script-hosting process types** (not just Window vs. Worker as a JS-level distinction — see [§1](#sec-1)), decide explicitly and early whether this step is scoped to just the main script-hosting process or all of them; deferring Worker/SharedWorker support is only cheap to retrofit later if a per-worker-process route to shared browser state already exists for something else.
3. Rate limiting (both budgets) — bounded from day one, not retrofitted.
4. Storage budget + eviction, including the running-totals/incremental-index performance work from the start — don't ship the O(n)/O(n log n) version even temporarily if you can avoid it; it's a straightforward rewrite later but easy to forget once it "works."
5. List scope + LRU merge behavior.
6. Wildcard scope: PHL integration first (get the fetch/verify/refresh pipeline solid and automated, or a placeholder that fails closed if you're deferring it), then GREASE'ing.
7. Streaming the write transfer to your shared registry service ([§3](#sec-3)) — after correctness is solid elsewhere, since it's a pure performance/memory optimization that's easy to get subtly wrong (see the integrity bug in [§3](#sec-3)) if done under time pressure.
8. Security review pass, specifically for: hash validation completeness across *every* recognized algorithm, unbounded-allocation paths reachable from a single script call (`seek()`/`truncate()` and anywhere else your API surface accepts a caller-controlled size), and — if your engine has a renderer/privileged-process trust boundary — re-validation on the trusted side of anything used for filesystem-path construction (see [§10](#sec-10)).
9. A genuine two-origin, PHL-aware browser-level test, in addition to unit tests — don't consider this feature done without one.

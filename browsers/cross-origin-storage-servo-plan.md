# Servo: Disk-Backed FileSystemWritableFileStream — Implementation Plan

## Context

Comparing the Ladybird and Servo Cross-Origin Storage (COS) implementations shows Servo's
`FileSystemWritableFileStream` buffers writes in an in-memory `Vec<u8>`, while Ladybird's is
disk-backed. COS targets multi-hundred-MiB to multi-GB payloads (sharded AI model weights), so
an in-memory buffer means holding gigabytes in RAM per write session, and needs a runtime cap to
stop `seek()`/`truncate()` from becoming an unbounded-allocation DoS. Disk-backed sidesteps that
whole bug class, trading it for a bounded, easier-to-guard disk-space claim instead — the better
choice, and worth porting Servo to match.

Scope: change the write-side scratch buffer only. The resource thread's own registry storage
(`components/net/cross_origin_storage_thread.rs`) already writes incoming chunks straight to its
own disk-backed temp file and hashes incrementally — that side needs no changes. The
`BeginWrite`/`WriteChunk`/`FinishWrite` wire protocol between script and the resource thread also
stays as-is: the channel (`servo_base::generic_channel`) is real, multiprocess-capable IPC bound
to `Serialize + Deserialize`, so a raw `File` handle can never cross it regardless — chunks must
still be read and sent individually, just sourced from disk instead of memory.

## Key architectural decisions

1. **Back the write buffer with a real temp file**, not a `Vec<u8>`. Use `tempfile::tempfile()`
   — already a workspace dependency, already used elsewhere in the `script` crate
   (`unminify.rs`, `mime_multipart.rs`) — which returns an anonymous file, unlinked on creation,
   needing no manual cleanup path even across a crash.
2. **Keep the chunked-transfer shape to the resource thread unchanged.** Only its source changes,
   from an in-memory slice to a bounded read from the temp file. Peak script-process memory for a
   write becomes one `WRITE_CHUNK_BYTES` chunk, not the whole payload, at both write time and at
   the final `close()`-time read-back.
3. **Keep the existing allocation-DoS ceiling, repurposed for disk.** The current
   `MAX_COS_WRITE_BUFFER_BYTES` (4 GiB) guard against a runaway `seek()`/`truncate()` still
   applies — it now bounds unbounded *disk* growth ahead of the registry's real budget check,
   rather than unbounded RAM allocation. Rename and re-document it accordingly; keep the same
   value.
4. **Environment prerequisite:** this checkout needs `ld64.lld` on `PATH` for anything that links
   `mozjs_sys` (`cargo check`, `mach build`), and it isn't there by default even though it ships
   inside the rustup toolchain. Export
   `PATH="$(rustc --print sysroot)/lib/rustlib/*/bin/gcc-ld:$PATH"` before any build/check/test
   step below. Always invoke `./mach` directly (never `python3 ./mach`) so its shell-script header
   re-execs through `uv run` into the managed venv.

## Implementation plan

### Steps

1. In `components/script/dom/stream/writablestreamdefaultcontroller.rs`, change
   `UnderlyingSinkType::CrossOriginStorageWrite`'s `bytes: RefCell<Vec<u8>>` field to
   `file: RefCell<Option<std::fs::File>>` (`Option` so `close()`/`abort()` can `take()`
   ownership — exactly one of them ever runs per stream).
2. Before touching the `#[derive(JSTraceable, PartialEq)]` on `UnderlyingSinkType`: grep the
   codebase for actual comparisons of `underlying_sink_type`/`UnderlyingSinkType`. None exist, so
   drop `PartialEq` from the derive up front rather than working around a `std::fs::File: !PartialEq`
   error later — `std::fs::File` has no `PartialEq` impl and never will.
3. In `components/script/dom/crossoriginstorage/filesystemwritablefilestream.rs`'s `new()`,
   create the temp file via `tempfile::tempfile()` before reflecting the DOM object, mapping any
   I/O error to `Error::Operation`.
4. Rewrite `write_chunk_at_position` to `file.seek(SeekFrom::Start(..))` + `write_all(..)` instead
   of `Vec::resize`/`copy_from_slice`. Zero-padding past the current end is free — ordinary sparse
   -file OS semantics — so no manual padding logic is needed.
5. Rewrite `apply_write_params`'s `"truncate"` command to `file.set_len(..)` instead of
   `Vec::resize`.
6. Rename `MAX_COS_WRITE_BUFFER_BYTES` → `MAX_COS_WRITE_FILE_BYTES` (same 4 GiB value), and
   re-document `reject_if_write_target_too_large` as guarding disk growth, not allocation.
7. In `abort_steps`, replace `bytes.borrow_mut().clear()` with `file.borrow_mut().take()` — drops
   (and thus reclaims) the temp file immediately rather than waiting for the controller itself to
   be GC'd.
8. In the close algorithm, replace `bytes.borrow_mut().split_off(0)` with
   `file.borrow_mut().take()`, and pass ownership of the `File` into `verify_and_store`.
9. In `components/script/dom/crossoriginstorage/registry.rs`, change `verify_and_store`'s
   signature from `bytes: Vec<u8>` to `mut file: std::fs::File`. Rewind it, read its length via
   `file.metadata()`, and loop-read it back in `WRITE_CHUNK_BYTES` pieces, sending each piece as a
   `WriteChunk` immediately — never materializing the whole file as one `Vec<u8>`.

## Deferred / follow-up work

This plan only changes the write-side scratch buffer (see Context above) — deliberately out of
scope:

- **The resource thread's own registry storage and the `BeginWrite`/`WriteChunk`/`FinishWrite`
  wire protocol** are unaffected by this change and stay exactly as they are.
- **Broader COS hardening** (rate limiting, PHL refresh automation, storage-budget eviction
  improvements) is unrelated to the write-buffer backing store and isn't touched here — see the
  shared cross-vendor engineering notes for that work generally.

## Risks

**The main risk is platform-specific `tempfile::tempfile()` behavior**, not the chunked-transfer
logic itself (which is explicitly unchanged, see Key architectural decisions above). An anonymous,
unlinked temp file's exact semantics (permissions, filesystem placement, behavior under a full
disk) can differ across the platforms Servo supports — verify the write/seek/truncate/close path
this change touches on each target platform, not just the one used for local development.

## Verification plan

1. `cargo check -p servo-script` must be clean, no new warnings.
2. `cargo test -p servo-net --lib cross_origin_storage` must pass all existing resource-thread
   tests unmodified — this is what confirms the wire protocol genuinely didn't need to change.
3. Build Servo for real (`./mach build --dev`) and run it against the actual WPT
   `cross-origin-storage` suite via `./mach test-wpt`, not just unit tests — validates the
   rewrite end-to-end through a real browser, including the exact `write()`/`seek()`/`truncate()`/
   `close()` path that changed.
   - Vendor the suite temporarily into `tests/wpt/tests/cross-origin-storage/` (plus
     `tests/wpt/tests/interfaces/cross-origin-storage.idl`, which `idlharness` fetches) purely
     for local validation; regenerate the manifest with `./mach update-manifest`.
   - Do **not** commit this vendored copy: the WPT PR adding these tests upstream is expected to
     land soon, at which point `./mach update-wpt`'s regular sync picks them up for real. Revert
     the local vendoring (including the manifest diff) once validation is done, so the feature PR
     stays scoped to the implementation change alone.
   - Expect the core API tests (`filesystemwritablefilestream-verify`,
     `requestFileHandle-create-and-read`, `requestFileHandle-validation`, `origins-scoping`) to
     pass; declarative CSS/HTML/JS integration and Permissions-Policy gating tests are out of
     scope for this change and are expected to fail until those separate features are built, as
     is every Service-Worker-flavored test variant (Servo has no Service Worker support at all).

## Documentation update plan

Update `browsers/cross-origin-storage-implementation-notes.md` in the shared WICG notes repo —
§3 (backing-store choice), §6 (streaming-time quota gap), §10 point 2 (unbounded-resource-claim
guard), and the §14 constants table — to state disk-backed as the recommended default and explain
the flat-ceiling-vs.-budget-fraction cap choice as a general tradeoff for any implementer, rather
than as a per-vendor historical comparison.

## Rollout

Commit and push both repos once verification passes:
- `tomayac/servo`, `cross-origin-storage` branch.
- `WICG/cross-origin-storage`, `main` — note this pushes directly to a shared, multi-vendor repo,
  not a personal fork.

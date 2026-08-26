# Filed issue: Fetch Standard, the `crossOriginStorage` request option

**Status of this document.** Filed on 2026-08-26 as
[whatwg/fetch#1954](https://github.com/whatwg/fetch/issues/1954), through the Fetch Standard's
"New feature" form. The text below the rule is what was submitted, kept here as the working copy;
the issue itself is now the place where the discussion happens, so prefer it over this file and
treat any divergence as this file being out of date.

It is the fourth and last of the host integrations. The other three are
[whatwg/html#12770](https://github.com/whatwg/html/issues/12770) (the `crossoriginstorage`
attribute), [whatwg/html#12771](https://github.com/whatwg/html/issues/12771) (the
`crossOriginStorage` import attribute), and
[w3c/csswg-drafts#14056](https://github.com/w3c/csswg-drafts/issues/14056) (the
`cross-origin-storage()` URL modifier). The explainer's
[Fetch integration](README.md#fetch-integration) section and the specification's
[Integration with other specifications](https://wicg.github.io/cross-origin-storage/#integration-with-other-specifications)
section both cite the issue.

**Follow-up still open:**

- Question 4 below (streaming versus SRI's full-body buffering) is not covered in the explainer. If
  the answer turns out to be that a fetch with `integrity` cannot resolve before the body is fully
  read, the "The streaming example, without the plumbing" example in the explainer overstates what
  the integration recovers and should be adjusted.

**How the form maps onto what follows** (recorded for the next integration filed this way): the
template is an issue *form*, not a free-text body. It has four textareas, labelled
`What problem are you trying to solve?` (the only required one), `What solutions exist today?`,
`How would you solve it?`, and `Anything else?`, and it applies the `addition/proposal` and
`needs implementer interest` labels automatically. The prose under each `###` heading below went
into the field with the matching label; the `###` headings themselves were not pasted, because
GitHub emits them from the labels when it renders the issue. That is why they appear here: the
draft mirrors the rendered result, heading levels included, so `####` subsections nest correctly
underneath.

---

### What problem are you trying to solve?

The [Cross-Origin Storage (COS) API](https://github.com/WICG/cross-origin-storage)
([specification draft](https://wicg.github.io/cross-origin-storage/)) is a proposed browser
mechanism that lets large resources, such as AI models, Wasm modules, popular JavaScript
libraries, and web fonts, be stored once and retrieved across origins, identified by their
cryptographic hash rather than by their URL. Two sites that use the same 3 GB model download it
once between them instead of once each.

Three host integrations let a resource opt into COS declaratively, each alongside an `integrity`
hash that identifies the resource: a `crossoriginstorage` content attribute on `<link>` and
`<script>` ([whatwg/html#12770](https://github.com/whatwg/html/issues/12770)), a
`crossOriginStorage` import attribute ([whatwg/html#12771](https://github.com/whatwg/html/issues/12771)),
and a `cross-origin-storage()` URL modifier in CSS
([w3c/csswg-drafts#14056](https://github.com/w3c/csswg-drafts/issues/14056)).

The imperative case has no such opt-in, and it is the case that matters most for the resources
this is designed around. A multi-gigabyte model, a Wasm module, or an asset bundle is not
referenced from markup or from a stylesheet: it is fetched by script that already holds both the
URL and the hash. Today, moving such a resource onto COS means abandoning `fetch()` for a
hand-written cache-check, fallback-fetch, and store sequence built on the imperative
`navigator.crossOriginStorage.requestFileHandle()` API. That is the most code of any of the four
surfaces, for the surface where the payoff is largest.

This issue proposes closing that gap with a `crossOriginStorage` option on `RequestInit`, used
alongside the existing [`integrity`](https://fetch.spec.whatwg.org/#dom-requestinit-integrity)
option, so that a script can opt a fetch into COS the same way markup, module graphs, and
stylesheets can opt their resources in.

### What solutions exist today?

The only existing (proposed) opt-in for an imperative fetch is
`navigator.crossOriginStorage.requestFileHandle()`. It works, but the caller has to write the
whole cache-miss path by hand, and for large resources it has to write the streaming version of
it, so that download and consumption overlap rather than serialize. This is the pattern the COS
explainer currently recommends for a Wasm module:

```js
const hash = {
  algorithm: 'SHA-256',
  value: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
};
const wasmHeaders = { headers: { 'Content-Type': 'application/wasm' } };

try {
  // Cache hit: stream from the stored file.
  const handle = await navigator.crossOriginStorage.requestFileHandle(hash);
  const file = await handle.getFile();
  const { instance } = await WebAssembly.instantiateStreaming(
    new Response(file.stream(), wasmHeaders),
    imports,
  );
  return instance;
} catch (err) {
  if (err.name !== 'NotFoundError') {
    throw err;
  }
}

// Cache miss: split the body so compilation and storage proceed in parallel.
const response = await fetch('/model.wasm');
if (!response.ok) {
  throw new Error(`HTTP ${response.status}`);
}
const [compileStream, storeStream] = response.body.tee();

// Fire-and-forget store; never block on the write.
(async () => {
  try {
    const handle = await navigator.crossOriginStorage.requestFileHandle(hash, {
      create: true,
      origins: '*',
    });
    const writableStream = await handle.createWritable();
    await storeStream.pipeTo(writableStream);
  } catch (err) {
    // Release the unconsumed branch so the body isn't buffered indefinitely.
    storeStream.cancel().catch(() => {});
  }
})();

const { instance } = await WebAssembly.instantiateStreaming(
  new Response(compileStream, wasmHeaders),
  imports,
);
return instance;
```

Around 30 lines of `tee()`, `pipeTo()`, and cancellation, per resource, for what is conceptually
one fetch. Every branch of it is a place to get the common case wrong, and getting it wrong is
silent: forgetting the `tee()` costs the download and compile overlap that
`WebAssembly.instantiateStreaming()` exists to provide, and forgetting the `cancel()` buffers an
unconsumed body for the lifetime of the fetch. The hash also has to be written twice, once as a
`requestFileHandle()` argument and once as an `integrity` value, in two different encodings, if
the caller also wants the network path verified.

With a request option, the same thing is:

```js
const { instance } = await WebAssembly.instantiateStreaming(
  fetch('module.wasm', {
    integrity: 'sha256-abc123...',
    crossOriginStorage: '*',
  }),
  imports,
);
```

### How would you solve it?

Add a `crossOriginStorage` member to `RequestInit`:

```webidl
partial dictionary RequestInit {
  (DOMString or sequence<DOMString>) crossOriginStorage;
};
```

The member is only meaningful alongside `integrity`, which supplies the hash that identifies the
resource in COS. Its value declares which origins may retrieve the stored bytes, mirroring the
`origins` option of `requestFileHandle()` and the values the three other integrations accept:

| Value | Meaning |
| --- | --- |
| absent | No COS participation (today's behavior) |
| `""` | Same-site access only |
| `"*"` | Globally available to all origins |
| `["https://a.example", …]` | Available to the listed origins only |

An origin list is subject to the same
[implementation-defined maximum length](https://wicg.github.io/cross-origin-storage/#storage-limits)
as the `origins` option of `requestFileHandle()`, for the same reason: without a cap, a caller
could enumerate enough origins to approximate `"*"` without ever declaring it. See
[Cross-site probing](https://wicg.github.io/cross-origin-storage/#cross-site-probing).

Note that same-site scope is spelled as an empty string rather than as an omitted member. The
imperative API carries its opt-in separately, in `create: true`, so it can treat an omitted
`origins` as "same-site only". `fetch()` has no such second signal, so the member's *presence* is
what opts the request into COS and its *value* is what scopes the result. Omitting
`crossOriginStorage` while keeping `integrity` therefore preserves today's behavior exactly: the
response is fetched and verified, and COS is neither consulted nor written.

The list form is a `sequence<DOMString>`, whereas the HTML attribute and the import attribute take
a space-separated string and the CSS modifier a comma-separated list of `<string>`s. That
difference is deliberate rather than an oversight: a `RequestInit` member is an ordinary
JavaScript value, so a sequence is the idiomatic spelling and it matches the imperative `origins`
option exactly, down to the IDL type. The other three surfaces have no such choice, because
attribute values are text, import attribute values are restricted to strings by
[TC39](https://github.com/tc39/proposal-import-attributes), and CSS has no array type. All four
resolve to the same value space.

#### Examples

```js
// Same-site only, mirroring an omitted `origins` in the imperative API.
const sameSite = await fetch('same-site-resource.ext', {
  integrity: 'sha256-abc123...',
  crossOriginStorage: '',
});

// Globally available.
const global = await fetch('popular-resource.ext', {
  integrity: 'sha256-abc123...',
  crossOriginStorage: '*',
});

// Restricted to specific origins.
const restricted = await fetch('acme-inc-corporate.ext', {
  integrity: 'sha256-def456...',
  crossOriginStorage: [
    'https://acme-inc.example.com',
    'https://acme-cdn.example.com',
  ],
});
```

#### Processing model

The four integrations are meant to share one model: look COS up by the integrity hash, and fall
back to the network on anything other than a disclosable hit.

1. If `crossOriginStorage` is absent, proceed exactly as today. COS is not involved.
2. Otherwise, before going to the network, run
   [resolve a COS lookup](https://wicg.github.io/cross-origin-storage/#reading-files) for the
   request's integrity metadata and the request's origin. On success, the response is served from
   COS and no network request is made.
3. On any failure, fetch from the network as usual. If the response's bytes match the integrity
   metadata and the declared value permits it, store them in COS for reuse. If the hash does not
   match, the response is rejected per existing SRI behavior and nothing is stored.

Step 2's failure is not only "not present". A lookup can also fail because the hash has not
cleared the [Public Hash List](https://wicg.github.io/cross-origin-storage/#public-hash-list),
because the user agent applied
[GREASE'ing](https://wicg.github.io/cross-origin-storage/#greaseing), or because the origin has
exhausted its cross-origin probe budget. All of these are deliberately indistinguishable from a
genuine cache miss and all fall through to step 3 identically; see
[Availability gating](https://wicg.github.io/cross-origin-storage/#availability-gating). An
integration that distinguished them would leak precisely what the gating exists to withhold.

There is precedent in Fetch for the shape of step 2. [Main fetch](https://fetch.spec.whatwg.org/#main-fetch)
already consults a local store keyed in part by integrity metadata, in the "consume a preloaded
resource" step, and short-circuits the network when it hits. A COS lookup is the same shape, with
a different store and an origin check.

#### Feature detection and progressive enhancement

An unknown `RequestInit` member is ignored, so a `fetch()` written against this proposal behaves
in a browser without COS exactly as it does today: the network fetch happens, `integrity` is
verified, nothing is stored. No fallback path is needed.

Detection is worth designing on purpose rather than leaving to the dictionary-getter trick. Fetch
already reflects `integrity` as a `Request` attribute, and reflecting this member the same way
gives a clean check:

```webidl
partial interface Request {
  readonly attribute any crossOriginStorage;
};
```

```js
const supported = 'crossOriginStorage' in Request.prototype;
```

#### Non-browser `fetch()` implementations

Server runtimes such as Node.js, Deno, and Bun implement `fetch()` but have no cross-origin
boundary and no user whose browsing history is at stake, so COS does not exist there. They would
ignore `crossOriginStorage` the way they ignore other browser-specific request options, and
isomorphic code keeps working unchanged.

### Anything else?

#### Open questions

The first two are specific to this integration and are the reason the COS explainer says the
answers belong in the Fetch Standard discussion rather than in the COS specification. The rest are
integration-mechanics questions that the three declarative forms did not have to face.

1. **Response fidelity on a hit: MIME type.** A COS entry carries bytes only, with no MIME type,
   status, or headers, deliberately so, because unverifiable metadata cannot be attributed to a
   hash (see
   [Storing the original URL as part of a COS entry](https://github.com/WICG/cross-origin-storage#storing-the-original-url-as-part-of-a-cos-entry)).
   A `Response` synthesized from a hit therefore has no `Content-Type` unless the integration
   invents one. The three other integrations sidestep this because the element, the module type,
   or the CSS property fixes the destination, whereas a bare `fetch()` has none. This bites
   immediately: `WebAssembly.instantiateStreaming()` refuses anything that is not
   `application/wasm`, which is exactly why the hand-written example above has to supply that
   header itself. Candidate answers: derive the type from the request's
   [destination](https://fetch.spec.whatwg.org/#concept-request-destination), let the caller
   declare it, or store a user-agent-computed type alongside the bytes.
2. **Response fidelity on a hit: everything else.** A response served from COS must not reveal
   whether the bytes came from storage or from the network, so it cannot carry the response
   headers of a fetch that never happened. As a privacy matter this is smaller than it looks,
   since cache hits are timing-observable regardless and disclosure is already gated by the
   declared origins, the Public Hash List, and GREASE'ing on the read step. The open question is
   one of fidelity: which `status`, `statusText`, `Content-Length`, `type`, and `url` a hit-served
   `Response` should report, and whether a
   [Resource Timing](https://w3c.github.io/resource-timing/) entry is recorded for it and with
   what values.
3. **Where the lookup hooks in, and what it ranks against.** The COS lookup has to sit below a
   service worker, so that `event.respondWith()` still wins for a page's own interception, and
   presumably below the HTTP cache, whose entries are same-origin and higher fidelity. That
   suggests the lookup belongs in [HTTP fetch](https://fetch.spec.whatwg.org/#http-fetch) after
   the service worker declines, rather than in main fetch. Confirmation, and the exact step,
   are wanted.
4. **Streaming versus SRI's full-body buffering.** When `integrity` is non-empty, main fetch
   currently fully reads the response body before running fetch response handover, so the
   `fetch()` promise does not resolve until all the bytes are in. That means
   `WebAssembly.instantiateStreaming(fetch(url, { integrity }))` does not actually overlap
   download and compilation today, with or without COS. Since recovering that overlap without
   hand-written `tee()` plumbing is a main motivation here, this proposal's value depends on
   whether streaming SRI validation is on the table, or whether a COS hit (whose bytes were
   hash-verified when they were written and need no re-verification) can stream even while a
   network response cannot.
5. **`crossOriginStorage` without `integrity`.** There is nothing to look up without a hash.
   Unlike a content attribute, `RequestInit` has an exception channel and the `Request`
   constructor already throws for invalid combinations, so a `TypeError` at construction time
   seems better than silently ignoring the member. (Authors' hunch: `TypeError`.)
6. **Interaction with other request options.** `mode: "no-cors"` already excludes integrity
   metadata, so presumably it excludes this member too, by the same rule. Less obvious: what
   `cache: "no-store"`, `"reload"`, and `"only-if-cached"` should mean for a COS lookup, and
   whether a COS hit populates the HTTP cache.
7. **Permissions Policy.** COS is gated by a
   [`cross-origin-storage` policy-controlled feature](https://wicg.github.io/cross-origin-storage/#permissions-policy-integration).
   When the feature is disallowed, `requestFileHandle()` rejects with a `NotAllowedError`. For
   this integration, rejecting the fetch would be wrong, since the request is perfectly valid;
   behaving as if the member were absent, that is fetching from the network and never touching
   COS, is consistent with an ordinary miss and with the answer proposed for the same question in
   whatwg/html#12770. (Authors' hunch: behave as if absent.)
8. **Probe budget accounting.** A COS lookup discloses one bit, whether the user already has these
   bytes, and a site can read that bit from an integration lookup just as well as from an
   imperative call, by observing whether its own server received the fallback request. Lookups
   from `fetch()` therefore have to be charged against the same
   [cross-origin probe budget](https://wicg.github.io/cross-origin-storage/#storage-limits) as
   `requestFileHandle()` calls, or the budget is trivially avoidable, since a `fetch()` lookup is
   as scriptable in a loop as an imperative one. The COS specification routes all four
   integrations through one algorithm for this reason; what is wanted here is that Fetch invokes
   that algorithm rather than reaching the store directly.
9. **A cancelled body on a miss.** If the caller cancels the response body partway through a
   cache-miss fetch, does the user agent keep downloading to complete the COS write, or abandon
   it? Abandoning it matches "the user agent does no work the page did not ask for", but throws
   away a partly transferred large resource. (Authors' hunch: abandon.)

#### This does not replace `requestFileHandle()`

Worth stating up front, since it came up when the fetch integration was first requested in
[WICG/cross-origin-storage#74](https://github.com/WICG/cross-origin-storage/issues/74): this
option is an addition to the imperative COS API, not a replacement for it. A fetch couples naming
a resource to downloading it, and three things COS has to support do not fit that shape.

- **Bytes reach COS from places `fetch()` does not own.** They may arrive from a
  [Background Fetch](https://wicg.github.io/background-fetch/), from `Range` requests for a
  sharded resource the site reassembles itself, from a file the user picked off their local disk,
  or from another storage API. The sharded case cannot be expressed through a fetch integration at
  all, because the stored entry is a shard that no single URL serves.
- **A read may have no URL to offer.** AI models ship as families of interchangeable variants, so
  an app built around `whisper-tiny` should transcribe with `whisper-large-v3` if the user already
  has it, rather than downloading a smaller and worse model on top of a better one. That means
  probing several hashes and committing to a download only after all of them come back empty. A
  fetch-shaped API cannot ask this, because every probe would have to name a URL the app has no
  intention of fetching.
- **Handles are not responses.** A `FileSystemFileHandle` can be transferred to another context,
  read several times, and written through with the same File System Standard machinery developers
  already use for OPFS. A `Response` is a single, one-shot consumption of a body, and a store-only
  write has no natural spelling in `fetch()`: there is no request to make, only bytes to hand
  over.

#### Related proposals

Sharing the same underlying model, one per host:

- [whatwg/html#12770](https://github.com/whatwg/html/issues/12770): a `crossoriginstorage` content
  attribute on `<link>` and `<script>`.
- [whatwg/html#12771](https://github.com/whatwg/html/issues/12771): a `crossOriginStorage` import
  attribute, for static `import` and dynamic `import()`.
- [w3c/csswg-drafts#14056](https://github.com/w3c/csswg-drafts/issues/14056): a
  `cross-origin-storage()` `<request-url-modifier>`.

#### References

- [Cross-Origin Storage explainer](https://github.com/WICG/cross-origin-storage), and its
  [Fetch integration](https://github.com/WICG/cross-origin-storage#fetch-integration) section.
- [Cross-Origin Storage specification draft](https://wicg.github.io/cross-origin-storage/).
- [Security and privacy self-review questionnaire](https://github.com/WICG/cross-origin-storage/blob/main/security-privacy-questionnaire.md).

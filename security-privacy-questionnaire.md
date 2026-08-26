# [Self-Review Questionnaire: Security and Privacy](https://w3ctag.github.io/security-questionnaire/)

## 01. What information does this feature expose, and for what purposes?

The COS API exposes the availability of files identified by their hash across different origins. The purpose is to enable efficient sharing of common files (for example, AI models, highly popular JavaScript libraries, Wasm modules, and large web fonts) to reduce redundant downloads and storage.

## 02. Do features in your specification expose the minimum amount of information necessary to implement the intended functionality?

Yes, the API exposes only the existence of a file with a known hash and provides read access to it. By default, exposure is limited to Same-Site contexts. No additional metadata is exposed. A COS entry deliberately stores bytes only, with no MIME type, status, or response headers, so the host integrations cannot expose more than the imperative API does either. In particular, a `Response` served from COS by the `fetch()` integration carries the stored bytes and cannot carry response headers from a network fetch that never happened. Write access is not gated by a permission prompt (analogously to how pages may freely store data until their quota is exhausted in mechanisms such as the Origin Private File System, IndexedDB, or the Cache API), but it can be denied via Permissions Policy, in which case the user agent throws a `NotAllowedError` `DOMException`. The optional `origins` field allows developers to further minimize exposure by restricting resource access to a trusted set of origins. Global sharing of resources is strictly an opt-in operation. Read access is additionally bounded by a **cross-origin probe budget**: an implementation-defined maximum number of distinct hashes a site may resolve other than those it stored itself, which caps the total information any one site can extract regardless of how many calls it makes. See Q03.

## 03. Do the features in your specification expose personal information, personally-identifiable information (PII), or information derived from either?

Possibly, and in two distinct ways.

**Inference.** If a COS file is only used on a couple of websites, a site can discover that the user visited those sites by checking for the file's presence. The attacker would probe hashes of resources it's interested in by calling `requestFileHandle()` for each hash; each such call is a probe. One such attack is checking for a niche JavaScript library only used on certain sites. The `origins` field addresses this by allowing resources to be hidden from any origin not explicitly listed by the storer.

Probing is not limited to the imperative API. Each of the host integrations (the `crossoriginstorage` attribute, the `crossOriginStorage` import attribute, the CSS `cross-origin-storage()` modifier, and the `crossOriginStorage` request option on `fetch()`) also consults COS before falling back to the network. An attacker learns the outcome of such a lookup by observing whether its own server receives the fallback request, which yields the same single bit that a `requestFileHandle()` call yields. No integration discloses more than the imperative API does, and all of them are subject to the same `origins` scoping, availability gating, and GREASE'ing. The mitigations have to apply to all four surfaces, though: a hash first resolved through the `fetch()` integration is rate-limited, and charged against the cross-origin probe budget described below, exactly as one resolved imperatively is.

As a further mitigation, user agents implement availability gating using a **Public Hash List (PHL)**, a shared, vendor-neutral allowlist. A `'*'`-scoped resource is disclosable cross-origin only if its hash is on the PHL, and a hash is admitted only once it clears a k-anonymity-style ubiquity bar — appearing byte-identical across a minimum number of independently observed origins — evaluated once, offline, as part of admission rather than as a check the user agent repeats per query. A `'*'`-scoped resource whose hash is not on the list returns `NotFoundError` regardless of whether the file is present, making COS state indistinguishable from absence. The sole exception is an origin that stored the file itself, which can always read it back.

User agents may additionally apply **GREASE'ing** ([Generate Random Extensions And Sustain Extensibility](https://tools.ietf.org/html/draft-ietf-tls-grease)): occasionally returning a `NotFoundError` `DOMException` even when a file passes the availability gating check, introducing noise that makes probing unreliable. This technique is used similarly in [UA Client Hints](https://wicg.github.io/ua-client-hints/#grease). User agents must not GREASE responses for very large files (such as gigabyte-scale AI model weights) where a spurious false negative would force the caller to perform a full re-download, imposing a significant bandwidth cost on the user.

**Identifier construction.** A distinct and more serious risk is an attacker that *writes* the resources itself and uses their presence purely as storage for a value it minted: a tracker picks 32 hashes, writes the subset corresponding to a random 32-bit identifier, and reconstructs that identifier by probing the same 32 hashes on any other site. Many trackers would settle for 16 bits and absorb the collisions. Neither the PHL nor GREASE'ing bounds this. PHL membership assumes an attacker learns only "this user encountered one of the many sites using this file", which fails when the attacker wrote the file: a k-anonymity bar constrains an attacker that can only *observe* state, not one that can *set* it. GREASE'ing and eviction do flip bits, but an attacker compensates with redundancy or a checksum at the cost only of more hashes.

What bounds it is the count: each distinct hash a site can resolve cross-origin yields at most one bit, so user agents impose a **cross-origin probe budget** — an implementation-defined maximum number of distinct hashes a site may resolve through any surface that reaches COS, other than those it stored itself or has a write in flight for. It is counted in distinct hashes rather than calls, charged whether or not the file is found, not partitioned by top-level site, replenished only on user activation, and cleared with the origin's site data. Reads over budget return `NotFoundError`, indistinguishable from any other read-path failure. See [Cross-site identifier construction](README.md#cross-site-identifier-construction).

## 04. How do the features in your specification deal with sensitive information?

The API does not allow arbitrary file discovery.

## 05. Does data exposed by your specification carry related but distinct information that may not be obvious to users?

No.

## 06. Do the features in your specification introduce state that persists across browsing sessions?

Yes. Files stored in COS persist across sessions. User agents may manage eviction policies to maintain control over this state and offer manual management options. Each origin's cross-origin probe budget, and the set of hashes it has already resolved, likewise persist, and are cleared with that origin's site data.

## 07. Do the features in your specification expose information about the underlying platform to origins?

No.

## 08. Does this specification allow an origin to send data to the underlying platform?

No.

## 09. Do features in this specification enable access to device sensors?

No.

## 10. Do features in this specification enable new script execution/loading mechanisms?

No. The declarative HTML (`crossoriginstorage` attribute on `<link>`/`<script>`), JavaScript (`crossOriginStorage` import attribute), and `fetch()` (`crossOriginStorage` request option) integrations do not introduce a new script execution or loading mechanism. They reuse the existing `<link>`, `<script>`, module-import, and `fetch()` loading paths, with COS only acting as an alternate source for content that must already match a developer-declared `integrity` hash before it is used. This matters most for the `fetch()` integration, whose response may be passed to a code-loading consumer such as `WebAssembly.instantiateStreaming()`: the bytes were hash-verified when they were written to COS and are matched against the caller's `integrity` value on retrieval, so the integration cannot substitute content that the same `integrity` value would not already have admitted from the network.

## 11. Do features in this specification allow an origin to access other devices?

No.

## 12. Do features in this specification allow an origin some measure of control over a user agent's native UI?

No.

## 13. What temporary identifiers do the features in this specification create or expose to the web?

The COS registry itself is the identifier surface, rather than any token the API mints: an attacker able to resolve N distinct hashes cross-origin can encode an N-bit value in which of them it writes. That is bounded by the cross-origin probe budget rather than eliminated; see Q03.

The budget is itself per-origin state that persists across sessions, and so deserves naming here. It is not usable as an identifier in its own right: reading how much of it remains costs budget, so it cannot be sampled repeatedly or held at a chosen value; it replenishes on user activation; and it is cleared with the origin's site data. No other temporary identifiers are created or exposed.

## 14. How does this specification distinguish between behavior in first-party and third-party contexts?

By default, the COS API is only available in Same-Site contexts: a site can only access files stored by itself or by other same-site origins. The optional `origins` field controls access by restricting it to specific trusted origins or expanding it to all origins. Global sharing is strictly an opt-in operation.

Availability gating adds a popularity threshold for globally-scoped resources, so a resource unique to, or concentrated among, a few origins is not disclosed to third-party requestors. This bounds cross-site *inference*. It does not bound an attacker that writes the resources itself, for which popularity is irrelevant; see Q03.

The cross-origin probe budget is where this specification draws its sharpest first-party / third-party distinction, and it does so deliberately in two ways. It is **not partitioned** by top-level site, the opposite of the usual default: partitioning would hand a third party a fresh allowance on every site it is embedded in, which is exactly the capability being bounded. And it **replenishes on user activation**, which a site the user is actually interacting with accrues readily and a script running in a third-party frame accrues almost none of.

The design deliberately does not depend on third-party cookie availability. A user agent that still supports third-party cookies gains little from a tight budget, since a tracker there already has a cheaper and more reliable identifier; a user agent that has removed them should choose a budget at the strict end. The mechanism is the same in both, and only the value differs.

## 15. How do the features in this specification work in the context of a browser’s Private Browsing or Incognito mode?

Files previously stored in COS are not accessible in Private Browsing or Incognito mode. User agents may allow COS to work during an Incognito session, but the data would not be retained. Alternatively, user agents may disable COS entirely or apply GREASE'ing to always return false negatives about the availability of files.

## 16. Does this specification have both "Security Considerations" and "Privacy Considerations" sections?

Yes. The specification includes detailed sections addressing [security considerations](README.md#security-considerations) and [privacy implications](README.md#privacy-considerations).

## 17. Do features in your specification enable origins to downgrade default security protections?

Yes. This is an explicit opt-in operation; user agents are encouraged to surface a console warning when a resource is stored with reduced visibility restrictions.

## 18. What happens when a document that uses your feature is kept alive in BFCache?

The BFCache behavior is aligned with that of the File System Standard ([whatwg/fs#17](https://github.com/whatwg/fs/issues/17)).

## 19. What happens when a document that uses your feature gets disconnected?

The file access operation will terminate, and any pending storage or retrieval will fail gracefully with appropriate errors.

## 20. Does your spec define when and how new kinds of errors should be raised?

Yes. The specification defines specific use cases for `NotAllowedError` and `NotFoundError` `DOMException`s.

## 21. Does your feature allow sites to learn about the user's use of assistive technology?

No.

## 22. What should this questionnaire have asked?

How much entropy is acceptable for a shared, content-addressed cache to expose cross-origin, and how should a user agent choose that bound?

The cross-origin probe budget described in Q03 converts an unbounded identifier channel into one whose width is exactly the budget. Because the budget starts full, that maximum is also exactly the number of bits a third party that has never been interacted with obtains on first contact — which makes the value, rather than the mechanism, the whole of the design: small enough that this width is uninteresting, large enough for a page's genuine resource count. There is not yet cross-vendor agreement on where that lands. This questionnaire asks what information a feature exposes, but not how much of it is too much, which is the question this feature actually turns on.

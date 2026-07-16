# Issue: Browser extension integration points for Cross-Origin Storage (COS)

## Authors

- [Thomas Steiner](mailto:tomac@google.com), Google Chrome
- [Oliver Dunk](mailto:oliverdunk@google.com), Google Chrome

## Background

The [Cross-Origin Storage (COS) API](https://github.com/WICG/cross-origin-storage) ([formal spec](https://wicg.github.io/cross-origin-storage/)) is a proposed browser mechanism that lets large resources — AI models, WebAssembly modules, popular JavaScript libraries, web fonts — be stored once and retrieved across origins, identified by their cryptographic hash rather than by URL.

Two independent points where the Chrome extensions platform could integrate with COS are sketched below:

1. Extensions could use COS instead of [Shared Modules](https://developer.chrome.com/docs/extensions/reference/manifest/shared-modules) to share resources between extensions.
2. Because a COS hit skips the network entirely, [`declarativeNetRequest`](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) (DNR) — which today only ever sees requests that reach the network stack — needs a way to still apply blocking policy to COS-served resources.

## 1. Replacing Shared Modules

### How Shared Modules work today

Shared Modules are declared via the `"export"`/`"import"` manifest keys. An importing extension reaches a module's files through the reserved path `chrome-extension://<importing-id>/_modules/<module-id>/…`. A module can optionally restrict itself to an allowlist of importing extension IDs; otherwise any extension can import it. Install/uninstall is tied to the Chrome Web Store — a module is fetched automatically when a dependent extension needs it, and removed once the last dependent is uninstalled. Notably, the docs currently carry the caution "*The Chrome Web Store does not allow the submission of shared modules*", and the page itself was last updated in 2015 — the mechanism is documented but effectively legacy.

### Where COS fits

Instead of publishing a separate Shared-Module extension and importing it by extension ID, an extension could resolve a common resource (a bundled library, a Wasm runtime, a font) via COS by hash — the same lookup a regular web page would perform with `crossoriginstorage`/`requestFileHandle()`. Because COS entries are keyed by hash rather than by extension ID:

- No separate Chrome Web Store listing or ID-based allowlist is needed for the shared resource itself; trust comes from the SRI-style hash match, not from who published it.
- A sufficiently common resource could be shared not just between extensions but with the ordinary web — an extension and a web page that both bundle the same widely-used library could resolve it from the same COS entry if that hash is on the [Public Hash List](https://wicg.github.io/cross-origin-storage/#public-hash-list).
- The `_modules/<module-id>/` path indirection goes away entirely; resources are addressed by content, not by a synthetic extension-relative path.

### Open questions

- What partition should extension COS reads/writes use — each extension's own `chrome-extension://` origin (closer to today's per-origin COS model), or a partition shared across all extensions (closer to today's Shared Modules model)?
- Extensions aren't "sites" in the usual sense and already carry elevated, manifest-declared permissions — does that change any of COS's cross-site-probing mitigations, e.g. the cap on the number of origins a resource can be shared with?
- Would extension-authored resources need their own curation path onto (or alongside) the Public Hash List, or should extension use stay restricted to same-extension / explicit-origin storage and never reach global availability?

## 2. Making COS resources blockable via declarativeNetRequest

### The gap

DNR rules match a request by `resourceTypes` (`main_frame`, `script`, `stylesheet`, `image`, `font`, `xmlhttprequest`, `media`, `websocket`, `webbundle`, …) and a `urlFilter`, then `block` / `redirect` / `upgradeScheme` / `allow` it as it reaches the network. That model assumes every controlled resource is fetched over the network each time it's needed.

COS is explicitly designed to skip the network on a cache hit — that's the point of it. But it also means an ad blocker, enterprise content filter, or any other extension using DNR to block a known resource by URL today would have nothing to intercept once that resource starts resolving from COS instead of from a network fetch.

### Proposal sketch

- DNR evaluation should still run against the resource's original request (its URL and `resourceTypes` context) *before* COS is consulted, so a matching `block` rule prevents the load regardless of whether the bytes would ultimately have come from the network or from COS. COS lookup should be a step that happens only after a request survives DNR, not a bypass of it.
- Because COS resources are hash-identified, a complementary matching capability — filtering on the `integrity` hash itself rather than only the eventual request URL — would let extensions block a specific known resource (say, a fingerprinting script) independent of whatever URL a page happens to reference it by. This could be a new `RuleCondition` field (e.g. `hashFilter`), separate from `urlFilter`.
- A new `ResourceType` value (e.g. `"cross-origin-storage"`) likely isn't necessary, since a COS lookup is always triggered by an existing request (a `<script>`, `<link>`, `import`, or `requestFileHandle()` call) that already carries a resource type. What needs confirming is whether DNR's request pipeline actually observes that request at the point it's about to be short-circuited by a COS hit, rather than only seeing requests that miss COS and fall through to the network.

### Open questions

- Does a COS hit currently generate any request DNR's pipeline can see at all, or would this need a new hook so DNR isn't blind to COS-served loads?
- Should blocking a COS-resolved resource be observably different from blocking a network-resolved one — e.g. could timing reveal "this would have been served from COS" even when blocked?
- Is hash-based blocking (`hashFilter`) worth adding as a first-class DNR concept, or is blocking by the referencing URL sufficient in practice, given most COS consumers will still declare a URL alongside the hash (as in the `crossoriginstorage` attribute proposal)?

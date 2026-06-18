# [Self-Review Questionnaire: Security and Privacy](https://w3ctag.github.io/security-questionnaire/)

## 01. What information does this feature expose, and for what purposes?

The COS API exposes the availability of files identified by their hash across different origins. The purpose is to enable efficient sharing of common files (for example, AI models, highly popular JavaScript libraries, Wasm modules, and large web fonts) to reduce redundant downloads and storage.

## 02. Do features in your specification expose the minimum amount of information necessary to implement the intended functionality?

Yes, the API exposes only the existence of a file with a known hash and provides read access to it. By default, exposure is limited to Same-Site contexts. No additional metadata is exposed. Write access is always granted, analogously to how pages may freely store data until their quota is exhausted in mechanisms such as the Origin Private File System, IndexedDB, or the Cache API. The optional `origins` field allows developers to further minimize exposure by restricting resource access to a trusted set of origins. Global sharing of resources is strictly an opt-in operation. User agents that disallow third-party cookies by default are expected not to expose the COS API.

## 03. Do the features in your specification expose personal information, personally-identifiable information (PII), or information derived from either?

Possibly. If a COS file is only used on a couple of websites, a site can discover that the user visited those sites by checking for the file's presence. The attacker site would need to probe hashes of resources it's interested in by calling `requestFileHandle()` for each hash; each such call can be considered a probe. User agents may return a false negative for any probe. One such attack could be checking for the presence of a specific niche JavaScript library only used on certain sites. The `origins` field specifically addresses this by allowing resources to be hidden from any origin not explicitly listed by the storer, reducing the attack surface.

As a further mitigation, user agents are expected to implement an availability gating mechanism. Resources on an allowlist of well-known, widely-used assets (for example, popular AI model weights from recognized model hubs) are unconditionally eligible for cross-origin disclosure. For all other resources, user agents should only confirm a file's presence once it has been observed on a minimum number of distinct origins, ensuring that resources unique to a small number of sites are not disclosed. When a resource does not meet this threshold, the user agent returns a `NotFoundError` `DOMException` regardless of whether the file is present in COS, making the COS storage state indistinguishable from absence.

User agents may additionally apply **GREASE'ing** ([Generate Random Extensions And Sustain Extensibility](https://tools.ietf.org/html/draft-ietf-tls-grease)): occasionally returning a `NotFoundError` `DOMException` even when a file passes the availability gating check, introducing noise that makes probing unreliable. This technique is used similarly in [UA Client Hints](https://wicg.github.io/ua-client-hints/#grease). User agents must not GREASE responses for very large files (such as gigabyte-scale AI model weights) where a spurious false negative would force the caller to perform a full re-download, imposing a significant bandwidth cost on the user.

## 04. How do the features in your specification deal with sensitive information?

The API does not allow arbitrary file discovery.

## 05. Does data exposed by your specification carry related but distinct information that may not be obvious to users?

No.

## 06. Do the features in your specification introduce state that persists across browsing sessions?

Yes. Files stored in COS persist across sessions. User agents may manage eviction policies to maintain control over this state and offer manual management options.

## 07. Do the features in your specification expose information about the underlying platform to origins?

No.

## 08. Does this specification allow an origin to send data to the underlying platform?

No.

## 09. Do features in this specification enable access to device sensors?

No.

## 10. Do features in this specification enable new script execution/loading mechanisms?

No.

## 11. Do features in this specification allow an origin to access other devices?

No.

## 12. Do features in this specification allow an origin some measure of control over a user agent's native UI?

No.

## 13. What temporary identifiers do the features in this specification create or expose to the web?

None.

## 14. How does this specification distinguish between behavior in first-party and third-party contexts?

By default, the COS API is only available in Same-Site contexts. This means that a site can only access files in COS that were stored by itself or by other same-site origins. The optional `origins` field controls access by restricting it to specific trusted origins or expanding it to all origins, providing an additional layer of control over third-party access. Global sharing of resources is strictly an opt-in operation, and user agents that disallow third-party cookies by default are expected not to expose the COS API at all.

Additionally, the availability gating mechanism ensures that even cross-origin reads for globally available resources are subject to a popularity threshold: a resource that is unique to, or concentrated among, only a few origins will not be disclosed to third-party requestors, further reducing the risk of cross-site state inference in third-party contexts.

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

N/A

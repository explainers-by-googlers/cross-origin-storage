# [Self-Review Questionnaire: Security and Privacy](https://w3ctag.github.io/security-questionnaire/)

## 01. What information does this feature expose, and for what purposes?

The COS API exposes the availability of files identified by their SHA-256 hash across different origins. The purpose is to enable efficient sharing of large files (e.g., AI models, SQLite databases, Wasm modules) to reduce redundant downloads and storage.

## 02. Do features in your specification expose the minimum amount of information necessary to implement the intended functionality?

Yes, the API exposes only the existence of a file and provides access to it after explicit user consent. No additional metadata or file contents are exposed.

## 03. Do the features in your specification expose personal information, personally-identifiable information (PII), or information derived from either?

No.

## 04. How do the features in your specification deal with sensitive information?

Files can only be accessed with explicit user consent. The API does not allow arbitrary file discovery or sharing of sensitive user data without permission.

## 05. Does data exposed by your specification carry related but distinct information that may not be obvious to users?

No.

## 06. Do the features in your specification introduce state that persists across browsing sessions?

Yes. Files stored in COS persist across sessions. However, their access is gated by user consent, and user agents can manage eviction policies to maintain control over this state.

## 07. Do the features in your specification expose information about the underlying platform to origins?

No.

## 08. Does this specification allow an origin to send data to the underlying platform?

No. The API strictly enables storage and retrieval of files identified by hashes without direct interaction with the underlying platform.

## 09. Do features in this specification enable access to device sensors?

No.

## 10. Do features in this specification enable new script execution/loading mechanisms?

No.

## 11. Do features in this specification allow an origin to access other devices?

No.

## 12. Do features in this specification allow an origin some measure of control over a user agent's native UI?

No. The user agent remains in full control, particularly for displaying permission prompts.

## 13. What temporary identifiers do the features in this specification create or expose to the web?

None. File access is based solely on static hashes, which are not session-specific identifiers.

## 14. How does this specification distinguish between behavior in first-party and third-party contexts?

The permission model ensures that file access is user-controlled, regardless of the context. Explicit user consent is required for cross-origin access.

## 15. How do the features in this specification work in the context of a browser’s Private Browsing or Incognito mode?

Files stored in COS are not accessible in Private Browsing or Incognito mode unless explicitly allowed by the user agent. Data stored during such sessions is not retained.

## 16. Does this specification have both "Security Considerations" and "Privacy Considerations" sections?

Yes. The specification includes detailed sections addressing security and privacy implications, including hashing, user consent, and eviction policies.

## 17. Do features in your specification enable origins to downgrade default security protections?

No. The API requires explicit user consent for all access, ensuring that default security protections remain intact.

## 18. What happens when a document that uses your feature is kept alive in BFCache?

The BFCache behavior should be aligned with user agent policies. File access requests may trigger re-validation if necessary.

## 19. What happens when a document that uses your feature gets disconnected?

The file access operation will terminate, and any pending storage or retrieval will fail gracefully with appropriate errors.

## 20. Does your spec define when and how new kinds of errors should be raised?

Yes. The specification defines specific errors such as `NotAllowedError` (for denied permissions) and `NotFoundError` (for unavailable files).

## 21. Does your feature allow sites to learn about the user's use of assistive technology?

No.

## 22. What should this questionnaire have asked?

It could include a question about whether the API promotes transparency in user-facing permission prompts to enhance user understanding of the implications of granting access.
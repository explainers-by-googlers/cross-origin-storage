## Manual PHL addition

<!--
  Use this template when proposing a new entry for manual-additions.json.
  For code changes (scraper fixes, infrastructure, etc.) delete this template
  and describe your change freely.

  Inclusion criteria: the resource must be so widely deployed across
  independent sites that its presence in a shared cache reveals nothing
  specific about a user's browsing history.
-->

### Resource

**Description:** <!-- What is this resource? (e.g. "jQuery 3.7.1 minified, served from cdnjs") -->

**URL:**
```
https://
```

**SHA-256:**
```
<64-char lowercase hex>
```

### Rationale

<!--
  Why does this resource meet the ubiquity bar?
  Concrete signals help: estimated embedding count, CDN hit statistics,
  references in well-known open-source projects, etc.
-->

### Independent verification

Anyone reviewing this PR can verify the hash:

```bash
# Linux / WSL
curl -sL <url> | sha256sum

# macOS
curl -sL <url> | shasum -a 256
```

Expected output: `<sha256>  -`

### Checklist

- [ ] The resource is publicly accessible without login or paywall
- [ ] The SHA-256 above matches the **current** bytes at the URL (verified with the command above)
- [ ] The `manual-additions.json` entry is valid JSON and follows the existing schema (`url`, `sha256`, `description`, `rationale`, `added`, `pr`)
- [ ] The `pr` field is set to `null` (the merge bot will update it after this PR lands, or you can fill it in yourself once you know the PR number)
- [ ] The resource meets the ubiquity criteria described in the README

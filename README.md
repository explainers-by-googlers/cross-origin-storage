# Explainer for the Cross-Origin Storage (COS) API

<img src="https://raw.githubusercontent.com/WICG/cross-origin-storage/refs/heads/main/logo-cos.svg" alt="Cross-Origin Storage (COS) logo, consisting of a folder icon with a crossing person." width="100">

This proposal outlines the design of the **Cross-Origin Storage (COS)** API, a **content-addressable cache** that allows web applications to store and retrieve files across different origins. Building on the **File System Living Standard** defined by the WHATWG, the COS API facilitates secure cross-origin file storage and retrieval for large assets, such as AI models, WebAssembly (Wasm) modules, and highly popular JavaScript libraries. Taking inspiration from **Cache Digests for HTTP/2**, the API identifies files by their content hashes rather than by URL, making it a true content-addressable storage system.

> [!TIP]
> **Try the proposed API with an extension**
>
> While this API is not yet natively implemented in browsers, you can experiment with the proposed surface today.
> Install the [Cross-Origin Storage extension](https://chromewebstore.google.com/detail/cross-origin-storage/denpnpcgjgikjpoglpjefakmdcbmlgih) to inject the `navigator.crossOriginStorage` polyfill on all pages and test the complete flow. See the [source code of the extension](https://github.com/web-ai-community/cross-origin-storage-extension) and read the [instructions](https://github.com/web-ai-community/cross-origin-storage-extension?tab=readme-ov-file#usage) for how to test it.

> [!TIP]
> **Test with your Vite project**
>
> If you are building with Vite, you can experiment with COS integration using the experimental [vite-plugin-cross-origin-storage](https://github.com/tomayac/vite-plugin-cross-origin-storage) plugin. Install it with `npm install vite-plugin-cross-origin-storage --save-dev` and add it to your `vite.config.ts`. The plugin automatically rewrites static imports to load vendor chunks and other assets from COS, stores newly fetched assets in COS for future use, and falls back gracefully to standard network requests when COS is unavailable or the asset is not yet cached.

## Authors

- [Thomas Steiner](mailto:tomac@google.com), Google Chrome
- [Christian Liebel](mailto:christian@liebel.org), Thinktecture AG
- [François Beaufort](mailto:fbeaufort@google.com), Google Chrome

## Participate

- [Spec](https://wicg.github.io/cross-origin-storage/) ([source](index.bs))
- [Public Hash List explainer](public-hash-list/phl-explainer.md)
- [Issues](https://github.com/WICG/cross-origin-storage/issues)
- [PRs](https://github.com/WICG/cross-origin-storage/pulls)
- Support this proposal: https://github.com/WICG/cross-origin-storage/labels/expression%20of%20support

The **Cross-Origin Storage (COS)** API provides a secure, **content-addressable cache** for web applications to store and retrieve large files across different origins. This allows applications to share common assets—such as AI models, Wasm modules, and popular JavaScript libraries—without redundant downloads. Resources are identified by their cryptographic hashes rather than by URL, which is what makes the cache content-addressable: the same bytes at two different URLs are a single cache entry, and the hash guarantees integrity. The API reuses concepts like `FileSystemFileHandle` from the **File System Living Standard**, specifically tailored for cross-origin scenarios. The following example demonstrates the basic flow for retrieving a file:

```js
// The hash of the desired file.
const hash = {
  algorithm: 'SHA-256',
  value: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
};
try {
  const handle = await navigator.crossOriginStorage.requestFileHandle(hash);
  // The file exists in Cross-Origin Storage.
  const fileBlob = await handle.getFile();
  // Do something with the blob.
} catch (err) {
  if (err.name === 'NotAllowedError') {
    // Permissions Policy blocks COS in this context.
    console.log('Cross-Origin Storage is blocked by Permissions Policy.');
  } else if (err.name === 'NotFoundError') {
    console.log('The file was not found in Cross-Origin Storage.');
  }
  return;
}
```

## Risk awareness

> [!CAUTION]
> The authors acknowledge that storage is usually isolated by origin to safeguard user security and privacy. Storing large resources such as AI models separately for each origin, as required by new [use cases](#use-cases), presents a significant scalability and efficiency challenge. For instance, if both `example.com` and `example.org` each require the same 8&nbsp;GB AI model, this would result in 16&nbsp;GB of downloaded data and a total allocation of 16&nbsp;GB on the user's device. This proposal introduces mechanisms that uphold protection standards while addressing the inefficiencies of duplicated downloads and storage.

## Goals

COS aims to:

- Provide a cross-origin storage mechanism for web applications to store and retrieve large files such as AI models, Wasm modules, and highly popular JavaScript libraries.
- Guarantee data integrity and consistency for file identification (see [Appendix&nbsp;B](#appendixb-blob-hash-with-the-web-crypto-api)).
- Make the web more sustainable and ethical by reducing redundant downloads of large resources the user agent may already have stored locally.

## Non-goals

COS does _not_ aim to:

- Replace existing storage solutions such as the **Origin Private File System**, the **Cache API**, **IndexedDB**, or **Web Storage**.
- Replace content delivery networks (CDNs).
- Allow cross-origin file access _without_ the possibility for the user agent to intervene.
- Modify or supersede the same-origin policy.

## User research

Feedback from developers working with large AI models, Wasm modules, and highly popular JavaScript libraries has highlighted the need for an efficient way to store and retrieve such large files across web applications on different origins. These developers are looking for a standardized solution that allows files to be stored once and accessed by multiple applications, without needing to download and store the files redundantly. COS ensures this is possible while maintaining privacy and security.

### User needs example: Hugging Face

[Joshua Lochner](https://huggingface.co/Xenova) (aka. Xenova) from Hugging Face had the following to say in his [talk at the 2024 Chrome Web AI Summit](https://youtu.be/n18Lrbo8VU8?t=1040):

> _"One can imagine a browser-based web store for models similar to the Chrome Web Store for extensions. From the user's perspective, they could search for web-compatible models on the Hugging Face hub, install it with a single click, and then access it across multiple domains. Currently, Transformers.js is limited in this regard, since models are cached on a per site or per extension basis."_

### User needs example: Web Machine Learning Working Group

Participants of the Web Machine Learning Working Group at the W3C in their meeting on September 21, 2023, discussed [Storage APIs for caching large models](https://www.w3.org/2023/09/21-webmachinelearning-minutes.html#t03). A proposal named [Hybrid AI Explorations](https://github.com/webmachinelearning/proposals/issues/5) listed the following open issues:

> _"If the model runs on the client, large models need to be downloaded, possibly multiple times in different contexts. This incurs a startup latency."_
>
> _"Models are large and can consume significant storage on the client, which needs to be managed."_

This led to the creation of a dedicated [Hybrid AI explainer](https://github.com/webmachinelearning/hybrid-ai/blob/main/explainer.md), which in its introduction states:

> _"For example, ML models are large. This creates network cost, transfer time, and storage problems. As mentioned, client capabilities can vary. This creates adaptation, partitioning, and versioning problems. We would like to discuss potential solutions to these problems, such as shared caches, progressive model updates, and capability/requirements negotiation."_

### User needs example: Mozilla

In their [standards position](https://github.com/mozilla/standards-positions/issues/1067#issuecomment-2631718109) on the [Writing Assistance APIs](https://github.com/webmachinelearning/writing-assistance-apis/tree/main), Mozilla engineer [Brian Grinstead](https://github.com/bgrins) wrote:

> _"We acknowledge a downside with this approach related to lack of shared client storage for model weights — it would be a better experience if the browser only had to download large weights one time. We don’t know of a privacy-preserving way to do this, short of high level APIs like these which abstract away the details of inference."_

## Use cases

### Use case 1: Large AI models

Developers working with large AI models can store these models once and access them across multiple web applications. By using the COS API, models can be stored and retrieved based on their hashes, minimizing repeated downloads and storage, ensuring file integrity. An example is Google's [Gemma 2](https://huggingface.co/google/gemma-2-2b/tree/main) model [`g-2b-it-gpu-int4.bin`](https://storage.googleapis.com/jmstore/kaggleweb/grader/g-2b-it-gpu-int4.bin) (1.35&nbsp;GB). Another example is Google's [Gemma 1.1 7B](https://huggingface.co/google/gemma-1.1-7b-it) model `gemma-1.1-7b-it` (8.60&nbsp;GB), which can be [run in the browser](https://research.google/blog/unlocking-7b-language-models-in-your-browser-a-deep-dive-with-google-ai-edges-mediapipe/). Yet another example is the [`Llama-3.1-70B-Instruct-q3f16_1-MLC`](https://huggingface.co/mlc-ai/Llama-3.1-70B-Instruct-q3f16_1-MLC/tree/main) model (33&nbsp;GB), which [likewise runs in the browser](https://chat.webllm.ai/) (choose the "Llama 3.1 70B Instruct" model in the picker).

### Use case 2: Large Wasm modules

Web applications that utilize large Wasm modules can store these modules using COS and access them across different origins. This enables efficient sharing of files between applications, reducing redundant downloading and improving performance. A notable example is Google's Flutter framework, which uses several Wasm files that are requested millions of times daily across thousands of hosts:

| Request (`https://gstatic.com/flutter-canvaskit/`)                                                                                                                           | Size   | Hosts | Requests |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----- | -------- |
| [`36335019a8eab588c3c2ea783c618d90505be233/chromium/canvaskit.wasm`](https://gstatic.com/flutter-canvaskit/36335019a8eab588c3c2ea783c618d90505be233/chromium/canvaskit.wasm) | 5.1 MB | 1,938 | 596,900  |
| [`a18df97ca57a249df5d8d68cd0820600223ce262/chromium/canvaskit.wasm`](https://gstatic.com/flutter-canvaskit/a18df97ca57a249df5d8d68cd0820600223ce262/chromium/canvaskit.wasm) | 5.1 MB | 1,586 | 579,380  |
| [`36335019a8eab588c3c2ea783c618d90505be233/canvaskit.wasm`](https://gstatic.com/flutter-canvaskit/36335019a8eab588c3c2ea783c618d90505be233/canvaskit.wasm)                   | 6.4 MB | 1,142 | 597,240  |
| [`a18df97ca57a249df5d8d68cd0820600223ce262/canvaskit.wasm`](https://gstatic.com/flutter-canvaskit/a18df97ca57a249df5d8d68cd0820600223ce262/canvaskit.wasm)                   | 6.4 MB | 1,014 | 288,800  |

(**Source:** Google-internal data from the Flutter team: "Flutter engine assets by unique hosts - one day - Dec 10, 2024".)

### Use case 3: Highly popular JavaScript libraries and frameworks

Traditionally, bundlers have combined vendor code and user code, leading to low cache hit rates even _before_ the regular HTTP cache was isolated. By bundling vendor code separately and in its entirety (for example, the complete React library) instead of using dead-code elimination, developers can ensure a higher cache hit rate. Storing such files once with the COS API allows multiple web apps to share the same highly popular libraries.

### Use case 4: Game engines

Web games built with game engines that have browser support such as [Godot](https://godotengine.org/) or [Unity](https://unity.com/) can store the core game engine code in COS and only load game-specific assets such as textures and game logic from the network. Web gaming portals such as [WebGamer](https://webgamer.io/) that host plenty of casual games with a short path to gameplay on different cross-origin iframes can benefit greatly from this.

### Use case 5: Large web fonts

Web fonts—especially large icon fonts, emoji fonts, and fonts with extensive Unicode coverage—are downloaded across an enormous number of pages daily. Popular fonts served by services like [Google Fonts](https://fonts.google.com/) (for example, [Noto Color Emoji](https://fonts.google.com/noto/specimen/Noto+Color+Emoji) or [Material Symbols](https://fonts.google.com/icons)) are requested by thousands of different sites. If these fonts were stored once in COS, any site using the same font could retrieve it locally instead of downloading it from a CDN on every visit, benefiting both performance and sustainability.

## Potential solution

### File Storage Process

The **COS** API will be available through the `navigator.crossOriginStorage` interface. Files will be stored and retrieved based on their hashes, ensuring that each file is uniquely identified.

#### COS entry

Each resource stored in COS is conceptually represented as an entry with the following fields:

- **`hash`**: the content identifier, consisting of an `algorithm` (a string naming a hash algorithm recognized by the [Web Crypto API](https://w3c.github.io/webcrypto/), e.g. `"SHA-256"`) and a `value` (a 64-character lowercase hex string). Entries are keyed by hash: two files with identical bytes and the same hash algorithm are the same entry, regardless of how many origins stored them or from how many URLs they were fetched.
- **`bytes`**: the raw file contents. The user agent verifies at write time that hashing `bytes` with `hash.algorithm` produces `hash.value`; a mismatch throws a `DataError`.
- **`origins`**: the declared sharing scope, initially set by the first writer and upgradeable but never downgradeable. One of: `'*'` (any origin), a list of origin strings (only those origins), or absent (same-site origins only). A list of origin strings has an implementation-defined maximum length, so it can't be used as an undeclared substitute for `'*'` (see [Storing files](#storing-files) and [Cross-site probing](#cross-site-probing)). See [Resource visibility upgrades](#resource-visibility-upgrades).
- **`storing origins`**: the set of origins that have successfully written this entry. An origin in `storing origins` may always retrieve the entry via `requestFileHandle()`, regardless of the `origins` field value or whether the hash is on the PHL.

`storing origins` is persisted across page loads and grows each time a new origin successfully writes the entry; it is never shrunk. If origin A writes a file restricted to `['https://a.example']` and origin B later writes the same hash with `origins: '*'`, both A and B are in `storing origins` and the `origins` field upgrades to `'*'`. Each writer must supply the full file bytes regardless of whether the entry already exists, which prevents any origin from using a write operation to detect prior presence.

#### Storing files

1. Hash the contents of the file using SHA-256 (or an equivalent secure algorithm, see [Appendix&nbsp;B](#appendixb-blob-hash-with-the-web-crypto-api)). The hash algorithm used is communicated as a string naming a hash algorithm recognized by the [Web Crypto API](https://w3c.github.io/webcrypto/).
1. Request a `FileSystemFileHandle` object for the file, specifying the file's hash.
1. Write the file's data to the `FileSystemFileHandle` object and store it in Cross-Origin Storage. Data can be written with one or more `write()` calls, or streamed in with `sourceStream.pipeTo(writableStream)` — which, by default, closes `writableStream` automatically once `sourceStream` is exhausted, unless called with `preventClose: true` (see [Streaming a file into COS while using it](#example-streaming-a-file-into-cos-while-using-it) for the recommended pattern on large resources). Whenever the stream closes, whether via an explicit `writableStream.close()` call or implicitly through `pipeTo()`, the user agent must verify that the hash of the complete written bytes matches the declared hash, using the algorithm specified in `hash.algorithm`. If the hashes do not match, the user agent must reject the closing operation's promise with a `DataError` `DOMException` and must not store the data in COS.

> [!NOTE]
> A hash-mismatched write does not leave a stuck placeholder behind. Once no other write for that same hash is still in progress, the user agent removes the entry entirely, so a subsequent `requestFileHandle()` call for that hash behaves exactly as if it had never been requested (`NotFoundError`), rather than being stuck returning `NotAllowedError` forever. This never applies to a hash some origin has already successfully written before: that entry is never removed by a later, unrelated write's failure, no matter how many times it's attempted. See [Concurrent writes](#concurrent-writes).

> [!NOTE]
> If `hash.value` is not a valid lowercase hexadecimal string of length 64, or `hash.algorithm` is not a hash algorithm name recognized by the [Web Crypto API](https://w3c.github.io/webcrypto/), the user agent must throw a `TypeError`.

> [!NOTE]
> If the [Permissions Policy](https://www.w3.org/TR/permissions-policy/) for the current context does not allow Cross-Origin Storage, the user agent must throw a `NotAllowedError` `DOMException` before attempting any write.

> [!NOTE]
> If `origins` is a list longer than an implementation-defined maximum length, the user agent must throw a `TypeError` before attempting any write. This limit exists so that a list of origins can't be used to approximate `origins: '*'` without going through its explicit opt-in; see [Cross-site probing](#cross-site-probing).

> [!NOTE]
> If storing the file would cause the requesting origin to exceed its implementation-defined storage limit, the user agent must reject the closing operation's promise with a `QuotaExceededError` `DOMException` and should log a warning to the console. Each origin can only store a limited amount of data in COS, which prevents any one site from flooding the cache in an attempt to evict other sites' resources; see [Cache flooding](#cache-flooding).

##### Example: Storing a single file

```js
/**
 * Example usage to store a single file.
 */

// The hash of the desired file.
const hash = {
  algorithm: 'SHA-256',
  value: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
};

// First, check if the file is already in COS.
try {
  const handle = await navigator.crossOriginStorage.requestFileHandle(hash);
  // The file exists in COS.
  const fileBlob = await handle.getFile();
  // Do something with the blob.
  console.log('Retrieved', fileBlob);
  return;
} catch (err) {
  // If the file wasn't in COS, load it from the network and store it in COS.
  if (err.name === 'NotFoundError') {
    // Load the file from the network.
    const fileBlob = await loadFileFromNetwork();
    try {
      const handle = await navigator.crossOriginStorage.requestFileHandle(
        hash,
        {
          create: true,
          // Optional: Only allow these origins to read the file.
          origins: ['https://example.com', 'https://example.org'],
        },
      );
      const writableStream = await handle.createWritable();
      await writableStream.write(fileBlob);
      await writableStream.close();
    } catch (err) {
      // The `write()` failed.
    }
    return;
  }
  // 'NotAllowedError': Permissions Policy blocks COS in this context.
  console.log('Cross-Origin Storage is blocked by Permissions Policy.');
}
```

##### Example: Streaming a file into COS while using it

The example above waits for the whole file to arrive before writing it, which is fine for small resources but throws away the download/consume overlap that streaming APIs such as `WebAssembly.instantiateStreaming()` provide. For large resources, the recommended pattern on a cache miss is to `tee()` the network response body: one branch is consumed immediately, the other is piped into COS in the background. Because `pipeTo()` closes the writable stream when the source is exhausted, and the user agent verifies the hash on close, no explicit `write()` or `close()` call is needed. On a cache hit, `File.stream()` gives the same streaming shape from the stored bytes.

```js
/**
 * Example usage to stream a Wasm module into COS while compiling it.
 */

const hash = {
  algorithm: 'SHA-256',
  value: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
};
const wasmHeaders = { headers: { 'Content-Type': 'application/wasm' } };

try {
  // Cache hit: stream from the stored file. The bytes were hash-verified when
  // they were written, so a fixed MIME type is safe.
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
    // Closes `writableStream` on completion; rejects with a `DataError` if the
    // bytes don't match `hash`.
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

The same shape works for any consumer that accepts a `ReadableStream`, for example a model loader that parses safetensors headers as bytes arrive, or `new Response(stream).blob()` if the consumer ultimately needs a `Blob`. Note that a `tee()`'d stream buffers whatever the slower branch has not yet read, so a store branch that never consumes must be cancelled, as shown above.

> [!NOTE]
> This is the amount of code the pattern costs when written by hand. Where the resource is a plain URL-plus-hash fetch, as it is here, the [fetch integration](#fetch-integration) collapses the entire example into a single `fetch()` call and leaves the stream splitting to the user agent.

##### Example: Restricting resources to specific origins

The `origins` field is useful for sharing resources between a set of related origins without making them globally available. **This option is recommended for proprietary resources or resources for which global COS cache hits are not anticipated.** For example, if a company has two related sites, `write.example.com` and `calculate.example.com`, that both use the same AI model for proofreading, they can store the model in COS and restrict access to just these two origins. This way, the model is not globally available to all sites that use COS, but only to the two related sites that need it.

```js
// The hash of an AI model for proofreading.
const hash = {
  algorithm: 'SHA-256',
  value: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
};

// Site `write.example.com` stores the model and restricts it to itself and
// `calculate.example.com`.
const handle = await navigator.crossOriginStorage.requestFileHandle(hash, {
  create: true,
  origins: ['https://calculate.example.com', 'https://write.example.com'],
});

// Write the file…

// Now, `calculate.example.com` can request the same hash and it will be found.
// Any other origin NOT in the list (e.g., `https://unrelated.com`) will receive
// a `NotFoundError` when requesting this hash, even if it's stored in COS.
```

##### Example: Making a resource globally available

By specifying `origins: '*'` when storing a file, the file becomes globally available to all origins that use COS. **This option is appropriate for widely used resources that many sites are likely to share, such as popular AI models, Wasm modules, or JavaScript libraries.** This is an explicit opt-in to avoid developers accidentally making resources globally available, which could lead to cross-site leaks.

```js
// The hash of a very common AI model.
const hash = {
  algorithm: 'SHA-256',
  value: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
};

const handle = await navigator.crossOriginStorage.requestFileHandle(hash, {
  create: true,
  origins: '*',
});

// Write the file…

// Now, any origin can request the same hash and it will be found.
```

##### Example: Making a resource available to Same-Site origins only

By omitting the `origins` option altogether when storing a file, the file becomes available only to Same-Site origins that use COS. This is a good option for resources that are expected to be shared across multiple subdomains of the same site, but not across completely unrelated sites.

```js
// The hash of a company's proprietary AI model.
const hash = {
  algorithm: 'SHA-256',
  value: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
};

const handle = await navigator.crossOriginStorage.requestFileHandle(hash, {
  create: true,
});

// Write the file…

// Now, any Same-Site origin can request the same hash and it will be found.
```

##### Example: Storing multiple files

To store or retrieve multiple files, call `requestFileHandle()` once per file and combine with `Promise.all()` for concurrent requests:

```js
/**
 * Example usage to store multiple files.
 */

// The hashes of the desired files.
const hashes = [
  {
    algorithm: 'SHA-256',
    value: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
  },
  {
    algorithm: 'SHA-256',
    value: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  },
];

// First, check if the files are already in COS.
try {
  const handles = await Promise.all(
    hashes.map((hash) =>
      navigator.crossOriginStorage.requestFileHandle(hash)
    )
  );
  // All files found in COS.
  for (const handle of handles) {
    const fileBlob = await handle.getFile();
    // Do something with the blob.
    console.log('Retrieved', fileBlob);
  }
  return;
} catch (err) {
  // At least one file wasn't found — fetch all from the network and store them.
  if (err.name === 'NotFoundError') {
    try {
      const fileBlobs = await loadFilesFromNetwork();
      const handles = await Promise.all(
        hashes.map((hash) =>
          navigator.crossOriginStorage.requestFileHandle(hash, { create: true })
        )
      );
      for (let i = 0; i < handles.length; i++) {
        const writableStream = await handles[i].createWritable();
        await writableStream.write(fileBlobs[i]);
        await writableStream.close();
      }
    } catch (err) {
      // The `write()` failed.
    }
    return;
  }
  // 'NotAllowedError': Permissions Policy blocks COS in this context.
  console.log('Cross-Origin Storage is blocked by Permissions Policy.');
}
```

#### Resource visibility upgrades

The visibility of a resource in COS can be upgraded but never downgraded:

- **Restricted to more permissive**: If a resource was initially stored with an `origins` list, any site (including the original storer or a completely different site) can later call `requestFileHandle()` for the same hash with `create: true` and change the `origins` field to a more permissive value. If the user agent verifies the hash matches, the resource is then marked as available according to the new `origins` value. The new site _must still_ write the full file using the returned `FileSystemFileHandle` object, to prevent sites from using this behavior to detect whether a file was previously stored.
- **Permissive to more restricted**: If a resource is already permissively available in COS, any attempt to store it again with a more restrictive `origins` list is ignored. The resource remains globally available, and the user agent should log a warning to the console to inform the developer that the restriction was not applied.
- **Origins list capacity**: The same implementation-defined maximum length that bounds a single write's `origins` list (see [Storing files](#storing-files)) also bounds the *merged* list when a newly requested `origins` list is added to an entry that already has one. This can only be reached by the cumulative effect of separate writes by different, possibly unrelated, sites over time, since any single write's own list is already capped. When it is reached, the write still succeeds — the bytes were already verified and stored — but the origins beyond capacity are silently dropped from the merge, and the user agent should log a console warning. Because a `NotFoundError` can't be distinguished from other gating outcomes (see [Availability gating](#availability-gating)), a site cannot reliably confirm after the fact whether its requested origin actually made it into the merge.
- **Original storer access**: An origin that stores a resource in COS can always read it back via `requestFileHandle()`, regardless of the `origins` value set at write time or whether the hash is on the PHL. This mirrors the Cache API's model where an origin always has access to what it stored.

#### Retrieving files

1. Request a `FileSystemFileHandle` object for the file, specifying the file's hash.
1. Check if the resource exists in COS and make sure it can be shared without causing privacy issues.
1. Retrieve the `FileSystemFileHandle` object after the user agent has granted access.

> [!NOTE]
> A `NotFoundError` `DOMException` does not necessarily mean the file is absent from COS. User agents may suppress availability of a file for privacy reasons (see [Availability gating](#availability-gating)), or because the calling origin is over its [cross-origin probe budget](#cross-site-identifier-construction). Callers should handle `NotFoundError` by falling back to a network fetch, regardless of the cause.

##### Example: Retrieving a single file

```js
/**
 * Example usage to retrieve a single file.
 */

// The hash of the desired file.
const hash = {
  algorithm: 'SHA-256',
  value: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
};

try {
  const handle = await navigator.crossOriginStorage.requestFileHandle(hash);
  // The file exists in COS.
  const fileBlob = await handle.getFile();
  console.log('Retrieved file', fileBlob);
  // Do something with the blob.
} catch (err) {
  if (err.name === 'NotFoundError') {
    // Load the file from the network.
    const fileBlob = await loadFileFromNetwork();
    // Return the file as a Blob.
    console.log('Obtained file from network', fileBlob);
    return;
  }
  // 'NotAllowedError': Permissions Policy blocks COS in this context.
  console.log('Cross-Origin Storage is blocked by Permissions Policy.');
}
```

##### Example: Retrieving multiple files

As with storing, use `Promise.all()` to retrieve multiple files concurrently:

```js
/**
 * Example usage to retrieve multiple files.
 */

// The hashes of the desired files.
const hashes = [
  {
    algorithm: 'SHA-256',
    value: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
  },
  {
    algorithm: 'SHA-256',
    value: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  },
];

try {
  const handles = await Promise.all(
    hashes.map((hash) =>
      navigator.crossOriginStorage.requestFileHandle(hash)
    )
  );
  // All files found in COS.
  for (const handle of handles) {
    const fileBlob = await handle.getFile();
    // Do something with the blob.
    console.log('Retrieved file', fileBlob);
  }
} catch (err) {
  if (err.name === 'NotFoundError') {
    // Load the files from the network.
    const fileBlobs = await loadFilesFromNetwork();
    // Do something with the blobs.
    console.log('Obtained files from network', fileBlobs);
    return;
  }
  // 'NotAllowedError': Permissions Policy blocks COS in this context.
  console.log('Cross-Origin Storage is blocked by Permissions Policy.');
}
```

##### Example: Choosing among interchangeable resources

The example above assumes the caller needs every file it asks for. A second pattern inverts this: the hashes are *alternatives*, and the caller wants whichever one the user already has. This is the everyday situation for AI models, which are published as families of interchangeable variants that differ in size and quality but expose the same interface. An app may be built around `whisper-tiny` because that is the smallest download it can justify, but it would rather transcribe with `whisper-large-v3` if the user already downloaded that one on some other site. Downloading the small model while a better one already sits on the device is the worst of both worlds: the user pays for bytes and gets worse transcriptions.

Expressing this means asking COS a question before committing to any download: *which of these do you already have?*

```js
/**
 * Example usage to pick the best locally available variant of a model.
 */

// Candidates, most capable first.
const candidates = [
  {
    name: 'whisper-large-v3',
    hash: {
      algorithm: 'SHA-256',
      value:
        '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
    },
  },
  {
    name: 'whisper-medium',
    hash: {
      algorithm: 'SHA-256',
      value:
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    },
  },
  {
    name: 'whisper-tiny',
    hash: {
      algorithm: 'SHA-256',
      value:
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
  },
];

for (const candidate of candidates) {
  try {
    const handle = await navigator.crossOriginStorage.requestFileHandle(
      candidate.hash
    );
    // Found one, so nothing needs to be downloaded at all.
    console.log('Using locally available model', candidate.name);
    return { name: candidate.name, file: await handle.getFile() };
  } catch (err) {
    if (err.name !== 'NotFoundError') {
      // 'NotAllowedError': Permissions Policy blocks COS in this context.
      throw err;
    }
    // Not available, so try the next candidate.
  }
}

// None of them is available, so fall back to downloading the smallest variant
// that satisfies the app's requirements.
const fallback = candidates.at(-1);
const fileBlob = await loadFileFromNetwork(fallback.name);
console.log('Obtained model from network', fallback.name);
```

Every step of this is a read with no URL attached. The app has no download URL to offer for `whisper-large-v3`, since it never intended to fetch that variant, and the whole point of asking is to avoid a network request rather than to condition one. A [fetch integration](#fetch-integration) cannot express this, which is one of the reasons it complements the imperative API instead of replacing it (see [Replacing the imperative API with a `fetch()` integration](#replacing-the-imperative-api-with-a-fetch-integration)).

> [!NOTE]
> Each `requestFileHandle()` call counts as a probe against the user agent's [cross-site probing](#cross-site-probing) safeguards, so candidate lists are expected to be short, in the order of the handful of variants a model family actually ships. A `NotFoundError` for a candidate may also be [availability gating](#availability-gating) rather than a genuine absence, which is why the loop must end in a real network fallback rather than in an assumption that nothing is cached.

#### Transferring a handle

A `FileSystemFileHandle` is serializable, so a handle for a COS entry can be passed to another context with `postMessage()`, a `MessagePort`, or a `BroadcastChannel`, the same way any other file handle can. This is a second way to obtain a handle, so the same disclosure rules apply to it:

- **Same-origin only.** Deserializing a COS handle in a context whose origin differs from the one that obtained it throws a `DataCloneError`. A readable handle cleared [availability gating](#availability-gating) for *the origin that asked*; passing it to another origin would hand over the bytes without `origins`, the Public Hash List, or GREASE'ing ever being evaluated for that origin. Transferring between a page and its own worker, or between same-origin documents, works normally.
- **Readability travels with the handle.** A handle from a `create: true` request that has not been written through is still not readable after being transferred — `getFile()` keeps rejecting until that handle's own write completes. Conversely, a handle from a successful read stays readable without being re-checked, so transferring a handle can't be used to re-roll [GREASE'ing](#greaseing) or otherwise re-probe availability.

```js
// Same-origin: fine. The worker gets a handle it can read from.
const handle = await navigator.crossOriginStorage.requestFileHandle(hash);
worker.postMessage(handle);

// Cross-origin: throws DataCloneError on the receiving side.
otherOriginFrame.postMessage(handle, 'https://other.example');
```

#### Storing and retrieving a file across unrelated sites

To illustrate the capabilities of the COS API, consider the following example where two unrelated sites want to interact with the same common large language model. The first site stores the model in COS and makes it globally available, while the second site retrieves it.

##### Site A: Storing a large language model

On Site A, a web application stores a large language model in COS.

```js
// The hash of the desired file.
const hash = {
  algorithm: 'SHA-256',
  value: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
};

try {
  const handle = await navigator.crossOriginStorage.requestFileHandle(hash);

  // Use the file and return.
  // …
  return;
} catch (err) {
  if (err.name === 'NotFoundError') {
    // Load the file from the network.
    const fileBlob = await loadFileFromNetwork();
    // Compute the control hash using the method in Appendix B.
    const controlHash = await getBlobHash(fileBlob);
    // Check if control hash and known hash are the same.
    if (controlHash !== hash.value) {
      // Downloaded file and desired file are different.
      // …
      return;
    }
    try {
      const handle = await navigator.crossOriginStorage.requestFileHandle(
        hash,
        {
          create: true,
          origins: '*', // Make the file globally available.
        },
      );
      const writableStream = await handle.createWritable();
      await writableStream.write(fileBlob);
      await writableStream.close();

      console.log('File stored.');
    } catch (err) {
      // The `write()` failed.
    }
    return;
  }
  // 'NotAllowedError': Permissions Policy blocks COS in this context.
  console.log('Cross-Origin Storage is blocked by Permissions Policy.');
}
```

##### Site B: Retrieving the same model

On Site B, entirely unrelated to Site A, a different web application retrieves the same popular model from COS.

```js
// The hash of the desired file.
const hash = {
  algorithm: 'SHA-256',
  value: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
};

try {
  const handle = await navigator.crossOriginStorage.requestFileHandle(hash);
  const fileBlob = await handle.getFile();
  console.log('File retrieved', fileBlob);
  // Use the fileBlob as needed.
} catch (err) {
  if (err.name === 'NotFoundError') {
    // The file wasn't in COS.
    console.error(err.name, err.message);
    return;
  }
  // 'NotAllowedError': Permissions Policy blocks COS in this context.
  console.log('Cross-Origin Storage is blocked by Permissions Policy.');
}
```

##### Key points

- **Unrelated sites:** The two sites belong to different origins and do not share any context, ensuring the example demonstrates cross-origin capabilities.
- **Strictly opt-in:** Site A explicitly opts in to make the file globally available by setting `origins: '*'` when storing the file. This ensures that the file is not accidentally made available to all sites.
- **Cross-origin sharing:** Despite the different origins, the files are securely identified by their hashes, demonstrating the API's ability to facilitate cross-origin file storage and retrieval.

### Additional integration surfaces

The imperative JavaScript API in the previous section covers the general case, but a large share of real-world resource loading already happens through constructs that carry a URL and, increasingly, an [`integrity`](https://w3c.github.io/webappsec-subresource-integrity/) hash. Routing those through `requestFileHandle()` means hand-writing a cache check, a fallback fetch, and a store, which is boilerplate the user agent can just as well perform itself. COS is therefore designed to be reachable from four host integrations:

| Surface | Opt-in | Reaches |
| --- | --- | --- |
| [HTML](#declarative-html-integration) | `crossoriginstorage` attribute | `<link>` and `<script>` subresources |
| [JavaScript imports](#javascript-import-attribute-integration) | `crossOriginStorage` import attribute | static and dynamic module imports |
| [CSS](#declarative-css-integration) | `cross-origin-storage()` URL modifier | CSS-referenced assets such as web fonts |
| [Fetch](#fetch-integration) | `crossOriginStorage` request option | imperative fetches of a known URL |

All four are keyed off the same `origins`-style value space used by `requestFileHandle()`: omitted or empty for same-site only, a list of origins for a specific set of origins, or `*` for global availability. All four are defined in their respective host specifications rather than in this one.

What the four have in common is that the caller holds both a URL and a hash, and wants the bytes. The imperative API remains the surface for everything that does not fit that shape: writes whose bytes did not come from a single `fetch()`, reads that have no URL to offer at all, and lookups across a set of interchangeable candidates (see [Choosing among interchangeable resources](#example-choosing-among-interchangeable-resources)). See [Replacing the imperative API with a `fetch()` integration](#replacing-the-imperative-api-with-a-fetch-integration) for why the last row of the table does not subsume `requestFileHandle()`.

#### Declarative HTML integration

`<link>` and `<script>` elements that already carry [`integrity`](https://w3c.github.io/webappsec-subresource-integrity/#integrity-metadata) can opt in to COS with a new `crossoriginstorage` attribute, proposed to the WHATWG in [whatwg/html#12770](https://github.com/whatwg/html/issues/12770). As in the JavaScript and CSS forms, the `integrity` hash identifies the file in COS, and `crossoriginstorage` specifies which origins may retrieve it.

##### Example: Same-site only stylesheet and script

A valueless `crossoriginstorage` attribute opts the resource into COS for same-site access only, mirroring the behavior of omitting `origins` in the imperative API:

```html
<link
  rel="stylesheet"
  href="same-site-css-framework.css"
  integrity="sha256-abc123..."
  crossoriginstorage
/>

<script
  src="same-site-js-framework.js"
  integrity="sha256-def456..."
  crossoriginstorage
></script>
```

##### Example: Globally available stylesheet and script

By passing `*`, the resource is made available to any origin that requests the same hash via COS:

```html
<link
  rel="stylesheet"
  href="popular-css-framework.css"
  integrity="sha256-abc123..."
  crossoriginstorage="*"
/>

<script
  src="popular-js-framework.js"
  integrity="sha256-def456..."
  crossoriginstorage="*"
></script>
```

##### Example: Script restricted to specific origins

To restrict a resource to specific origins instead of making it globally available, `crossoriginstorage` takes a space-separated list of origins, mirroring the `origins` array in the JavaScript API:

```html
<script
  src="acme-inc-corporate.js"
  integrity="sha256-def456..."
  crossoriginstorage="https://acme-inc.example.com https://acme-cdn.example.com"
></script>
```

Omitting `crossoriginstorage` entirely while keeping `integrity` preserves today's behavior: the resource is fetched and verified, but never consulted against or stored in COS.

> [!NOTE]
> `crossoriginstorage` is unrelated to the existing [`crossorigin`](https://html.spec.whatwg.org/multipage/urls-and-fetching.html#cors-settings-attributes) attribute despite the similar name. The `crossorigin` attribute controls the CORS request mode for the element's fetch, which is an orthogonal concern.

#### JavaScript import attribute integration

[Import attributes](https://github.com/tc39/proposal-import-attributes) provide a way to reach COS from module imports and dynamic `import()`, without going through `navigator.crossOriginStorage` directly, proposed to the WHATWG in [whatwg/html#12771](https://github.com/whatwg/html/issues/12771). As with the HTML and CSS forms, `integrity` identifies the file in COS, and `crossOriginStorage` specifies which origins may retrieve it.

> [!NOTE]
> The `with { … }` syntax is defined by TC39, but `crossOriginStorage` is a **host-defined attribute key** — like `integrity`, it requires no TC39 involvement and will be defined in the HTML Standard.

##### Example: Same-site only module

An empty string for `crossOriginStorage` opts the module into COS for same-site access only, mirroring the behavior of omitting `origins` in the imperative API:

```js
import data from "same-site-resource.ext" with {
  integrity: "sha256-abc123...",
  crossOriginStorage: "",
};
```

The same attribute works with dynamic `import()`:

```js
const module = await import("same-site-resource.ext", {
  with: {
    integrity: "sha256-abc123...",
    crossOriginStorage: "",
  },
});
```

##### Example: Globally available module

By passing `"*"`, the module is made available to any origin that requests the same hash via COS:

```js
import data from "popular-resource.ext" with {
  integrity: "sha256-abc123...",
  crossOriginStorage: "*",
};
```

The same attributes work with dynamic `import()`:

```js
const module = await import("popular-resource.ext", {
  with: {
    integrity: "sha256-abc123...",
    crossOriginStorage: "*",
  },
});
```

##### Example: Module restricted to specific origins

To restrict the resource to specific origins, `crossOriginStorage` takes a space-separated list of origins instead of `"*"`, mirroring the `crossoriginstorage` attribute in the HTML integration:

```js
import data from "acme-inc-corporate.ext" with {
  integrity: "sha256-def456...",
  crossOriginStorage: "https://acme-inc.example.com https://acme-cdn.example.com",
};
```

#### Declarative CSS integration

In addition to the imperative JavaScript API, COS can be accessed declaratively from CSS via a new [`<request-url-modifier>`](https://drafts.csswg.org/css-values-5/#typedef-request-url-modifier) called `cross-origin-storage()`, proposed to the CSS Working Group in [w3c/csswg-drafts#14056](https://github.com/w3c/csswg-drafts/issues/14056). This is especially valuable for resources referenced in CSS—such as large web fonts—where the imperative JavaScript API is not easily applicable.

The modifier is used alongside the existing [`integrity()`](https://drafts.csswg.org/css-values-5/#typedef-request-url-modifier-integrity-modifier) modifier. The hash from `integrity()` identifies the file in COS, and `cross-origin-storage()` specifies which origins may retrieve it—mirroring the `origins` option in the JavaScript API.

```
cross-origin-storage() = cross-origin-storage( [ '*' | <string># ]? )
```

##### Example: Same-site only font

Calling `cross-origin-storage()` with no arguments opts the font into COS for same-site access only, mirroring the behavior of omitting `origins` in the imperative API:

```css
@font-face {
  font-family: "Same-Site Corporate Font";
  src: url(
    "same-site-corporate.woff2"
    integrity("sha256-abc123...")
    cross-origin-storage()
  );
}
```

##### Example: Globally available font

By passing `*`, the font is made available to any origin that requests the same hash via COS:

```css
@font-face {
  font-family: "Popular Emoji Font";
  src: url(
    "https://example.com/popular-emoji.woff2"
    integrity("sha256-xyz789...")
    cross-origin-storage(*)
  );
}
```

##### Example: Font restricted to specific origins

Passing a list of origins limits COS retrieval to only those origins. All other origins still fetch the font from the network URL:

```css
@font-face {
  font-family: "ACME Inc Corporate Font";
  src: url(
    "acme-inc-corporate.woff2"
    integrity("sha256-abc123...")
    cross-origin-storage("https://acme-inc.example.com", "https://acme-cdn.example.com", "https://acme-inc-marketing-site.example.com")
  );
}
```

> [!NOTE]
> `cross-origin-storage()` is unrelated to the CSS [`cross-origin()`](https://drafts.csswg.org/css-values-5/#typedef-request-url-modifier-cross-origin-modifier) modifier despite the similar name. The `cross-origin()` modifier controls the CORS request mode, which is an orthogonal concern.

#### Fetch integration

The three integrations above cover resources referenced from markup, from module graphs, and from stylesheets. The remaining case is the imperative one: a script that already knows the URL and the hash of a resource and fetches it itself. That is how most Wasm modules, asset bundles, and other large binaries are loaded today, and it is currently the case that costs the most code to move onto COS.

A `crossOriginStorage` option on [`RequestInit`](https://fetch.spec.whatwg.org/#requestinit), used alongside the existing [`integrity`](https://fetch.spec.whatwg.org/#dom-requestinit-integrity) option, closes that gap. As in the other three forms, the `integrity` hash identifies the file in COS, and `crossOriginStorage` specifies which origins may retrieve it. This is proposed to the WHATWG in [whatwg/fetch#1954](https://github.com/whatwg/fetch/issues/1954), where it would be defined as:

```webidl
partial dictionary RequestInit {
  (DOMString or sequence<DOMString>) crossOriginStorage;
};
```

##### Example: Fetching through COS

An empty string opts the resource into COS for same-site access only, `*` makes it globally available, and an array of origins restricts it to those origins, mirroring the values the imperative `origins` option accepts:

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

Omitting `crossOriginStorage` while keeping `integrity` preserves today's behavior: the response is fetched and verified, but COS is never consulted or written. This is why same-site scope is spelled as an empty string rather than as an omitted member, unlike the imperative API: `fetch()` has no `create: true` to carry the opt-in separately, so the member's presence is what opts the request into COS and its value is what scopes the result.

> [!NOTE]
> The list form is an array here, whereas the HTML attribute and the import attribute use a space-separated string and the CSS modifier a comma-separated list of `<string>`s. This is deliberate rather than an inconsistency. A `RequestInit` member is an ordinary JavaScript value, so a `sequence<DOMString>` is the idiomatic spelling, and it matches the imperative `origins` option exactly, down to the IDL type. The three other surfaces have no such choice to make: HTML content attribute values are text, import attribute values are restricted to strings by [TC39](https://github.com/tc39/proposal-import-attributes), and CSS has no array type, so each takes the closest list syntax its host already provides. All four resolve to the same `origins` value space.

##### Example: The streaming example, without the plumbing

The [streaming example](#example-streaming-a-file-into-cos-while-using-it) above is the recommended way to write a cache-miss path by hand today, and it is around 30 lines of `tee()`, `pipeTo()`, and cancellation for what is conceptually a single fetch. The common case is easy to get wrong, and getting it wrong silently costs the download and compile overlap that `WebAssembly.instantiateStreaming()` exists to provide. With the fetch integration, the whole example collapses to:

```js
const { instance } = await WebAssembly.instantiateStreaming(
  fetch('module.wasm', {
    integrity: 'sha256-abc123...',
    crossOriginStorage: '*',
  }),
  imports,
);
```

The user agent performs the COS lookup, serves the bytes from storage on a hit, fetches and stores them on a miss, and does the stream splitting internally.

> [!NOTE]
> Server runtimes such as Node.js, Deno, and Bun implement `fetch()` but have no cross-origin boundary and no user to protect, so COS does not exist there. They ignore `crossOriginStorage` the way they ignore other browser-specific request options, and isomorphic code keeps working unchanged.

##### Open design questions

Two questions are specific to this integration and need answers in the [Fetch Standard discussion](https://github.com/whatwg/fetch/issues/1954):

- **Response fidelity on a cache hit.** A COS entry carries bytes only, with no MIME type, status, or headers, deliberately so (see [Storing the original URL as part of a COS entry](#storing-the-original-url-as-part-of-a-cos-entry) for why unverifiable metadata stays out). A `Response` synthesized from a hit therefore has no `Content-Type` unless the integration invents one. The three other integrations sidestep this because the element, the module type, or the CSS property defines the destination, whereas a bare `fetch()` has none. This matters concretely: `WebAssembly.instantiateStreaming()` refuses anything that is not `application/wasm`, which is exactly why the hand-written example above has to supply that header itself. Candidate answers include deriving the type from the request's [destination](https://fetch.spec.whatwg.org/#concept-request-destination), letting the caller declare it, or storing a user-agent-computed type alongside the bytes.
- **Header stripping.** A response served from COS must not reveal whether the bytes came from storage or from the network, so it cannot carry the response headers of a fetch that never happened. As a privacy matter this is smaller than it first appears: cache hits are timing-observable regardless, and disclosure is already gated by `origins`, the [Public Hash List](#availability-gating), and [GREASE'ing](#greaseing) on the read step, so this integration discloses no more than `requestFileHandle()` does. The open question is one of fidelity, that is, which `status`, `Content-Length`, and `type` a hit-served `Response` should report, not one of leakage.

#### Processing flow common to all four integrations

The HTML, import attribute, CSS, and fetch forms above share the same underlying model as the imperative API: a resource is identified by its integrity hash, and a COS lookup is attempted before falling back to the network.

1. The user agent checks COS for a file matching the `integrity` hash. If found and the requesting origin is allowed per the declared `origins`-style value, the resource is served from COS, and no network request is made.
2. Otherwise, the resource is fetched from the declared URL as usual. If the fetched content matches the `integrity` hash and the declared origins permit it, the user agent stores it in COS for future use by this or other origins. If the hash does not match, the resource is rejected per existing `integrity` behavior and is not stored in COS.

Step 1's COS lookup is subject to the same [availability gating](#availability-gating) as the imperative API. A resource declared with the global (`*`) origins-style value is only found by a requester outside its storing origins if its hash also clears the Public Hash List (and GREASE'ing doesn't suppress it); a same-site- or list-scoped resource needs no such additional clearance once the requesting origin is in scope. Either way, a lookup that doesn't succeed simply falls through to step 2's network fetch — it is indistinguishable from a genuine cache miss, exactly as `requestFileHandle()`'s `NotFoundError` is.

Because all four forms piggyback on `integrity`, they inherit its existing failure semantics: a hash mismatch is always treated as a fetch failure, independent of whether COS is involved.

> [!NOTE]
> The hash format differs between these four integrations and the imperative form, intentionally so. The `integrity` attribute, the `integrity` import attribute, the `integrity()` CSS modifier, and the `integrity` request option all follow the [Subresource Integrity](https://w3c.github.io/webappsec-subresource-integrity/) convention and express hashes as base64-encoded strings (e.g., `sha256-abc123…`). The imperative `requestFileHandle()` API uses lowercase hexadecimal strings (e.g., `8f434346…`), which matches the format used by AI model hubs such as [Hugging Face](https://huggingface.co/) when publishing model checksums. The user agent normalizes both representations internally; they identify the same underlying bytes.

## Detailed design discussion

### Hashing

The current hashing algorithm is [SHA-256](https://w3c.github.io/webcrypto/#alg-sha-256), implemented by the **Web Crypto API**. If hashing best practices should change, COS will reflect the [implementers' recommendation](https://w3c.github.io/webcrypto/#algorithm-recommendations-implementers) in the Web Crypto API.

The hashing algorithm used is encoded in the hash object's `algorithm` field as a plain string naming a hash algorithm recognized by the [Web Crypto API](https://w3c.github.io/webcrypto/), e.g. `"SHA-256"`. This flexible design allows changing the hashing algorithm in the future. The hash string must be a valid lowercase hexadecimal string of length 64 (for SHA-256).

Note that `algorithm` is typed as a plain `DOMString`, not as a [`HashAlgorithmIdentifier`](https://w3c.github.io/webcrypto/#dom-hashalgorithmidentifier), even though its value space is exactly the set of names a `HashAlgorithmIdentifier` accepts. `HashAlgorithmIdentifier` is `(object or DOMString)`—the `object` branch exists so parameterized algorithms like HMAC can carry extra fields (e.g. `{name: "HMAC", hash: "SHA-256"}`). Hash algorithms take no such parameters, and `algorithm` is stored, compared, and round-tripped as part of a content-addressable key rather than consumed once by a single Web Crypto call, so admitting arbitrary objects here would add no capability while complicating equality and serialization.

```js
const hash = {
  algorithm: 'SHA-256',
  value: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
};
```

### Handling multiple files

`requestFileHandle()` operates on one file at a time. For concurrent requests across multiple files and per-file error handling, see the [FAQ entry on why the API is singular](#appendixc-frequently-asked-questions-faq).

### Concurrent writes

If two tabs both check COS for the same file, find it absent, and begin downloading, the user agent may receive two concurrent writes for the same hash. The user agent stores the file once; the duplicate download is accepted as an edge-case cost. This proposal does not prescribe coordination between tabs for this scenario.

While an entry exists but has not yet been fully written—for example, while one of those concurrent writes is still in flight—it deliberately does not behave like an absent entry. Any `requestFileHandle()` call for that hash, from any origin, including the origin currently writing it, rejects with a `NotAllowedError` rather than a `NotFoundError` for as long as the entry remains unwritten (see the "Created, not yet written" row of the [read path table](#read-path)). This prevents a reader from mistaking an in-progress write for a genuine cache miss and starting a redundant, concurrent download of a file that may already be gigabytes into being written.

This also applies to a handle you already hold: calling `getFile()` on a `FileSystemFileHandle` obtained from a `create: true` request rejects with that same `NotAllowedError` until that very handle's `write()`/`close()` has resolved—even for the origin that requested the handle. Call `getFile()` only after the write has completed, not on a handle you are about to write to.

If a write fails—for example, its bytes don't hash to the requested value—the entry it was writing to is cleaned up rather than left stuck: once no other write for that same hash is still outstanding, the user agent removes the entry, and a subsequent `requestFileHandle()` call for that hash gets an ordinary `NotFoundError` instead of an indefinite `NotAllowedError`. This is why the "no other write still outstanding" qualifier matters: if two tabs are racing to write the same hash and one supplies the wrong bytes while the other is still in flight (or has already succeeded), the failing tab's cleanup must not disturb the other tab's write. The user agent tracks this per entry so that a failure only ever cleans up after itself, never after a sibling write it doesn't control. An already-written entry is never affected by this at all—no later failed write, from any origin, can remove an entry that some origin has already successfully stored.

### What a COS handle can and cannot do

`requestFileHandle()` returns an ordinary `FileSystemFileHandle`, so it arrives carrying the whole File System Standard surface — including operations that mean nothing for an entry that has no name, no containing directory, and no identity beyond its hash. Two of those needed deciding rather than leaving to each implementation.

**`isSameEntry()` answers.** Content-addressability means the registry holds at most one entry per hash, so two handles address the same entry exactly when their hashes match. That makes this the one identity question a COS handle can always answer, unlike `move()` or `remove()`, which have nothing to act on and are refused. Refusing `isSameEntry()` too would discard information the user agent already holds. Comparing against a handle the calling origin did not obtain, or one belonging to a different file system, rejects instead of returning `false` — returning `false` would assert the two are different entries, which is a claim about a handle the caller is not entitled to inspect.

**`name` is the hash, and that follows rather than being chosen.** The File System Standard defines `name` as the last path component of the handle's locator path, so all COS had to say is what that path is: a single item holding the entry's hash. An entry has no name of its own, and the hash is the only identity it has, so reporting it carries information the empty string would discard.

**`move()` and `remove()` are refused, not absent.** An entry is shared by every origin that stored it, so honoring a removal would let one site destroy data other sites depend on; deletion belongs to eviction and to the user's own storage controls. A rename has nothing to act on. Neither method is defined by the File System Standard or the File System Access API today ([WICG/file-system-access#214](https://github.com/WICG/file-system-access/issues/214)), so the error name follows `removeEntry()` — the operation the standard *does* define for deleting an entry — which rejects with `NotAllowedError` when readwrite access is not granted.

**Permission queries never say `prompt`, and say `denied` for writing without `create`.** Handles are pre-authorized, so no prompt can appear. Writing is the one capability a handle can genuinely lack: only a create request yields a writable handle, so reporting `granted` for a write mode on any other handle would claim a capability `createWritable()` will refuse. Requesting cannot change the answer — there is no prompt to show and nowhere to record a grant.

**`createSyncAccessHandle()` was never ours to decide.** Its File System Standard steps reject with `InvalidStateError` whenever the handle is not in a bucket file system, and the COS file system is a root distinct from any origin's, so the standard already fixes both the refusal and the error name. That is the outcome we would want anyway: a sync access handle hands the caller a writable file descriptor, which would let it change an entry's bytes out from under the hash they are stored against — and every other origin the entry is disclosable to reads those same bytes.

**`createWritable({keepExistingData: true})` still starts empty.** The File System Standard defines that option as seeding the stream with the file's current contents, and honoring it here would be an availability-gating bypass. A create request hands back a handle whether or not the entry already exists, so a caller could open a writable for a hash some other origin stored, close it having written nothing, and let the carried-over bytes hash to the requested value — becoming a storing origin, and gaining read access, for bytes it never possessed, with `origins`, the Public Hash List and GREASE'ing never consulted. It is the same reasoning that makes every create request supply the complete contents. A writable closed without any write therefore holds the empty byte sequence and fails verification with `DataError`, like any other mismatch; reporting a storage or I/O error there would hide a verification result behind an unrelated failure.

### Workers and origin inheritance

A `CrossOriginStorageManager` is keyed to the origin of the context it lives in, which for a worker is the origin of that worker's environment settings object rather than anything derived from its script URL. Two worker kinds that look similar therefore behave very differently, and it is worth knowing which is which before reaching for one.

A worker created from a `blob:` URL has the origin of the context that created it. It shares one COS view with that page: what the worker writes, the page can read back, and what the page stored, the worker can read. The `blob:` URL is not an origin of its own, and revoking it does not detach the worker from that view. A worker's writes are consequently indistinguishable from its creating page's own writes, which is the intended behavior but is easy to misread as isolation.

A worker created from a `data:` URL has an opaque origin. An opaque origin has no stable identity to key storing origins or same-site comparisons on, so there is nothing meaningful to grant it. This proposal does not currently define what `requestFileHandle()` does for a caller whose own origin is opaque — the opaque-origin rule in "validate a COS request" governs the origins a caller *names* in `origins`, not the origin it speaks from. Implementations should at minimum reject such calls promptly rather than leaving the returned promise pending.

### Eviction

Under critical storage pressure, user agents could offer a dialog that invites the user to manually free up storage. The user agent could also delete files automatically based on, for example, a least recently used approach.

User agents are further expected to provide settings UI through which users can inspect which files are stored in COS and which origins have most or least recently accessed each file. Users may then choose to delete files from COS through this UI. This UI could also offer an affordance to let users add manually downloaded files—such as large AI models already on disk—to COS directly.

When the user clears site data, all usage information associated with the origin should be removed from files in COS. If a file in COS, after the removal of usage information, is deemed unused, the user agent may delete it from COS.

### Web sustainability

In the context of [evaluating carbon emissions in digital data usage](https://websitesustainability.com/cache/files/research23.pdf), current methodologies predominantly utilize a [kilowatt-hour (kWh) per gigabyte (GB) framework](https://sustainablewebdesign.org/estimating-digital-emissions/) to estimate the operational energy intensity of data transmission and storage. This approach provides the following energy consumption benchmarks:

- **Network transmission:** 0.013&nbsp;kWh/GB
- **User devices:** 0.081&nbsp;kWh/GB

While this document does not aim to critically assess the precision of these estimates, it is an established principle that minimizing redundant data downloads and storage is inherently beneficial for sustainability. The [Ethical Web Principles](https://w3ctag.github.io/ethical-web-principles/) specifically highlight that the Web [_"is an environmentally sustainable platform"_](https://w3ctag.github.io/ethical-web-principles/#sustainable) and suggest _"lowering carbon emissions by minimizing data storage and processing requirements"_ as measures to achieve this. Consequently, one of the key objectives of the COS API is to enhance Web sustainability by reducing redundant large file downloads when such files are possibly already stored locally on the user's device.

> [!IMPORTANT]
> In the context of AI, its implications for sustainability efforts are undeniable. It's essential to adhere to [Web Sustainability Guidelines](https://w3c.github.io/sustainableweb-wsg/) when integrating AI solutions. Prior to implementing AI, it's recommended to [assess and research visitor needs](https://w3c.github.io/sustainableweb-wsg/#audience-evaluation) to ensure that AI is a justifiable and effective solution that truly improves the experience. For example, by increasing user privacy of video calls by applying AI-based background blurring.

## Considered alternatives

### Adding a description for each file apart from the hash

To facilitate manual COS management, one approach would be to allow developers to store a human-readable description alongside the resource. Apps could reference to the same file identified by a unique hash using different descriptions. For example, an English site could refer to the [`g-2b-it-gpu-int4.bin`](https://storage.googleapis.com/jmstore/kaggleweb/grader/g-2b-it-gpu-int4.bin) AI model as "Gemma AI model from Google", whereas another Spanish site could refer to it as "modelo de IA grande de Google". Instead, we envision user agents to enrich COS management UI based on the hashes. For example, a user agent could know that a file identified by a given hash is a well-known AI model and optionally surface this information to the user in the user agent settings UI.

### Storing the original URL as part of a COS entry

A related idea is to record, on each COS entry, the URL the file was originally fetched from. It is tempting for much the same reason a description is: it would make a multi-gigabyte blob legible in the browser's storage UI, and it would help a developer debug a `requestFileHandle()` miss. It does not fit the model, for three reasons:

- **It isn't a property of the entry.** A COS entry is shared by every origin that stores those bytes, and the URL belongs to one writer's fetch, not to the entry. Ten origins may store the same file from ten different URLs. First-writer-wins is arbitrary—the first storer is not privileged in any other respect—and keeping a set of URLs grows without bound and can be polluted by any origin that writes the bytes.
- **It can't be verified.** Bytes are checked against the hash; a URL string is merely a claim by whoever wrote them, and an origin can claim any URL. Placing an unverifiable label inside an otherwise fully verified structure invites it to be read as provenance when it is nothing of the sort.
- **It leaks far more than an origin does.** COS's disclosure limits—`origins`, [availability gating](https://wicg.github.io/cross-origin-storage/#availability-gating), and the Public Hash List—are calibrated around coarse, origin-level information. A full URL can carry paths, query parameters, tokens, and user identifiers (`https://cdn.example/models/user-1234/weights.bin`), which is a much higher-entropy signal than that calibration accounts for.

The adjacent motivations do not survive scrutiny either. Re-fetching after eviction would mean the user agent issuing a request to a third party's URL with ambient authority, and the calling origin already knows its own URL and can simply fetch it again. Attribution in permission UI does not need it, since the user agent already has the requesting origin at prompt time, and a historical, spoofable URL recorded by some other site would mislead rather than inform. Popularity corroboration belongs to [Public Hash List](public-hash-list/phl-explainer.md) admission, which happens offline, not per user in the browser.

What remains is the debugging and storage-inspection motivation, and that needs no web-exposed field. A user agent is free to keep an **implementation-private provenance record**—say, the URL each storing origin fetched the bytes from, and when—as long as it is treated as browser state rather than as part of the entry:

- It is never exposed to script by any COS API, and a requesting origin cannot observe a record it did not itself produce.
- It is surfaced only through trusted, non-web surfaces: the browser's own settings and storage inspection UI, developer tools, and extension APIs gated behind an explicit, user-granted permission, on the same footing as other APIs that expose browsing history. See [Browser extension integration points for COS](extensions/extensions-explainer.md) for the extension surfaces under consideration.
- It is presented as an unverified claim by the writing origin, not as an attestation about the bytes—only the hash guarantees the content. Two origins may record different URLs for the same entry.
- It is discarded with the entry, and per origin when that origin is removed from the entry's storing origins, including when the user clears that origin's site data.

Because such a record is invisible to content, a site cannot detect whether the browser keeps one, so this stays purely a matter of implementation quality of life. See [Provenance metadata](https://wicg.github.io/cross-origin-storage/#provenance-metadata) in the spec.

### Storing files without hashing

Storing files by their names rather than using hashes would risk name collisions, especially in a cross-origin environment. The use of hashes guarantees unique identification of each file, ensuring that the contents are consistently recognized and retrieved. Storing files based on their URLs would work if apps reference the same URLs, for example, on the same CDN, but wouldn't work if apps reference the same file stored at different locations.

### Requiring a minimum file size

One approach would be to require a minimum file size for a resource to be eligible for COS. No minimum file size is proposed. It would be trivial to inflate a file's size to meet any such threshold, for example by appending padding bytes or comments.

### Manually accessing files from a local disk

Different origins can manually open the same file on disk, either using the File System Access API's `showOpenFilePicker()` method or using the classic `<input type="file">` approach. This requires the file to be stored once, and access to the file can then be shared as explained in [Cache AI models in the browser](https://developer.chrome.com/docs/ai/cache-models#special_case_use_a_model_on_a_hard_disk). While this works, it's manual and error-prone, as it requires the user to know what file to choose from their hard drive in the file picker.

### Replacing the imperative API with a `fetch()` integration

COS is reachable from `fetch()` (see [Fetch integration](#fetch-integration)), so the question is not whether `fetch()` should reach COS, but whether it should be the *only* way to reach it, with `navigator.crossOriginStorage.requestFileHandle()` dropped in favor of a `RequestInit` option. That was considered and rejected, because the two express different things: a fetch couples naming a resource to downloading it, while the imperative API keeps those steps separate.

**Bytes reach COS from places `fetch()` does not own.** Managing downloads is explicitly out of scope for this proposal (see [Appendix&nbsp;C](#appendixc-frequently-asked-questions-faq)), and in practice the bytes stored in COS often did not come from one `fetch()` call. They may arrive from a [Background Fetch](https://wicg.github.io/background-fetch/), from `Range` requests for a sharded resource that the site reassembles itself, from a file the user picked off their local disk, or from another storage API entirely. The sharded case cannot be expressed through a fetch integration at all, because the COS entry is a shard that no single URL serves.

**A read may have no URL to offer.** A lookup that only asks whether COS already holds a given hash has no URL attached, and the caller may have nothing to download if the answer is no. The motivating case is AI models, which ship as families of interchangeable variants: an app built around `whisper-tiny` should transcribe with `whisper-large-v3` if the user already has it, rather than downloading a smaller and worse model on top of a better one that is already on the device. Expressing that means probing several hashes and committing to a download only after all of them come back empty, as shown in [Choosing among interchangeable resources](#example-choosing-among-interchangeable-resources). A fetch-shaped API cannot ask this question, since every probe would have to name a URL the app has no intention of fetching, and a probe whose whole purpose is to *avoid* a network request would be spelled as a request.

**Handles are not responses.** A `FileSystemFileHandle` can be [transferred to another context](#transferring-a-handle), reused across several reads, and written through with the same File System Standard machinery developers already use for [OPFS](https://fs.spec.whatwg.org/#sandboxed-filesystem). A `Response` is a single, one-shot consumption of a body. Store-only writes in particular have no natural spelling in `fetch()`: there is no request to make, only bytes to hand over.

The imperative API is therefore the general surface, and the four [host integrations](#additional-integration-surfaces) are ergonomic shortcuts for the common special case where a URL and a hash are both known up front and the bytes are wanted immediately.

### Integrating cross-origin storage in the Cache API

The Cache API is fundamentally modeled around the concepts of `Request` or URL strings, and `Response`, for example, `Cache.match()` or `Cache.put()`. In contrast, what makes COS unique is that it uses file hashes as the keys to files to avoid duplicates.

### Solving the problem only for AI models

AI models are admittedly the biggest motivation for working on COS, so one alternative would be to solve the problem exclusively for AI models. A question that arises in the context is how it would be enforced that files actually be AI models? Given this question, this approach does not seem like a good fit, and the non-AI [use cases](#use-cases) are well worth addressing, too.

Additionally, common AI inference solutions like [Transformers.js](https://github.com/huggingface/transformers.js) rely on [WebAssembly in the underlying ONNX Runtime](https://onnxruntime.ai/docs/build/web.html#build-instructions), which is true independent of the backend, WebGPU or Wasm. The same applies to [MediaPipe](https://github.com/google-ai-edge/mediapipe), which requires Wasm files as so-called [`WasmFileset`](https://ai.google.dev/edge/api/mediapipe/js/tasks-text.filesetresolver) objects for its various MediaPipe Tasks APIs.

## Security and privacy considerations

See the complete [questionnaire](security-privacy-questionnaire.md) for details.

### Security considerations

#### Resource integrity check through hashes 

Access is scoped to individual files, [each identified by their hash](#hashing). Developers cannot arbitrarily access any random files or obtain the complete list of resources in COS, ensuring limited and precise access control. Files are uniquely identified by their cryptographic hashes (for example, SHA-256), ensuring data integrity. Hashes prevent tampering with the file contents, that is, a site can be sure it gets the same contents from COS as if it had downloaded the file itself, as COS guarantees that each file's contents matches its hash. For enhanced protection, user agents can check file hashes against virus databases like [VirusTotal](https://www.virustotal.com/gui/home/search), and integrate with in-browser security features like [Safe Browsing](https://safebrowsing.google.com/) even before storing a file.

#### User controls

User agents are expected to provide [settings UI for managing COS files](#eviction), showing stored files and their associated origins. Users can manually evict files or clear all COS data, maintaining control over their storage.

User agents are expected to enrich settings UI based on the file hashes. For example, a user agent could know that a file identified by a given hash is a well-known AI model and optionally surface this information to the user in the settings UI.

#### Cache flooding

Sites are prevented from flooding the cache in an attempt to evict other sites' resources. Each site can only store a limited amount of data in COS, and if a site tries to exceed this limit, the user agent rejects the write with a `QuotaExceededError` `DOMException` and logs a warning to the console.

### Privacy considerations

COS exposes two distinct privacy risks, addressed separately below. The first is **inference**: an attacker learning that a resource it did not put there is present, and drawing conclusions about where the user has been ([Cross-site probing](#cross-site-probing)). The second is **identifier construction**: an attacker writing resources itself and using their presence purely as storage for a value it minted ([Cross-site identifier construction](#cross-site-identifier-construction)). The mitigations differ, and a mitigation for one is generally not a mitigation for the other.

#### Cross-site probing

This section covers an attacker that does not control what is in COS and must infer something from what it finds. An attacker that writes the entries itself is covered in [Cross-site identifier construction](#cross-site-identifier-construction).

If a file is only used on certain kinds of websites, an attacker can discover that the user visited those sites by checking for the file's presence. For example, if someone has a game engine stored in COS, they probably play games on the web, which an attacker might exploit, for example, for targeted advertising. The attacker site would need to probe hashes of resources it's interested in. The `origins` field mitigates this risk by allowing origins to restrict resource access to a specific set of trusted origins, ensuring the resource is not globally "probeable". Sites are expected to use this field for proprietary resources or when global COS cache hits are not expected.

This mitigation only holds if a "specific set of trusted origins" stays meaningfully smaller than the web. Nothing about the shape of `origins` stops a caller from enumerating a very large number of origins—for example, a list assembled from a public top-sites ranking—which would functionally approximate global disclosure while bypassing the deliberate, explicit opt-in that `origins: '*'` alone requires. This is why `origins` lists have an implementation-defined maximum length (see [Storing files](#storing-files)): a limit small enough to fit genuine multi-property use cases (a handful of related origins under common control) but far short of any meaningful approximation of "every origin".

Beyond the `origins` field, user agents apply [availability gating](#availability-gating) as a second line of defense: even for globally available resources, the user agent may decline to confirm a file's presence if the resource has not been encountered on a sufficient number of distinct origins.

Each call to `requestFileHandle()` is a probe, and user agents are expected to rate-limit probes per origin and to apply on-device heuristics to detect and block probing patterns. Rate limiting bounds how *fast* an origin can probe, which is what this threat model needs: an attacker guessing at hashes it did not choose is limited chiefly by how many guesses it can make. It does not bound how *much* an origin ultimately learns, since entropy accumulates across visits and a rate limit resets. Bounding the total is a separate mechanism for a separate attacker; see [Cross-site identifier construction](#cross-site-identifier-construction).

A lookup performed by one of the [host integrations](#additional-integration-surfaces) is equally a probe. Such a lookup surfaces no error to the page, but a site learns its outcome anyway by observing whether its own server receives the fallback request, which is the same single bit a `NotFoundError` carries. This discloses nothing the imperative API would not, and the same `origins` scoping, availability gating, and GREASE'ing apply to it unchanged. What it does mean is that both bounds have to take all four surfaces into account: a hash first resolved through the [fetch integration](#fetch-integration) has to be rate-limited, and charged to the [cross-origin probe budget](#cross-site-identifier-construction), exactly as one resolved through `requestFileHandle()` is. That integration is as scriptable in a loop as the imperative API, so counting only imperative calls would leave either bound trivially avoidable.

#### Cross-site identifier construction

[Cross-site probing](#cross-site-probing) covers an attacker that must guess what to probe and learns only what a resource's popularity permits. The inverse threat is an attacker that *chooses* the resources, writes them itself, and treats their presence purely as storage for a value it minted. Such an attacker doesn't care what the resources are, only that it can set them and read them back.

Concretely: a tracker embeds a fixed list of 32 hashes in a script it serves across many sites. On first encounter it mints a random 32-bit identifier and writes the subset of those resources whose bit is 1. On every later site it probes all 32 hashes, and the subset that discloses reconstructs the identifier. A 32-bit identifier comfortably covers most trackers' user bases, and many would settle for 16 bits and absorb the collisions.

Neither the PHL nor GREASE'ing bounds this:

- **PHL membership** assumes an attacker learns only "this user encountered one of the many sites using this ubiquitous file". That fails when the attacker wrote the file: the bit means "I marked this user", not "this user uses React". A k-anonymity bar constrains an attacker that can only *observe* state, not one that can *set* it. An attacker is also free to pick the least common entries on the list, minimizing the chance a bit is set by the user's ordinary browsing.
- **GREASE'ing, eviction, and the user's own browsing** do flip bits, but an attacker compensates with redundancy — encoding the identifier several times over disjoint hash sets, or adding a checksum — at the cost only of more hashes.

What bounds it is the count. Each distinct hash a site can resolve cross-origin yields at most one bit, so an identifier's width is exactly the number of distinct cross-origin probes the user agent grants that site. User agents therefore impose a **cross-origin probe budget**: an implementation-defined maximum number of distinct hashes a site may resolve, other than those it stored itself. Reads over budget return `NotFoundError`, indistinguishable from any other read-path failure.

The budget is keyed by site rather than origin on purpose. Subdomains are free, so a per-origin budget would be defeated by minting `01.example.com`, `02.example.com`, and so on, one per bit. A registrable domain costs money, which is what makes the key mean something.

For the same reason, `requestFileHandle()` rejects outright when the calling context has an opaque origin, such as a sandboxed `<iframe>` without `allow-same-origin`. Each such context gets a *fresh* opaque origin, so without this a page could mint unlimited budget by spawning sandboxed frames and `postMessage()`-ing the bits back. There is also nothing meaningful to grant such a context, since it can never be a storing origin or match a same-site comparison.

The budget's shape matters as much as its size:

- **Counted in distinct hashes, not lookups.** Re-probing a hash yields no bit the origin doesn't already have, so it costs nothing. A page that reloads, or resolves the same resource on every visit, pays once, ever.
- **Charged whether or not the file is found.** Absence and presence are each one bit, so charging only for hits would leave half the attacker's vector free.
- **Not partitioned by top-level site.** Partitioning is the usual default, but here it would hand a third party a fresh allowance on every site it's embedded in — exactly the capability being bounded.
- **Replenished on user activation**, not per document, navigation, or elapsed time. A budget an origin can refresh by navigating is not a budget. Interaction also distinguishes a site the user is actually using, which accrues budget readily, from a script in a third-party frame, which accrues almost none.
- **Charged on every surface that reaches COS**, not only `requestFileHandle()`. The three declarative integrations and the `crossOriginStorage` option on `fetch()` all resolve a hash against the registry, and all yield the same single bit. Counting imperative calls alone would make the budget avoidable, since a `fetch()` lookup is as scriptable in a loop as an imperative one. See [Cross-site probing](#cross-site-probing).
- **Cleared only when the *user* clears site data**, through the browser's own settings or storage UI. A clearing the site asked for itself, such as via the `Clear-Site-Data` header, must leave the budget untouched. Otherwise a site could clear itself between probes and draw an unbounded number of them, which would defeat the whole mechanism. Retaining it costs the site nothing it is entitled to: the budget grants no capability, cannot be read except by spending it, and holds no information the site did not itself supply.

**This doesn't constrain what COS is for.** The budget taxes the *number* of resources an origin resolves; the benefit scales with their *size*. The resources this proposal targets are single, large files — a multi-gigabyte model, a game engine, a large font — where a single probe can save a download of anywhere from megabytes to gigabytes. A page resolving a handful of such resources fits comfortably in a budget of a handful, and pays only once, ever. Sharding one logical resource across many hashes is the exception rather than the norm, and it is the only pattern a tight budget genuinely constrains. Nor does a bounded budget freeze a site's dependencies: because the budget replenishes with user activation, an origin is never charged twice for the same hash, and is never charged at all for one it stored itself or is in the middle of writing, a site can follow its resources through upgrades and replacements indefinitely. What it can't do is resolve many previously unseen hashes in one sitting — the shape of the attack, not the shape of ordinary use.

**On third-party cookies.** A user agent that still supports them gains little from a tight budget: a tracker there already has a cheaper, more reliable identifier, so constraining COS removes no capability it doesn't already have. A user agent that has removed third-party cookies should choose a budget at the strict end. The mechanism is the same in both; only the value differs, so COS remains available regardless of a user agent's cookie policy rather than being contingent on it.

> [!NOTE]
> Because the budget starts full, the maximum is also exactly the number of bits a third party that has never been interacted with obtains on first contact. That makes the value, rather than the mechanism, the whole of the design: small enough that this width is uninteresting, large enough for a page's genuine resource count. There is not yet cross-vendor agreement on where that lands, or on how much entropy is tolerable here at all.

#### Availability gating

Two independent mechanisms can control whether a `requestFileHandle()` call returns a file handle or a `NotFoundError`:

- **Access control** (`origins`-based): which origins may obtain a file handle. This is determined by the `origins` field set at write time. An origin that is not in scope receives `NotFoundError`, even if the resource is physically present in COS.
- **Availability gating** (PHL-based): whether the user agent discloses that the resource exists in COS at all. **This applies only to resources stored with `origins: '*'`.** It is determined by whether the hash is on the **Public Hash List (PHL)**, a shared, vendor-neutral allowlist that all browser vendors are expected to respect. A `'*'`-scoped resource not on the PHL receives `NotFoundError` from all requesters except the original storer, even though `'*'` nominally permits any origin.

For a resource stored with `origins: '*'`, both mechanisms apply and both must be satisfied for a read to succeed: a resource stored with `origins: '*'` but not on the PHL is not actually cross-origin accessible — the user agent returns `NotFoundError` to all origins except the original storer, because availability gating still applies on top of the `'*'` scope. For a resource stored with a specific `origins` list, or left at the same-site default, **only access control applies**: an in-scope origin succeeds without needing PHL membership at all. This is deliberate, not an oversight — the storing origin has already made an explicit, bounded disclosure decision by choosing a specific list or accepting the same-site default, and requiring separate global-ubiquity clearance on top of that would make ordinary restricted sharing (see [Restricting resources to specific origins](#example-restricting-resources-to-specific-origins)) depend on unrelated, public curation of what is often a proprietary resource that will never appear on a public allowlist. Availability gating exists specifically to bound the one case — `'*'` — where disclosure could otherwise reach any origin on the web.

**Availability gating in detail.** For a `'*'`-scoped resource, user agents implement availability gating using the PHL:

- **On the PHL:** The user agent may answer truthfully, returning a handle if the file is present, or a `NotFoundError` `DOMException` if it is absent. ([GREASE'ing](#greaseing) may still introduce occasional false negatives even for PHL-listed resources.)
- **Not on the PHL:** The user agent must always return a `NotFoundError` `DOMException`, regardless of whether the file is physically present in COS. The response must be identical whether the file is absent or present, so that cache state cannot be inferred by observing the response or its timing.

The PHL covers well-known resources, such as popular open-source libraries, widely used Wasm modules, web fonts served by major font CDNs, and AI model weights published by recognized model hubs, that are unconditionally eligible for cross-origin availability disclosure because independent, corroborated evidence of their ubiquity — for example, appearing byte-identical across a large number of independently crawled origins — makes cache presence uninformative about any individual user (a form of **k-anonymity**, where _k_ is that minimum corroborating-origin count). This ubiquity check happens once, offline, as part of how a hash is admitted to the PHL; it is not a separate check the user agent repeats at query time. A hash is either on the current PHL snapshot or it isn't; a hash that never clears that bar is treated as permanently absent at the API surface, and the user agent returns a `NotFoundError` `DOMException` as if the file were not stored in COS at all.

The full design of the PHL — its data format, admission criteria, sourcing, and cross-vendor governance — is specified separately from this explainer, in the [Public Hash List explainer](public-hash-list/phl-explainer.md). In short, it proposes: governance by the WHATWG, modeled directly on the [Public Suffix List](https://publicsuffix.org/)'s cross-vendor, rolling-release precedent; a compact, algorithm-sectioned flat-text format of bare hex digests with provenance kept in human-readable comments rather than machine fields; and a separate, optional section for hashes hand-curated from a recognized AI model hub, to unlock the AI use case that objective popularity signals alone cannot cover. An early, non-normative code prototype of the list itself is maintained in this repository, at [`public-hash-list/implementation/`](public-hash-list/implementation/) — a pragmatic interim home; the [Governance](public-hash-list/phl-explainer.md#governance) section of the PHL explainer describes the target end state of a dedicated, cross-vendor repository.

Developers must NOT rely on a `NotFoundError` as definitive proof that a file is absent from COS. A `NotFoundError` MAY indicate that the requesting origin is simply out of scope, or — for a `'*'`-scoped resource — that the user agent has withheld confirmation of the file's presence for privacy reasons.

#### GREASE'ing

As an additional privacy mitigation, user agents may employ **GREASE'ing** ([Generate Random Extensions And Sustain Extensibility](https://tools.ietf.org/html/draft-ietf-tls-grease)): occasionally returning a `NotFoundError` `DOMException` even when a file is present in COS. This introduces noise that makes it harder for sites to distinguish a true absence from a privacy-motivated false negative. A similar technique is applied in [UA Client Hints](https://wicg.github.io/ua-client-hints/#grease).

However, user agents must exercise size-proportionate judgment when applying GREASE'ing. For small files, where a fallback to a network fetch is inexpensive, occasional false negatives are a reasonable privacy trade-off. For very large files—such as gigabyte-scale AI model weights—a false negative would force the caller to perform a full re-download, imposing a significant and observable bandwidth and latency cost on the user. User agents must NOT GREASE responses for files whose size makes a spurious re-download clearly disproportionate to the privacy benefit.

#### API response reference

The following tables summarize the response a user agent must return for every combination of inputs. Outside of the "Created, not yet written" case below, every non-success read-path outcome returns `NotFoundError` — the caller cannot distinguish between a genuine cache miss and a gated or access-controlled resource.

##### Read path

| On PHL? | In COS? | Written with | Requesting origin | GREASEd? | Response |
| -- | -- | -- | -- | -- | -- |
| — | Any | Any | Not a storing origin or pending writer, over probe budget | — | `NotFoundError` |
| — | Created, not yet written | — | — | — | `NotAllowedError` |
| — | Yes | Any | Storing origin | — | Success |
| Yes | Yes | `*` | Not a storing origin | No | Success |
| Yes | Yes | `*` | Not a storing origin | Yes | `NotFoundError` |
| No | Yes | `*` | Not a storing origin | — | `NotFoundError` |
| — | Yes | Same-site or list | In scope, not a storing origin | No | Success |
| — | Yes | Same-site or list | In scope, not a storing origin | Yes | `NotFoundError` |
| — | Yes | Same-site or list | Out of scope | — | `NotFoundError` |
| — | No | — | — | — | `NotFoundError` |

"On PHL?" only ever matters for a `*`-written entry: a same-site- or list-scoped entry never consults the PHL, so its rows show "—" regardless of whether the hash happens to be on it. A storing origin always succeeds too, independent of PHL, `origins`, or GREASE'ing — see [Original storer access](#resource-visibility-upgrades).

The probe-budget row comes first because the charge happens before any registry state is consulted — including the pending check — so an origin over budget cannot distinguish a pending entry, a gated one, or a genuine miss. Neither a storing origin nor an origin with a write of its own still in flight is ever charged; see [Cross-site identifier construction](#cross-site-identifier-construction).

The "Created, not yet written" row applies both to a fresh `requestFileHandle()` call for that hash and to calling `getFile()` on a `FileSystemFileHandle` that was itself obtained from a still-pending `create: true` request; see [Concurrent writes](#concurrent-writes).

`getFile()` is gated per handle rather than per entry, so a handle obtained from a `create: true` request also rejects with `NotAllowedError` when the entry is *already* `written`—by some other origin—and this handle has not been written through. Otherwise a create request would be a read: any origin could ask for a handle and immediately call `getFile()`, learning an entry's contents without satisfying `origins`, the PHL, or GREASE'ing, all of which are enforced on the read path only.

##### Write path

| Condition | Written with | Response |
| -- | -- | -- |
| `hash.value` or `hash.algorithm` is malformed | Any | `TypeError` |
| `origins` is a list longer than the implementation-defined maximum length | Any | `TypeError` |
| Permissions Policy blocks COS | Any | `NotAllowedError` |
| Valid hash, declared hash matches computed hash | `*` | Success |
| Valid hash, declared hash matches computed hash | Same-site or list | Success |
| Valid hash, declared hash matches computed hash, but exceeds the requesting origin's storage limit | Any | `QuotaExceededError` |
| Valid hash, declared hash does not match computed hash | Any | `DataError` |
| Merging `origins` into an existing list-scoped entry would exceed the implementation-defined maximum length | List | Success (excess origins silently dropped) |

##### Transfer path

| Condition | Response |
| -- | -- |
| Deserializing a handle in a context same-origin with the one that obtained it | Success, preserving whether it was readable |
| Deserializing a handle in any other origin | `DataCloneError` |

##### Policy

| Condition | Response |
| -- | -- |
| Permissions Policy blocks COS | `NotAllowedError` |

#### Fingerprinting detection

User agents are also expected to use (on-device) machine learning to identify possible fingerprinting attempts. For example, if a site crafts unique hashes for each user (which hints at fingerprinting), user agents can detect this and block the COS probing attempt. Some user agents have [successfully applied this technique](https://blog.google/products/chrome/building-a-more-helpful-browser-with-machine-learning/#:~:text=More%20peace%20of%20mind%2C%20less%20annoying%20prompts) to silence notification spam.

The knowledge an attacker can gain about a user depends heavily on the popularity of the resources stored in COS. If a user has a very popular resource stored, such as a common AI model, a large Wasm module, or a popular JavaScript library, the attacker can only learn that the user visited one of the many sites that use this resource, which is not very useful information. If a user has a very uncommon or even unique resource stored, the attacker can learn that the user visited one of the few sites (or the only site) that use this resource, which is more useful information. However, user agents are expected to implement safeguards against such attacks, as described above. This holds for an attacker inferring something from resources it did not choose. It does not hold for one that writes the resources itself, where popularity is irrelevant and the bound is the probe budget instead; see [Cross-site identifier construction](#cross-site-identifier-construction).

## Stakeholder feedback / opposition

- **Web Developers**: [Expressed support](#user-research) for enabling sharing of large files without redundant downloads and storage, particularly large AI models, large Wasm modules, and highly popular JavaScript libraries.

## References

- [Public Hash List explainer](public-hash-list/phl-explainer.md)
- [File System Living Standard](https://fs.spec.whatwg.org/)
- [Web Cryptography API](https://w3c.github.io/webcrypto/)
- [Subresource Integrity](https://w3c.github.io/webappsec-subresource-integrity/)
- [Import Attributes](https://github.com/tc39/proposal-import-attributes)
- [CSS Values and Units Module Level 5](https://drafts.csswg.org/css-values-5/)
- [Fetch Living Standard](https://fetch.spec.whatwg.org/)
- [Cache Digests for HTTP/2](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-cache-digest)
- [Web Sustainability Guidelines (WSG)](https://w3c.github.io/sustainableweb-wsg/)
- [Ethical Web Principles](https://w3ctag.github.io/ethical-web-principles/)

## Acknowledgements

Many thanks for valuable feedback from:

- **Tab Atkins-Bittner**, Google Chrome
- **Yash Raj Bharti**, Google Cloud
- **Joshua Lochner**, Hugging Face

Many thanks for valuable inspiration or ideas from:

- **Kenji Baheux**, Google Chrome
- **Kevin Moore**, Google Chrome

## Appendices

### Appendix&nbsp;A: Full IDL

This is kept in sync with the [formal spec](https://wicg.github.io/cross-origin-storage/); if the two ever disagree, the spec is authoritative.

```webidl
[Exposed=(Window,Worker), SecureContext]
interface CrossOriginStorageManager {
  Promise<FileSystemFileHandle> requestFileHandle(
      CrossOriginStorageRequestFileHandleHash hash,
      optional CrossOriginStorageRequestFileHandleOptions options = {});
};

dictionary CrossOriginStorageRequestFileHandleHash {
  required DOMString value; // Must be a valid lowercase hexadecimal string; length varies by algorithm (e.g., 64 characters for SHA-256).
  required DOMString algorithm; // Must name a hash algorithm recognized by the Web Crypto API (https://w3c.github.io/webcrypto/), e.g. "SHA-256".
}

dictionary CrossOriginStorageRequestFileHandleOptions {
  boolean create = false;
  (DOMString or sequence<DOMString>) origins;
}

interface mixin NavigatorCrossOriginStorage {
  [SameObject, SecureContext] readonly attribute CrossOriginStorageManager crossOriginStorage;
};
Navigator includes NavigatorCrossOriginStorage;
WorkerNavigator includes NavigatorCrossOriginStorage;
```

### Appendix&nbsp;B: Blob hash with the Web Crypto API

```js
async function getBlobHash(blob) {
  const hashAlgorithmIdentifier = 'SHA-256';

  // Get the contents of the blob as binary data contained in an ArrayBuffer.
  const arrayBuffer = await blob.arrayBuffer();

  // Hash the arrayBuffer using SHA-256.
  const hashBuffer = await crypto.subtle.digest(
    hashAlgorithmIdentifier,
    arrayBuffer,
  );

  // Convert the ArrayBuffer to a hex string.
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  return {
    algorithm: hashAlgorithmIdentifier,
    value: hashHex,
  };
}

// Example usage:
const fileBlob = await fetch('https://example.com/ai-model.bin').then(
  (response) => response.blob(),
);
getBlobHash(fileBlob).then((hash) => {
  console.log('Hash:', hash);
});
```

### Appendix&nbsp;C: Frequently asked questions (FAQ)

<details>
  <summary>
    <strong>Question:</strong> Does this API help with resuming downloads? What if downloading a large file fails before the file ends up in COS?
  </summary>
  <p>
    <strong>Answer:</strong> Managing downloads is out of scope of this proposal. COS can work with complete or with sharded files that the developer stores in COS as separate blobs and then assembles them after retrieval from COS. This way, downloads can be handled completely out-of-bounds, and developers can, for example, leverage the <a href="https://wicg.github.io/background-fetch/">Background Fetch API</a> or regular <code>fetch()</code> requests with <code>Range</code> headers to download large files.
  </p>
</details>

<details>
  <summary>
    <strong>Question:</strong> How does this API help with popular JavaScript libraries like jQuery or React?
  </summary>
  <p>
    <strong>Answer:</strong> Bundlers have historically combined vendor and application code, causing low cache hit rates. By bundling vendor code separately and completely (e.g., all of React) instead of applying dead-code elimination, a higher cache hit rate can be achieved. While JavaScript libraries used to be very fragmented, modern bundling strategies (where vendor code is bundled separately and completely) make them well-suited for COS to ensure high cache hit rates and improved performance across different applications.
  </p>
</details>

<details>
  <summary>
    <strong>Question:</strong> What other API is this API shaped after?
  </summary>
  <p>
    <strong>Answer:</strong> The COS API is shaped after the File System Standard's <a href="https://fs.spec.whatwg.org/#api-filesystemdirectoryhandle-getfilehandle"><code>getFileHandle()</code></a> function (<code>FileSystemDirectoryHandle.getFileHandle(name, options)</code> which returns a <code>FileSystemFileHandle</code>). Instead of the <code>name</code> parameter in <code>getFileHandle()</code>, in COS, there is the <code>hash</code> object that fulfills the equivalent function of uniquely identifying a file in COS. If <code>options.create</code> is not set or is set to <code>false</code>, the user agent will return a handle for the file identified by the hash value. If and only if <code>options.create</code> is set to <code>true</code>, the user agent will return a handle that can be written to. Optionally, when <code>options.create</code> is <code>true</code>, developers can also provide a list of <code>origins</code> to restrict who can later read the resource, or make the resource globally available.
  </p>
</details>

<details>
  <summary>
    <strong>Question:</strong> Would the first site that added a file be seen as the authority?
  </summary>
  <p>
    <strong>Answer:</strong> No, each site has the same powers. If the user stops using the first site that has put a given file into COS, but continues using another site that depends on the same file, the file would stay around. Only if no site depends on the file anymore, the user agent may consider the file for manual or automatic removal from COS if it's under storage pressure or based on regular storage house keeping.
  </p>
</details>

<details>
  <summary>
    <strong>Question:</strong> Can workers access Cross-Origin Storage?
  </summary>
  <p>
    <strong>Answer:</strong> Yes, the COS API is available in workers, and the same principles apply. For example, a worker can call <code>navigator.crossOriginStorage.requestFileHandle()</code> to request access to a file in COS, and if granted access, it can read from or write to that file using the returned <code>FileSystemFileHandle</code> object. This allows workers to also benefit from shared resources in COS, such as large AI models or Wasm modules, without needing to download them separately.
</p>
</details>

<details>
  <summary>
    <strong>Question:</strong> Why does the API use <code>requestFileHandle()</code> (singular) rather than <code>requestFileHandles()</code> (plural)?
  </summary>
  <p>
    <strong>Answer:</strong> Early drafts of the API exposed <code>requestFileHandles(hashes, options)</code>, which accepted an array of hashes and returned an array of <code>FileSystemFileHandle</code> objects. A <a href="https://github.com/WICG/cross-origin-storage/issues/61">survey of every known real-world implementation</a> — across Hugging Face Transformers.js, wllama, Flutter, Apache TVM, MLC WebLLM, Emscripten, and others — found that <strong>every single call site passed a single-element array and immediately destructured the result to a single handle</strong>. No implementation ever passed more than one hash in a single call.
  </p>
  <p>
    The plural form was therefore pure ergonomic friction: callers had to wrap a value in an array only to unwrap it again (<code>const [handle] = await ...requestFileHandles([hash])</code>). The singular form <code>requestFileHandle(hash, options)</code> — modeled directly on the File System Standard's <a href="https://fs.spec.whatwg.org/#api-filesystemdirectoryhandle-getfilehandle"><code>FileSystemDirectoryHandle.getFileHandle()</code></a> — makes the common case clean and readable. For the rare case where multiple files are needed concurrently, the idiomatic JavaScript pattern <code>Promise.all(hashes.map(hash =&gt; navigator.crossOriginStorage.requestFileHandle(hash)))</code> gives better per-file error granularity than a batched call would anyway.
  </p>
</details>

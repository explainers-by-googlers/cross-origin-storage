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

#### Storing files

1. Hash the contents of the file using SHA-256 (or an equivalent secure algorithm, see [Appendix&nbsp;B](#appendixb-blob-hash-with-the-web-crypto-api)). The hash algorithm used is communicated as a valid [`HashAlgorithmIdentifier`](https://w3c.github.io/webcrypto/#dom-hashalgorithmidentifier).
1. Request a `FileSystemFileHandle` object for the file, specifying the file's hash.
1. Write the file's data to the `FileSystemFileHandle` object and store it in Cross-Origin Storage. When `writableStream.write(data)` is called, the user agent must verify that the hash of `data` matches the declared hash, using the algorithm specified in `hash.algorithm`. If the hashes do not match, the user agent must throw a `DataError` `DOMException` and must not store the data in COS.

> [!NOTE]
> If `hash.value` is not a valid lowercase hexadecimal string of length 64, or `hash.algorithm` is not a valid [`HashAlgorithmIdentifier`](https://w3c.github.io/webcrypto/#dom-hashalgorithmidentifier), the user agent must throw a `TypeError`.

> [!NOTE]
> If the [Permissions Policy](https://www.w3.org/TR/permissions-policy/) for the current context does not allow Cross-Origin Storage, the user agent must throw a `NotAllowedError` `DOMException` before attempting any write.

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
- **Original storer access**: An origin that stores a resource in COS can always read it back via `requestFileHandle()`, regardless of the `origins` value set at write time or whether the hash is on the PHL. This mirrors the Cache API's model where an origin always has access to what it stored.

#### Retrieving files

1. Request a `FileSystemFileHandle` object for the file, specifying the file's hash.
1. Check if the resource exists in COS and make sure it can be shared without causing privacy issues.
1. Retrieve the `FileSystemFileHandle` object after the user agent has granted access.

> [!NOTE]
> A `NotFoundError` `DOMException` does not necessarily mean the file is absent from COS. User agents may suppress availability of a file for privacy reasons (see [Availability gating](#availability-gating)). Callers should handle `NotFoundError` by falling back to a network fetch, regardless of the cause.

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

### Declarative integrations

The imperative JavaScript API in the previous section covers the general case, but several use cases, namely markup-driven resource loading, module imports, and CSS-referenced assets like web fonts, are more naturally expressed declaratively. COS is designed to be reachable from HTML, JavaScript's import attributes, and CSS; all consistently keyed off the same `origins`-style value space used by `requestFileHandle()`: omitted for Same-Site only, a list of origin strings for a specific set of origins, or `*` for global availability.

#### Declarative HTML integration

`<link>` and `<script>` elements that already carry [`integrity`](https://w3c.github.io/webappsec-subresource-integrity/#integrity-element) can opt in to COS with a new `crossoriginstorage` attribute. As in the JavaScript and CSS forms, the `integrity` hash identifies the file in COS, and `crossoriginstorage` specifies which origins may retrieve it.

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

#### Declarative JavaScript integration

[Import attributes](https://github.com/tc39/proposal-import-attributes) provide a way to reach COS from module imports and dynamic `import()`, without going through `navigator.crossOriginStorage` directly. As with the HTML and CSS forms, `integrity` identifies the file in COS, and `crossOriginStorage` specifies which origins may retrieve it.

> [!NOTE]
> The `with { … }` syntax is defined by TC39, but `crossOriginStorage` is a **host-defined attribute key** — like `integrity`, it requires no TC39 involvement and will be defined in the HTML Standard.

##### Example: Same-site only module

An empty array for `crossOriginStorage` opts the module into COS for same-site access only, mirroring the behavior of omitting `origins` in the imperative API:

```js
import data from "same-site-resource.ext" with {
  type: "type",
  integrity: "sha256-abc123...",
  crossOriginStorage: [],
};
```

The same attribute works with dynamic `import()`:

```js
const module = await import("same-site-resource.ext", {
  with: {
    type: "type",
    integrity: "sha256-abc123...",
    crossOriginStorage: [],
  },
});
```

##### Example: Globally available module

By passing `"*"`, the module is made available to any origin that requests the same hash via COS:

```js
import data from "popular-resource.ext" with {
  type: "type",
  integrity: "sha256-abc123...",
  crossOriginStorage: "*",
};
```

The same attributes work with dynamic `import()`:

```js
const module = await import("popular-resource.ext", {
  with: {
    type: "type",
    integrity: "sha256-abc123...",
    crossOriginStorage: "*",
  },
});
```

##### Example: Module restricted to specific origins

To restrict the resource to specific origins, `crossOriginStorage` takes an array of origin strings instead of `"*"`, mirroring the `origins` option in the imperative API:

```js
import data from "acme-inc-corporate.ext" with {
  type: "type",
  integrity: "sha256-def456...",
  crossOriginStorage: ["https://acme-inc.example.com", "https://acme-cdn.example.com"],
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

#### Processing flow common to all declarative integrations

The HTML, JavaScript, and CSS forms above share the same underlying model as the imperative API: a resource is identified by its integrity hash, and a COS lookup is attempted before falling back to the network.

1. The user agent checks COS for a file matching the `integrity` hash. If found and the requesting origin is allowed per the declared `origins`-style value, the resource is served from COS, and no network request is made.
2. Otherwise, the resource is fetched from the declared URL as usual. If the fetched content matches the `integrity` hash and the declared origins permit it, the user agent stores it in COS for future use by this or other origins. If the hash does not match, the resource is rejected per existing `integrity` behavior and is not stored in COS.

Because all three forms piggyback on `integrity`, they inherit its existing failure semantics: a hash mismatch is always treated as a fetch failure, independent of whether COS is involved.

> [!NOTE]
> The hash format differs between the declarative and imperative forms, intentionally so. The `integrity` attribute and `integrity()` CSS modifier follow the [Subresource Integrity](https://w3c.github.io/webappsec-subresource-integrity/) convention and express hashes as base64-encoded strings (e.g., `sha256-abc123…`). The imperative `requestFileHandle()` API uses lowercase hexadecimal strings (e.g., `8f434346…`), which matches the format used by AI model hubs such as [Hugging Face](https://huggingface.co/) when publishing model checksums. The user agent normalizes both representations internally; they identify the same underlying bytes.

## Detailed design discussion

### Hashing

The current hashing algorithm is [SHA-256](https://w3c.github.io/webcrypto/#alg-sha-256), implemented by the **Web Crypto API**. If hashing best practices should change, COS will reflect the [implementers' recommendation](https://w3c.github.io/webcrypto/#algorithm-recommendations-implementers) in the Web Crypto API.

The hashing algorithm used is encoded in the hash object's `algorithm` field as a [`HashAlgorithmIdentifier`](https://w3c.github.io/webcrypto/#dom-hashalgorithmidentifier). This flexible design allows changing the hashing algorithm in the future. The hash string must be a valid lowercase hexadecimal string of length 64 (for SHA-256). The `algorithm` field must be a valid [`HashAlgorithmIdentifier`](https://w3c.github.io/webcrypto/#dom-hashalgorithmidentifier), e.g. `"SHA-256"`.

```js
const hash = {
  algorithm: 'SHA-256',
  value: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
};
```

### Handling multiple files

`requestFileHandle()` operates on one file at a time. For concurrent requests across multiple files and per-file error handling, see the [FAQ on why the API is singular](#why-does-the-api-use-requestfilehandle-singular-rather-than-requestfilehandles-plural).

### Concurrent writes

If two tabs both check COS for the same file, find it absent, and begin downloading, the user agent may receive two concurrent writes for the same hash. The user agent stores the file once; the duplicate download is accepted as an edge-case cost. This proposal does not prescribe coordination between tabs for this scenario.

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
> In the context of AI, its implications for sustainability efforts are undeniable. It's essential to adhere to [Web Sustainability Guidelines](https://w3c.github.io/sustainableweb-wsg/) when integrating AI solutions. Prior to implementing AI, it's recommended to [assess and research visitor needs](https://w3c.github.io/sustainableweb-wsg/#assess-and-research-visitor-needs) to ensure that AI is a justifiable and effective solution that truly improves the experience. For example, by increasing user privacy of video calls by applying AI-based background blurring.

## Considered alternatives

### Adding a description for each file apart from the hash

To facilitate manual COS management, one approach would be to allow developers to store a human-readable description alongside the resource. Apps could reference to the same file identified by a unique hash using different descriptions. For example, an English site could refer to the [`g-2b-it-gpu-int4.bin`](https://storage.googleapis.com/jmstore/kaggleweb/grader/g-2b-it-gpu-int4.bin) AI model as "Gemma AI model from Google", whereas another Spanish site could refer to it as "modelo de IA grande de Google". Instead, we envision user agents to enrich COS management UI based on the hashes. For example, a user agent could know that a file identified by a given hash is a well-known AI model and optionally surface this information to the user in the user agent settings UI.

### Storing files without hashing

Storing files by their names rather than using hashes would risk name collisions, especially in a cross-origin environment. The use of hashes guarantees unique identification of each file, ensuring that the contents are consistently recognized and retrieved. Storing files based on their URLs would work if apps reference the same URLs, for example, on the same CDN, but wouldn't work if apps reference the same file stored at different locations.

### Requiring a minimum file size

One approach would be to require a minimum file size for a resource to be eligible for COS. No minimum file size is proposed. It would be trivial to inflate a file's size to meet any such threshold, for example by appending padding bytes or comments.

### Manually accessing files from a local disk

Different origins can manually open the same file on disk, either using the File System Access API's `showOpenFilePicker()` method or using the classic `<input type="file">` approach. This requires the file to be stored once, and access to the file can then be shared as explained in [Cache AI models in the browser](https://developer.chrome.com/docs/ai/cache-models#special_case_use_a_model_on_a_hard_disk). While this works, it's manual and error-prone, as it requires the user to know what file to choose from their hard drive in the file picker.

### Integrating cross-origin storage in the `fetch()` API

On the server, cross-origin isolation is not really a problem. At the same time, server runtimes like Node.js, Bun, or Deno implement `fetch()` as well. To avoid fragmentation and to keep the present `fetch()` API simple, it does not make sense to add COS to `fetch()`. Since `fetch()` is URL-based, this would also not solve the case where the same file is stored at different locations.

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

Sites are prevented from flooding the cache in an attempt to evict other sites' resources. Each site can only store a limited amount of data in COS, and if a site tries to exceed this limit, the user agent can block the attempt and log a warning to the console.

### Privacy considerations

In browsers that still support third-party cookies, user agents are expected to make this API available only in contexts where third-party cookies are enabled.

#### Cross-site probing

If a file is only used on certain kinds of websites, an attacker can discover that the user visited those sites by checking for the file's presence. For example, if someone has a game engine stored in COS, they probably play games on the web, which an attacker might exploit, for example, for targeted advertising. The attacker site would need to probe hashes of resources it's interested in. The `origins` field mitigates this risk by allowing origins to restrict resource access to a specific set of trusted origins, ensuring the resource is not globally "probeable". Sites are expected to use this field for proprietary resources or when global COS cache hits are not expected.

Beyond the `origins` field, user agents apply [availability gating](#availability-gating) as a second line of defense: even for globally available resources, the user agent may decline to confirm a file's presence if the resource has not been encountered on a sufficient number of distinct origins.

User agents are expected to implement safeguards against such attacks, for example, by limiting the number of probes, or by returning false negatives when a site known to be malicious is probing. Each call to `requestFileHandle()` can be considered a probe, and user agents can limit the number of probes per site or even block probes from sites known to be malicious.

#### Availability gating

Two independent mechanisms control whether a `requestFileHandle()` call returns a file handle or a `NotFoundError`:

- **Access control** (`origins`-based): which origins may obtain a file handle. This is determined by the `origins` field set at write time. An origin that is not in scope receives `NotFoundError`, even if the resource is physically present in COS.
- **Availability gating** (PHL-based): whether the user agent discloses that the resource exists in COS at all. This is determined by whether the hash is on the **Public Hash List (PHL)**, a shared, vendor-neutral allowlist that all browser vendors are expected to respect. A resource not on the PHL receives `NotFoundError` from all cross-origin requesters, even if the requesting origin would otherwise be in scope.

Both conditions must be satisfied for a read to succeed. These two mechanisms are orthogonal. In particular, the PHL and `origins: '*'` are not the same thing: a resource stored with `origins: '*'` but not on the PHL is not cross-origin accessible — the user agent returns `NotFoundError` to all origins except the original storer, because availability gating still applies. Conversely, a PHL resource stored with a specific `origins` list is only accessible to in-scope origins, because access control is still enforced on top of the gating bypass the PHL provides.

**Availability gating in detail.** User agents implement availability gating using the PHL:

- **On the PHL:** The user agent may answer truthfully, returning a handle if the file is present, or a `NotFoundError` `DOMException` if it is absent. ([GREASE'ing](#greasing) may still introduce occasional false negatives even for PHL-listed resources.)
- **Not on the PHL:** The user agent must always return a `NotFoundError` `DOMException`, regardless of whether the file is physically present in COS. The response must be identical whether the file is absent or present, so that cache state cannot be inferred by observing the response or its timing.

The PHL covers well-known resources, such as popular open-source libraries, widely used Wasm modules, web fonts served by major font CDNs, and AI model weights published by recognized model hubs, that are unconditionally eligible for cross-origin availability disclosure because their ubiquity makes cache presence uninformative about any individual user. A hash not on the PHL may still be disclosed if it has met a **popularity threshold** and been encountered on a minimum number of distinct origins (a form of **k-anonymity** where _k_ is that minimum origin count). Hashes that clear neither bar are treated as permanently absent at the API surface: the user agent returns a `NotFoundError` `DOMException` as if the file were not stored in COS at all.

Developers must NOT rely on a `NotFoundError` as definitive proof that a file is absent from COS. A `NotFoundError` MAY indicate that the user agent has withheld confirmation of the file's presence for privacy reasons.

#### GREASE'ing

As an additional privacy mitigation, user agents may employ **GREASE'ing** ([Generate Random Extensions And Sustain Extensibility](https://tools.ietf.org/html/draft-ietf-tls-grease)): occasionally returning a `NotFoundError` `DOMException` even when a file is present in COS. This introduces noise that makes it harder for sites to distinguish a true absence from a privacy-motivated false negative. A similar technique is applied in [UA Client Hints](https://wicg.github.io/ua-client-hints/#grease).

However, user agents must exercise size-proportionate judgment when applying GREASE'ing. For small files, where a fallback to a network fetch is inexpensive, occasional false negatives are a reasonable privacy trade-off. For very large files—such as gigabyte-scale AI model weights—a false negative would force the caller to perform a full re-download, imposing a significant and observable bandwidth and latency cost on the user. User agents must NOT GREASE responses for files whose size makes a spurious re-download clearly disproportionate to the privacy benefit.

#### API response reference

The following tables summarize the response a user agent must return for every combination of inputs. All non-success read-path outcomes return `NotFoundError` — the caller cannot distinguish between a genuine cache miss and a gated or access-controlled resource.

##### Read path

| On PHL? | In COS? | Written with | Requesting origin | GREASEd? | Response |
| -- | -- | -- | -- | -- | -- |
| Yes | Yes | `*` | Any | No | Success |
| Yes | Yes | `*` | Any | Yes | `NotFoundError` |
| Yes | Yes | Same-site or list | In scope | No | Success |
| Yes | Yes | Same-site or list | In scope | Yes | `NotFoundError` |
| Yes | Yes | Same-site or list | Out of scope | — | `NotFoundError` |
| Yes | No | — | — | — | `NotFoundError` |
| No | Yes | Any | Original storer | — | Success |
| No | Yes | Any | Any other origin | — | `NotFoundError` |
| No | No | — | — | — | `NotFoundError` |

##### Write path

| Condition | Written with | Response |
| -- | -- | -- |
| `hash.value` or `hash.algorithm` is malformed | Any | `TypeError` |
| Permissions Policy blocks COS | Any | `NotAllowedError` |
| Valid hash, declared hash matches computed hash | `*` | Success |
| Valid hash, declared hash matches computed hash | Same-site or list | Success |
| Valid hash, declared hash does not match computed hash | Any | `DataError` |

##### Policy

| Condition | Response |
| -- | -- |
| Permissions Policy blocks COS | `NotAllowedError` |

#### Fingerprinting detection

User agents are also expected to use (on-device) machine learning to identify possible fingerprinting attempts. For example, if a site crafts unique hashes for each user (which hints at fingerprinting), user agents can detect this and block the COS probing attempt. Some user agents have [successfully applied this technique](https://blog.google/products/chrome/building-a-more-helpful-browser-with-machine-learning/#:~:text=More%20peace%20of%20mind%2C%20less%20annoying%20prompts) to silence notification spam.

The knowledge an attacker can gain about a user depends heavily on the popularity of the resources stored in COS. If a user has a very popular resource stored, such as a common AI model, a large Wasm module, or a popular JavaScript library, the attacker can only learn that the user visited one of the many sites that use this resource, which is not very useful information. If a user has a very uncommon or even unique resource stored, the attacker can learn that the user visited one of the few sites (or the only site) that use this resource, which is more useful information. However, user agents are expected to implement safeguards against such attacks, as described above.

## Stakeholder feedback / opposition

- **Web Developers**: [Expressed support](#user-research) for enabling sharing of large files without redundant downloads and storage, particularly large AI models, large Wasm modules, and highly popular JavaScript libraries.

## References

- [File System Living Standard](https://fs.spec.whatwg.org/)
- [Web Cryptography API](https://w3c.github.io/webcrypto/)
- [Subresource Integrity](https://w3c.github.io/webappsec-subresource-integrity/)
- [Import Attributes](https://github.com/tc39/proposal-import-attributes)
- [CSS Values and Units Module Level 5](https://drafts.csswg.org/css-values-5/)
- [Cache Digests for HTTP/2](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-cache-digest)
- [Web Sustainability Guidelines (WSG)](https://w3c.github.io/sustainableweb-wsg/)
- [Ethical Web Principles](https://w3ctag.github.io/ethical-web-principles/)

## Acknowledgements

Many thanks for valuable feedback from:

- **Yash Raj Bharti**, independent freelancer
- **Joshua Lochner**, Hugging Face

Many thanks for valuable inspiration or ideas from:

- **Kenji Baheux**, Google Chrome
- **Kevin Moore**, Google Chrome

## Appendices

### Appendix&nbsp;A: Full IDL

```webidl
interface mixin NavigatorCrossOriginStorage {
  [SameObject, SecureContext] readonly attribute CrossOriginStorageManager crossOriginStorage;
};
Navigator includes NavigatorCrossOriginStorage;

[Exposed=(Window,Worker), SecureContext]
interface CrossOriginStorageManager {
  Promise<FileSystemFileHandle> requestFileHandle(
      CrossOriginStorageRequestFileHandleHash hash,
      CrossOriginStorageRequestFileHandleOptions options = {});
};

dictionary CrossOriginStorageRequestFileHandleHash {
  DOMString value; // Must be a valid lowercase hexadecimal string; length varies by algorithm (e.g., 64 characters for SHA-256).
  DOMString algorithm; // Must be a valid HashAlgorithmIdentifier (https://w3c.github.io/webcrypto/#dom-hashalgorithmidentifier), e.g. "SHA-256".
}

dictionary CrossOriginStorageRequestFileHandleOptions {
  optional boolean create = false;
  optional (USVString or sequence<USVString>) origins;
}
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

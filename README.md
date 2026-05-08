# Explainer for the Cross-Origin Storage (COS) API

<img src="https://raw.githubusercontent.com/WICG/cross-origin-storage/refs/heads/main/logo-cos.svg" alt="Cross-Origin Storage (COS) logo, consisting of a folder icon with a crossing person." width="100">

This proposal outlines the design of the **Cross-Origin Storage (COS)** API, which allows web applications to store and retrieve files across different origins. Building on the **File System Living Standard** defined by the WHATWG, the COS API facilitates secure cross-origin file storage and retrieval for large assets, such as AI models, WebAssembly (Wasm) modules, and highly popular JavaScript libraries. Taking inspiration from **Cache Digests for HTTP/2**, the API identifies files by their hashes to ensure integrity.

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

The **Cross-Origin Storage (COS)** API provides a secure mechanism for web applications to store and retrieve large files across different origins. This allows applications to share common assets—such as AI models, Wasm modules, and popular JavaScript libraries—without redundant downloads. Resources are identified by their cryptographic hashes to ensure data integrity. The API reuses concepts like `FileSystemFileHandle` from the **File System Living Standard**, specifically tailored for cross-origin scenarios. The following example demonstrates the basic flow for retrieving a file:

```js
// The hash of the desired file.
const hash = {
  algorithm: 'SHA-256',
  value: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
};
try {
  const [handle] = await navigator.crossOriginStorage.requestFileHandles([
    hash,
  ]);
  // The file exists in Cross-Origin Storage.
  const fileBlob = await handle.getFile();
  // Do something with the blob.
} catch (err) {
  if (err.name === 'NotAllowedError') {
    console.log('The user agent did not grant permission to access the file.');
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

## Potential solution

### File Storage Process

The **COS** API will be available through the `navigator.crossOriginStorage` interface. Files will be stored and retrieved based on their hashes, ensuring that each file is uniquely identified.

#### Storing files

1. Hash the contents of the files using SHA-256 (or an equivalent secure algorithm, see [Appendix&nbsp;B](#appendixb-blob-hash-with-the-web-crypto-api)). The hash algorithm used is communicated as a valid [`HashAlgorithmIdentifier`](https://w3c.github.io/webcrypto/#dom-hashalgorithmidentifier).
1. Request a sequence of `FileSystemFileHandle` objects for the files, specifying the files' hashes.
1. Write the files' data to the `FileSystemFileHandle` objects and store them in Cross-Origin Storage. When `writableStream.write(data)` is called, the user agent **must** verify that the hash of `data` matches the hash declared in the corresponding entry of the `hashes` array, using the algorithm specified in `hash.algorithm`. If the hashes do not match, the user agent **must** throw a `NotAllowedError` `DOMException` and **must not** store the data in COS.

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
  const [handle] = await navigator.crossOriginStorage.requestFileHandles([
    hash,
  ]);
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
      const [handle] = await navigator.crossOriginStorage.requestFileHandles(
        [hash],
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
  // 'NotAllowedError', the user agent did not grant access to the file.
  console.log('The user agent did not grant access to the file.');
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
const [handle] = await navigator.crossOriginStorage.requestFileHandles([hash], {
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

const [handle] = await navigator.crossOriginStorage.requestFileHandles([hash], {
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

const [handle] = await navigator.crossOriginStorage.requestFileHandles([hash], {
  create: true,
});

// Write the file…

// Now, any Same-Site origin  can request the same hash and it will be found.
```

##### Resource visibility upgrades

The visibility of a resource in COS can be upgraded but never downgraded:

- **Restricted to more permissive**: If a resource was initially stored with an `origins` list, any site (including the original storer or a completely different site) can later call `requestFileHandles()` for the same hash with `create: true` and change the `origins` field to a more permissive value. If the user agent verifies the hash matches, the resource is then marked as available according to the new `origins` value. The new site _must still_ write the full file using the returned `FileSystemFileHandle` object, to prevent sites from using this behavior to detect whether a file was previously stored.
- **Permissive to more restricted**: If a resource is already permissively available in COS, any attempt to store it again with a more restrictive `origins` list is ignored. The resource remains globally available, and the user agent should log a warning to the console to inform the developer that the restriction was not applied.

##### Example: Storing multiple files

```js
/**
 * Example usage to store multiple files.
 */

// The hashes of the desired files.
const hashes = [{
  algorithm: 'SHA-256',
  value: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
}, {
  algorithm: 'SHA-256',
  value: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
}];

// First, check if the files are already in COS.
try {
  const handles = await navigator.crossOriginStorage.requestFileHandles(hashes);
  // The files exist in COS.
  for (const handle of handles) {
    const fileBlob = await handle.getFile();
    // Do something with the blob.
    console.log('Retrieved', fileBlob);
  }
  return;
} catch (err) {
  // If the files weren't in COS, load them from the network and store them in
  // COS. The method throws a `NotFoundError` `DOMException` if _any_ of the
  // files is not found.
  if (err.name === 'NotFoundError') {
    try {
      // Load the files from the network.
      const fileBlobs = await loadFilesFromNetwork();
      const handles = await navigator.crossOriginStorage.requestFileHandles(
        hashes,
        {
          create: true,
        },
      );
      handles.forEach((handle, i) => {
        const writableStream = await handle.createWritable();
        await writableStream.write(fileBlobs[i]);
        await writableStream.close();
      });
    } catch (err) {
      // The `write()` failed.
    }
    return;
  }
  // 'NotAllowedError', the user agent did not grant access to the file.
  console.log('The user agent did not grant access to the file.');
}
```

#### Retrieving files

1. Request a sequence of `FileSystemFileHandle` objects for the files, specifying the files' hashes.
1. Check if each resource exists in COS and make sure it can be shared without causing privacy issues.
1. Retrieve the sequence of `FileSystemFileHandle` objects after the user agent has granted access.

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
  const [handle] = await navigator.crossOriginStorage.requestFileHandles([
    hash,
  ]);
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
  // 'NotAllowedError', the user agent did not grant access to the file.
  console.log('The user agent did not grant access to the file.');
}
```

##### Example: Retrieving multiple files

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
  const handles = await navigator.crossOriginStorage.requestFileHandles(hashes);
  // The files exist in COS.
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
  // 'NotAllowedError', the user agent did not grant access to the files.
  console.log('The user agent did not grant access to the files.');
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
  const [handle] = await navigator.crossOriginStorage.requestFileHandles([
    hash,
  ]);

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
      const [handle] = await navigator.crossOriginStorage.requestFileHandles(
        [hash],
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
  // 'NotAllowedError', the user agent did not grant access to the file.
  console.log('The user agent did not grant access to the file.');
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
  const [handle] = await navigator.crossOriginStorage.requestFileHandles([
    hash,
  ]);
  const fileBlob = await handle.getFile();
  console.log('File retrieved', fileBlob);
  // Use the fileBlob as needed.
} catch (err) {
  if (err.name === 'NotFoundError') {
    // The file wasn't in COS.
    console.error(err.name, err.message);
    return;
  }
  // 'NotAllowedError', the user agent did not grant access to the file.
  console.log('The user agent did not grant access to the file.');
}
```

##### Key points

- **Unrelated sites:** The two sites belong to different origins and do not share any context, ensuring the example demonstrates cross-origin capabilities.
- **Strictly opt-in:** Site A explicitly opts in to make the file globally available by setting `origins: '*'` when storing the file. This ensures that the file is not accidentally made available to all sites.
- **Cross-origin sharing:** Despite the different origins, the files are securely identified by their hashes, demonstrating the API's ability to facilitate cross-origin file storage and retrieval.

## Detailed design discussion

### Hashing

The current hashing algorithm is [SHA-256](https://w3c.github.io/webcrypto/#alg-sha-256), implemented by the **Web Crypto API**. If hashing best practices should change, COS will reflect the [implementers' recommendation](https://w3c.github.io/webcrypto/#algorithm-recommendations-implementers) in the Web Crypto API.

The hashing algorithm used is encoded in each hash object's `algorithm` field of the `hashes` array as a [`HashAlgorithmIdentifier`](https://w3c.github.io/webcrypto/#dom-hashalgorithmidentifier). This flexible design allows changing the hashing algorithm in the future.

```js
const hashes = [
  {
    algorithm: 'SHA-256',
    value: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
  },
];
```

### Web sustainability

In the context of [evaluating carbon emissions in digital data usage](https://websitesustainability.com/cache/files/research23.pdf), current methodologies predominantly utilize a [kilowatt-hour (kWh) per gigabyte (GB) framework](https://sustainablewebdesign.org/estimating-digital-emissions/) to estimate the operational energy intensity of data transmission and storage. This approach provides the following energy consumption benchmarks:

- **Network transmission:** 0.013&nbsp;kWh/GB
- **User devices:** 0.081&nbsp;kWh/GB

While this document does not aim to critically assess the precision of these estimates, it is an established principle that minimizing redundant data downloads and storage is inherently beneficial for sustainability. The [Ethical Web Principles](https://w3ctag.github.io/ethical-web-principles/) specifically highlight that the Web [_"is an environmentally sustainable platform"_](https://w3ctag.github.io/ethical-web-principles/#sustainable) and suggest _"lowering carbon emissions by minimizing data storage and processing requirements"_ as measures to achieve this. Consequently, one of the key objectives of the COS API is to enhance Web sustainability by reducing redundant large file downloads when such files are possibly already stored locally on the user's device.

> [!IMPORTANT]
> In the context of AI, its implications for sustainability efforts are undeniable. It's essential to adhere to [Web Sustainability Guidelines](https://w3c.github.io/sustainableweb-wsg/) when integrating AI solutions. Prior to implementing AI, it's recommended to [assess and research visitor needs](https://w3c.github.io/sustainableweb-wsg/#assess-and-research-visitor-needs) to ensure that AI is a justifiable and effective solution that truly improves the experience. For example, by increasing user privacy of video calls by applying AI-based background blurring.

## Open questions

### Concurrency

What should happen if two tabs depend on the same file, check COS, see the file is not in COS, and start downloading? Should this be handled more efficiently? How often does this happen in practice? In the worst case, the file gets downloaded twice, but would then still only be stored once in COS. This proposal does not address this case. In the worst case, the file is downloaded twice but stored only once in COS, which is considered an acceptable outcome.

### Partial COS matches

If the developer wants to check if two files A and B, with the hashes hash_A and hash_B are stored in COS, but only one of the two is stored, the API will still fail with a `NotFoundError` `DOMException` without revealing the partial match. The current position is that revealing partial matches would complicate error handling, particularly since the expected use cases commonly require all files to be present simultaneously—for example, the tokenizer, configuration files, weights, and graph for an AI model. Partial-match disclosure is also undesirable from a privacy perspective, as it would enable limited enumeration of COS contents.

As an alternative, the developer can always check for each file separately if it is stored in COS. This way, the developer can handle partial matches as they see fit, for example, by only downloading the missing files from the network.

### Minimum file size

Should there be a required minimum file size for a file to be eligible for COS? No minimum file size is proposed. It would be trivial to inflate a file's size to meet any such threshold, for example by appending padding bytes or comments.

### Handling of eviction

Under critical storage pressure, user agents could offer a dialog that invites the user to manually free up storage. The user agent could also delete files automatically based on, for example, a least recently used approach.

User agents are further expected to provide settings UI through which users can inspect which files are stored in COS and which origins have most or least recently accessed each file. Users may then choose to delete files from COS through this UI.

When the user clears site data, all usage information associated with the origin should be removed from files in COS. If a file in COS, after the removal of usage information, is deemed unused, the user agent may delete it from COS.

### Manual COS management

If a user already has manually downloaded a file such as a large AI model, should the user agent offer a way to let the user put the file in COS? This could be an affordance provided by the user agent.

## Considered alternatives

### Adding a description for each file apart from the hash

To facilitate manual COS management, one approach would be to allow developers to store a human-readable description alongside the resource. Apps could reference to the same file identified by a unique hash using different descriptions. For example, an English site could refer to the [`g-2b-it-gpu-int4.bin`](https://storage.googleapis.com/jmstore/kaggleweb/grader/g-2b-it-gpu-int4.bin) AI model as "Gemma AI model from Google", whereas another Spanish site could refer to it as "modelo de IA grande de Google". Instead, we envision user agents to enrich COS management UI based on the hashes. For example, a user agent could know that a file identified by a given hash is a well-known AI model and optionally surface this information to the user in the user agent settings UI.

### Storing files without hashing

Storing files by their names rather than using hashes would risk name collisions, especially in a cross-origin environment. The use of hashes guarantees unique identification of each file, ensuring that the contents are consistently recognized and retrieved. Storing files based on their URLs would work if apps reference the same URLs, for example, on the same CDN, but wouldn't work if apps reference the same file stored at different locations.

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

Access is scoped to individual files, [each identified by their hash](#hashing). Developers cannot arbitrarily access any random files or obtain the complete list of resources in COS, ensuring limited and precise access control. Files are uniquely identified by their cryptographic hashes (for example, SHA-256), ensuring data integrity. Hashes prevent tampering with the file contents, that is, a site can be sure it gets the same contents from COS as if it had downloaded the file itself, as COS guarantees that each file's contents matches its hash. For enhanced protection, user agents can check file hashes against virus databases like [VirusTotal](https://www.virustotal.com/gui/home/search), and integrate with in-browser security features like [Safe Browsing](https://safebrowsing.google.com/) even before storing a file.

User agents are expected to provide [settings UI for managing COS files](#handling-of-eviction), showing stored files and their associated origins. Users can manually evict files or clear all COS data, maintaining control over their storage.

User agents are expected to enrich settings UI based on the file hashes. For example, a user agent could know that a file identified by a given hash is a well-known AI model and optionally surface this information to the user in the settings UI.

### Privacy considerations

User agents are expected to make this API available only in contexts where third-party cookies are enabled.

#### Cross-site probing

If a file is only used on certain kinds of websites, an attacker can discover that the user visited those sites by checking for the file's presence. For example, if someone has a game engine stored in COS, they probably play games on the web, which an attacker might exploit, for example, for targeted advertising. The attacker site would need to probe hashes of resources it's interested in. The `origins` field mitigates this risk by allowing origins to restrict resource access to a specific set of trusted origins, ensuring the resource is not globally "probeable". Sites are expected to use this field for proprietary resources or when global COS cache hits are not expected.

Beyond the `origins` field, user agents apply [availability gating](#availability-gating) as a second line of defense: even for globally available resources, the user agent may decline to confirm a file's presence if the resource has not been encountered on a sufficient number of distinct origins.

User agents are expected to implement safeguards against such attacks, for example, by limiting the number of probes, or by returning false negatives when a site known to be malicious is probing. Each call to `requestFileHandles()` can be considered a probe, independent of the number of files requested, and user agents can limit the number of probes per site or even block probes from sites known to be malicious. Counting calls with multiple requested files as one single probe is acceptable, as the API does not reveal which file was (not) found, but just fails with a `NotFoundError` `DOMException`. Therefore, the attacker would still need to make multiple calls to probe for multiple files, which is more easily detectable and more easily blocked by user agents.

#### Availability gating

User agents are expected to implement an **availability gating** mechanism that may suppress the presence of a file in COS even when the file is physically stored there. `requestFileHandles()` must return a `NotFoundError` `DOMException` when the user agent determines that revealing the file's presence would constitute a privacy risk, regardless of whether the file is actually present.

User agents should maintain an **allowlist** of well-known resources—such as AI model weights published by recognized model hubs—that are unconditionally eligible for cross-origin availability disclosure. For resources not on the allowlist, user agents should only confirm a file's presence if it has met a **popularity threshold** and been encountered on a minimum number of distinct origins, ensuring that no file unique to a small set of sites can be used as a cross-site identifier. Resources that do not meet the popularity threshold are treated as absent: the user agent returns a `NotFoundError` `DOMException` as if the file were not stored in COS at all.

Developers must NOT rely on a `NotFoundError` as definitive proof that a file is absent from COS. A `NotFoundError` MAY indicate that the user agent has withheld confirmation of the file's presence for privacy reasons.

#### Cross-site leaks

User agents are also expected to implement safeguards against developers trying to store potentially state-revealing resources in COS through console warnings. For example, if the user agent detects that a site is trying to store a resource with a hash that is unique or uncommon, it can warn the developer that this might be a privacy risk.

### Cache flooding

Sites are prevented from flooding the cache in an attempt to evict other sites' resources. Each site can only store a limited amount of data in COS, and if a site tries to exceed this limit, the user agent can block the attempt and log a warning to the console.

#### Fingerprinting detection

User agents are also expected to use (on-device) machine learning to identify possible fingerprinting attempts. For example, if a site crafts unique hashes for each user (which hints at fingerprinting), user agents can detect this and block the COS probing attempt. Some user agents have [successfully applied this technique](https://blog.google/products/chrome/building-a-more-helpful-browser-with-machine-learning/#:~:text=More%20peace%20of%20mind%2C%20less%20annoying%20prompts) to silence notification spam.

The knowledge an attacker can gain about a user depends heavily on the popularity of the resources stored in COS. If a user has a very popular resource stored, such as a common AI model, a large Wasm module, or a popular JavaScript library, the attacker can only learn that the user visited one of the many sites that use this resource, which is not very useful information. If a user has a very uncommon or even unique resource stored, the attacker can learn that the user visited one of the few sites (or the only site) that use this resource, which is more useful information. However, user agents are expected to implement safeguards against such attacks, as described above.

## Stakeholder feedback / opposition

- **Web Developers**: [Expressed support](#user-research) for enabling sharing of large files without redundant downloads and storage, particularly large AI models, large Wasm modules, and highly popular JavaScript libraries.

## References

- [File System Living Standard](https://fs.spec.whatwg.org/)
- [Web Cryptography API](https://w3c.github.io/webcrypto/)
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
  Promise<sequence<FileSystemFileHandle>> requestFileHandles(
      sequence<CrossOriginStorageRequestFileHandleHash> hashes,
      CrossOriginStorageRequestFileHandleOptions options = {});
};

dictionary CrossOriginStorageRequestFileHandleHash {
  DOMString value;
  DOMString algorithm;
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
    <strong>Answer:</strong> The COS API is shaped after the File System Standard's <a href="https://fs.spec.whatwg.org/#api-filesystemdirectoryhandle-getfilehandle"><code>getFileHandle()</code></a> function (<code>FileSystemDirectoryHandle.getFileHandle(name, options)</code> which returns a <code>FileSystemFileHandle</code>). Instead of the <code>name</code> parameter in `getFileHandle()`, in COS, there is the <code>hashes</code> array that fulfills the equivalent function of uniquely identifying a set of files in COS. If <code>options.create</code> is not set or is set to <code>false</code>, the user agent will return handles for the files identified by the hashes value. If and only if <code>options.create</code> is set to <code>true</code>, the user agent will return handles that can be written to. Optionally, when <code>options.create</code> is <code>true</code>, developers can also provide a list of <code>origins</code> to restrict who can later read the resource, or make the resource globally available.
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
    <strong>Answer:</strong> Yes, the COS API is available in workers, and the same principles apply. For example, a worker can call `navigator.crossOriginStorage.requestFileHandles()` to request access to files in COS, and if granted access, it can read from or write to those files using the returned `FileSystemFileHandle` objects. This allows workers to also benefit from shared resources in COS, such as large AI models or Wasm modules, without needing to download them separately.
</p>
</details>

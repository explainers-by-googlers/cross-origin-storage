# Explainer for the Cross-Origin File System (COFS) API

This proposal outlines the design of the **Cross-Origin File System (COFS)** API, which allows web applications to store and retrieve files across different web origins with explicit user consent. Modeled after the **File System Living Standard** defined by the WHATWG, the COFS API facilitates secure cross-origin file storage and retrieval for large files, such as AI models and shared WebAssembly (Wasm) modules. The API uses file hashes for integrity, while human-readable names allow for easier management.

## Proponents

- Chrome Developer Relations

## Participate

- https://github.com/tomayac/cross-origin-file-system/issues

## Introduction

The **Cross-Origin File System (COFS)** API provides a cross-origin file storage and retrieval mechanism for web applications. It allows applications to store and access large files, such as AI models and shared WebAssembly (Wasm) modules, across domains securely and with user consent. Files are identified by their SHA-256 hashes, ensuring consistency, and a human-readable name can be assigned to files for easier management. The API follows the **File System Living Standard** with a focus on cross-origin usage.

## Goals

COFS aims to:

- Provide a cross-origin file system for web applications to store and retrieve large files like AI models and Wasm modules.
- Ensure security and user control with explicit consent before accessing or storing files.
- Use SHA-256 (or similar, see [Appendix A](#appendix-a-blob-hash-with-the-web-crypto-api)) hashes for file identification, guaranteeing data integrity and consistency.
- Allow developers to assign human-readable names to files for easier management.
  
## Non-goals

COFS does not aim to:

- Replace existing storage solutions such as the **Origin Private File System**, the **Cache API**, **IndexedDB**, or **localStorage**.
- Provide backend or cloud storage solutions.
- Allow cross-origin file access _without_ explicit user consent.

## User research

Feedback from developers working with large AI models, datasets, and WebAssembly modules has highlighted the need for an efficient way to store and retrieve such large files across web applications. These developers are looking for a standardized solution that allows files to be stored once and accessed by multiple applications, without needing to re-upload or re-compile the files repeatedly. COFS ensures this is possible while maintaining privacy and security via user consent.

## Use cases

### Use case 1: Large AI Models

Developers working with large AI models can store these models once and access them across multiple web applications. By using the COFS API, the model can be stored under its hash and retrieved with user consent, minimizing repeated uploads and ensuring file integrity.

### Use case 2: Big Shared Wasm Modules

Web applications that utilize large WebAssembly modules can store these modules using COFS and share them across applications. This enables efficient sharing of resources between applications, reducing redundant downloading and improving performance.

## Potential Solution

### File Storage Process

The **COFS** API will be available through `navigator.crossOriginStorage`. Files will be stored and retrieved using their hashes, ensuring that each file is uniquely identified. A human-readable name can be provided for easier management of files.

#### Storing a file

1. The contents of the file will be hashed using SHA-256 (or an equivalent secure algorithm, see [Appendix A](#appendix-a-blob-hash-with-the-web-crypto-api)).
2. A handle for the file will be requested, specifying the file’s hash and a human-readable name.
3. A permission prompt will be displayed to the user, asking if it’s okay to store the file with the provided name, hash, and size.
4. If a file with the hash already exists, only the human-readable name will be stored by the browser and associated with the current origin.
5. Else, upon user consent, the file and the human-readable name will be stored by the browser and the human-readable name be associated with the current origin.

```js
// Example usage to store a file
const hash = 'abc123def456'; // Assume file is already identified with a hash
const humanReadableName = 'Large AI model';

// If the file already exists, nothing to be done
const fileExists = await navigator.crossOriginStorage.getHandle(hash);

if (!fileExists) {
  const handle = await navigator.crossOriginStorage.getHandle(hash, humanReadableName, { create: true });
  
  // Request user permission and store the file
  const writableStream = await handle.createWritable();
  await writableStream.write(fileBlob);  // Assuming the blob is available
  await writableStream.close();  // Close the writable stream properly after writing
}
```

This will prompt the user to confirm the storage, displaying the human-readable name, file size, and hash.

#### Retrieving a file

1. The application will request a file handle using the file’s hash.
2. A permission prompt will appear, showing the file’s human-readable name and hash.
3. After user consent, the file will be retrieved.

```js
// Retrieve the file handle and human-readable name
const hash = 'abc123def456';

// If the file already exists, get it from the COFS
const fileExists = await navigator.crossOriginStorage.getHandle(hash);

if (fileExists) {
  const { handle, humanReadableName } = await navigator.crossOriginStorage.getHandle(hash);
  
  // Request user permission and retrieve the file
  const fileBlob = await handle.getFile();
  console.log(`Retrieved file: ${humanReadableName}`);
  
  // Return the file as a Blob
  console.log(fileBlob);  // This will return the Blob object
} else {
  // Obtain the the file from the network
  const fileBlob = await fetch('https://example.com/ai-model.bin').then(response => response.blob());
  // Return the file as a Blob
  console.log(fileBlob);  // This will return the Blob object
}
```

## Detailed design discussion

### User Consent

The permission prompt must clearly display the file’s name, size, and hash to ensure users understand what file they are being asked to store or retrieve. The goal is to strike a balance between providing sufficient technical details and maintaining user-friendly simplicity. 

## Considered alternatives

### Alternative: Storing Files Without Hashing

Storing files by their names rather than using hashes would risk collisions and lead to inconsistent access, especially in a cross-origin environment. The use of hashes guarantees unique identification of each file, ensuring that the contents are consistently recognized and retrieved.

## Stakeholder Feedback / Opposition

- **Web Developers**: Positive feedback for enabling sharing large files without repeated downloads, particularly in the context of huge AI models and large Wasm modules.

## References

- [File System Living Standard](https://fs.spec.whatwg.org/)
- [Web Cryptography API](https://w3c.github.io/webcrypto/)

## Acknowledgements

Many thanks for valuable feedback, inspiration, or ideas from:

- Kenji Baheux
- Kevin Moore

## Appendices

### Appendix A: Blob hash with the Web Crypto API

```js
async function getBlobHash(blob) {
  // Get the contents of the blob as binary data contained in an ArrayBuffer
  const arrayBuffer = await blob.arrayBuffer();
  
  // Hash the arrayBuffer using SHA-256
  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
  
  // Convert the ArrayBuffer to a hex string
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(byte => byte.toString(16).padStart(2, '0')).join('');
  
  return hashHex;
}

// Example usage
const fileBlob = await fetch('https://example.com/ai-model.bin').then(response => response.blob());
getBlobHash(fileBlob).then(hash => {
  console.log('Hash:', hash);
});
```

async function getBlobHash(blob) {
  const hashAlgorithmIdentifier = 'SHA-256';

  const arrayBuffer = await blob.arrayBuffer();

  const hashBuffer = await crypto.subtle.digest(
    hashAlgorithmIdentifier,
    arrayBuffer
  );

  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  return `${hashAlgorithmIdentifier}: ${hashHex}`;
}

export { getBlobHash };

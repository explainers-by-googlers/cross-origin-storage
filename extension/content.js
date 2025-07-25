/**
 * This is the ISOLATED world script (the bridge).
 * It has access to chrome.* APIs.
 */

// 1. Inject the main-world.js script into the page's context (MAIN world)
const script = document.createElement('script');
script.src = chrome.runtime.getURL('main-world.js');
script.onload = function () {
  this.remove();
};
(document.head || document.documentElement).appendChild(script);

/**
 * A library to handle base64 encoding and decoding.
 * @namespace base64
 * @property {function(ArrayBuffer): string} encode - Encodes an ArrayBuffer into a base64 string.
 * @property {function(string): ArrayBuffer} decode - Decodes a base64 string into an ArrayBuffer.
 */
var base64 = (function () {
  'use strict';

  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  // Use a lookup table to find the index of each base64 character.
  const lookup = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) {
    lookup[chars.charCodeAt(i)] = i;
  }

  /**
   * Encodes an ArrayBuffer into a base64 string.
   * @param {ArrayBuffer} arraybuffer The ArrayBuffer to encode.
   * @returns {string} The base64-encoded string.
   */
  const encode = (arraybuffer) => {
    const bytes = new Uint8Array(arraybuffer);
    const len = bytes.length;
    let base64 = '';

    for (let i = 0; i < len; i += 3) {
      base64 += chars[bytes[i] >> 2];
      base64 += chars[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)];
      base64 += chars[((bytes[i + 1] & 15) << 2) | (bytes[i + 2] >> 6)];
      base64 += chars[bytes[i + 2] & 63];
    }

    if (len % 3 === 2) {
      base64 = base64.substring(0, base64.length - 1) + '=';
    } else if (len % 3 === 1) {
      base64 = base64.substring(0, base64.length - 2) + '==';
    }

    return base64;
  };

  /**
   * Decodes a base64 string into an ArrayBuffer.
   * @param {string} base64 The base64 string to decode.
   * @returns {ArrayBuffer} The decoded ArrayBuffer.
   */
  const decode = (base64) => {
    const len = base64.length;
    let bufferLength = len * 0.75;

    if (base64.endsWith('==')) {
      bufferLength -= 2;
    } else if (base64.endsWith('=')) {
      bufferLength -= 1;
    }

    const arraybuffer = new ArrayBuffer(bufferLength);
    const bytes = new Uint8Array(arraybuffer);
    let p = 0;

    for (let i = 0; i < len; i += 4) {
      const encoded1 = lookup[base64.charCodeAt(i)];
      const encoded2 = lookup[base64.charCodeAt(i + 1)];
      const encoded3 = lookup[base64.charCodeAt(i + 2)];
      const encoded4 = lookup[base64.charCodeAt(i + 3)];

      bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
      bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
      bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
    }

    return arraybuffer;
  };

  // Expose the public functions.
  return {
    encode: encode,
    decode: decode,
  };
})();

// 2. Listen for messages from the MAIN world script
window.addEventListener('message', (event) => {
  // We only accept messages from ourselves
  if (
    event.source !== window ||
    event.data.source !== 'cos-polyfill-main' ||
    !event.data.id
  ) {
    return;
  }
  const { id, action, data } = event.data;

  // 3. Forward the message to the background script
  if (data.arrayBuffer) {
    // Send ArrayBuffer as Base64.
    data.arrayBuffer = base64.encode(data.arrayBuffer);
  }
  chrome.runtime.sendMessage({ action, data }, (response) => {
    if (response.data.arrayBuffer && response.data.arrayBuffer.length) {
      // Send Base64 as ArrayBuffer.
      response.data.arrayBuffer = base64.decode(response.data.arrayBuffer);
    }
    window.postMessage(
      {
        source: 'cos-polyfill-isolated',
        id: id,
        data: response.data,
      },
      event.origin,
    );
  });
});

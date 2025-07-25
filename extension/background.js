/**
 * Copyright 2025 Google LLC.
 * SPDX-License-Identifier: Apache-2.0
 *
 * This file is adapted from the original iframe.html logic for a
 * Chrome Extension's background service worker.
 */

// Open the cache once when the service worker starts.
const cachePromise = caches.open('cos-storage');

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

// Listen for messages from the content script.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Immediately start an async task.
  (async () => {
    const { action, data } = request;
    const cache = await cachePromise;
    let responseData;

    try {
      switch (action) {
        case 'requestFileHandles': {
          const { hashes, create } = data;
          const success = [];
          for (const hash of hashes) {
            const handle = await getFileHandle(cache, hash, create);
            if (!handle) {
              responseData = { hashes, success };
              sendResponse({ data: responseData });
              return; // Exit early
            }
            success.push(handle);
          }
          responseData = { hashes, success };
          break;
        }
        case 'getFileData': {
          const { hash } = data;
          let arrayBuffer = await getFileData(cache, hash);
          responseData = { hash, arrayBuffer };
          break;
        }
        case 'storeFileData': {
          let { hash, arrayBuffer, mimeType } = data;
          await storeFileData(cache, hash, arrayBuffer, mimeType);
          responseData = { hash, arrayBuffer };
          break;
        }
        case 'getPermission': {
          const { host } = data;
          const permissions = await chrome.storage.local.get('cosPermissions');
          const hostPermission =
            (permissions.cosPermissions || {})[host] || false;
          responseData = { permission: hostPermission };
          break;
        }
        case 'storePermission': {
          const { host, permission } = data;
          const result = await chrome.storage.local.get('cosPermissions');
          const permissions = result.cosPermissions || {};
          permissions[host] = permission;
          await chrome.storage.local.set({ cosPermissions: permissions });
          responseData = { success: true };
          break;
        }
        default:
          console.warn('Unknown action:', action);
          responseData = { error: `Unknown action: ${action}` };
          break;
      }
      // Send the successful response at the end.
      if (responseData) {
        sendResponse({ data: responseData });
      }
    } catch (error) {
      // Send an error response if something goes wrong.
      console.error(`Error processing action "${action}":`, error);
      sendResponse({ error: error.message });
    }
  })();

  // ✅ CRITICAL: Return true immediately to indicate we will send a response asynchronously.
  return true;
});

// --- Helper functions remain the same ---

function generateCacheKey(hash) {
  //return `https://cos.polyfill.cache/${hash.value}`;
  return hash.value;
}

async function storeFileData(cache, hash, arrayBuffer, mimeType) {
  const key = generateCacheKey(hash);
  /*
  arrayBuffer = base64.decode(arrayBuffer);
  await cache.put(
    key,
    new Response(arrayBuffer, {
      headers: {
        'content-type': mimeType['content-type'] || 'application/octet-stream',
      },
    }),
  );
  */
  await chrome.storage.local.set({
    [key]: arrayBuffer,
  });
}

async function getFileData(cache, hash) {
  const key = generateCacheKey(hash);
  /*
  const response = await cache.match(key);
  // Data comes as ArrayBuffer out of Cache, but send as Base64.
  return base64.encode(response.arrayBuffer());
  */
  const response = (await chrome.storage.local.get(key))[key];
  return response;
}

async function getFileHandle(cache, hash, create) {
  const key = generateCacheKey(hash);
  /*
  if (!create) {
    return !!(await cache.match(key));
  }
  return true;
  */
  if (!create) {
    return (await chrome.storage.local.getKeys()).includes(key);
  }
  return true;
}

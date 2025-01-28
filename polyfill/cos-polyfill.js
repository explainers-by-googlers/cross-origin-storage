/**
 * Copyright 2025 Google LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

(() => {
  const POLYFILL_IFRAME_SRC = new URL('iframe.html', import.meta.url);

  let iframe;
  let iframeReadyPromise;

  function createIframe() {
    iframe = document.createElement('iframe');
    iframeReadyPromise = new Promise((resolve) => {
      iframe.onload = resolve;
    });

    iframe.src = POLYFILL_IFRAME_SRC;
    iframe.style.display = 'none';
    document.body.append(iframe);
  }

  async function talkToIframe(action, payload) {
    return new Promise((resolve, reject) => {
      function handleIframeMessage(event) {
        window.removeEventListener('message', handleIframeMessage);

        const { action: responseAction, data } = event.data;
        if (responseAction !== action) {
          return;
        }

        if (responseAction === 'requestFileHandles') {
          handleRequestFileHandlesResponse(data).then(resolve).catch(reject);
        } else if (responseAction === 'getFileData') {
          resolve(data.arrayBuffer);
        } else if (responseAction === 'storeFileData') {
          resolve(data);
        } else {
          reject(new Error(`Unexpected action: ${responseAction}`));
        }
      }

      window.addEventListener('message', handleIframeMessage);

      iframe.contentWindow.postMessage({ action, data: payload }, '*');
    });
  }

  async function handleRequestFileHandlesResponse(data) {
    if (!data.success.length) {
      throw new DOMException(
        `File${data.hashes.length > 1 ? 's' : ''} "${data.hashes.map((hash) => hash.value).join(', ')}" not found in cross-origin storage.`,
        'NotFoundError',
      );
    }

    const { hashes } = data;
    const handles = [];
    for (const hash of hashes) {
      handles.push({
        getFile: async () => {
          return await talkToIframe('getFileData', { hash });
        },
        createWritable: async () => {
          return {
            write: async (blob) => {
              return await talkToIframe('storeFileData', {
                hash,
                arrayBuffer: await blob.arrayBuffer(),
              });
            },
            close: async () => {
              // no-op
            },
          };
        },
      });
    }
    return handles;
  }

  async function requestFileHandles(hashes, create = false) {
    await iframeReadyPromise;

    if (!create) {
      const hostname = location.hostname;
      const message = `${hostname} wants to check if your browser already has files the site needs, possibly saved from another site. If found, it will use the files without changing them.`;
      const userPermission = confirm(message);
      if (!userPermission) {
        throw new DOMException(
          `The user did not grant permission to access the file${hashes.length > 1 ? 's' : ''} "${hashes.map((hash) => hash.value).join(', ')}".`,
          'NotAllowedError',
        );
      }
    }

    return talkToIframe('requestFileHandles', { hashes, create });
  }

  const crossOriginStorage = {
    requestFileHandles: async (hashes, options = {}) => {
      if (!hashes) {
        throw new TypeError(
          `Failed to execute 'requestFileHandles': first argument 'hashes' is required.`,
        );
      }
      if (!Array.isArray(hashes)) {
        throw new TypeError(
          `Failed to execute 'requestFileHandles': first argument 'hashes' must be an array.`,
        );
      }
      for (const hash of hashes) {
        if (!hash.value) {
          throw new TypeError(
            `Failed to execute 'requestFileHandles': missing required 'hash.value'.`,
          );
        }
        if (!hash.algorithm) {
          throw new TypeError(
            `Failed to execute 'requestFileHandles': missing required 'hash.algorithm'.`,
          );
        }
      }
      const { create = false } = options;
      return await requestFileHandles(hashes, create);
    },
  };

  if (!navigator.crossOriginStorage) {
    Object.defineProperty(navigator, 'crossOriginStorage', {
      value: crossOriginStorage,
      writable: false,
    });
  }

  createIframe();
})();

(function () {
  const POLYFILL_IFRAME_SRC = new URL('iframe.html',import.meta.url);
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
        const { action: responseAction, data } = event.data;

        if (responseAction !== action) return;

        window.removeEventListener('message', handleIframeMessage);

        if (responseAction === 'requestFileHandle') {
          handleRequestFileHandleResponse(data).then(resolve).catch(reject);
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

  async function handleRequestFileHandleResponse(data) {
    if (!data.success) {
      throw new DOMException(
        `File "${data.name}" not found in cross-origin storage.`,
        'NotFoundError'
      );
    }

    const { hash, name } = data;
    return {
      name,
      getFile: async () => {
        return await talkToIframe('getFileData', { hash });
      },
      createWritable: async () => {
        return {
          write: async (blob) => {
            return await talkToIframe('storeFileData', { hash, arrayBuffer: await blob.arrayBuffer() });
          },
          close: async () => {
            // no-op
          },
        };
      },
    };
  }

  async function requestFileHandle(hash, name, create = false) {
    await iframeReadyPromise;

    const hostname = location.hostname;
    const message = create
      ? `${hostname} wants to store the file "${name}" in your browser.`
      : `${hostname} wants to access the file "${name}" stored in your browser.`;

    const userPermission = confirm(message);
    if (!userPermission) {
      throw new DOMException(
        `The user did not grant permission to ${create ? 'create' : 'access'} the file "${name}".`,
        'NotAllowedError'
      );
    }

    return talkToIframe('requestFileHandle', { hash, name, create });
  }

  const crossOriginStorage = {
    requestFileHandle: async (hash, options = {}) => {
      if (!hash) {
        throw new TypeError(
          `Failed to execute 'requestFileHandle': first argument 'hash' is required.`
        );
      }

      const { name, create = false } = options;
      if (!name) {
        throw new TypeError(
          `Failed to execute 'requestFileHandle': 'options.name' is required.`
        );
      }

      return await requestFileHandle(hash, name, create);
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

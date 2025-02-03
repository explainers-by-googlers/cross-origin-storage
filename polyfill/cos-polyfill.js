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

  function createPermissionDialogIframe(host) {
    const iframe = document.createElement('iframe');
    const html = `
<style>
  button {
    width: fit-content;
    min-width: 200px;
    background-color: #004a77;
    color: #c2e7ff;
    padding: 0.5rem;
    margin: 0.5rem;
    border-radius: 20px;
    border: none;
    display: block;
    font: inherit;
  }
  button:hover {
    background-color: #2677a8;
  }
  h1 {
    font-weight: bold;
    font-size: 16px;
  }
  dialog {
    border-radius: 20px;
    outline: solid 1px;
    outline-offset: -1px;
    margin-block-start: -8px;
    font-family: system-ui, sans-serif;
    font-size: 14px;
    border: none;
    box-sizing: border-box;
    block-size: 100%;
    width: fit-content;
    max-width: 500px;
  }
  input {
    position: absolute;
    right: 20px;
    top: 20px;
    border-radius: 50%;
    appearance: none;
    border: none;
    font-size: 20px;
  }
  section {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  @supports (align-items: anchor-center) {
    section {
      align-items: anchor-center;
    }
  }
  @media (prefers-color-scheme: dark) {
    dialog {
      color: #c7c7c7;
      background-color: #1f1f1f;
      outline-color: #222;
    }
    input {
      color: #c7c7c7;
      background-color: #1f1f1f;
    }
    input:hover {
      filter: brightness(1.4);
    }
  }
  @media (prefers-color-scheme: light) {
    dialog {
      outline-color: #eee;
    }
    input:hover {
      filter: brightness(0.8);
    }
  }
</style>
<dialog open>
  <h1>${host} wants to</h1>
  <section>
    <div>
      <svg width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg"><style>path {stroke: #c7c7c7;}</style><path d="M10 17c-1.958 0-3.618-.292-4.98-.875C3.675 15.542 3 14.833 3 14V6c0-.833.68-1.542 2.042-2.125C6.402 3.292 8.056 3 10 3c1.93 0 3.576.292 4.938.875C16.311 4.458 17 5.167 17 6v8c0 .833-.68 1.542-2.042 2.125-1.36.583-3.014.875-4.958.875Zm0-9.5c1.194 0 2.347-.146 3.458-.438C14.57 6.758 15.25 6.402 15.5 6c-.25-.389-.938-.736-2.063-1.042A12.905 12.905 0 0 0 10 4.5c-1.194 0-2.354.153-3.48.458C5.41 5.264 4.737 5.611 4.5 6c.236.403.903.757 2 1.063 1.111.291 2.278.437 3.5.437Zm0 4c.583 0 1.139-.028 1.667-.083.527-.07 1.02-.16 1.479-.271.472-.111.903-.25 1.291-.417a5.92 5.92 0 0 0 1.063-.604v-2.27c-.333.18-.708.346-1.125.5-.403.138-.84.256-1.313.353-.472.098-.965.174-1.479.23a20.646 20.646 0 0 1-3.208 0 15.708 15.708 0 0 1-1.48-.23 12.065 12.065 0 0 1-1.312-.354 7.89 7.89 0 0 1-1.083-.5v2.271c.306.222.653.424 1.042.604.389.167.812.306 1.27.417.473.11.973.201 1.5.27.542.056 1.105.084 1.688.084Zm0 4c.611 0 1.222-.042 1.833-.125a15.99 15.99 0 0 0 1.709-.354c.527-.153.965-.32 1.312-.5.361-.18.577-.368.646-.563v-2.104c-.333.18-.708.347-1.125.5-.403.14-.84.257-1.313.354-.472.098-.965.174-1.479.23a20.631 20.631 0 0 1-3.208 0 15.698 15.698 0 0 1-1.48-.23 12.059 12.059 0 0 1-1.312-.354 7.898 7.898 0 0 1-1.083-.5V14c.07.18.278.361.625.542.361.18.799.34 1.313.479.527.139 1.104.257 1.729.354.625.083 1.236.125 1.833.125Z" fill="#000"/></svg>
    </div>
    <div>
      <p>Check if your browser already has files the site needs, possibly saved from another site. If found, it will use the files without changing them.</p>
    </div>
  </section>
  <form method="dialog">
    <input type="submit" aria-label="close" value="×">
    <button type="submit" value="allow-session">Allow while visiting the site</button>
    <button type="submit" value="allow-once">Allow this time</button>
    <button type="submit" value="never-allow">Never allow</button>
  </form>
  <p>⚠️ This is not a real permission prompt.</p>
</dialog>`;
    iframe.style.height = '324px';
    iframe.style.width = '500px';
    iframe.style.border = 'none';
    iframe.style.borderRadius = '20px';
    iframe.style.position = 'fixed';
    iframe.style.top = '0px';
    iframe.style.left = '120px';
    iframe.style.overflow = 'hidden';
    document.body.append(iframe);
    iframe.srcdoc = html;
    return iframe;
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
        } else if (responseAction === 'getPermission') {
          resolve(data.permission);
        } else if (responseAction === 'storePermission') {
          resolve(data.success);
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
    // Only ask for permission if `{create: false}`.;
    if (!create) {
      return new Promise(async (resolve, reject) => {
        const host = location.host;
        // If the site may always use COS, don't ask for permission.
        const permission = await talkToIframe('getPermission', { host });
        if (permission === 'allow-session') {
          return resolve(
            talkToIframe('requestFileHandles', { hashes, create }),
          );
        } else if (permission === 'never-allow') {
          return reject(
            new DOMException(
              `The user did not grant permission to access the file${hashes.length > 1 ? 's' : ''} "${hashes.map((hash) => hash.value).join(', ')}".`,
              'NotAllowedError',
            ),
          );
        }
        // Ask for permission.
        const iframe = createPermissionDialogIframe(host);
 	      iframe.onload = () => {
          const dialog = iframe.contentDocument.body.querySelector('dialog');
          dialog.returnValue = '';
          dialog.addEventListener('close', async () => {
            iframe.remove();
            let returnValue = dialog.returnValue;
            if (returnValue === '×') {
              returnValue = '';
            }
            dialog.remove();
            if (
              returnValue === 'never-allow' ||
              returnValue === 'allow-session'
            ) {
              await talkToIframe('storePermission', {
                host,
                permission: returnValue,
              });
            }
            if (!returnValue || returnValue === 'never-allow') {
              return reject(
                new DOMException(
                  `The user did not grant permission to access the file${hashes.length > 1 ? 's' : ''} "${hashes.map((hash) => hash.value).join(', ')}".`,
                  'NotAllowedError',
                ),
              );
            }
            return resolve(
              talkToIframe('requestFileHandles', { hashes, create }),
            );
          });
        }
      });
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
      return await requestFileHandles(hashes, create).catch((err) => {
        throw err;
      });
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

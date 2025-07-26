import ResourceManager from './resource-manager.js';

let creating; // A global promise to avoid concurrency issues

async function setupOffscreenDocument(path) {
  // Check all windows controlled by the service worker to see if one
  // of them is the offscreen document with the given path
  const offscreenUrl = chrome.runtime.getURL(path);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl],
  });

  if (existingContexts.length > 0) {
    return;
  }

  // create offscreen document
  if (creating) {
    await creating;
  } else {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Create Blob URLs',
    });
    await creating;
    creating = null;
  }
}

const resourceManager = new ResourceManager();

// Create the offscreen document for Blob operations.
(async () => {
  await setupOffscreenDocument('offscreen.html');
  // Load the initial state when the extension starts.
  await resourceManager.loadManagerFromStorage();
})();

// Open the cache once when the service worker starts.
const cachePromise = caches.open('cos-storage');
let cache;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    cache = await cachePromise;
    let responseData;
    const { action, data, target } = message;
    if (target && target === 'offscreen-doc') {
      return;
    }
    try {
      switch (action) {
        case 'requestFileHandles': {
          const { origin, hashes, create } = data;
          const success = [];
          for (const hash of hashes) {
            const handle = await getFileHandle(hash, create);
            if (!handle) {
              responseData = { hashes, success };
              sendResponse({ data: responseData });
              return;
            }
            success.push(handle);
            // Log access statistics.
            resourceManager.recordAccess(origin, hash.value);
          }
          resourceManager.saveManagerToStorage();
          responseData = { hashes, success };
          break;
        }
        case 'getFileData': {
          const { hash } = data;
          let blobURL = await getFileData(hash);
          responseData = { hash, blobURL };
          break;
        }
        case 'storeFileData': {
          let { hash, blobURL, mimeType } = data;
          const blob = await fetch(blobURL).then((response) => response.blob());
          await storeFileData(hash, blob, mimeType);
          responseData = { hash };
          break;
        }
        case 'getPermission': {
          const { origin } = data;
          const permissions = await chrome.storage.local.get('cosPermissions');
          const hostPermission =
            (permissions.cosPermissions || {})[origin] || false;
          responseData = { permission: hostPermission };
          break;
        }
        case 'storePermission': {
          const { origin, permission } = data;
          const result = await chrome.storage.local.get('cosPermissions');
          const permissions = result.cosPermissions || {};
          permissions[origin] = permission;
          await chrome.storage.local.set({ cosPermissions: permissions });
          responseData = { success: true };
          break;
        }
        default:
          console.warn('Unknown action:', action);
          responseData = { error: `Unknown action: ${action}` };
          break;
      }

      if (responseData) {
        sendResponse({ data: responseData });
      }
    } catch (error) {
      console.error(`Error processing action "${action}":`, error);
      sendResponse({ error: error.message });
    }
  })();

  return true;
});

function generateCacheKey(hash) {
  return `https://cos.example.com/${hash.algorithm}_${hash.value}`;
}

async function storeFileData(hash, blob, mimeType) {
  const key = generateCacheKey(hash);
  await cache.put(
    key,
    new Response(blob, {
      headers: {
        'content-type': mimeType['content-type'] || 'application/octet-stream',
      },
    }),
  );
}

async function getFileData(hash) {
  const key = generateCacheKey(hash);
  const match = await cache.match(key);
  if (!match) {
    return false;
  }
  return new Promise((resolve) => {
    // Data comes as Blob out of Cache, but send as Blob URL.
    chrome.runtime.sendMessage(
      {
        action: 'getBlobURL',
        target: 'offscreen-doc',
        data: {
          key,
        },
      },
      (response) => {
        resolve(response.data.blobURL);
      },
    );
  });
}

async function getFileHandle(hash, create) {
  const key = generateCacheKey(hash);
  if (!create) {
    return !!(await cache.match(key));
  }
  return true;
}

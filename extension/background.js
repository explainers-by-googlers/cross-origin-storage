(async () => {
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Create Blob URLs',
  });
})();

// NOTE: Paste the refactored ResourceManager class from step 1 here.
class ResourceManager {
  constructor(historyLimit = 3) {
    this.historyLimit = historyLimit;
    this.originToHashes = {};
    this.hashToOrigins = {};
    this.accessHistory = {};
  }
  recordAccess(origin, hash, timestamp = new Date()) {
    if (!this.originToHashes[origin]) {
      this.originToHashes[origin] = [];
    }
    if (!this.originToHashes[origin].includes(hash)) {
      this.originToHashes[origin].push(hash);
    }
    if (!this.hashToOrigins[hash]) {
      this.hashToOrigins[hash] = [];
    }
    if (!this.hashToOrigins[hash].includes(origin)) {
      this.hashToOrigins[hash].push(origin);
    }
    const key = `${origin}|${hash}`;
    if (!this.accessHistory[key]) {
      this.accessHistory[key] = [];
    }
    this.accessHistory[key].unshift(timestamp.toISOString());
    if (this.accessHistory[key].length > this.historyLimit) {
      this.accessHistory[key].length = this.historyLimit;
    }
  }
  getHashesByOrigin(origin) {
    return this.originToHashes[origin] || [];
  }
  getOriginsByHash(hash) {
    return this.hashToOrigins[hash] || [];
  }
  getAllOrigins() {
    return Object.keys(this.originToHashes).sort();
  }
  getAllHashes() {
    return Object.keys(this.hashToOrigins).sort();
  }
  getAccessHistory(origin, hash) {
    return this.accessHistory[`${origin}|${hash}`] || [];
  }
}

const STORAGE_KEY = 'resourceManagerData';
const manager = new ResourceManager(3);

/**
 * Loads the manager's state from chrome.storage.local.
 */
async function loadManagerFromStorage() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  if (data[STORAGE_KEY]) {
    const stored = data[STORAGE_KEY];
    manager.originToHashes = stored.originToHashes || {};
    manager.hashToOrigins = stored.hashToOrigins || {};
    manager.accessHistory = stored.accessHistory || {};
  }
}

/**
 * Saves the manager's current state to chrome.storage.local.
 */
async function saveManagerToStorage() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      originToHashes: manager.originToHashes,
      hashToOrigins: manager.hashToOrigins,
      accessHistory: manager.accessHistory,
    },
  });
}

// Load the initial state when the extension starts.
loadManagerFromStorage();

// Open the cache once when the service worker starts.
const cachePromise = caches.open('cos-storage');
let cache;

// Listen for messages from other parts of the extension.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Immediately start an async task.
  (async () => {
    cache = await cachePromise;
    let responseData;
    const { action, data } = message;
    try {
      switch (action) {
        case 'getResourceData': {
          // The popup is requesting data to display.
          sendResponse({
            originToHashes: manager.originToHashes,
            hashToOrigins: manager.hashToOrigins,
            accessHistory: manager.accessHistory,
          });
          break;
        }
        case 'requestFileHandles': {
          const { origin, hashes, create } = data;
          const success = [];
          for (const hash of hashes) {
            const handle = await getFileHandle(hash, create);
            if (!handle) {
              responseData = { hashes, success };
              sendResponse({ data: responseData });
              return; // Exit early
            }
            success.push(handle);
            // The hash object from the page has { algorithm, value }
            manager.recordAccess(origin, hash.value);
          }
          saveManagerToStorage(); // Persist changes
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
  return new Promise((resolve, reject) => {
    // Data comes as Blob out of Cache, but send as Blob URL.
    chrome.runtime.sendMessage(
      {
        action: 'getBlobURL',
        target: 'offscreen-doc',
        data: {
          key,
        },
      },
      async (response) => {
        resolve(response.data.blobURL);
      },
    );
  });

  /*
  let response = (await chrome.storage.local.get(key))[key];
  response = base64.decode(response);
  return response;
  */
}

async function getFileHandle(hash, create) {
  const key = generateCacheKey(hash);

  if (!create) {
    return !!(await cache.match(key));
  }
  return true;
  /*
  if (!create) {
    return (await chrome.storage.local.getKeys()).includes(key);
  }
  return true;
  */
}

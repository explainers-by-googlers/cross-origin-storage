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

// Listen for messages from other parts of the extension.
chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (message.action === 'trackResourceAccess') {
    const origin = sender.origin;
    const { hashes } = message.data;

    if (origin && hashes) {
      hashes.forEach((hash) => {
        // The hash object from the page has { algorithm, value }
        manager.recordAccess(origin, hash.value);
      });
      saveManagerToStorage(); // Persist changes
      sendResponse({ success: true, message: 'Access tracked.' });
    }
    return true; // Keep the message channel open for async response
  }

  if (message.action === 'getResourceData') {
    // The popup is requesting data to display.
    sendResponse({
      originToHashes: manager.originToHashes,
      hashToOrigins: manager.hashToOrigins,
      accessHistory: manager.accessHistory,
    });
    return true;
  }
});

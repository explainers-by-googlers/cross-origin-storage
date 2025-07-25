const HISTORY_LIMIT = 3;
const STORAGE_KEY = 'resourceManagerData';

class ResourceManager {
  constructor() {
    this.historyLimit = HISTORY_LIMIT;
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
    return this.originToHashes[origin].sort() || [];
  }

  getOriginsByHash(hash) {
    return this.hashToOrigins[hash].sort() || [];
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

  async loadManagerFromStorage() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    if (data[STORAGE_KEY]) {
      const stored = data[STORAGE_KEY];
      this.originToHashes = stored.originToHashes || {};
      this.hashToOrigins = stored.hashToOrigins || {};
      this.accessHistory = stored.accessHistory || {};
    }

  }

  async saveManagerToStorage() {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        originToHashes: this.originToHashes,
        hashToOrigins: this.hashToOrigins,
        accessHistory: this.accessHistory,
      },
    });
  }
}

export default ResourceManager;

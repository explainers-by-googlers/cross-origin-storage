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
    return this.originToHashes[origin]
      ? [...this.originToHashes[origin]].sort()
      : [];
  }

  getOriginsByHash(hash) {
    return this.hashToOrigins[hash] ? [...this.hashToOrigins[hash]].sort() : [];
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

  /**
   * Deletes one or more resources based on their hash value(s).
   * @param {string|string[]} hashesToDelete - A single hash string or an array of hash strings.
   */
  async deleteResourcesByHash(hashesToDelete) {
    // Standardize input to always be an array for consistent processing.
    const hashes = Array.isArray(hashesToDelete)
      ? hashesToDelete
      : [hashesToDelete];
    let itemsWereDeleted = false;

    for (const hash of hashes) {
      // Find all origins associated with this hash.
      const origins = this.hashToOrigins[hash];
      if (!origins) {
        console.warn(`Resource with hash ${hash} not found. Skipping.`);
        continue;
      }

      itemsWereDeleted = true;

      // Remove the hash from each associated origin's list.
      for (const origin of origins) {
        if (this.originToHashes[origin]) {
          this.originToHashes[origin] = this.originToHashes[origin].filter(
            (h) => h !== hash,
          );
          // If the origin now has no hashes, remove the origin key itself.
          if (this.originToHashes[origin].length === 0) {
            delete this.originToHashes[origin];
          }
        }
        // Remove the access history for the origin-hash pair.
        delete this.accessHistory[`${origin}|${hash}`];
      }

      // Remove the hash from the central hash-to-origins map.
      delete this.hashToOrigins[hash];
    }

    // If any changes were made, persist them to storage.
    if (itemsWereDeleted) {
      await this.saveManagerToStorage();
    }
  }

  async loadManagerFromStorage() {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      if (data[STORAGE_KEY]) {
        const stored = data[STORAGE_KEY];
        this.originToHashes = stored.originToHashes || {};
        this.hashToOrigins = stored.hashToOrigins || {};
        this.accessHistory = stored.accessHistory || {};
      }
    } catch (error) {
      console.error('Error loading resource manager from storage:', error);
    }
  }

  async saveManagerToStorage() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          originToHashes: this.originToHashes,
          hashToOrigins: this.hashToOrigins,
          accessHistory: this.accessHistory,
        },
      });
    } catch (error) {
      console.error('Error saving resource manager to storage:', error);
    }
  }
}

export default ResourceManager;

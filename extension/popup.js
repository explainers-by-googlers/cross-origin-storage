class ResourceManager {
  /**
   * @param {number} historyLimit - The max number of access times to store.
   */
  constructor(historyLimit = 3) {
    this.historyLimit = historyLimit;
    // Map: origin (string) => Set of hashes (string)
    this.originToHashes = new Map();
    // Map: hash (string) => Set of origins (string)
    this.hashToOrigins = new Map();
    // New: Map to store access timestamps
    // Key: `${origin}|${hash}`, Value: Array of Date objects
    this.accessHistory = new Map();
  }

  /**
   * Records an access for an origin-resource pair at a specific time.
   * @param {string} origin - The origin URL.
   * @param {string} hash - The SHA-256 hash of the resource.
   * @param {Date} [timestamp=new Date()] - The time of access (defaults to now).
   */
  recordAccess(origin, hash, timestamp = new Date()) {
    // First, ensure the primary relationship links exist
    if (!this.originToHashes.has(origin)) {
      this.originToHashes.set(origin, new Set());
    }
    this.originToHashes.get(origin).add(hash);

    if (!this.hashToOrigins.has(hash)) {
      this.hashToOrigins.set(hash, new Set());
    }
    this.hashToOrigins.get(hash).add(origin);

    // Now, record the timestamp for this specific access
    const key = `${origin}|${hash}`;
    if (!this.accessHistory.has(key)) {
      this.accessHistory.set(key, []);
    }
    const timestamps = this.accessHistory.get(key);

    // Add the new timestamp to the beginning of the array
    timestamps.unshift(timestamp);

    // Trim the array to ensure it doesn't exceed the history limit
    if (timestamps.length > this.historyLimit) {
      timestamps.length = this.historyLimit;
    }
  }

  /**
   * Retrieves the access history for a specific origin-resource pair.
   * @param {string} origin
   * @param {string} hash
   * @returns {Date[]} - An array of Date objects, most recent first.
   */
  getAccessHistory(origin, hash) {
    const key = `${origin}|${hash}`;
    return this.accessHistory.get(key) || [];
  }

  // --- Existing methods remain the same ---
  getHashesByOrigin(origin) {
    return this.originToHashes.get(origin) || new Set();
  }
  getOriginsByHash(hash) {
    return this.hashToOrigins.get(hash) || new Set();
  }
  getAllOrigins() {
    return [...this.originToHashes.keys()].sort();
  }
  getAllHashes() {
    return [...this.hashToOrigins.keys()].sort();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // 1. Initialize the resource manager with a history limit of 3
  const resourceManager = new ResourceManager(3);

  // 2. Populate with sample data, simulating accesses over time
  const hashB = 'sha256-B/O2pM2d9wT9p2L+3s4e5v6f7w8g9h0i+j1k2l3m4n5o=';
  const hashC = 'sha256-C/d3qN3e0xU0q3M/4t5f6w7g8h9i0j+k1l2m3n4o5p=';
  const hashD = 'sha256-D/e4rO4f1yV1r4N/5u6g7x8h9i0j+k1l2m3n4o5p6q=';
  const hashE = 'sha256-E/f5sP5g2zW2s5O/6v7h8y9i0j+k1l2m3n4o5p6q7r=';

  // To simulate history, we record accesses with past timestamps
  const now = Date.now();
  const sampleAccesses = [
    // This access is the 4th one for example.com & hashB, so it will be ignored due to the limit=3
    {
      origin: 'https://example.com',
      hash: hashB,
      time: new Date(now - 900000),
    }, // 15m ago
    {
      origin: 'https://example.com',
      hash: hashB,
      time: new Date(now - 600000),
    }, // 10m ago
    {
      origin: 'https://example.org',
      hash: hashC,
      time: new Date(now - 120000),
    }, // 2m ago
    { origin: 'https://my-app.io', hash: hashE, time: new Date(now - 60000) }, // 1m ago
    { origin: 'https://example.com', hash: hashB, time: new Date(now - 30000) }, // 30s ago
    { origin: 'https://example.org', hash: hashC, time: new Date(now - 15000) }, // 15s ago
    { origin: 'https://example.com', hash: hashC, time: new Date(now - 10000) }, // 10s ago
    { origin: 'https://example.org', hash: hashD, time: new Date(now - 8000) }, // 8s ago
    { origin: 'https://my-app.io', hash: hashB, time: new Date(now - 5000) }, // 5s ago
  ];

  // Process accesses from oldest to newest to build up the history correctly
  sampleAccesses
    .sort((a, b) => a.time - b.time)
    .forEach((access) => {
      resourceManager.recordAccess(access.origin, access.hash, access.time);
    });

  // 3. Get references to DOM elements
  const originSelect = document.getElementById('origin-select');
  const hashSelect = document.getElementById('hash-select');
  const hashesList = document.getElementById('hashes-list');
  const originsList = document.getElementById('origins-list');

  // 4. Populate the dropdown menus
  function populateSelects() {
    resourceManager.getAllOrigins().forEach((origin) => {
      originSelect.add(new Option(origin, origin));
    });
    resourceManager.getAllHashes().forEach((hash) => {
      hashSelect.add(new Option(hash, hash));
    });
  }

  // 5. Update display functions
  function updateHashesDisplay() {
    const selectedOrigin = originSelect.value;
    const hashes = resourceManager.getHashesByOrigin(selectedOrigin);
    hashesList.innerHTML = ''; // Clear previous list

    hashes.forEach((hash) => {
      const history = resourceManager.getAccessHistory(selectedOrigin, hash);

      const li = document.createElement('li');
      li.className = 'resource-item';

      const hashDiv = document.createElement('div');
      hashDiv.className = 'hash-value';
      hashDiv.textContent = hash;
      li.appendChild(hashDiv);

      if (history.length > 0) {
        const timesUl = document.createElement('ul');
        timesUl.className = 'access-times';
        history.forEach((ts) => {
          const timeLi = document.createElement('li');
          timeLi.textContent = `Accessed on: ${ts.toLocaleString()}`;
          timesUl.appendChild(timeLi);
        });
        li.appendChild(timesUl);
      }
      hashesList.appendChild(li);
    });
  }

  function updateOriginsDisplay() {
    const selectedHash = hashSelect.value;
    const origins = resourceManager.getOriginsByHash(selectedHash);
    originsList.innerHTML = ''; // Clear previous list
    origins.forEach((origin) => {
      const li = document.createElement('li');
      li.textContent = origin;
      originsList.appendChild(li);
    });
  }

  // 6. Attach event listeners
  originSelect.addEventListener('change', updateHashesDisplay);
  hashSelect.addEventListener('change', updateOriginsDisplay);

  // 7. Initial population
  populateSelects();
  if (originSelect.options.length > 0) updateHashesDisplay();
  if (hashSelect.options.length > 0) updateOriginsDisplay();
});

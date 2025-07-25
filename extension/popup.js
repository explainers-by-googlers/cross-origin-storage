// NOTE: Paste the refactored ResourceManager class from step 1 here.
class ResourceManager {
  constructor(data = {}) {
    this.originToHashes = data.originToHashes || {};
    this.hashToOrigins = data.hashToOrigins || {};
    this.accessHistory = data.accessHistory || {};
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

/**
 * Main function to initialize the popup view.
 */
async function initializePopup() {
  // 1. Request live data from the background script
  const liveData = await chrome.runtime.sendMessage({
    action: 'getResourceData',
  });

  // 2. Initialize the resource manager with the live data
  const resourceManager = new ResourceManager(liveData);

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
        history.forEach((tsString) => {
          // Convert ISO string back to Date object for display
          const timestamp = new Date(tsString);
          const timeLi = document.createElement('li');
          timeLi.textContent = `Accessed on: ${timestamp.toLocaleString()}`;
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
}

initializePopup();

import ResourceManager from './resource-manager.js';

async function initializePopup() {
  const resourceManager = new ResourceManager();

  // Get references to DOM elements.
  const originSelect = document.getElementById('origin-select');
  const hashSelect = document.getElementById('hash-select');
  const hashesList = document.getElementById('hashes-list');
  const originsList = document.getElementById('origins-list');
  const deleteAllBtn = document.getElementById('delete-all-btn');
  const confirmationDialog = document.getElementById('confirmation-dialog');
  const confirmationMessage = document.getElementById('confirmation-message');
  const dialogConfirmBtn = document.getElementById('dialog-confirm-btn');

  /**
   * Shows a custom confirmation dialog.
   * @param {string} message The message to display in the dialog.
   * @param {string} confirmText The text for the confirm button.
   * @returns {Promise<boolean>} A promise that resolves to true if confirmed, false otherwise.
   */
  function showConfirmationDialog(message, confirmText = 'Confirm') {
    return new Promise((resolve) => {
      confirmationMessage.innerHTML = message;
      dialogConfirmBtn.textContent = confirmText;

      const closeListener = () => {
        // Clean up the event listener to prevent memory leaks.
        confirmationDialog.removeEventListener('close', closeListener);
        // The returnValue is 'confirm' if the confirm button was clicked.
        resolve(confirmationDialog.returnValue === 'confirm');
      };

      confirmationDialog.addEventListener('close', closeListener);
      confirmationDialog.showModal();
    });
  }

  /**
   * Updates the list of hashes based on the selected origin.
   */
  function updateHashesDisplay() {
    const selectedOrigin = originSelect.value;
    hashesList.innerHTML = '';
    if (!selectedOrigin) return;

    const hashes = resourceManager.getHashesByOrigin(selectedOrigin);
    hashes.forEach((hash) => {
      const history = resourceManager.getAccessHistory(selectedOrigin, hash);

      const li = document.createElement('li');
      li.className = 'resource-item';

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = 'Delete';
      deleteBtn.className = 'delete-btn';
      deleteBtn.title = `Delete this resource (${hash.substring(0, 8)}...)`;
      deleteBtn.addEventListener('click', async () => {
        const originsUsingResource = resourceManager.getOriginsByHash(hash);
        const message = `<h1>Are you sure you want to delete the resource with hash<br><code>${hash}</code>?</h1><p>It's used by the following origins:<ul><li>${originsUsingResource.join(
          '</li><li>',
        )}</li></ul>`;

        const confirmed = await showConfirmationDialog(message, 'Delete');
        if (confirmed) {
          chrome.runtime.sendMessage(
            {
              action: 'deleteResource',
              target: 'offscreen-doc',
              data: {
                hash,
              },
            },
            async (response) => {
              if (!response.data.success) {
                console.error(`Deleting resource with hash ${hash} failed.`);
                return;
              }
              await resourceManager.deleteResourcesByHash(hash);
              await refreshUI(); // Refresh the entire UI after deletion
            },
          );
        }
      });
      li.append(deleteBtn);

      const hashDiv = document.createElement('div');
      hashDiv.className = 'hash-value';
      hashDiv.textContent = hash;
      li.append(hashDiv);

      if (history.length > 0) {
        const timesUl = document.createElement('ul');
        timesUl.className = 'access-times';
        history.forEach((tsString) => {
          const timestamp = new Date(tsString);
          const timeLi = document.createElement('li');
          timeLi.textContent = `Accessed on: ${timestamp.toLocaleString(
            'en-US',
            {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
            },
          )}`;
          timesUl.append(timeLi);
        });
        li.append(timesUl);
      }
      hashesList.append(li);
    });
  }

  /**
   * Updates the list of origins based on the selected hash.
   */
  function updateOriginsDisplay() {
    const selectedHash = hashSelect.value;
    originsList.innerHTML = '';
    if (!selectedHash) return;

    const origins = resourceManager.getOriginsByHash(selectedHash);
    origins.forEach((origin) => {
      const li = document.createElement('li');
      li.textContent = origin;
      originsList.append(li);
    });
  }

  /**
   * A central function to completely refresh the UI from storage data.
   */
  async function refreshUI() {
    // Reload the latest data from storage.
    await resourceManager.loadManagerFromStorage();

    // Clear current selections and lists.
    originSelect.innerHTML = '';
    hashSelect.innerHTML = '';
    hashesList.innerHTML = '';
    originsList.innerHTML = '';

    const currentTab = await getCurrentTab();
    let currentOrigin;
    if (currentTab) {
      currentOrigin = new URL(currentTab.url).origin;
    }

    // Populate origin dropdown.
    const allOrigins = resourceManager.getAllOrigins();
    if (allOrigins.length === 0) {
      originSelect.add(new Option('No origins found', ''));
    } else {
      allOrigins.forEach((origin) => {
        originSelect.add(new Option(origin, origin));
        if (origin === currentOrigin) {
          originSelect.value = origin;
        }
      });
    }

    // Populate hash dropdown.
    const allHashes = resourceManager.getAllHashes();
    const hashesOfCurrentOrigin =
      resourceManager.getHashesByOrigin(currentOrigin);
    if (allHashes.length === 0) {
      hashSelect.add(new Option('No resources found', ''));
    } else {
      let hashSelected = false;
      allHashes.forEach((hash) => {
        hashSelect.add(new Option(hash, hash));
        if (hashesOfCurrentOrigin.includes(hash)) {
          if (!hashSelected) {
            hashSelected = true;
            hashSelect.value = hash;
          }
        }
      });
    }

    // Redraw the lists.
    updateHashesDisplay();
    updateOriginsDisplay();
  }

  originSelect.addEventListener('change', updateHashesDisplay);
  hashSelect.addEventListener('change', updateOriginsDisplay);

  deleteAllBtn.addEventListener('click', async () => {
    const allHashes = resourceManager.getAllHashes();
    if (allHashes.length === 0) {
      alert('There are no resources to remove.');
      return;
    }

    const message =
      '<h1>Are you sure you want to delete all resources?</h1><p>This action cannot be undone.</p>';
    const confirmed = await showConfirmationDialog(message, 'Delete All');

    if (confirmed) {
      chrome.runtime.sendMessage(
        {
          action: 'deleteAllResources',
          target: 'offscreen-doc',
          data: {
            hashes: allHashes,
          },
        },
        async (response) => {
          if (!response.data.success) {
            console.error('Deleting all resources failed.');
            return;
          }
          await resourceManager.deleteResourcesByHash(allHashes);
          await refreshUI();
        },
      );
    }
  });

  // Initial population of the UI.
  await refreshUI();
}

async function getCurrentTab() {
  let queryOptions = { active: true, lastFocusedWindow: true };
  // `tab` will either be a `tabs.Tab` instance or `undefined`.
  let [tab] = await chrome.tabs.query(queryOptions);
  return tab;
}

// Run the main function when the popup is opened.
initializePopup();

/**
 * This is the ISOLATED world script (the bridge).
 * It has access to chrome.* APIs.
 */

// 1. Inject the main-world.js script into the page's context (MAIN world)
const script = document.createElement('script');
script.src = chrome.runtime.getURL('main-world.js');
script.onload = function () {
  this.remove();
};
(document.head || document.documentElement).appendChild(script);

/*
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, data } = message;
  switch (action) {
    case 'getBlobURL': {

  });
      break;
    }
  }

*/

// 2. Listen for messages from the MAIN world script
window.addEventListener('message', async (event) => {
  // We only accept messages from ourselves
  if (
    event.source !== window ||
    event.data.source !== 'cos-polyfill-main' ||
    !event.data.id
  ) {
    return;
  }
  const { id, action, data } = event.data;

  // 3. Forward the message to the background script
  if (data.arrayBuffer) {
    // Send ArrayBuffer as Blob URL.
    const blob = new Blob([data.arrayBuffer], {
      type: 'application/octet-stream',
    });
    data.blobURL = URL.createObjectURL(blob);
    delete data.arrayBuffer;
  }
  chrome.runtime.sendMessage({ action, data }, async (response) => {
    console.log(response);
    if (response.data.blobURL) {
      // Send Blob URL as ArrayBuffer.
      response.data.arrayBuffer = await fetch(response.data.blobURL).then(
        (response) => response.blob(),
      );
    }
    window.postMessage(
      {
        source: 'cos-polyfill-isolated',
        id: id,
        data: response.data,
      },
      event.origin,
    );
  });
});

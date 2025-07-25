chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { target, action, data } = message;
  (async () => {
    // Return early if this message isn't meant for the offscreen document.
    if (target !== 'offscreen-doc') {
      return;
    }

    // Dispatch the message to an appropriate handler.
    switch (action) {
      case 'getBlobURL':
        const cache = await caches.open('cos-storage');
        const response = await cache.match(data.key);
        const blob = await response.blob();
        const blobURL = URL.createObjectURL(blob);
        sendResponse({
          data: {
            blobURL,
          },
        });
        break;
      default:
        console.warn(`Unexpected message type received: '${message.type}'.`);
    }
  })();
  return true;
});

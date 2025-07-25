const cachePromise = caches.open('cos-storage');
let cache;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { target, action, data } = message;
  (async () => {
    // Return early if this message isn't meant for the offscreen document.
    if (target !== 'offscreen-doc') {
      return;
    }
    cache = await cachePromise;
    switch (action) {
      case 'getBlobURL':
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
        console.warn(`Unexpected message action received: '${action}'.`);
    }
  })();
  return true;
});

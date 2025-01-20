/**
 * Copyright 2025 Google LLC.
 * SPDX-License-Identifier: Apache-2.0
 */

const CACHE_NAME = 'cos-polyfill';

const FILES_TO_CACHE = ['iframe.html'];

self.addEventListener('install', async (event) => {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(FILES_TO_CACHE);
  } catch (error) {
    console.error('Failed to cache files during install:', error);
  }
});

self.addEventListener('activate', async (event) => {
  const cacheWhitelist = [CACHE_NAME];
  try {
    const cacheNames = await caches.keys();
    const deletePromises = cacheNames.map((cacheName) => {
      if (!cacheWhitelist.includes(cacheName)) {
        return caches.delete(cacheName);
      }
    });
    await Promise.all(deletePromises);
  } catch (error) {
    console.error('Failed to activate and clean up caches:', error);
  }
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    (async () => {
      try {
        const cachedResponse = await caches.match(event.request);
        return cachedResponse || fetch(event.request);
      } catch (error) {
        console.error('Fetch failed; returning fallback response:', error);
        return new Response('Network error occurred', { status: 408 });
      }
    })(),
  );
});

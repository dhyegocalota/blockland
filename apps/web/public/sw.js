// Blockland service worker. Makes the single-player game installable and offline-capable.
// - Resilient precache of stable static assets (one missing/redirecting URL must NOT abort install).
// - Cache-first for static assets (Next chunks, icons, tenant images, bundled tenant.json).
// - Network-first for navigations: caches each fetched page so the locale-prefixed shell works offline.
// Bump CACHE_VERSION on every shipped change to invalidate old caches on activate.
const CACHE_VERSION = 'v3';
const CACHE_NAME = `blockland-${CACHE_VERSION}`;
// Only assets that live at a fixed, always-200 path. '/' redirects to a locale prefix and
// '/tenant.json' is per-tenant — a redirect/404 in an atomic addAll rejected the whole install, which
// left the OLD worker serving stale bundles (the freshly-deployed page then crashed, e.g. missing
// #hotbar). Those two are cached on first visit by the navigation / cache-first handlers instead.
const APP_SHELL = ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => Promise.allSettled(APP_SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // A static asset failed to fetch (offline, or a stale page asking for a chunk the newest deploy
    // removed). Return a clean network error instead of an uncaught rejection; a reload pulls fresh HTML.
    return Response.error();
  }
}

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Dynamic API routes (presence, admin, auth, uploads) must always hit the network — caching them
  // served stale data, and a cacheFirst miss/error broke the lobby's reachability check.
  if (url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  event.respondWith(cacheFirst(request));
});

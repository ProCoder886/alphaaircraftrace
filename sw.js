/**
 * ALPHA AIRCRAFT RACE 3D — service worker
 * ---------------------------------------------------------------------------
 * Caches the app shell and the vendored engine so repeat launches start almost
 * instantly and the game keeps working offline. The aircraft .glb files and the
 * Draco decoder are not pre-cached — they are several megabytes and would make
 * the install slow — but the cache-first rule below keeps them after the first
 * launch, so the second launch is offline-capable including the modelled jets.
 *
 * Strategy:
 *   • vendor/ and Assets/ — cache-first (immutable, large, version-pinned)
 *   • everything else     — network-first with a cache fallback, so a fresh
 *                           deploy is always picked up on the next load
 * Bump CACHE_VERSION whenever the shipped files change.
 */

const CACHE_VERSION = 'alpha-aircraft-race-3d-v2';
const SHELL = [
  './',
  './index.html',
  './css/main.css',
  './css/animations.css',
  './css/menu.css',
  './css/hud.css',
  './css/mobile.css',
  './js/main.js',
  './js/config.js',
  './js/game.js',
  './js/renderer.js',
  './js/player.js',
  './js/world.js',
  './js/ai.js',
  './js/ui.js',
  './js/audio.js',
  './js/performance.js',
  './vendor/three/build/three.module.min.js',
  './vendor/three/build/three.core.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // Individually, so one missing optional file cannot fail the whole install.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const immutable = url.pathname.includes('/vendor/') || url.pathname.includes('/Assets/');

  if (immutable) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(CACHE_VERSION)).put(req, res.clone());
        return res;
      } catch (e) {
        return new Response('', { status: 504, statusText: 'Offline' });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE_VERSION)).put(req, res.clone());
      return res;
    } catch (e) {
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});

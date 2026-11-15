/* Service Worker — Sistema de Gestión de la Panadería
   Cachea la interfaz para arranque rápido y funcionamiento sin internet. */

const VERSION = 'pan-shell-v27';
const RUNTIME = 'pan-runtime-v27';

const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-180.png',
  '/vendor/lucide.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // La interfaz solo cachea recursos del mismo origen.
  e.respondWith(
    caches.open(RUNTIME).then((c) =>
      fetch(req).then((response) => {
        if (response.ok) c.put(req, response.clone());
        return response;
      }).catch((error) => {
        return c.match(req).then((hit) => {
          if (hit) return hit;
          throw error;
        });
      })
    )
  );
});
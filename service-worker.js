/* eslint-disable no-restricted-globals */

// Simple offline-first service worker for GitHub Pages.
// Precaches app shell and uses a navigation fallback to index.html.

const CACHE_NAME = "spanish-journal-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./db.js",
  "./ui.js",
  "./analysis.js",
  "./manifest.json",
  "./lib/chart.umd.js",
  "./lib/jszip.min.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/logo.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_SHELL);
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((k) => (k === CACHE_NAME ? null : caches.delete(k)))
      );
      self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin
  if (url.origin !== self.location.origin) return;

  // Navigation requests: serve index.html fallback so app works offline
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match("./index.html");
        if (cached) return cached;

        try {
          const fresh = await fetch("./index.html", { cache: "no-store" });
          cache.put("./index.html", fresh.clone());
          return fresh;
        } catch {
          return cached || new Response("Offline", { status: 503 });
        }
      })()
    );
    return;
  }

  // Cache-first for static assets with background refresh
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      if (cached) {
        event.waitUntil(
          (async () => {
            try {
              const fresh = await fetch(req);
              if (fresh && fresh.ok) await cache.put(req, fresh.clone());
            } catch {
              // ignore
            }
          })()
        );
        return cached;
      }

      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) await cache.put(req, fresh.clone());
        return fresh;
      } catch {
        return new Response("Offline", { status: 503 });
      }
    })()
  );
});

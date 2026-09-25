/* ============================================================
   TRAIN service worker -- caches the app shell for offline use
   and installability once served over https (or localhost).

   This can only register from a real origin: service workers are
   not permitted on file:// pages at all, which is exactly how
   this app is used when opened directly from disk -- there, the
   app already works fully offline as a local file with no worker
   needed. index.html's registration call is guarded to skip
   itself entirely on file://, so this file being present or
   absent never changes that path's behavior.

   Cache-first with a background revalidation: every request for
   one of the app's own files is answered from cache immediately
   when available (instant load, works offline), while a network
   fetch still runs in the background to refresh the cache for
   next time. There is nothing else to fetch -- no API, no CDN
   fonts/scripts, no third-party requests.
   ============================================================ */
"use strict";

var CACHE_NAME = "train-cache-v1";
var APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(APP_SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(names.filter(function (name) { return name !== CACHE_NAME; }).map(function (name) { return caches.delete(name); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      var networkFetch = fetch(event.request).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
        }
        return response;
      }).catch(function () { return cached; });
      return cached || networkFetch;
    })
  );
});

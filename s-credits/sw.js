/* S crédits : service worker (fonctionnement hors ligne).
   Pour publier une nouvelle version, changez le numéro de CACHE ci-dessous. */
var CACHE = 'scredits-v1';
var ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'store.js', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/logo-ring.png', 'icons/favicon-64.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function store(req, res) {
  if (res && (res.ok || res.type === 'opaque')) {
    var copy = res.clone();
    caches.open(CACHE).then(function (c) { c.put(req, copy); });
  }
  return res;
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  var fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== location.origin && !fonts) return;
  if (fonts) {
    /* Polices : cache d'abord */
    e.respondWith(caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) { return store(req, res); });
    }));
    return;
  }
  /* Fichiers de l'application : réseau d'abord, cache si hors ligne */
  e.respondWith(fetch(req).then(function (res) { return store(req, res); }).catch(function () {
    return caches.match(req).then(function (hit) { return hit || caches.match('index.html'); });
  }));
});

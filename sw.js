const CACHE_NAME = 'seenmybus-v22';
const STATIC_ASSETS = [
    './',
    './index.html',
    './main.css',
    './map.css',
    './app.js',
    './config.js',
    './ArkaJainUniversityBusMap.xml',
    './logo.svg',
    './no-bus-icon.svg',
    './app-icon.png',
    './icon-192.png',
    './icon-512.png',
    './manifest.json',
    './faq.html',
    './admin-dashboard.html',
    './terms-and-conditions.html',
    './privacy-policy.html'
];

self.addEventListener('install', event => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return Promise.allSettled(
                STATIC_ASSETS.map(url => cache.add(url))
            );
        })
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.map(key => {
                    if (key !== CACHE_NAME) {
                        return caches.delete(key);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    // Bypass external APIs, Google Fonts, and Firebase WebSockets to eliminate Response errors
    if (
        url.origin !== self.location.origin ||
        url.hostname.includes('firebasedatabase.app') ||
        url.hostname.includes('googleapis.com') ||
        url.hostname.includes('gstatic.com') ||
        url.hostname.includes('workers.dev') ||
        url.protocol === 'ws:' ||
        url.protocol === 'wss:'
    ) {
        return;
    }

    event.respondWith(
        caches.match(event.request).then(cachedResponse => {
            const networkFetch = fetch(event.request).then(networkResponse => {
                if (networkResponse && networkResponse.status === 200) {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
                }
                return networkResponse;
            }).catch(err => {
                if (cachedResponse) return cachedResponse;
                throw err;
            });

            return cachedResponse || networkFetch;
        }).catch(() => fetch(event.request))
    );
});

self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});
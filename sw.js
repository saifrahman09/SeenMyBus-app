// BUMPED CACHE TO v20 FOR STREAM CLONE & OFFLINE SENTINEL FIX
const CACHE_NAME = 'seenmybus-v20';

// 1. PURE WEB PUSH ENGINE
self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (e) {
        payload = { notification: { title: "Campus Bus Alert", body: event.data ? event.data.text() : "" } };
    }

    const title = payload.notification?.title || payload.data?.title || "Campus Bus Alert";
    const body = payload.notification?.body || payload.data?.message || payload.data?.body || "";
    const routeTag = payload.data?.routeNum || "general";

    if (!body && !payload.notification?.title) return;

    const notificationOptions = {
        body: body,
        icon: './app-icon.png',      
        badge: './badge-icon.png',   
        vibrate: [200, 100, 200],
        tag: `bus-dest-${routeTag}`, // Replaces old notifications for the same route
        renotify: true,
        data: { url: './index.html' }
    };

    event.waitUntil(
        self.registration.showNotification(title, notificationOptions)
    );
});

const STATIC_ASSETS = [
    './',
    './index.html',
    './app.js',
    './config.js',
    './main.css',
    './map.css',
    './logo.svg',
    './badge-icon.png',
    './app-icon.png',
    './icon-192.png',
    './icon-512.png',
    './admin-dashboard.html',
    './manifest.json',
    './onboarding-1.jpg',
    './onboarding-2.jpg',
    './onboarding-3.jpg',
    './ArkaJainUniversityBusMap.xml',
    './faq.html',
    './terms-and-conditions.html',
    './privacy-policy.html'
];

// 2. Install & Cache App Shell
self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
    );
});

// 3. Clean Outdated Caches
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
        }).then(() => self.clients.claim())
    );
});

// 4. Skip Waiting Listener (Triggered by app.js updatefound)
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

// 5. STALE-WHILE-REVALIDATE FETCH HANDLER (Synchronous Clone Fix)
self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;
    const url = new URL(e.request.url);

    // Bypass browser extensions, Firebase WebSockets/APIs, Cloudflare Worker, and network sentinels
    if (url.protocol.startsWith('chrome-extension')) return;
    if (
        url.hostname.includes('firebasedatabase.app') || 
        url.hostname.includes('firebaseio.com') || 
        url.hostname.includes('workers.dev') ||
        url.searchParams.has('_probe')
    ) {
        return;
    }

    e.respondWith(
        caches.match(e.request).then((cachedResponse) => {
            const fetchPromise = fetch(e.request).then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200 && (networkResponse.type === 'basic' || networkResponse.type === 'cors')) {
                    // SYNCHRONOUS CLONE: Executed immediately before the response stream can be consumed
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(e.request, responseClone);
                    });
                }
                return networkResponse;
            }).catch(() => {
                // If offline and navigating to a page, fallback to cached index.html
                if (e.request.mode === 'navigate') {
                    return caches.match('./index.html');
                }
            });

            return cachedResponse || fetchPromise;
        })
    );
});

// 6. Notification Click Handler
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = (event.notification.data && event.notification.data.url) ? event.notification.data.url : './index.html';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            for (let client of windowClients) {
                if (client.url.includes('index.html') && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) return clients.openWindow(targetUrl);
        })
    );
});
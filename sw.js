// BUMPED CACHE TO v18 FOR SINGLE-NOTIFICATION FIX
const CACHE_NAME = 'seenmybus-v19';

// 1. PURE WEB PUSH ENGINE (No Firebase SDK overlap causing duplicates)
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
    './offline-page.jpg',
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

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
        }).then(() => self.clients.claim())
    );
});

// PURE STALE-WHILE-REVALIDATE STRATEGY 
self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;
    const url = new URL(e.request.url);

    if (url.protocol.startsWith('chrome-extension')) return;
    if (url.hostname.includes('firebasedatabase.app') || url.hostname.includes('workers.dev')) return;

    e.respondWith(
        caches.match(e.request).then((cachedResponse) => {
            const fetchPromise = fetch(e.request).then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200 && (networkResponse.type === 'basic' || networkResponse.type === 'cors')) {
                    caches.open(CACHE_NAME).then((cache) => cache.put(e.request, networkResponse.clone()));
                }
                return networkResponse;
            }).catch(() => {}); 
            return cachedResponse || fetchPromise;
        })
    );
});

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
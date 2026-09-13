// sw.js
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

const CACHE_NAME = 'seenmybus-v26';
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

// 1. Firebase Initialization for Background Pushes
firebase.initializeApp({
    apiKey: "AIzaSyCXejNb5wgmZ6KJ3Q4r4BhBqw9KPn7iX5I",
    authDomain: "seenmybus.firebaseapp.com",
    databaseURL: "https://seenmybus-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "seenmybus",
    storageBucket: "seenmybus.firebasestorage.app",
    messagingSenderId: "352466758419",
    appId: "1:352466758419:web:b86ed30eff7223910688e6",
    measurementId: "G-7RF7CK39M9"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
    console.log('[sw.js] Background Push Received:', payload);
    const title = payload.notification?.title || payload.data?.title || 'SeenMyBus Alert';
    const options = {
        body: payload.notification?.body || payload.data?.message || payload.data?.body || '',
        icon: './badge-icon.png',
        badge: './badge-icon.png',
        vibrate: [100, 50, 100],
        data: { url: self.location.origin + '/' }
    };
    return self.registration.showNotification(title, options);
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    const urlToOpen = event.notification.data.url || self.location.origin + '/';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
            for (let i = 0; i < windowClients.length; i++) {
                const client = windowClients[i];
                if (client.url === urlToOpen && 'focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow(urlToOpen);
        })
    );
});

// 2. Standard PWA Caching Lifecycle
self.addEventListener('install', event => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => Promise.allSettled(STATIC_ASSETS.map(url => cache.add(url))))
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.map(key => { if (key !== CACHE_NAME) return caches.delete(key); })
        )).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);

    // Bypass external APIs and Websockets
    if (
        url.origin !== self.location.origin ||
        url.pathname.startsWith('/_vercel') ||
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
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
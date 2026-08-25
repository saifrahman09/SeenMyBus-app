// Import Firebase Service Worker SDKs
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

// Initialize Firebase in the Service Worker
firebase.initializeApp({
    apiKey: "AIzaSyCXejNb5wgmZ6KJ3Q4r4BhBqw9KPn7iX5I",
    authDomain: "seenmybus.firebaseapp.com",
    projectId: "seenmybus",
    storageBucket: "seenmybus.firebasestorage.app",
    messagingSenderId: "352466758419",
    appId: "1:352466758419:web:b86ed30eff7223910688e6"
});

const messaging = firebase.messaging();

// Handle Background Messages from FCM
messaging.onBackgroundMessage((payload) => {
    console.log('[firebase-messaging-sw.js] Received background message ', payload);
    const notificationTitle = payload.notification.title;
    const notificationOptions = {
        body: payload.notification.body,
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: payload.data?.routeNum ? `bus-dest-${payload.data.routeNum}` : 'aju-bus-alert',
        data: { url: './index.html' }
    };

    self.registration.showNotification(notificationTitle, notificationOptions);
});

// BUMPED CACHE TO v11 to force the update
const CACHE_NAME = 'seenmybus-v11';

const STATIC_ASSETS = [
    './',
    './index.html',
    './app.js',
    './main.css',
    './map.css',
    './logo.svg',
    './app-icon.png',
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

// 1. Install & Pre-cache
self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS);
        }).then(() => self.skipWaiting())
    );
});

// 2. Activate & Clean Old Caches + Claim Clients Immediately
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            );
        }).then(() => self.clients.claim())
    );
});

// 3. Fetch Cache Strategy (Stale-While-Revalidate for local assets, bypass Firebase)
self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;
    
    const url = new URL(e.request.url);
    if (!url.origin.includes(self.location.origin) || url.protocol.startsWith('chrome-extension')) return;

    e.respondWith(
        caches.match(e.request).then((cachedResponse) => {
            if (cachedResponse) {
                fetch(e.request).then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200) {
                        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, networkResponse));
                    }
                }).catch(() => {});
                return cachedResponse;
            }
            return fetch(e.request);
        })
    );
});

// 4. Handle Notification Tap / Click Focus
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
            if (clients.openWindow) {
                return clients.openWindow(targetUrl);
            }
        })
    );
});
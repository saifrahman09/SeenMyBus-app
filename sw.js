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

// 1. Unified Push Engine (Prevents Duplicate Alerts)
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
        icon: './app-icon.png',      // Full color app logo
        badge: './badge-icon.png',   // Transparent cutout silhouette mask
        vibrate: [200, 100, 200],
        tag: `bus-dest-${routeTag}`,
        renotify: true,
        data: { url: './index.html' }
    };

    event.waitUntil(
        self.registration.showNotification(title, notificationOptions)
    );
});

// BUMPED CACHE TO v13
const CACHE_NAME = 'seenmybus-v14';

const STATIC_ASSETS = [
    './',
    './index.html',
    './app.js',
    './main.css',
    './map.css',
    './logo.svg',
    './badge-icon.png',
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

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS);
        }).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;
    const url = new URL(e.request.url);
    if (!url.origin.includes(self.location.origin) || url.protocol.startsWith('chrome-extension')) return;

    if (url.pathname.match(/\.(jpg|jpeg|png|gif|svg)$/)) {
        e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
        return;
    }

    e.respondWith(
        caches.match(e.request).then((cachedResponse) => {
            if (cachedResponse) return cachedResponse;
            return fetch(e.request).then((response) => {
                if (!response || response.status !== 200 || response.type !== 'basic') return response;
                const responseToCache = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(e.request, responseToCache));
                return response;
            });
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
const CACHE_NAME = 'seenmybus-v5';

const STATIC_ASSETS = [
    './',
    './index.html',
    './app.js',
    './main.css',
    './map.css',
    './logo.svg',
    './ArkaJainUniversityBusMap.xml',
    './faq.html',
    './terms-and-conditions.html',
    './privacy-policy.html'
];

// 1. Install - Pre-cache essential static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS);
        })
    );

    self.skipWaiting();
});

// 2. Activate - Clean up old cache versions
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys
                    .filter(
                        (key) => key !== CACHE_NAME
                    )
                    .map(
                        (key) =>
                            caches.delete(key)
                    )
            );
        }).then(() =>
            self.clients.claim()
        )
    );
});

// 3. Fetch - Cache-first for static files,
// bypass Firebase & WebSockets
self.addEventListener('fetch', (event) => {
    const url = event.request.url;

    if (
        url.includes('firebaseio.com') ||
        url.startsWith('chrome-extension') ||
        event.request.method !== 'GET'
    ) {
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then((response) => {

                if (
                    response &&
                    response.status === 200 &&
                    response.type === 'basic'
                ) {
                    const responseClone =
                        response.clone();

                    caches.open(
                        CACHE_NAME
                    ).then(
                        (cache) =>
                            cache.put(
                                event.request,
                                responseClone
                            )
                    );
                }

                return response;
            })
            .catch(() =>
                caches.match(
                    event.request
                )
            )
    );
});

// 4. Background Push Listener
self.addEventListener(
    'push',
    (event) => {

        let data = {
            title:
                "Campus Bus Alert",

            message:
                "Bus status has been updated."
        };

        if (event.data) {
            try {
                data =
                    event.data.json();
            } catch (e) {
                data.message =
                    event.data.text();
            }
        }

        const createdAt =
            Number(data.createdAt) ||
            Date.now();

        const options = {
            body:
                data.message ||
                data.body ||
                "",

            icon:
                './logo.svg',

            badge:
                './logo.svg',

            tag:
                'seenmybus-broadcast',

            renotify:
                false,

            requireInteraction:
                false,

            timestamp:
                createdAt,

            data: {
                url:
                    './index.html',

                createdAt:
                    createdAt
            }
        };

        event.waitUntil(
            self.registration.showNotification(
                data.title,
                options
            )
        );
    }
);

// 5. Notification Tap Action
self.addEventListener(
    'notificationclick',
    (event) => {

        event.notification.close();

        event.waitUntil(
            clients.matchAll({
                type: 'window',
                includeUncontrolled: true
            }).then(
                (clientsArr) => {

                    if (
                        clientsArr.length > 0
                    ) {
                        return clientsArr[0]
                            .focus();
                    }

                    return clients.openWindow(
                        './index.html'
                    );
                }
            )
        );
    }
);

// Listen for clicks on the push notifications
self.addEventListener('notificationclick', function(event) {
    event.notification.close();

    // If the user clicked "Dismiss", do nothing
    if (event.action === 'dismiss') {
        return;
    }

    // If they clicked "See Map" or tapped the main notification body, focus/open the app
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
            for (let i = 0; i < clientList.length; i++) {
                let client = clientList[i];
                if (client.url.includes('index.html') && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow('./index.html');
            }
        })
    );
});


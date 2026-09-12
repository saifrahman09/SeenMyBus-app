// firebase-messaging-sw.js
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

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
    console.log('[firebase-messaging-sw.js] Background Push Received:', payload);
    const title = payload.notification?.title || payload.data?.title || 'SeenMyBus Alert';
    const options = {
        body: payload.notification?.body || payload.data?.message || payload.data?.body || '',
        icon: './icon-192.png',
        badge: './app-icon.png',
        vibrate: [100, 50, 100],
        data: { url: self.location.origin + '/' }
    };

    return self.registration.showNotification(title, options);
});

// Handle tap on the OS background notification
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const urlToOpen = event.notification.data.url || self.location.origin + '/';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
            for (let i = 0; i < windowClients.length; i++) {
                const client = windowClients[i];
                if (client.url === urlToOpen && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(urlToOpen);
            }
        })
    );
});
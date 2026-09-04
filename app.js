import { getMessaging, getToken, onMessage } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-messaging.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { getDatabase, ref, onValue, set, update, get, goOnline } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-database.js";
import * as Config from "./config.js";

// =============================================================================
// 1. CAMPUS SHIFT PURGE TIMINGS (EASY CONFIGURATION)
// =============================================================================
// Enter university campus departure shift cutoffs in "HH:MM" 24-hour format.
// Modify, add, or delete shift departure cutoffs here:
export const CAMPUS_SHIFT_TIMINGS = [
    "13:15", // Shift 1 Cutoff: 1:15 PM (Morning shift departures)
    "16:15", // Shift 2 Cutoff: 4:15 PM (Afternoon regular departures)
    "19:00"  // Shift 3 Cutoff: 7:00 PM (Evening / Special shift departures)
];

// Maximum allowable data lifespan (in minutes) if no shift cutoffs occurred
export const MAX_PARKING_STALE_MINUTES = 90;

// --- FIREBASE CONFIGURATION ---
const firebaseConfig = {
    apiKey: "AIzaSyCXejNb5wgmZ6KJ3Q4r4BhBqw9KPn7iX5I",
    authDomain: "seenmybus.firebaseapp.com",
    databaseURL: "https://seenmybus-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "seenmybus",
    storageBucket: "seenmybus.firebasestorage.app",
    messagingSenderId: "352466758419",
    appId: "1:352466758419:web:b86ed30eff7223910688e6",
    measurementId: "G-7RF7CK39M9"
};
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const messaging = getMessaging(app);

// Dynamic Reactive App Configurations (Live from Firebase with static fallback)
let ALL_ROUTES = Config.DEFAULT_ROUTES || Config.ALL_ROUTES || [];
let ALL_BUSES = Config.DEFAULT_BUSES || Config.ALL_BUSES || Array.from({ length: 45 }, (_, i) => String(i + 1).padStart(2, '0'));
let ALL_SPOTS = Config.DEFAULT_SPOTS || Config.ALL_SPOTS || Array.from({ length: 41 }, (_, i) => `spot-${String(i + 1).padStart(2, '0')}`);

// State Variables
const mapContainer = document.getElementById('map-container');
let mapElement = null;
let activeBuses = [];
let unassignedBuses = [];
let appState = 'VIEW'; 
let pendingUpdate = { route: null, busNo: null, spotId: null, isReplacement: false };
let busLocationTracker = {}; 
let routeLocationTracker = {};
let currentSearchQuery = ''; 

let selectedRouteKey = null;
let topRouteKey = null;
let listOrderKeys = [];
let lastActiveDataSignature = null;
let lastUnassignedDataSignature = null;
let mapViewportInitialized = false;

window.ignoreMapTap = false; 

// --- Service Worker Registration & Instant Auto-Update ---
if ('serviceWorker' in navigator) {
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!refreshing) {
            refreshing = true;
            window.location.reload();
        }
    });

    navigator.serviceWorker.register('./sw.js').then(registration => {
        registration.update();
        registration.addEventListener('updatefound', () => {
            const newWorker = registration.installing;
            if (!newWorker) return;
            newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    newWorker.postMessage({ type: 'SKIP_WAITING' });
                }
            });
        });
    }).catch(err => console.warn("SW Registration:", err));
}

function checkAdminVisibility() {
    const adminLink = document.getElementById('admin-portal-link');
    const adminTopBtn = document.getElementById('admin-top-btn');
    if (localStorage.getItem('smb_admin_active') === 'true') {
        if (adminLink) adminLink.classList.remove('hidden');
        if (adminTopBtn) adminTopBtn.classList.remove('hidden');
    } else {
        if (adminLink) adminLink.classList.add('hidden');
        if (adminTopBtn) adminTopBtn.classList.add('hidden');
    }
}
checkAdminVisibility();

function initSidebarLogoTap() {
    const brandLogo = document.querySelector('.brand-logo');
    if (!brandLogo) return;
    let tapCount = 0;
    let tapTimeout = null;
    brandLogo.style.cursor = 'pointer';
    brandLogo.addEventListener('click', (e) => {
        e.preventDefault();
        tapCount++;
        clearTimeout(tapTimeout);
        if (tapCount >= 3) {
            tapCount = 0;
            window.location.href = './admin-dashboard.html';
        } else {
            tapTimeout = setTimeout(() => { tapCount = 0; }, 1200);
        }
    });
}
initSidebarLogoTap();

let deferredInstallPrompt = null;
const installAppBtn = document.getElementById('btn-install-app') || document.getElementById('pwa-install-btn');

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (installAppBtn) installAppBtn.classList.remove('hidden');
});

if (installAppBtn) {
    installAppBtn.addEventListener('click', async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        const { outcome } = await deferredInstallPrompt.userChoice;
        if (outcome === 'accepted') installAppBtn.classList.add('hidden');
        deferredInstallPrompt = null;
    });
}

window.addEventListener('appinstalled', () => {
    if (installAppBtn) installAppBtn.classList.add('hidden');
    deferredInstallPrompt = null;
});

function getDeviceToken() {
    let token = localStorage.getItem('smb_device_token');
    if (!token) {
        token = 'dev_' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('smb_device_token', token);
    }
    return token;
}
const currentDeviceToken = getDeviceToken();

const connectedRef = ref(db, ".info/connected");
onValue(connectedRef, (snap) => {
    if (snap.val() === true) console.log("SeenMyBus Realtime Connected");
});
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') goOnline(db);
});

function hideSplashScreen() {
    const splash = document.getElementById('splash-screen');
    if (splash && !splash.classList.contains('fade-out')) {
        splash.classList.add('fade-out');
        setTimeout(() => { if (splash.parentNode) splash.remove(); }, 500);
    }
}
setTimeout(hideSplashScreen, 1500);

function getCurrentCycleKey() {
    const now = new Date();
    let year = now.getFullYear();
    let month = now.getMonth() + 1;
    if (now.getDate() < 5) {
        month -= 1;
        if (month === 0) { month = 12; year -= 1; }
    }
    return `cycle_${year}_${String(month).padStart(2, '0')}`;
}

async function addContributionPoints(points = 10) {
    if (window.isTourActive) return;
    const cycleKey = getCurrentCycleKey();
    const userRef = ref(db, `userProfiles/${currentDeviceToken}/${cycleKey}`);
    try {
        const snap = await get(userRef);
        const currentData = snap.val() || { score: 0, actions: 0 };
        const newScore = (currentData.score || 0) + points;
        await update(userRef, {
            score: newScore,
            actions: (currentData.actions || 0) + 1,
            lastActive: Date.now()
        });
        updateRankDisplay(newScore);
    } catch (e) {}
}

function updateRankDisplay(score) {
    const rankElem = document.getElementById('user-rank-display');
    if (!rankElem) return;
    let level = "Level 1 (Rookie)";
    if (score >= 300) level = `Level 5 (Campus Legend)`;
    else if (score >= 150) level = "Level 4 (Spotter Pro)";
    else if (score >= 75) level = "Level 3 (Regular Scout)";
    else if (score >= 30) level = "Level 2 (Active Contributor)";
    rankElem.textContent = `Score: ${score} pts   ${level}`;
}

async function loadUserRank() {
    try {
        const snap = await get(ref(db, `userProfiles/${currentDeviceToken}/${getCurrentCycleKey()}`));
        const data = snap.val() || { score: 0 };
        updateRankDisplay(data.score || 0);
    } catch (e) {}
}

async function registerFCMToken() {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
        const registration = await navigator.serviceWorker.ready;
        const fcmToken = await getToken(messaging, { 
            vapidKey: 'BPgf5onxNHlQiYFzQ3Q03IHvYKe22Yuu1JahIj9MQkvl5XwadaViZOAAVXCV_tmqhwWlq2vfZe1T0ybd9PGhLsI',
            serviceWorkerRegistration: registration
        });
        if (fcmToken) await set(ref(db, `fcmTokens/${currentDeviceToken}`), fcmToken);
    } catch (err) {}
}

function initNotificationSystem() {
    const notifBanner = document.getElementById('notif-banner');
    if ("Notification" in window && Notification.permission === 'granted') {
        registerFCMToken();
        return;
    }
    const isAsked = localStorage.getItem('smb_notif_asked');
    if (!isAsked && "Notification" in window && Notification.permission === 'default') {
        setTimeout(() => { 
            if (!localStorage.getItem('smb_notif_asked') && notifBanner) {
                notifBanner.classList.remove('hidden'); 
            }
        }, 8000);
    }
    const allowBtn = document.getElementById('btn-allow-notif');
    if (allowBtn) {
        allowBtn.onclick = async () => {
            try {
                const permission = await Notification.requestPermission();
                if (permission === 'granted') {
                    localStorage.setItem('smb_notif_asked', 'true');
                    if (notifBanner) notifBanner.classList.add('hidden');
                    await registerFCMToken();
                }
            } catch (err) {}
        };
    }
    const dismissBtn = document.getElementById('btn-dismiss-notif');
    if (dismissBtn) {
        dismissBtn.onclick = () => {
            localStorage.setItem('smb_notif_asked', 'true');
            if (notifBanner) notifBanner.classList.add('hidden');
        };
    }
}

function updateRouteSelectDropdown() {
    const rSelect = document.getElementById('route-select');
    if (!rSelect) return;
    const currentVal = rSelect.value;
    rSelect.innerHTML = `
        <option value="" disabled selected>Select a Route</option>
        <option value="UNASSIGNED">Parked on Campus (Route Unknown)</option>
    `;
    ALL_ROUTES.forEach(r => {
        rSelect.innerHTML += `<option value="${r.num}|${r.name}">Route ${r.num} - ${r.name}</option>`;
    });
    if (currentVal) rSelect.value = currentVal;
}
updateRouteSelectDropdown();

onValue(ref(db, 'appConfig'), (snapshot) => {
    const configData = snapshot.val();
    if (!configData) return;
    if (Array.isArray(configData.routes) && configData.routes.length > 0) {
        ALL_ROUTES = configData.routes;
        updateRouteSelectDropdown();
    }
    if (configData.totalBuses) {
        const busCount = parseInt(configData.totalBuses, 10);
        if (!isNaN(busCount) && busCount > 0) {
            ALL_BUSES = Array.from({ length: busCount }, (_, i) => String(i + 1).padStart(2, '0'));
        }
    }
    if (configData.totalSpots) {
        const spotCount = parseInt(configData.totalSpots, 10);
        if (!isNaN(spotCount) && spotCount > 0) {
            ALL_SPOTS = Array.from({ length: spotCount }, (_, i) => `spot-${String(i + 1).padStart(2, '0')}`);
            if (mapElement && appState === 'VIEW') renderMapSpots();
        }
    }
});

function getSpotCoordinates(spotId) {
    const g = document.getElementById(spotId);
    if (!g) return null;
    const circle = g.querySelector('circle');
    if (!circle) return null;
    return {
        x: parseFloat(circle.getAttribute('cx')),
        y: parseFloat(circle.getAttribute('cy')),
        r: parseFloat(circle.getAttribute('r')) || 6
    };
}

function animateBusTransition(busNo, fromSpotId, toSpotId) {
    if (!mapElement || fromSpotId === toSpotId) return;
    const start = getSpotCoordinates(fromSpotId);
    const end = getSpotCoordinates(toSpotId);
    if (!start || !end) return;

    const animGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    animGroup.setAttribute('class', 'animating-bus-transit');
    
    const pulseCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    pulseCircle.setAttribute('cx', '0'); pulseCircle.setAttribute('cy', '0');
    pulseCircle.setAttribute('r', (start.r * 1.5).toString());
    pulseCircle.setAttribute('fill', '#815FD7'); pulseCircle.setAttribute('class', 'transit-glow-pulse');

    const busCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    busCircle.setAttribute('cx', '0'); busCircle.setAttribute('cy', '0');
    busCircle.setAttribute('r', start.r.toString());
    busCircle.setAttribute('fill', '#FCB041'); busCircle.setAttribute('stroke', '#815FD7');
    busCircle.setAttribute('stroke-width', '1.5');

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', '0'); text.setAttribute('y', '0');
    text.setAttribute('text-anchor', 'middle'); text.setAttribute('dy', '0.35em');
    text.setAttribute('class', 'spot-text text-black');
    text.style.fontSize = '4.2px'; text.style.fontWeight = '800';
    text.textContent = busNo;

    animGroup.appendChild(pulseCircle);
    animGroup.appendChild(busCircle);
    animGroup.appendChild(text);
    animGroup.style.transform = `translate(${start.x}px, ${start.y}px)`;
    animGroup.style.transition = 'transform 1.3s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.3s ease';

    mapElement.appendChild(animGroup);
    requestAnimationFrame(() => {
        animGroup.style.transform = `translate(${end.x}px, ${end.y}px) scale(1.15)`;
    });
    setTimeout(() => {
        animGroup.style.opacity = '0';
        setTimeout(() => animGroup.remove(), 300);
        const targetSpotEl = document.getElementById(toSpotId);
        if (targetSpotEl) {
            targetSpotEl.classList.add('pop-animate');
            setTimeout(() => targetSpotEl.classList.remove('pop-animate'), 600);
        }
    }, 1300);
}

function isDataStale(updatedAt) { 
    return (Date.now() - updatedAt) > (MAX_PARKING_STALE_MINUTES * 60 * 1000); 
}

async function checkShiftPurge(data) {
    if (!data) return;
    const now = new Date();
    const currentMins = now.getHours() * 60 + now.getMinutes();
    
    const cutoffs = CAMPUS_SHIFT_TIMINGS.map(timeStr => {
        const [h, m] = timeStr.split(':').map(Number);
        return (h * 60) + m;
    });
    
    let activeBusesUpdates = {};
    let needsPurge = false;
    
    Object.keys(data).forEach(spotId => {
        if (!spotId.startsWith('spot-')) return;
        const item = data[spotId];
        if (item && item.updatedAt) {
            const itemDate = new Date(item.updatedAt);
            const itemMins = itemDate.getHours() * 60 + itemDate.getMinutes();
            const isSameDay = now.toDateString() === itemDate.toDateString();
            const crossedCutoff = isSameDay && cutoffs.some(c => itemMins < c && currentMins >= c);
            
            if (crossedCutoff || isDataStale(item.updatedAt) || !isSameDay) {
                activeBusesUpdates[spotId] = null;
                needsPurge = true;
            }
        }
    });

    if (needsPurge) {
        try { await update(ref(db, 'activeBuses'), activeBusesUpdates); }
        catch (e) {}
    }
}

setInterval(async () => {
    if (appState === 'VIEW' && !window.isTourActive) {
        try {
            const snap = await get(ref(db, 'activeBuses'));
            if (snap.exists()) checkShiftPurge(snap.val());
        } catch (e) {}
    }
}, 60000);

window.triggerPostTourConsents = function() {
    const consentBanner = document.getElementById('consent-banner');
    if (consentBanner && !localStorage.getItem('aju_consent')) consentBanner.classList.remove('hidden');
    initNotificationSystem();
};

const acceptBtn = document.getElementById('btn-accept-cookies');
if (acceptBtn) {
    acceptBtn.onclick = () => {
        localStorage.setItem('aju_consent', 'true');
        const consentBanner = document.getElementById('consent-banner');
        if (consentBanner) consentBanner.classList.add('hidden');
        initNotificationSystem();
        loadUserRank();
    };
}
if (localStorage.getItem('smb_tour_completed')) window.triggerPostTourConsents();
loadUserRank();

const btnHam = document.getElementById('btn-hamburger');
const sidePanel = document.getElementById('side-panel');
const sideOverlay = document.getElementById('side-panel-overlay');
const closePanel = document.getElementById('btn-close-panel');
const togglePanel = () => {
    if (sidePanel) {
        sidePanel.classList.toggle('open');
        sidePanel.scrollTop = 0;
    }
    if (sideOverlay) sideOverlay.classList.toggle('hidden');
    if (sidePanel && sidePanel.classList.contains('open')) loadUserRank();
};
if (btnHam) btnHam.onclick = togglePanel;
if (closePanel) closePanel.onclick = togglePanel;
if (sideOverlay) sideOverlay.onclick = togglePanel;

fetch('./ArkaJainUniversityBusMap.xml')
    .then(res => { if (!res.ok) throw new Error("Map load failure"); return res.text(); })
    .then(svgText => {
        if (mapContainer) {
            mapContainer.innerHTML = svgText;
            requestAnimationFrame(() => {
                mapElement = mapContainer.querySelector('svg');
                if (mapElement) {
                    mapElement.id = 'campus-map';
                    mapElement.setAttribute('preserveAspectRatio', 'xMidYMid slice');
                    mapElement.style.shapeRendering = 'geometricPrecision';
                    const rootGroup = document.getElementById('campus-map-root');
                    if (rootGroup) rootGroup.removeAttribute('clip-path');
                    renderMapSpots();
                    requestAnimationFrame(() => {
                        if (!mapViewportInitialized) {
                            setDefaultMapViewport();
                            mapViewportInitialized = true;
                        }
                    });
                }
                hideSplashScreen();
            });
        }
    }).catch(err => { hideSplashScreen(); });

function getFilteredBuses() {
    if (!currentSearchQuery) return activeBuses;
    return activeBuses.filter(bus => {
        const matchesBusNo = bus.busNos.some(b => b.toLowerCase().includes(currentSearchQuery));
        const matchesName = bus.name.toLowerCase().includes(currentSearchQuery);
        const matchesRoute = bus.routeNum.toLowerCase().includes(currentSearchQuery);
        let matchesIndividualRoute = false;
        if (bus.routes && Array.isArray(bus.routes)) {
            matchesIndividualRoute = bus.routes.some(r => 
                r.num.toLowerCase().includes(currentSearchQuery) || 
                r.name.toLowerCase().includes(currentSearchQuery)
            );
        }
        return matchesBusNo || matchesName || matchesRoute || matchesIndividualRoute;
    });
}

function createActiveDataSignature(data) {
    if (!data) return '';
    return Object.keys(data).filter(k => k.startsWith('spot-')).sort().map(spotId => {
        const item = data[spotId] || {};
        const buses = item.busNos ? item.busNos : (item.busNo ? [item.busNo] : []);
        return [
            spotId,
            item.routeNum || '',
            item.name || '',
            buses.join(','),
            item.users ?? '',
            item.updatedAt ?? '',
            item.updatedBy ?? ''
        ].join('~');
    }).join('|');
}

function createUnassignedDataSignature(data) {
    if (!data) return '';
    return Object.keys(data).filter(k => k.startsWith('spot-')).sort().map(spotId => {
        const item = data[spotId] || {};
        return `${spotId}~${item.busNo || ''}~${item.updatedAt ?? ''}~${item.updatedBy ?? ''}`;
    }).join('|');
}

function handleBusesData(data) {
    if (window.isTourActive) {
        data = {
            'spot-15': { busNo: "04", busNos: ["04"], routeNum: "6", name: "Adityapur", users: 1, updatedAt: 1700000000000, updatedBy: 'tour' },
            'spot-03': { busNo: "25", busNos: ["25"], routeNum: "3", name: "Bistupur", users: 1, updatedAt: 1700000000000, updatedBy: 'tour' },
            'spot-07': { busNo: "22", busNos: ["22"], routeNum: "7", name: "Mango chowk", users: 1, updatedAt: 1700000000000, updatedBy: 'tour' }
        };
    }
    
    const skeleton = document.getElementById('skeleton-loader');
    const busListEl = document.getElementById('bus-list');
    if (skeleton) skeleton.classList.add('hidden');
    if (busListEl) busListEl.classList.remove('hidden');

    const validSpots = data ? Object.keys(data).filter(k => k.startsWith('spot-')) : [];

    if (!data || validSpots.length === 0) {
        if (lastActiveDataSignature === '') return;
        lastActiveDataSignature = '';
        activeBuses = [];
        busLocationTracker = {};
        routeLocationTracker = {};
        if (mapElement && appState === 'VIEW') renderMapSpots();
        if (appState === 'VIEW') renderList([]);
        return;
    }

    checkShiftPurge(data);

    const signature = createActiveDataSignature(data);
    if (signature === lastActiveDataSignature) return;
    lastActiveDataSignature = signature;

    const newActiveBuses = validSpots.map(spotId => {
        const item = data[spotId];
        const buses = item.busNos ? item.busNos : (item.busNo ? [item.busNo] : []);
        return { spotId, ...item, busNos: buses };
    });

    const newRouteLocationTracker = {};

    newActiveBuses.forEach(ab => {
        ab.busNos.forEach(bNo => {
            const routeCompositeKey = `${ab.routeNum}_${ab.name}`;
            let prevSpot = busLocationTracker[bNo];

            if (!prevSpot && routeLocationTracker[routeCompositeKey] && routeLocationTracker[routeCompositeKey] !== ab.spotId) {
                prevSpot = routeLocationTracker[routeCompositeKey];
            }

            if (!window.isTourActive && prevSpot && prevSpot !== ab.spotId) {
                animateBusTransition(bNo, prevSpot, ab.spotId);
            }
            busLocationTracker[bNo] = ab.spotId;
        });
        newRouteLocationTracker[`${ab.routeNum}_${ab.name}`] = ab.spotId;
    });

    routeLocationTracker = newRouteLocationTracker;
    activeBuses = newActiveBuses;

    if (appState === 'VIEW') {
        if (mapElement) renderMapSpots();
        renderList(getFilteredBuses());
    }
}

function handleUnassignedData(data) {
    if (window.isTourActive) data = null; 
    const signature = createUnassignedDataSignature(data);
    if (signature === lastUnassignedDataSignature) return;
    lastUnassignedDataSignature = signature;
    const validSpots = data ? Object.keys(data).filter(k => k.startsWith('spot-')) : [];
    unassignedBuses = validSpots.map(spotId => ({ spotId, ...data[spotId] }));
    if (appState === 'VIEW' && mapElement) renderMapSpots();
}

onValue(ref(db, 'activeBuses'), (snapshot) => { try { handleBusesData(snapshot.val()); } catch (err) {} });
onValue(ref(db, 'unassignedBuses'), (snapshot) => { try { handleUnassignedData(snapshot.val()); } catch (e) {} });

function getUnassignedBusNumbers() {
    const assigned = new Set();
    activeBuses.forEach(ab => ab.busNos.forEach(b => assigned.add(b)));
    return ALL_BUSES.filter(bNo => !assigned.has(bNo));
}

function renderMapSpots() {
    ALL_SPOTS.forEach(spotId => {
        const g = document.getElementById(spotId);
        if (!g) return;

        g.querySelectorAll('text.spot-text').forEach(t => t.remove());
        g.classList.remove('spot-grey', 'spot-green', 'spot-yellow', 'spot-deep-green', 'spot-unassigned');
        g.onclick = null;
        g.style.opacity = '1';
        g.style.pointerEvents = 'all';
        g.style.cursor = 'pointer';

        const busInfo = activeBuses.find(b => b.spotId === spotId);
        const unassignedInfo = unassignedBuses.find(b => b.spotId === spotId);

        if (appState === 'VIEW') {
            if (busInfo && busInfo.busNos.length > 0) {
                g.classList.add('spot-yellow');
                addTextToSpot(g, busInfo.busNos.join(','), 'text-black');
                g.onclick = (e) => { e.preventDefault(); e.stopPropagation(); if (window.ignoreMapTap) return; focusOnSpot(spotId); highlightInList(spotId, true); };
            } else if (unassignedInfo) {
                g.classList.add('spot-unassigned');
                addTextToSpot(g, unassignedInfo.busNo, 'text-black');
                g.onclick = (e) => { e.preventDefault(); e.stopPropagation(); if (window.ignoreMapTap) return; focusOnSpot(spotId); };
            } else {
                g.classList.add('spot-grey');
                g.style.opacity = '0';
                g.style.pointerEvents = 'none';
            }
        } else if (appState === 'SELECTION') {
            if (busInfo && busInfo.busNos.length > 0) {
                g.classList.add('spot-green');
                addTextToSpot(g, busInfo.busNos.join(','), 'text-green');
            } else {
                g.classList.add('spot-grey');
            }

            if (pendingUpdate.spotId === spotId) {
                g.classList.remove('spot-grey', 'spot-green');
                g.classList.add('spot-yellow');
                addTextToSpot(g, pendingUpdate.busNo, 'text-black');
            }

            g.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (window.ignoreMapTap) return;
                
                if (busInfo) {
                    const existingBuses = busInfo.busNos || (busInfo.busNo ? [busInfo.busNo] : []);
                    const isSameBus = existingBuses.includes(pendingUpdate.busNo);

                    if (!isSameBus) {
                        alert(`Slot is already occupied by Bus ${existingBuses.join(', ')}. A parking slot can only hold one bus at a time.`);
                        return;
                    }
                }
                
                ALL_SPOTS.forEach(s => {
                    const sg = document.getElementById(s);
                    if (!sg) return;
                    sg.classList.remove('spot-yellow', 'spot-deep-green');
                    const txt = sg.querySelector('text');
                    if (txt && !sg.classList.contains('spot-green')) txt.remove();
                    if (txt && sg.classList.contains('spot-green')) txt.classList.replace('text-white', 'text-green');
                });
                pendingUpdate.spotId = spotId;
                if (busInfo) {
                    g.classList.add('spot-deep-green');
                    const txt = g.querySelector('text.spot-text');
                    if (txt) txt.classList.replace('text-green', 'text-white');
                } else {
                    g.classList.add('spot-yellow');
                    addTextToSpot(g, pendingUpdate.busNo, 'text-black');
                }
            };
        }
    });
}

function addTextToSpot(g, textContent, colorClass) {
    const circle = g.querySelector('circle');
    if (!circle) return;
    const cx = circle.getAttribute('cx'), cy = circle.getAttribute('cy');
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', cx); text.setAttribute('y', cy);
    text.setAttribute('text-anchor', 'middle'); text.setAttribute('dy', '0.35em'); 
    text.setAttribute('class', `spot-text ${colorClass}`);
    if (textContent.length > 3) text.style.fontSize = '3.8px';
    text.textContent = textContent;
    g.appendChild(text);
}

const draggableSheet = document.getElementById('draggable-sheet');
const dragHandle = document.getElementById('drag-handle-area');
const contentWrapper = document.getElementById('sheet-content-wrapper');
let currentTranslate = 0, sheetStartY = 0, isDraggingSheet = false;

if (dragHandle) {
    dragHandle.addEventListener('touchstart', (e) => {
        sheetStartY = e.touches[0].clientY - currentTranslate;
        isDraggingSheet = true;
        if (draggableSheet) draggableSheet.style.transition = 'none';
    }, { passive: true });
    dragHandle.addEventListener('touchmove', (e) => {
        if (!isDraggingSheet || !contentWrapper || !draggableSheet) return;
        const maxTranslate = contentWrapper.offsetHeight; 
        currentTranslate = Math.max(0, Math.min(e.touches[0].clientY - sheetStartY, maxTranslate));
        draggableSheet.style.transform = `translateY(${currentTranslate}px)`;
    }, { passive: true });
    dragHandle.addEventListener('touchend', () => {
        isDraggingSheet = false;
        if (!contentWrapper || !draggableSheet) return;
        draggableSheet.style.transition = 'transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1)';
        const maxTranslate = contentWrapper.offsetHeight;
        currentTranslate = (currentTranslate > maxTranslate / 3) ? maxTranslate : 0;
        draggableSheet.style.transform = `translateY(${currentTranslate}px)`;
    });
}

let scale = 1, pointX = 0, pointY = 0, startX = 0, startY = 0, isPanning = false, initialPinchDist = null, initialScale = 1, panPointerMoved = false, transformFramePending = false;
const DEFAULT_MAP_ZOOM = 1.95, DEFAULT_MAP_CENTER_X = 735, DEFAULT_MAP_CENTER_Y = 750;

function applyBoundaries() {
    if (!mapContainer) return;
    const contW = mapContainer.clientWidth, contH = mapContainer.clientHeight, scaledW = contW * scale, scaledH = contH * scale;
    if (scaledW <= contW) pointX = (contW - scaledW) / 2;
    else pointX = Math.min(0, Math.max(pointX, contW - scaledW));
    if (scaledH <= contH) pointY = (contH - scaledH) / 2;
    else pointY = Math.min(0, Math.max(pointY, contH - scaledH));
}

function writeTransform() {
    transformFramePending = false;
    if (!mapElement) return;
    applyBoundaries();
    mapElement.style.transform = `translate(${pointX}px, ${pointY}px) scale(${scale})`;
    if (mapContainer) {
        if (scale >= 1.6) mapContainer.classList.add('is-zoomed-in');
        else mapContainer.classList.remove('is-zoomed-in');
    }
}

function setTransform() {
    if (transformFramePending) return;
    transformFramePending = true;
    requestAnimationFrame(writeTransform);
}

function setDefaultMapViewport() {
    if (!mapElement || !mapContainer) return;
    const baseW = mapElement.viewBox.baseVal.width || 1265, baseH = mapElement.viewBox.baseVal.height || 1335;
    const contW = mapContainer.clientWidth, contH = mapContainer.clientHeight;
    const fitScale = Math.max(contW / baseW, contH / baseH);
    const offsetX = ((baseW * fitScale) - contW) / 2, offsetY = ((baseH * fitScale) - contH) / 2;
    scale = DEFAULT_MAP_ZOOM;
    pointX = (contW / 2) - (((DEFAULT_MAP_CENTER_X * fitScale) - offsetX) * scale);
    pointY = (contH / 2) - (((DEFAULT_MAP_CENTER_Y * fitScale) - offsetY) * scale);
    mapElement.style.transition = 'none';
    setTransform();
}

function zoomMapAt(clientX, clientY, zoomFactor) {
    if (!mapContainer || !mapElement) return;
    const rect = mapContainer.getBoundingClientRect();
    const localX = clientX - rect.left, localY = clientY - rect.top;
    const oldScale = scale;
    const newScale = Math.min(5, Math.max(1, oldScale * zoomFactor));
    if (newScale === oldScale) return;
    const mapX = (localX - pointX) / oldScale, mapY = (localY - pointY) / oldScale;
    scale = newScale;
    pointX = localX - (mapX * scale);
    pointY = localY - (mapY * scale);
    setTransform();
}

function resetFocus() {
    if (!mapElement || !mapContainer) return;
    document.querySelectorAll('.active-target').forEach(el => el.classList.remove('active-target', 'pop-animate'));
    document.querySelectorAll('.active-list-item').forEach(el => el.classList.remove('active-list-item'));
    document.querySelectorAll('.flash-highlight').forEach(el => el.classList.remove('flash-highlight'));
    scale = 1; pointX = 0; pointY = 0;
    mapElement.style.transition = 'transform 0.35s ease';
    setTransform();
    setTimeout(() => { if (mapElement) mapElement.style.transition = 'none'; }, 350);
    selectedRouteKey = null; topRouteKey = null;
    if (typeof hideValidationCard === 'function') hideValidationCard();
}

if (mapContainer) {
    mapContainer.addEventListener('mousedown', e => { if (e.button !== 0) return; isPanning = true; panPointerMoved = false; startX = e.clientX - pointX; startY = e.clientY - pointY; mapContainer.style.cursor = 'grabbing'; });
    window.addEventListener('mousemove', e => { if (!isPanning) return; const nextX = e.clientX - startX, nextY = e.clientY - startY; if (Math.abs(nextX - pointX) > 2 || Math.abs(nextY - pointY) > 2) panPointerMoved = true; pointX = nextX; pointY = nextY; setTransform(); });
    window.addEventListener('mouseup', () => { isPanning = false; if (mapContainer) mapContainer.style.cursor = 'grab'; });
    window.addEventListener('mouseleave', () => { isPanning = false; if (mapContainer) mapContainer.style.cursor = 'grab'; });
    mapContainer.addEventListener('wheel', e => { e.preventDefault(); const factor = e.deltaY < 0 ? 1.12 : (1 / 1.12); zoomMapAt(e.clientX, e.clientY, factor); }, { passive: false });
    mapContainer.addEventListener('touchstart', e => { if (e.touches.length === 1) { isPanning = true; panPointerMoved = false; startX = e.touches[0].clientX - pointX; startY = e.touches[0].clientY - pointY; } else if (e.touches.length === 2) { isPanning = false; initialPinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); initialScale = scale; } }, { passive: true });
    mapContainer.addEventListener('touchmove', e => { if (e.touches.length === 1 && isPanning) { e.preventDefault(); pointX = e.touches[0].clientX - startX; pointY = e.touches[0].clientY - startY; panPointerMoved = true; setTransform(); } else if (e.touches.length === 2 && initialPinchDist) { e.preventDefault(); const currentDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); const nextScale = Math.min(5, Math.max(1, initialScale * (currentDist / initialPinchDist))); const rect = mapContainer.getBoundingClientRect(), centerX = ((e.touches[0].clientX + e.touches[1].clientX) / 2) - rect.left, centerY = ((e.touches[0].clientY + e.touches[1].clientY) / 2) - rect.top; const mapX = (centerX - pointX) / scale, mapY = (centerY - pointY) / scale; scale = nextScale; pointX = centerX - (mapX * scale); pointY = centerY - (mapY * scale); setTransform(); } }, { passive: false });
    mapContainer.addEventListener('touchend', e => { if (e.touches.length === 0) { isPanning = false; initialPinchDist = null; } }, { passive: true });
    mapContainer.addEventListener('click', e => { if (window.ignoreMapTap || panPointerMoved) { panPointerMoved = false; return; } if (!e.target.closest('[id^="spot-"]')) resetFocus(); });
}

function getGroupedRoutes(buses) {
    const routeMap = {};
    buses.forEach(bus => {
        const routesList = (bus.routes && Array.isArray(bus.routes) && bus.routes.length > 0) ? bus.routes : [{ num: bus.routeNum, name: bus.name }];
        routesList.forEach(r => {
            if (!r || !r.num) return;
            const key = `route_${r.num}_${r.name}`;
            if (!routeMap[key]) { routeMap[key] = { key, routeNum: r.num, name: r.name, buses: [], users: bus.users || 1 }; }
            bus.busNos.forEach(bNo => {
                if (!routeMap[key].buses.some(b => b.busNo === bNo)) { routeMap[key].buses.push({ busNo: bNo, spotId: bus.spotId }); }
            });
            routeMap[key].users = Math.max(routeMap[key].users, bus.users || 1);
        });
    });
    return Object.values(routeMap).sort((a, b) => parseInt(a.routeNum) - parseInt(b.routeNum));
}

function buildStableListOrder(groupedRoutes) {
    const defaultKeys = groupedRoutes.map(item => item.key);
    const availableKeys = new Set(defaultKeys);
    listOrderKeys = listOrderKeys.filter(key => availableKeys.has(key));
    defaultKeys.forEach((key, defaultIndex) => {
        if (listOrderKeys.includes(key)) return;
        let insertAt = listOrderKeys.length;
        for (let i = 0; i < listOrderKeys.length; i++) {
            if (defaultKeys.indexOf(listOrderKeys[i]) > defaultIndex) { insertAt = i; break; }
        }
        listOrderKeys.splice(insertAt, 0, key);
    });
    if (topRouteKey && availableKeys.has(topRouteKey)) listOrderKeys = [topRouteKey, ...listOrderKeys.filter(key => key !== topRouteKey)];
    const routeMap = new Map(groupedRoutes.map(item => [item.key, item]));
    return listOrderKeys.map(key => routeMap.get(key)).filter(Boolean);
}

function applyListSelection(container) {
    if (!container) return;
    const items = container.querySelectorAll('.bus-item');
    items.forEach(item => item.classList.remove('active-list-item', 'flash-highlight'));
    if (!selectedRouteKey) return;
    const selectedItem = Array.from(items).find(item => item.dataset.routeKey === selectedRouteKey);
    if (selectedItem) selectedItem.classList.add('active-list-item');
}

function selectListRoute(routeKey, spotId = null, fromMap = false) {
    const container = document.getElementById('bus-list');
    if (!container || !routeKey) return;
    if (window.isTourActive && currentTourStep === 8 && !fromMap) {
        setTimeout(() => { if (typeof hideValidationCard === 'function') hideValidationCard(); window.nextTourStep(); }, 400);
    }
    selectedRouteKey = routeKey;
    if (fromMap) {
        topRouteKey = routeKey;
        const targetItem = Array.from(container.querySelectorAll('.bus-item')).find(item => item.dataset.routeKey === routeKey);
        if (targetItem) { container.prepend(targetItem); listOrderKeys = [routeKey, ...listOrderKeys.filter(key => key !== routeKey)]; container.scrollTop = 0; }
    }
    applyListSelection(container);
    if (fromMap) {
        const targetItem = Array.from(container.querySelectorAll('.bus-item')).find(item => item.dataset.routeKey === routeKey);
        if (targetItem) {
            void targetItem.offsetWidth;
            targetItem.classList.add('flash-highlight');
            setTimeout(() => { if (selectedRouteKey !== routeKey) return; targetItem.classList.remove('flash-highlight'); targetItem.classList.add('active-list-item'); }, 600);
        }
    }
}

function renderList(buses) {
    const container = document.getElementById('bus-list');
    if (!container) return;
    const groupedRoutes = getGroupedRoutes(buses);
    const emptyState = document.getElementById('empty-state');
    if (groupedRoutes.length === 0) {
        listOrderKeys = []; container.innerHTML = '';
        if (emptyState) emptyState.classList.remove('hidden');
        return;
    }
    if (emptyState) emptyState.classList.add('hidden');
    const orderedRoutes = buildStableListOrder(groupedRoutes);
    const fragment = document.createDocumentFragment();
    orderedRoutes.forEach(item => {
        const div = document.createElement('div');
        div.className = 'bus-item';
        div.dataset.routeKey = item.key;
        if (item.buses.length > 0) div.dataset.spots = item.buses.map(b => b.spotId).join(',');

        let subtextHtml = '';
        const displayUsers = item.users >= 999 ? 1 : (item.users || 1);
        if (item.users >= 999) {
            subtextHtml = `<span class="verified-text verified-official">Official Campus Schedule</span>`;
        } else if (item.users >= 3) {
            subtextHtml = `<span class="verified-text verified-consensus">✓ Community Confirmed</span>`;
        } else {
            subtextHtml = `<span class="verified-text">Reported by ${displayUsers} student${displayUsers !== 1 ? 's' : ''}</span>`;
        }

        div.innerHTML = `
            <div class="bus-info-left">
                <span class="route-badge">Route ${item.routeNum}</span>
                <span class="route-name">${item.name}</span>
                ${subtextHtml}
            </div>
            <div class="bus-badge-group"></div>
        `;
        const badgeGroup = div.querySelector('.bus-badge-group');
        item.buses.forEach(bObj => {
            const badge = document.createElement('div');
            badge.className = 'bus-circle-badge';
            badge.textContent = bObj.busNo;
            badge.addEventListener('click', (e) => { 
                e.preventDefault(); e.stopPropagation(); window.ignoreMapTap = true; setTimeout(() => window.ignoreMapTap = false, 400);
                focusOnSpot(bObj.spotId); selectListRoute(item.key, bObj.spotId, false);
            });
            badgeGroup.appendChild(badge);
        });
        div.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation(); window.ignoreMapTap = true; setTimeout(() => window.ignoreMapTap = false, 400);
            if (item.buses.length > 0) { focusOnSpot(item.buses[0].spotId); selectListRoute(item.key, item.buses[0].spotId, false); }
        });
        fragment.appendChild(div);
    });
    container.innerHTML = '';
    container.appendChild(fragment);
    applyListSelection(container);
}

function highlightInList(spotId, fromMap = false) {
    const container = document.getElementById('bus-list');
    if (!container) return;
    const targetItem = Array.from(container.querySelectorAll('.bus-item')).find(item => {
        const spots = (item.dataset.spots || '').split(',').filter(Boolean);
        return spots.includes(spotId);
    });
    if (!targetItem) return;
    selectListRoute(targetItem.dataset.routeKey, spotId, fromMap);
}

const searchInput = document.getElementById('search-input');
if (searchInput) {
    searchInput.addEventListener('input', (e) => {
        currentSearchQuery = e.target.value.toLowerCase().trim();
        renderList(getFilteredBuses());
    });
}

function focusOnSpot(spotId) {
    if (!mapElement || !mapContainer) return;
    const spotGroup = document.getElementById(spotId);
    if (!spotGroup) return;
    const circle = spotGroup.querySelector('circle');
    if (!circle) return;
    
    if (draggableSheet && contentWrapper) {
        const halfHeight = contentWrapper.offsetHeight * 0.6; 
        currentTranslate = halfHeight;
        draggableSheet.style.transform = `translateY(${halfHeight}px)`;
    }

    const cx = parseFloat(circle.getAttribute('cx')), cy = parseFloat(circle.getAttribute('cy'));
    const contW = mapContainer.clientWidth, contH = mapContainer.clientHeight;
    const baseW = mapElement.viewBox.baseVal.width, baseH = mapElement.viewBox.baseVal.height;
    const scaleRatio = Math.max(contW / baseW, contH / baseH);
    const offsetX = ((baseW * scaleRatio) - contW) / 2, offsetY = ((baseH * scaleRatio) - contH) / 2;

    scale = 3.5;
    pointX = (contW / 2) - (((cx * scaleRatio) - offsetX) * scale);
    pointY = (contH * 0.45) - (((cy * scaleRatio) - offsetY) * scale); 
    
    mapElement.style.transition = 'transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)';
    setTransform();
    setTimeout(() => { if (mapElement) mapElement.style.transition = 'none'; }, 600);

    document.querySelectorAll('.active-target').forEach(el => el.classList.remove('active-target', 'pop-animate'));
    spotGroup.classList.add('active-target', 'pop-animate');
    setTimeout(() => { if (spotGroup) spotGroup.classList.remove('pop-animate'); }, 500);

    if (typeof showValidationCard === 'function') {
        const activeBusInfo = activeBuses.find(b => b.spotId === spotId);
        const allowTourValidation = !window.isTourActive || currentTourStep === 6;

        if (activeBusInfo && appState === 'VIEW' && allowTourValidation) {
            const voters = activeBusInfo.votersLedger || {};
            const isAuthor = activeBusInfo.updatedBy === currentDeviceToken || activeBusInfo.updatedBy === ('ADMIN_' + currentDeviceToken);
            const hasVoted = voters[currentDeviceToken] === true;
            if (isAuthor || hasVoted) hideValidationCard();
            else showValidationCard(activeBusInfo);
        } else hideValidationCard();
    }
}

const modal = document.getElementById('modal-overlay');
const tabPark = document.getElementById('tab-park'), tabDepart = document.getElementById('tab-depart');
const flowPark = document.getElementById('flow-park'), flowDepart = document.getElementById('flow-depart');
const s1 = document.getElementById('step-1'), s2 = document.getElementById('step-2'), s3Confirm = document.getElementById('step-3-confirm');
const grid = document.getElementById('bus-grid'), departList = document.getElementById('depart-bus-list');
const fixedFooter = document.getElementById('fixed-footer'), selFooter = document.getElementById('selection-footer');
const topBar = document.querySelector('.top-bar'), rSelect = document.getElementById('route-select');

if (document.getElementById('btn-update-bus')) {
    document.getElementById('btn-update-bus').onclick = () => {
        if (modal) modal.classList.remove('hidden');
        switchTab('PARK');
        if (s1) s1.classList.remove('hidden'); 
        if (s2) s2.classList.add('hidden');
        if (s3Confirm) s3Confirm.classList.add('hidden');
        pendingUpdate = { route: null, busNo: null, spotId: null, isReplacement: false };
    };
}
if (document.getElementById('btn-close-modal')) document.getElementById('btn-close-modal').onclick = () => { if (modal) modal.classList.add('hidden'); };

function switchTab(mode) {
    if (mode === 'PARK') {
        if (tabPark) tabPark.classList.add('active'); if (tabDepart) tabDepart.classList.remove('active');
        if (flowPark) flowPark.classList.remove('hidden'); if (flowDepart) flowDepart.classList.add('hidden');
    } else {
        if (tabDepart) tabDepart.classList.add('active'); if (tabPark) tabPark.classList.remove('active');
        if (flowDepart) flowDepart.classList.remove('hidden'); if (flowPark) flowPark.classList.add('hidden');
        renderSimpleDepartList();
    }
}
if (tabPark) tabPark.onclick = () => switchTab('PARK');
if (tabDepart) tabDepart.onclick = () => switchTab('DEPART');

function renderSimpleDepartList() {
    if (!departList) return;
    departList.innerHTML = '';
    const activeList = [];
    activeBuses.forEach(ab => {
        const routeLabel = ab.routes && ab.routes.length > 0 ? ab.routes.map(r => `Route ${r.num} (${r.name})`).join(' + ') : `Route ${ab.routeNum} - ${ab.name}`;
        ab.busNos.forEach(b => activeList.push({ busNo: b, label: routeLabel }));
    });
    unassignedBuses.forEach(ub => activeList.push({ busNo: ub.busNo, label: "Unassigned Spot" }));

    if (activeList.length === 0) {
        departList.innerHTML = `<p style="text-align:center;color:#727272;font-size:13px;padding:20px 0;">No active buses parked.</p>`;
        return;
    }
    activeList.forEach(item => {
        const card = document.createElement('div');
        card.className = 'depart-card';
        card.innerHTML = `
            <div>
                <div class="depart-left-title">Bus #${item.busNo}</div>
                <div class="depart-left-sub">${item.label}</div>
            </div>
            <div class="depart-action-pill">
                <svg class="ui-icon-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                <span>Remove from Map</span>
            </div>
        `;
        card.onclick = () => { const targetBus = item.busNo; if (modal) modal.classList.add('hidden'); executeFastUnassign(targetBus); };
        departList.appendChild(card);
    });
}

async function executeFastUnassign(busNumber) {
    if (window.isTourActive) return;
    try {
        const [snapActive, snapUn] = await Promise.all([get(ref(db, 'activeBuses')), get(ref(db, 'unassignedBuses'))]);
        const valActive = snapActive.val() || {}, valUn = snapUn.val() || {};
        let activeUpdates = {}, unassignedUpdates = {};

        Object.keys(valActive).filter(k => k.startsWith('spot-')).forEach(sId => {
            let bList = valActive[sId].busNos || (valActive[sId].busNo ? [valActive[sId].busNo] : []);
            if (bList.includes(busNumber)) {
                bList = bList.filter(b => b !== busNumber);
                if (bList.length === 0) activeUpdates[sId] = null;
                else activeUpdates[`${sId}/busNos`] = bList;
            }
        });

        Object.keys(valUn).filter(k => k.startsWith('spot-')).forEach(sId => {
            if (valUn[sId].busNo === busNumber) unassignedUpdates[sId] = null;
        });

        if (Object.keys(activeUpdates).length > 0) await update(ref(db, 'activeBuses'), activeUpdates);
        if (Object.keys(unassignedUpdates).length > 0) await update(ref(db, 'unassignedBuses'), unassignedUpdates);
        addContributionPoints(5);
    } catch (e) {}
}

if (document.getElementById('btn-next-1')) {
    document.getElementById('btn-next-1').onclick = () => {
        const selectedVal = rSelect.value;
        if (!selectedVal) return alert("Please select a route destination.");

        if (selectedVal === "UNASSIGNED") {
            pendingUpdate.route = null;
            if (s1) s1.classList.add('hidden');
            if (s2) s2.classList.remove('hidden');
            if (document.getElementById('step-2-summary')) document.getElementById('step-2-summary').textContent = `Parked on Campus (Route Unknown)`;
            populateBusGrid(true);
        } else {
            const [selNum, ...nameParts] = selectedVal.split('|');
            const selName = nameParts.join('|');
            pendingUpdate.route = ALL_ROUTES.find(r => r.num === selNum && r.name === selName);
            
            if (s1) s1.classList.add('hidden');
            if (s2) s2.classList.remove('hidden');
            if (document.getElementById('step-2-summary') && pendingUpdate.route) {
                document.getElementById('step-2-summary').textContent = `Route ${pendingUpdate.route.num} - ${pendingUpdate.route.name}`;
            }
            populateBusGrid(false);
        }
    };
}

function populateBusGrid(isUnassignedMode) {
    if (!grid) return;
    grid.innerHTML = '';
    const busesToShow = isUnassignedMode ? getUnassignedBusNumbers() : ALL_BUSES;

    if (busesToShow.length === 0) {
        grid.innerHTML = `<p style="grid-column:1/-1;text-align:center;color:#727272;font-size:13px;">All buses parked.</p>`;
        return;
    }

    busesToShow.forEach(bNo => {
        const isActive = activeBuses.find(ab => ab.busNos.includes(bNo));
        const isSpottedUnassigned = unassignedBuses.find(ub => ub.busNo === bNo);
        const btn = document.createElement('div');
        btn.className = `grid-bus ${isActive ? 'green' : 'grey'}`;
        btn.textContent = bNo;

        btn.onclick = () => {
            grid.querySelectorAll('.grid-bus').forEach(el => el.classList.remove('yellow-active'));
            btn.classList.add('yellow-active');
            pendingUpdate.busNo = bNo;

            if (isSpottedUnassigned) pendingUpdate.spotId = isSpottedUnassigned.spotId;
            else if (isActive) pendingUpdate.spotId = isActive.spotId;
        };
        grid.appendChild(btn);
    });
}

if (document.getElementById('btn-prev-2')) document.getElementById('btn-prev-2').onclick = () => { if (s2) s2.classList.add('hidden'); if (s1) s1.classList.remove('hidden'); };

if (document.getElementById('btn-next-2')) {
    document.getElementById('btn-next-2').onclick = () => {
        if (!pendingUpdate.busNo) return alert("Please select a bus number.");

        if (pendingUpdate.route) {
            const activeRouteSpots = activeBuses.filter(ab => {
                if (ab.routes && Array.isArray(ab.routes)) return ab.routes.some(r => r.num === pendingUpdate.route.num && r.name === pendingUpdate.route.name);
                return ab.routeNum === pendingUpdate.route.num && ab.name === pendingUpdate.route.name;
            });
            let isDifferentBus = false;

            if (activeRouteSpots.length > 0) {
                const existingBusesForRoute = activeRouteSpots.flatMap(spot => spot.busNos);
                if (existingBusesForRoute.length > 0 && !existingBusesForRoute.includes(pendingUpdate.busNo)) isDifferentBus = true;
            }

            if (isDifferentBus) {
                if (s2) s2.classList.add('hidden');
                if (s3Confirm) s3Confirm.classList.remove('hidden');
                if (document.getElementById('step-3-confirm-summary')) document.getElementById('step-3-confirm-summary').textContent = `Bus ${pendingUpdate.busNo} for Route ${pendingUpdate.route.num} - ${pendingUpdate.route.name}`;
            } else {
                goToMapSelection(false);
            }
        } else {
            goToMapSelection(false);
        }
    };
}

if (document.getElementById('btn-prev-3-confirm')) document.getElementById('btn-prev-3-confirm').onclick = () => { if (s3Confirm) s3Confirm.classList.add('hidden'); if (s2) s2.classList.remove('hidden'); };
if (document.getElementById('btn-replace-yes')) document.getElementById('btn-replace-yes').onclick = () => goToMapSelection(true);
if (document.getElementById('btn-replace-no')) document.getElementById('btn-replace-no').onclick = () => goToMapSelection(false);

function goToMapSelection(isReplacement) {
    pendingUpdate.isReplacement = isReplacement;
    appState = 'SELECTION';

    let summaryStr = pendingUpdate.route ? `(Route ${pendingUpdate.route.num} - ${pendingUpdate.route.name})` : `(Unassigned Location)`;
    let extraText = pendingUpdate.spotId ? `<br><span style="font-size:12px;color:#16a34a;font-weight:700;line-height:1.5;display:block;margin-top:6px;">Bus already on map. If location is correct, just tap Confirm.</span>` : '';

    if (document.getElementById('step-3-summary')) document.getElementById('step-3-summary').innerHTML = `Tap the exact spot where <span style="color:#815FD7;">Bus ${pendingUpdate.busNo}</span> is physically parked ${summaryStr}${extraText}`;

    if (s3Confirm) s3Confirm.classList.add('hidden');
    if (s2) s2.classList.add('hidden');
    if (modal) modal.classList.add('hidden');
    if (fixedFooter) fixedFooter.classList.add('hidden');
    if (draggableSheet) draggableSheet.style.transform = `translateY(150%)`;
    if (topBar) topBar.style.transform = `translateY(-150%)`;
    if (selFooter) selFooter.classList.remove('hidden');

    if (pendingUpdate.spotId && mapElement && mapContainer) {
        const spotGroup = document.getElementById(pendingUpdate.spotId);
        const circle = spotGroup ? spotGroup.querySelector('circle') : null;
        if (circle) {
            const cx = parseFloat(circle.getAttribute('cx')), cy = parseFloat(circle.getAttribute('cy'));
            const scaleRatio = Math.max(mapContainer.clientWidth / mapElement.viewBox.baseVal.width, mapContainer.clientHeight / mapElement.viewBox.baseVal.height);
            const offsetX = ((mapElement.viewBox.baseVal.width * scaleRatio) - mapContainer.clientWidth) / 2;
            const offsetY = ((mapElement.viewBox.baseVal.height * scaleRatio) - mapContainer.clientHeight) / 2;
            scale = 3.5;
            pointX = (mapContainer.clientWidth / 2) - (((cx * scaleRatio) - offsetX) * scale);
            pointY = (mapContainer.clientHeight * 0.45) - (((cy * scaleRatio) - offsetY) * scale);
        } else { scale = 1.6; pointX = 0; pointY = 0; }
    } else { scale = 1.6; pointX = 0; pointY = 0; }

    if (mapElement) {
        mapElement.style.transition = 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)';
        setTransform();
        setTimeout(() => { if (mapElement) mapElement.style.transition = 'none'; }, 400);
    }
    renderMapSpots();
}

if (document.getElementById('btn-prev-3')) {
    document.getElementById('btn-prev-3').onclick = () => {
        appState = 'VIEW';
        if (selFooter) selFooter.classList.add('hidden');
        if (fixedFooter) fixedFooter.classList.remove('hidden');
        if (draggableSheet) draggableSheet.style.transform = `translateY(${currentTranslate}px)`;
        if (topBar) topBar.style.transform = `translateY(0)`;
        if (modal) modal.classList.remove('hidden');
        renderMapSpots();
    };
}

if (document.getElementById('btn-submit-update')) {
    document.getElementById('btn-submit-update').onclick = async () => {
        if (!pendingUpdate.spotId) return alert("Tap a spot on the map!");
        
        if (window.isTourActive) {
            if (modal) modal.classList.add('hidden');
            if (selFooter) selFooter.classList.add('hidden');
            if (fixedFooter) fixedFooter.classList.remove('hidden');
            if (draggableSheet) draggableSheet.style.transform = `translateY(${currentTranslate}px)`;
            if (topBar) topBar.style.transform = `translateY(0)`;
            appState = 'VIEW';
            renderMapSpots();
            if (typeof window.nextTourStep === 'function') window.nextTourStep();
            return;
        }

        document.getElementById('btn-submit-update').disabled = true;
        const targetSpot = pendingUpdate.spotId;
        const selectedBus = pendingUpdate.busNo;
        const targetRoute = pendingUpdate.route;
        appState = 'VIEW';

        if (selFooter) selFooter.classList.add('hidden');
        if (fixedFooter) fixedFooter.classList.remove('hidden');
        if (draggableSheet) draggableSheet.style.transform = `translateY(${currentTranslate}px)`;
        if (topBar) topBar.style.transform = `translateY(0)`;

        try {
            const [snapActive, snapUn] = await Promise.all([get(ref(db, 'activeBuses')), get(ref(db, 'unassignedBuses'))]);
            const activeData = snapActive.val() || {}, unData = snapUn.val() || {};
            const updates = {};
            let notificationUpdates = {};
            const timestamp = Date.now();

            let routeOldBus = null, isNewRoute = true, oldSpotForSelectedBus = null;

            if (activeData[targetSpot]) {
                const existingSpot = activeData[targetSpot];
                const existingBuses = existingSpot.busNos || (existingSpot.busNo ? [existingSpot.busNo] : []);
                const isSameBus = existingBuses.includes(selectedBus);

                if (!isSameBus && existingBuses.length > 0) {
                    alert(`Slot is occupied by Bus ${existingBuses.join(', ')}. A parking slot can only hold one physical bus at a time. Please mark it departed first.`);
                    document.getElementById('btn-submit-update').disabled = false;
                    return;
                }
            }

            Object.keys(activeData).filter(k => k.startsWith('spot-')).forEach(sId => {
                const item = activeData[sId];
                if (!item) return;
                const bList = item.busNos || (item.busNo ? [item.busNo] : []);
                if (bList.includes(selectedBus)) oldSpotForSelectedBus = sId;
                
                const hasRoute = (item.routes && Array.isArray(item.routes))
                    ? item.routes.some(r => targetRoute && r.num === targetRoute.num && r.name === targetRoute.name)
                    : (targetRoute && item.routeNum === targetRoute.num && item.name === targetRoute.name);

                if (hasRoute) { isNewRoute = false; routeOldBus = bList[0]; }
            });

            Object.keys(activeData).filter(k => k.startsWith('spot-')).forEach(sId => {
                let spotData = activeData[sId];
                if (!spotData) return;
                let bList = spotData.busNos || (spotData.busNo ? [spotData.busNo] : []);
                let voters = spotData.votersLedger || {};
                let modified = false;

                if (spotData.users >= 999 && Object.keys(voters).length === 0) voters = { 'admin_locked': true };

                if (bList.includes(selectedBus) && sId !== targetSpot) {
                    bList = bList.filter(b => b !== selectedBus);
                    modified = true;
                    if (voters[currentDeviceToken]) delete voters[currentDeviceToken];
                }

                const matchesRoute = (spotData.routes && Array.isArray(spotData.routes))
                    ? spotData.routes.some(r => targetRoute && r.num === targetRoute.num && r.name === targetRoute.name)
                    : (targetRoute && spotData.routeNum === targetRoute.num && spotData.name === targetRoute.name);

                if (targetRoute && pendingUpdate.isReplacement && matchesRoute) {
                    bList = [];
                    modified = true;
                    if (voters[currentDeviceToken]) delete voters[currentDeviceToken];
                    if (sId !== targetSpot) busLocationTracker[selectedBus] = sId;
                }

                if (modified && sId !== targetSpot) {
                    if (bList.length === 0 || Object.keys(voters).length === 0) updates[`activeBuses/${sId}`] = null;
                    else {
                        updates[`activeBuses/${sId}/busNos`] = bList;
                        updates[`activeBuses/${sId}/users`] = spotData.users >= 999 ? 999 : Object.keys(voters).length;
                        updates[`activeBuses/${sId}/votersLedger`] = voters;
                    }
                }
            });

            Object.keys(unData).filter(k => k.startsWith('spot-')).forEach(sId => {
                if (unData[sId] && unData[sId].busNo === selectedBus) updates[`unassignedBuses/${sId}`] = null;
            });

            if (targetRoute) {
                let existingRoutes = [];
                let existingVoters = {};

                if (activeData[targetSpot]) {
                    const spotData = activeData[targetSpot];
                    if (spotData.routes && Array.isArray(spotData.routes)) existingRoutes = [...spotData.routes];
                    else if (spotData.routeNum && spotData.name) existingRoutes = [{ num: spotData.routeNum, name: spotData.name }];

                    if (pendingUpdate.isReplacement) existingRoutes = [];
                    
                    existingVoters = spotData.votersLedger || {};
                    if (spotData.users >= 999 && Object.keys(existingVoters).length === 0) existingVoters = { 'admin_locked': true };
                }

                if (!existingRoutes.some(r => r.num === targetRoute.num && r.name === targetRoute.name)) {
                    existingRoutes.push({ num: targetRoute.num, name: targetRoute.name });
                }

                existingVoters[currentDeviceToken] = true;

                if (pendingUpdate.isReplacement && !isNewRoute && routeOldBus && routeOldBus !== selectedBus) {
                    const notifId = Date.now().toString() + "_" + Math.random().toString(36).substr(2, 4);
                    notificationUpdates[notifId] = {
                        title: `Bus Changed for ${targetRoute.name}`,
                        message: `Bus for ${targetRoute.name} has changed to Bus ${selectedBus}.`,
                        routeName: targetRoute.name,
                        createdAt: Date.now(),
                        senderToken: currentDeviceToken
                    };
                    fetch('https://seenmybus-notifier.rahmansaif822.workers.dev/broadcast', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ title: `Bus Changed for ${targetRoute.name}`, message: `Bus for ${targetRoute.name} has changed to Bus ${selectedBus}.`, routeName: targetRoute.name, sender: currentDeviceToken })
                    }).catch(e => {});
                }

                const combinedNums = existingRoutes.map(r => r.num).join(', ');
                const combinedNames = existingRoutes.map(r => r.name).join(' + ');

                updates[`activeBuses/${targetSpot}`] = {
                    busNo: selectedBus,
                    busNos: [selectedBus],
                    routeNum: combinedNums,
                    name: combinedNames,
                    routes: existingRoutes,
                    users: existingVoters['admin_locked'] ? 999 : Object.keys(existingVoters).length,
                    votersLedger: existingVoters,
                    updatedAt: timestamp,
                    updatedBy: currentDeviceToken
                };
            } else {
                updates[`unassignedBuses/${targetSpot}`] = { busNo: selectedBus, updatedAt: timestamp, updatedBy: currentDeviceToken };
            }

            await update(ref(db), updates);
            if (Object.keys(notificationUpdates).length > 0) await update(ref(db, 'broadcastNotifications'), notificationUpdates);
            await addContributionPoints(10);
        } catch (err) {} finally { document.getElementById('btn-submit-update').disabled = false; }
    };
}

const valBubble = document.getElementById('bus-validation-bubble');
const valFab = document.getElementById('val-fab'), valCard = document.getElementById('val-card');
const valBusDetails = document.getElementById('val-bus-details');
const btnValYes = document.getElementById('btn-val-yes'), btnValNo = document.getElementById('btn-val-no'), btnValCollapse = document.getElementById('val-btn-collapse');

let currentValidationBus = null, isValidationCardCollapsed = false;

if (valBubble) ['touchstart', 'touchmove', 'touchend', 'mousedown', 'mousemove', 'mouseup', 'click', 'wheel'].forEach(evt => { valBubble.addEventListener(evt, (e) => e.stopPropagation(), { passive: false }); });

function showValidationCard(busInfo) {
    if (!valBubble || !busInfo) return;
    if (!currentValidationBus || currentValidationBus.spotId !== busInfo.spotId) isValidationCardCollapsed = false; 
    currentValidationBus = busInfo;
    const busDisplay = busInfo.busNos ? busInfo.busNos.join(', ') : busInfo.busNo;
    
    let routeDesc = busInfo.name;
    if (busInfo.routes && Array.isArray(busInfo.routes)) routeDesc = busInfo.routes.map(r => `Route ${r.num} (${r.name})`).join(' & ');

    if (valBusDetails) valBusDetails.textContent = `Bus number ${busDisplay} for ${routeDesc} has been parked here.`;
    valBubble.classList.remove('hidden');
    if (isValidationCardCollapsed) { if (valFab) valFab.classList.remove('hidden'); if (valCard) valCard.classList.add('hidden'); }
    else { if (valFab) valFab.classList.add('hidden'); if (valCard) valCard.classList.remove('hidden'); }
}

function hideValidationCard() {
    currentValidationBus = null;
    if (valBubble) valBubble.classList.add('hidden');
    if (valCard) valCard.classList.add('hidden');
    if (valFab) valFab.classList.add('hidden');
}

if (valFab) valFab.onclick = () => { isValidationCardCollapsed = false; valFab.classList.add('hidden'); valCard.classList.remove('hidden'); };
if (btnValCollapse) btnValCollapse.onclick = () => { isValidationCardCollapsed = true; valCard.classList.add('hidden'); valFab.classList.remove('hidden'); };

if (btnValYes) {
    btnValYes.onclick = async () => {
        if (window.isTourActive) { if (typeof hideValidationCard === 'function') hideValidationCard(); if (typeof window.nextTourStep === 'function') window.nextTourStep(); return; }
        if (!currentValidationBus) return;
        const spotId = currentValidationBus.spotId;
        const item = activeBuses.find(b => b.spotId === spotId);
        if (!item) { alert("This bus is no longer active at this slot."); hideValidationCard(); return; }
        if (item.updatedBy === currentDeviceToken || item.updatedBy === ('ADMIN_' + currentDeviceToken)) { alert("You posted the latest update for this bus. Only others can validate it."); return; }
        const voters = item.votersLedger || {};
        if (voters[currentDeviceToken]) { alert("You have already confirmed this bus location."); return; }

        voters[currentDeviceToken] = true;
        const newCount = voters['admin_locked'] ? 999 : Object.keys(voters).length;
        const updates = {};
        updates[`activeBuses/${spotId}/votersLedger`] = voters;
        updates[`activeBuses/${spotId}/users`] = newCount;

        try {
            btnValYes.disabled = true;
            await update(ref(db), updates);
            await addContributionPoints(5);
            alert("Thanks for keeping the AJU community updated!");
            hideValidationCard();
        } catch (err) {} finally { btnValYes.disabled = false; }
    };
}

if (btnValNo) {
    btnValNo.onclick = () => {
        if (window.isTourActive) { if (typeof hideValidationCard === 'function') hideValidationCard(); if (typeof window.nextTourStep === 'function') window.nextTourStep(); return; }
        if (!currentValidationBus) return;
        const targetBus = currentValidationBus;
        hideValidationCard();

        if (modal) modal.classList.remove('hidden');
        switchTab('PARK');

        let primaryRoute = null;
        if (targetBus.routes && targetBus.routes.length > 0) primaryRoute = targetBus.routes[0];

        pendingUpdate.route = primaryRoute || ALL_ROUTES.find(r => r.num === targetBus.routeNum && r.name === targetBus.name) || ALL_ROUTES.find(r => r.num === targetBus.routeNum) || null;
        pendingUpdate.busNo = (targetBus.busNos && targetBus.busNos[0]) || targetBus.busNo || null;
        pendingUpdate.spotId = targetBus.spotId;
        pendingUpdate.isReplacement = false;

        if (rSelect && pendingUpdate.route) rSelect.value = `${pendingUpdate.route.num}|${pendingUpdate.route.name}`;

        if (s1) s1.classList.add('hidden');
        if (s2) s2.classList.remove('hidden');
        if (s3Confirm) s3Confirm.classList.add('hidden');
        if (document.getElementById('step-2-summary') && pendingUpdate.route) document.getElementById('step-2-summary').textContent = `Route ${pendingUpdate.route.num} - ${pendingUpdate.route.name}`;

        populateBusGrid(false);
        if (grid && pendingUpdate.busNo) {
            const activeBtn = Array.from(grid.querySelectorAll('.grid-bus')).find(el => el.textContent.trim() === pendingUpdate.busNo);
            if (activeBtn) activeBtn.classList.add('yellow-active');
        }
    };
}

// --- Industrial Network Sentinel Engine ---
const offlineOverlay = document.getElementById('offline-screen');
const btnRetryNetwork = document.getElementById('btn-retry-network');
let offlineDebounceTimer = null;
let isCurrentlyOffline = false;

async function pingNetwork() {
    if (!navigator.onLine) return false;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2500);
        const res = await fetch(`/manifest.json?_probe=${Date.now()}`, { method: 'HEAD', cache: 'no-store', signal: controller.signal });
        clearTimeout(timeoutId);
        return res.ok;
    } catch (e) { return false; }
}

function showOfflineUI() {
    isCurrentlyOffline = true;
    if (offlineOverlay) { offlineOverlay.classList.add('active'); offlineOverlay.setAttribute('aria-hidden', 'false'); }
}

function hideOfflineUI() {
    isCurrentlyOffline = false;
    if (offlineOverlay) { offlineOverlay.classList.remove('active'); offlineOverlay.setAttribute('aria-hidden', 'true'); }
    goOnline(db);
}

window.addEventListener('offline', () => {
    clearTimeout(offlineDebounceTimer);
    offlineDebounceTimer = setTimeout(async () => {
        const isConnected = await pingNetwork();
        if (!isConnected) showOfflineUI();
    }, 3500);
});

window.addEventListener('online', async () => {
    clearTimeout(offlineDebounceTimer);
    const isConnected = await pingNetwork();
    if (isConnected && isCurrentlyOffline) hideOfflineUI();
});

if (btnRetryNetwork) {
    btnRetryNetwork.addEventListener('click', async () => {
        btnRetryNetwork.disabled = true;
        btnRetryNetwork.textContent = 'Checking connection...';
        const isConnected = await pingNetwork();
        if (isConnected) {
            btnRetryNetwork.textContent = 'Connected!';
            setTimeout(() => { hideOfflineUI(); btnRetryNetwork.disabled = false; btnRetryNetwork.textContent = 'Try Again'; }, 600);
        } else {
            btnRetryNetwork.textContent = 'Still Offline';
            setTimeout(() => { btnRetryNetwork.disabled = false; btnRetryNetwork.textContent = 'Try Again'; }, 1500);
        }
    });
}
setTimeout(async () => { if (!navigator.onLine) { const isConnected = await pingNetwork(); if (!isConnected) showOfflineUI(); } }, 1000);

// --- Viewport & Sidebar Safe Navigation Recovery ---
window.addEventListener('pageshow', (event) => {
    window.scrollTo(0, 0); document.body.scrollTop = 0;
    if (sidePanel) { sidePanel.classList.remove('open'); sidePanel.scrollTop = 0; }
    if (sideOverlay) sideOverlay.classList.add('hidden');
    currentTranslate = 0;
    if (draggableSheet) { draggableSheet.style.transition = 'transform 0.3s ease'; draggableSheet.style.transform = 'translateY(0px)'; }
    if (fixedFooter) { fixedFooter.classList.remove('hidden'); fixedFooter.style.transform = 'translateY(0)'; }
    if (topBar) topBar.style.transform = 'translateY(0)';
    appState = 'VIEW';
    if (mapElement) renderMapSpots();
});

// --- Interactive Onboarding Controller ---
let currentTourStep = 1;
const totalTourSteps = 10;
window.isTourActive = false;
let tourAbortController = new AbortController();

window.forceTourRefresh = async function() {
    try {
        const snapActive = await get(ref(db, 'activeBuses'));
        const snapUn = await get(ref(db, 'unassignedBuses'));
        handleBusesData(snapActive.val());
        handleUnassignedData(snapUn.val());
    } catch (e) {
        handleBusesData(null);
        handleUnassignedData(null);
    }
};

function checkFirstVisitOnboarding() {
    if (!localStorage.getItem('smb_tour_completed')) setTimeout(() => showTourStep(1), 1000);
}

window.showTourStep = function(stepNum) {
    currentTourStep = stepNum;
    const overlay = document.getElementById('onboarding-overlay');
    if (!overlay) return;
    
    overlay.classList.remove('hidden');
    
    if (stepNum >= 5) {
        overlay.classList.add('app-visible');
        const fsContainer = document.getElementById('tour-fs-container');
        if (fsContainer) fsContainer.style.display = 'none';
        const spotContainer = document.getElementById('tour-spotlight-container');
        if (spotContainer) spotContainer.classList.remove('hidden');
    } else {
        overlay.classList.remove('app-visible');
        const fsContainer = document.getElementById('tour-fs-container');
        if (fsContainer) fsContainer.style.display = 'block';
        const spotContainer = document.getElementById('tour-spotlight-container');
        if (spotContainer) spotContainer.classList.add('hidden');
    }

    if (stepNum <= 4) {
        document.querySelectorAll('.tour-fs-slide').forEach(el => {
            const s = parseInt(el.dataset.step);
            if (s === stepNum) el.className = 'tour-fs-slide tour-step active-slide';
            else if (s < stepNum) el.className = 'tour-fs-slide tour-step hidden-left';
            else el.className = 'tour-fs-slide tour-step hidden-right';
        });
    }

    if (stepNum >= 5) {
        document.querySelectorAll('.tour-spotlight-step').forEach(el => {
            if (parseInt(el.dataset.step) === stepNum) el.classList.remove('hidden');
            else el.classList.add('hidden');
        });
    }

    document.querySelectorAll('.tour-target-glow').forEach(el => el.classList.remove('tour-target-glow'));
    document.querySelectorAll('.tour-target-html').forEach(el => el.classList.remove('tour-target-html'));
    
    tourAbortController.abort();
    tourAbortController = new AbortController();
    const signal = tourAbortController.signal;

    if (stepNum === 5) {
        window.isTourActive = true;
        window.forceTourRefresh();
        if (typeof hideValidationCard === 'function') hideValidationCard();

        setTimeout(() => {
            focusOnSpot('spot-15');
            const adityapurSpot = document.getElementById('spot-15');
            if (adityapurSpot) adityapurSpot.classList.add('tour-target-glow');

            ['spot-15', 'spot-03', 'spot-07'].forEach(sId => {
                const el = document.getElementById(sId);
                if (el) {
                    el.addEventListener('click', () => {
                        if (adityapurSpot) adityapurSpot.classList.remove('tour-target-glow');
                        setTimeout(() => {
                            window.nextTourStep();
                            const busInfo = activeBuses.find(b => b.spotId === sId);
                            if (busInfo && typeof showValidationCard === 'function') showValidationCard(busInfo);
                        }, 300);
                    }, { once: true, signal });
                }
            });
        }, 500);
    }

    if (stepNum === 6) {
        setTimeout(() => {
            const btnYes = document.getElementById('btn-val-yes'), btnNo = document.getElementById('btn-val-no');
            if (btnYes) btnYes.classList.add('tour-target-html');
            if (btnNo) btnNo.classList.add('tour-target-html');
        }, 500);
    }

    if (stepNum === 7) {
        const searchInput = document.getElementById('search-input');
        if (searchInput) searchInput.classList.add('tour-target-html');
    }

    if (stepNum === 8) {
        setTimeout(() => {
            const listEl = document.querySelector('#bus-list .bus-item[data-route-key="route_6_Adityapur"]') || document.querySelector('#bus-list .bus-item');
            if (listEl) listEl.classList.add('tour-target-html');
        }, 300);
    }

    if (stepNum === 9) {
        const btnUpdate = document.getElementById('btn-update-bus');
        if (btnUpdate) {
            btnUpdate.classList.add('tour-target-html');
            btnUpdate.addEventListener('click', () => {
                btnUpdate.classList.remove('tour-target-html');
                setTimeout(() => window.nextTourStep(), 400);
            }, { once: true, signal });
        }
    }
};

window.nextTourStep = function() {
    if (typeof hideValidationCard === 'function') hideValidationCard();
    document.querySelectorAll('.tour-target-glow').forEach(el => el.classList.remove('tour-target-glow'));
    document.querySelectorAll('.tour-target-html').forEach(el => el.classList.remove('tour-target-html'));
    if (currentTourStep < totalTourSteps) window.showTourStep(currentTourStep + 1);
    else window.finishTour();
};

window.skipTour = function() { window.finishTour(); };

window.finishTour = function() {
    localStorage.setItem('smb_tour_completed', 'true');
    window.isTourActive = false;
    tourAbortController.abort();
    
    lastActiveDataSignature = null;
    lastUnassignedDataSignature = null;
    activeBuses = []; unassignedBuses = []; busLocationTracker = {}; routeLocationTracker = {};
    window.forceTourRefresh();
    
    const overlay = document.getElementById('onboarding-overlay');
    if (overlay) overlay.classList.add('hidden');
    const modal = document.getElementById('modal-overlay');
    if (modal) modal.classList.add('hidden');
    if (typeof hideValidationCard === 'function') hideValidationCard();
    if (typeof window.triggerPostTourConsents === 'function') window.triggerPostTourConsents();
};

checkFirstVisitOnboarding();

const replayTourBtn = document.getElementById('btn-replay-tour');
if (replayTourBtn) {
    replayTourBtn.onclick = (e) => {
        e.preventDefault();
        const sidePanel = document.getElementById('side-panel');
        const sideOverlay = document.getElementById('side-panel-overlay');
        if (sidePanel) sidePanel.classList.remove('open');
        if (sideOverlay) sideOverlay.classList.add('hidden');
        window.showTourStep(1);
    };
}

const devNoteToggle = document.getElementById('dev-note-toggle');
const devNoteCard = document.getElementById('dev-note-card');
if (devNoteToggle && devNoteCard) { devNoteToggle.onclick = () => { devNoteCard.classList.toggle('collapsed'); }; }
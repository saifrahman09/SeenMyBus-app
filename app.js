// Import Firebase modular SDKs via CDN
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { getDatabase, ref, onValue, set, update, get, goOnline } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-database.js";

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

// Selection State Trackers
// UI-only state. Firebase realtime syncing is intentionally untouched.
let selectedRouteKey = null;
let topRouteKey = null;
let listOrderKeys = [];
let lastActiveDataSignature = null;
let lastUnassignedDataSignature = null;
let mapViewportInitialized = false;

// Ghost Click Protector
window.ignoreMapTap = false; 

// Routes & Slots Registry
const allRoutes = [
    { num: "6", name: "Adityapur" }, { num: "7", name: "Mango chauk" },
    { num: "3", name: "Bistupur" }, { num: "9", name: "Dhatkidih" },
    { num: "5", name: "Telco Colony" }, { num: "2", name: "Lal Building" }
];
const allBuses = ["01", "02", "03", "04", "05", "10", "15", "19", "22", "25", "29", "30"];
const allSpots = [
    "spot-01", "spot-02", "spot-03", "spot-04", "spot-05",
    "spot-06", "spot-07", "spot-08", "spot-09", "spot-10",
    "spot-11", "spot-12", "spot-13", "spot-14", "spot-15",
    "spot-16", "spot-17", "spot-18", "spot-19", "spot-20",
    "spot-21", "spot-22", "spot-23", "spot-24", "spot-25",
    "spot-26", "spot-27"
];

// --- 1. Background Service Worker Registration ---
// --- 1. Background Service Worker Registration & Cache Nuke ---
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then(registration => {
        // Force the browser to check for sw.js updates every time the page loads
        registration.update();
    }).catch(err => console.log("SW Registration bypassed:", err));
}

// --- 2. Admin Visibility Check ---
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

// --- 3. Triple-Tap Sidebar Logo Gesture ---
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

// --- 4. Simplified Device Identity ---
function getDeviceToken() {
    let token = localStorage.getItem('smb_device_token');
    if (!token) {
        token = 'dev_' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('smb_device_token', token);
    }
    return token;
}
const currentDeviceToken = getDeviceToken();

// --- 5. Real-Time Keepalive & Reconnect ---
const connectedRef = ref(db, ".info/connected");
onValue(connectedRef, (snap) => {
    if (snap.val() === true) console.log("SeenMyBus Realtime Connected");
});
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') goOnline(db);
});

// --- 6. Splash Screen Dismissal ---
function hideSplashScreen() {
    const splash = document.getElementById('splash-screen');
    if (splash && !splash.classList.contains('fade-out')) {
        splash.classList.add('fade-out');
        setTimeout(() => { if (splash.parentNode) splash.remove(); }, 500);
    }
}
setTimeout(hideSplashScreen, 1500);

// --- 7. Guide, Points & Ranks ---
function initPinchGuide() {
    const guide = document.getElementById('pinch-guide');
    if (!guide) return;
    if (!localStorage.getItem('smb_guide_shown')) {
        guide.classList.remove('hidden');
        const dismissGuide = () => {
            if (!guide.classList.contains('fade-out')) {
                guide.classList.add('fade-out');
                localStorage.setItem('smb_guide_shown', 'true');
                setTimeout(() => guide.classList.add('hidden'), 500);
            }
        };
        if (mapContainer) {
            mapContainer.addEventListener('touchstart', dismissGuide, { once: true, passive: true });
            mapContainer.addEventListener('mousedown', dismissGuide, { once: true });
        }
        setTimeout(dismissGuide, 4500);
    }
}

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
    } catch (e) {
        console.error("Contributor sync error:", e);
    }
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

// --- 8. Notification System ---
function initNotificationSystem() {
    const notifBanner = document.getElementById('notif-banner');
    if (!notifBanner) return;
    const isAsked = localStorage.getItem('smb_notif_asked');
    if (!isAsked && "Notification" in window && Notification.permission === 'default') {
        setTimeout(() => { if (!localStorage.getItem('smb_notif_asked')) notifBanner.classList.remove('hidden'); }, 15000);
    }
    const allowBtn = document.getElementById('btn-allow-notif');
    if (allowBtn) {
        allowBtn.onclick = () => {
            Notification.requestPermission().then(() => {
                localStorage.setItem('smb_notif_asked', 'true');
                notifBanner.classList.add('hidden');
            });
        };
    }
    const dismissBtn = document.getElementById('btn-dismiss-notif');
    if (dismissBtn) {
        dismissBtn.onclick = () => {
            localStorage.setItem('smb_notif_asked', 'true');
            notifBanner.classList.add('hidden');
        };
    }
}

function sendLocalNotification(title, body) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;

    // Professional notification configuration to prevent spam flagging
    const notifOptions = {
        body: body,
        icon: "./logo.svg",
        badge: "./logo.svg", // Shows official white/transparent icon in Android status bar
        vibrate: [200, 100, 200, 100, 200],
        tag: "aju-bus-alert", // Groups alerts so they replace each other instead of spamming 100 separate alerts
        renotify: true,
        actions: [
            { action: 'open_map', title: 'See on App' },
            { action: 'dismiss', title: 'Dismiss' }
        ]
    };

    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then(registration => {
            registration.showNotification(title, notifOptions);
        });
    } else {
        const notif = new Notification(title, notifOptions);
        notif.onclick = function() {
            window.focus();
            this.close();
        };
    }
}

onValue(ref(db, 'broadcastNotifications'), (snap) => {
    const broadcasts = snap.val();
    if (!broadcasts) return;
    const lastSeenTime = parseInt(localStorage.getItem('smb_last_broadcast_seen') || '0', 10);
    Object.keys(broadcasts).forEach(notifId => {
        const item = broadcasts[notifId];
        if (item && item.createdAt > lastSeenTime) {
            sendLocalNotification(item.title || "Campus Bus Alert", item.message);
            localStorage.setItem('smb_last_broadcast_seen', Date.now().toString());
        }
    });
});

// --- 9. Smooth SVG Relocation Transit Animation ---
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

// --- 10. Automated Purge Engine ---
function isDataStale(updatedAt) { return (Date.now() - updatedAt) > (90 * 60 * 1000); }
async function checkShiftPurge(data) {
    if (!data) return;
    const now = new Date();
    const currentMins = now.getHours() * 60 + now.getMinutes();
    const cutoffs = [795, 975, 1140]; // 1:15 PM, 4:15 PM, 7:00 PM
    
    let activeBusesUpdates = {};
    let needsPurge = false;
    
    Object.keys(data).forEach(spotId => {
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
        catch (e) { console.error("Purge Error:", e); }
    }
}

// --- 11. Consent & Setup ---
const consentBanner = document.getElementById('consent-banner');
if (consentBanner && !localStorage.getItem('aju_consent')) consentBanner.classList.remove('hidden');
const acceptBtn = document.getElementById('btn-accept-cookies');
if (acceptBtn) {
    acceptBtn.onclick = () => {
        localStorage.setItem('aju_consent', 'true');
        if (consentBanner) consentBanner.classList.add('hidden');
        initNotificationSystem();
        loadUserRank();
    };
}
initPinchGuide();
initNotificationSystem();
loadUserRank();

const btnHam = document.getElementById('btn-hamburger');
const sidePanel = document.getElementById('side-panel');
const sideOverlay = document.getElementById('side-panel-overlay');
const closePanel = document.getElementById('btn-close-panel');
const togglePanel = () => {
    if (sidePanel) sidePanel.classList.toggle('open');
    if (sideOverlay) sideOverlay.classList.toggle('hidden');
    if (sidePanel && sidePanel.classList.contains('open')) loadUserRank();
};
if (btnHam) btnHam.onclick = togglePanel;
if (closePanel) closePanel.onclick = togglePanel;
if (sideOverlay) sideOverlay.onclick = togglePanel;

// --- 12. Load Campus Map ---
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
    })
    .catch(err => { hideSplashScreen(); });

// Helper to filter active buses by search query
function getFilteredBuses() {
    if (!currentSearchQuery) return activeBuses;
    return activeBuses.filter(bus => 
        bus.busNos.some(b => b.toLowerCase().includes(currentSearchQuery)) || 
        bus.name.toLowerCase().includes(currentSearchQuery) || 
        bus.routeNum.toLowerCase().includes(currentSearchQuery)
    );
}

// --- 13. Realtime & Auto-Refresh Syncing ---
function createActiveDataSignature(data) {
    if (!data) return '';
    return Object.keys(data).sort().map(spotId => {
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
    return Object.keys(data).sort().map(spotId => {
        const item = data[spotId] || {};
        return `${spotId}~${item.busNo || ''}~${item.updatedAt ?? ''}~${item.updatedBy ?? ''}`;
    }).join('|');
}

function handleBusesData(data) {
    const skeleton = document.getElementById('skeleton-loader');
    const busListEl = document.getElementById('bus-list');
    if (skeleton) skeleton.classList.add('hidden');
    if (busListEl) busListEl.classList.remove('hidden');

    if (!data) {
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

    const newActiveBuses = Object.keys(data).map(spotId => {
        const item = data[spotId];
        const buses = item.busNos ? item.busNos : (item.busNo ? [item.busNo] : []);
        return { spotId, ...item, busNos: buses };
    });

    const newRouteLocationTracker = {};

    newActiveBuses.forEach(ab => {
        ab.busNos.forEach(bNo => {
            let prevSpot = busLocationTracker[bNo];

            if (
                !prevSpot &&
                routeLocationTracker[ab.routeNum] &&
                routeLocationTracker[ab.routeNum] !== ab.spotId
            ) {
                prevSpot = routeLocationTracker[ab.routeNum];
            }

            if (prevSpot && prevSpot !== ab.spotId) {
                animateBusTransition(bNo, prevSpot, ab.spotId);
            }

            busLocationTracker[bNo] = ab.spotId;
        });

        newRouteLocationTracker[ab.routeNum] = ab.spotId;
    });

    routeLocationTracker = newRouteLocationTracker;
    activeBuses = newActiveBuses;

    if (appState === 'VIEW') {
        if (mapElement) renderMapSpots();
        renderList(getFilteredBuses());
    }
}

function handleUnassignedData(data) {
    const signature = createUnassignedDataSignature(data);
    if (signature === lastUnassignedDataSignature) return;

    lastUnassignedDataSignature = signature;

    unassignedBuses = data
        ? Object.keys(data).map(spotId => ({ spotId, ...data[spotId] }))
        : [];

    if (appState === 'VIEW' && mapElement) renderMapSpots();
}

onValue(ref(db, 'activeBuses'), (snapshot) => { try { handleBusesData(snapshot.val()); } catch (err) {} });
onValue(ref(db, 'unassignedBuses'), (snapshot) => { try { handleUnassignedData(snapshot.val()); } catch (e) {} });

// 5-Second Real-Time Auto-Refresh
setInterval(async () => {
    try {
        const snapActive = await get(ref(db, 'activeBuses'));
        handleBusesData(snapActive.val());
        const snapUn = await get(ref(db, 'unassignedBuses'));
        handleUnassignedData(snapUn.val());
    } catch (e) {}
}, 5000);

function getUnassignedBusNumbers() {
    const assigned = new Set();
    activeBuses.forEach(ab => ab.busNos.forEach(b => assigned.add(b)));
    return allBuses.filter(bNo => !assigned.has(bNo));
}

// --- 14. Map Render Logic ---
function renderMapSpots() {
    allSpots.forEach(spotId => {
        const g = document.getElementById(spotId);
        if (!g) return;

        g.querySelectorAll('text.spot-text').forEach(t => t.remove());

        g.classList.remove(
            'spot-grey',
            'spot-green',
            'spot-yellow',
            'spot-deep-green',
            'spot-unassigned'
        );

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
                g.style.opacity = '1';
                g.style.pointerEvents = 'all';

                g.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (window.ignoreMapTap) return;

                    focusOnSpot(spotId);
                    highlightInList(spotId, true);
                };
            } else if (unassignedInfo) {
                g.classList.add('spot-unassigned');
                addTextToSpot(g, unassignedInfo.busNo, 'text-black');
                g.style.opacity = '1';
                g.style.pointerEvents = 'all';

                g.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (window.ignoreMapTap) return;

                    focusOnSpot(spotId);
                };
            } else {
                // HIDE EMPTY SPOTS IN NORMAL VIEW
                g.classList.add('spot-grey');
                g.style.opacity = '0';
                g.style.pointerEvents = 'none';
                g.onclick = null;
            }
        } else if (appState === 'SELECTION') {
            // SHOW ALL SPOTS DURING FORM SELECTION
            g.style.opacity = '1';
            g.style.pointerEvents = 'all';

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
                    const existingRouteNum = busInfo.routeNum;

                    if (pendingUpdate.isReplacement) {
                        if (
                            pendingUpdate.route &&
                            existingRouteNum !== pendingUpdate.route.num
                        ) {
                            alert(`Slot occupied by Route ${existingRouteNum}. Please mark it departed first.`);
                            return;
                        }
                    } else {
                        const existingBuses = busInfo.busNos || [];

                        if (
                            existingBuses.length > 0 &&
                            !existingBuses.includes(pendingUpdate.busNo)
                        ) {
                            alert(`Slot is already occupied. A slot can only hold one bus at a time.`);
                            return;
                        }
                    }
                }
                
                allSpots.forEach(s => {
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

// --- 15. Sheet Drag & Pure Pan Engine ---
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

let scale = 1;
let pointX = 0;
let pointY = 0;
let startX = 0;
let startY = 0;
let isPanning = false;
let initialPinchDist = null;
let initialScale = 1;
let panPointerMoved = false;

let transformFramePending = false;

const DEFAULT_MAP_ZOOM = 1.95;
const DEFAULT_MAP_CENTER_X = 735;
const DEFAULT_MAP_CENTER_Y = 750;

function applyBoundaries() {
    if (!mapContainer) return;

    const contW = mapContainer.clientWidth;
    const contH = mapContainer.clientHeight;

    const scaledW = contW * scale;
    const scaledH = contH * scale;

    if (scaledW <= contW) {
        pointX = (contW - scaledW) / 2;
    } else {
        pointX = Math.min(
            0,
            Math.max(pointX, contW - scaledW)
        );
    }

    if (scaledH <= contH) {
        pointY = (contH - scaledH) / 2;
    } else {
        pointY = Math.min(
            0,
            Math.max(pointY, contH - scaledH)
        );
    }
}

function writeTransform() {
    transformFramePending = false;

    if (!mapElement) return;

    applyBoundaries();

    mapElement.style.transform =
    `translate(${pointX}px, ${pointY}px) scale(${scale})`;

    if (mapContainer) {
        if (scale >= 1.6) {
            mapContainer.classList.add('is-zoomed-in');
        } else {
            mapContainer.classList.remove('is-zoomed-in');
        }
    }
}

function setTransform() {
    if (transformFramePending) return;

    transformFramePending = true;
    requestAnimationFrame(writeTransform);
}

function setDefaultMapViewport() {
    if (!mapElement || !mapContainer) return;

    const viewBox = mapElement.viewBox.baseVal;

    const baseW = viewBox.width || 1265;
    const baseH = viewBox.height || 1335;

    const contW = mapContainer.clientWidth;
    const contH = mapContainer.clientHeight;

    const fitScale = Math.max(
        contW / baseW,
        contH / baseH
    );

    const renderedW = baseW * fitScale;
    const renderedH = baseH * fitScale;

    const offsetX = (renderedW - contW) / 2;
    const offsetY = (renderedH - contH) / 2;

    const targetPixelX =
        (DEFAULT_MAP_CENTER_X * fitScale) - offsetX;

    const targetPixelY =
        (DEFAULT_MAP_CENTER_Y * fitScale) - offsetY;

    scale = DEFAULT_MAP_ZOOM;

    pointX =
        (contW / 2) -
        (targetPixelX * scale);

    pointY =
        (contH / 2) -
        (targetPixelY * scale);

    mapElement.style.transition = 'none';
    setTransform();
}

function zoomMapAt(clientX, clientY, zoomFactor) {
    if (!mapContainer || !mapElement) return;

    const rect = mapContainer.getBoundingClientRect();

    const localX = clientX - rect.left;
    const localY = clientY - rect.top;

    const oldScale = scale;

    const newScale = Math.min(
        5,
        Math.max(1, oldScale * zoomFactor)
    );

    if (newScale === oldScale) return;

    const mapX = (localX - pointX) / oldScale;
    const mapY = (localY - pointY) / oldScale;

    scale = newScale;

    pointX = localX - (mapX * scale);
    pointY = localY - (mapY * scale);

    setTransform();
}

function resetFocus() {
    if (!mapElement || !mapContainer) return;

    document
        .querySelectorAll('.active-target')
        .forEach(el => el.classList.remove('active-target', 'pop-animate'));

    document
        .querySelectorAll('.active-list-item')
        .forEach(el => el.classList.remove('active-list-item'));

    document
        .querySelectorAll('.flash-highlight')
        .forEach(el => el.classList.remove('flash-highlight'));

    scale = 1;
    pointX = 0;
    pointY = 0;

    mapElement.style.transition = 'transform 0.35s ease';

    setTransform();

    setTimeout(() => {
        if (mapElement) {
            mapElement.style.transition = 'none';
        }
    }, 350);

    selectedRouteKey = null;
    topRouteKey = null;

    // --- ADDED FOR VALIDATION CARD ---
    if (typeof hideValidationCard === 'function') {
        hideValidationCard();
    }
}

if (mapContainer) {
    mapContainer.addEventListener('mousedown', e => {
        if (e.button !== 0) return;

        isPanning = true;
        panPointerMoved = false;

        startX = e.clientX - pointX;
        startY = e.clientY - pointY;

        mapContainer.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', e => {
        if (!isPanning) return;

        const nextX = e.clientX - startX;
        const nextY = e.clientY - startY;

        if (
            Math.abs(nextX - pointX) > 2 ||
            Math.abs(nextY - pointY) > 2
        ) {
            panPointerMoved = true;
        }

        pointX = nextX;
        pointY = nextY;

        setTransform();
    });

    window.addEventListener('mouseup', () => {
        if (!isPanning) return;

        isPanning = false;

        if (mapContainer) {
            mapContainer.style.cursor = 'grab';
        }
    });

    window.addEventListener('mouseleave', () => {
        isPanning = false;

        if (mapContainer) {
            mapContainer.style.cursor = 'grab';
        }
    });

    mapContainer.addEventListener('wheel', e => {
        e.preventDefault();

        const factor =
            e.deltaY < 0
                ? 1.12
                : (1 / 1.12);

        zoomMapAt(
            e.clientX,
            e.clientY,
            factor
        );
    }, { passive: false });

    mapContainer.addEventListener('touchstart', e => {
        if (e.touches.length === 1) {
            isPanning = true;
            panPointerMoved = false;

            startX =
                e.touches[0].clientX - pointX;

            startY =
                e.touches[0].clientY - pointY;

        } else if (e.touches.length === 2) {
            isPanning = false;

            initialPinchDist = Math.hypot(
                e.touches[0].clientX -
                e.touches[1].clientX,

                e.touches[0].clientY -
                e.touches[1].clientY
            );

            initialScale = scale;
        }
    }, { passive: true });

    mapContainer.addEventListener('touchmove', e => {
        if (
            e.touches.length === 1 &&
            isPanning
        ) {
            e.preventDefault();

            pointX =
                e.touches[0].clientX -
                startX;

            pointY =
                e.touches[0].clientY -
                startY;

            panPointerMoved = true;

            setTransform();

        } else if (
            e.touches.length === 2 &&
            initialPinchDist
        ) {
            e.preventDefault();

            const currentDist = Math.hypot(
                e.touches[0].clientX -
                e.touches[1].clientX,

                e.touches[0].clientY -
                e.touches[1].clientY
            );

            const nextScale = Math.min(
                5,
                Math.max(
                    1,
                    initialScale *
                    (currentDist / initialPinchDist)
                )
            );

            const rect =
                mapContainer.getBoundingClientRect();

            const centerX =
                ((e.touches[0].clientX +
                  e.touches[1].clientX) / 2) -
                rect.left;

            const centerY =
                ((e.touches[0].clientY +
                  e.touches[1].clientY) / 2) -
                rect.top;

            const mapX =
                (centerX - pointX) / scale;

            const mapY =
                (centerY - pointY) / scale;

            scale = nextScale;

            pointX =
                centerX -
                (mapX * scale);

            pointY =
                centerY -
                (mapY * scale);

            setTransform();
        }
    }, { passive: false });

    mapContainer.addEventListener('touchend', e => {
        if (e.touches.length === 0) {
            isPanning = false;
            initialPinchDist = null;
        }
    }, { passive: true });

    mapContainer.addEventListener('click', e => {
        if (window.ignoreMapTap) return;

        if (panPointerMoved) {
            panPointerMoved = false;
            return;
        }

        if (!e.target.closest('[id^="spot-"]')) {
            resetFocus();
        }
    });
}

// --- 16. Bus List UI & Highlight ---
//
// IMPORTANT:
// This section controls ONLY the visual list selection and list ordering.
// Firebase realtime listeners, polling, map rendering, and database updates
// are intentionally left unchanged.
//
// Rules:
// 1. A normal tap on a list item changes selection only. It never reorders.
// 2. A tap on a bus/spot on the MAP can pin that route to the top.
// 3. Only one route can ever have the active-list-item class.
// 4. Realtime list rebuilds preserve the current UI order instead of restoring
//    the original numeric route order.

function getGroupedRoutes(buses) {
    const routeMap = {};

    buses.forEach(bus => {
        const key = `route_${bus.routeNum}_${bus.name}`;

        if (!routeMap[key]) {
            routeMap[key] = {
                key,
                routeNum: bus.routeNum,
                name: bus.name,
                buses: [],
                users: bus.users || 1
            };
        }

        bus.busNos.forEach(bNo => {
            if (!routeMap[key].buses.some(b => b.busNo === bNo)) {
                routeMap[key].buses.push({
                    busNo: bNo,
                    spotId: bus.spotId
                });
            }
        });

        routeMap[key].users = Math.max(
            routeMap[key].users,
            bus.users || 1
        );
    });

    return Object.values(routeMap).sort(
        (a, b) => parseInt(a.routeNum) - parseInt(b.routeNum)
    );
}

function buildStableListOrder(groupedRoutes) {
    const defaultKeys = groupedRoutes.map(item => item.key);
    const availableKeys = new Set(defaultKeys);

    listOrderKeys = listOrderKeys.filter(key => availableKeys.has(key));

    defaultKeys.forEach((key, defaultIndex) => {
        if (listOrderKeys.includes(key)) return;

        let insertAt = listOrderKeys.length;

        for (let i = 0; i < listOrderKeys.length; i++) {
            const existingDefaultIndex = defaultKeys.indexOf(listOrderKeys[i]);
            if (existingDefaultIndex > defaultIndex) {
                insertAt = i;
                break;
            }
        }

        listOrderKeys.splice(insertAt, 0, key);
    });

    if (topRouteKey && availableKeys.has(topRouteKey)) {
        listOrderKeys = [
            topRouteKey,
            ...listOrderKeys.filter(key => key !== topRouteKey)
        ];
    }

    const routeMap = new Map(groupedRoutes.map(item => [item.key, item]));

    return listOrderKeys
        .map(key => routeMap.get(key))
        .filter(Boolean);
}

function applyListSelection(container) {
    if (!container) return;

    const items = container.querySelectorAll('.bus-item');

    items.forEach(item => {
        item.classList.remove('active-list-item', 'flash-highlight');
    });

    if (!selectedRouteKey) return;

    const selectedItem = Array.from(items).find(
        item => item.dataset.routeKey === selectedRouteKey
    );

    if (selectedItem) {
        selectedItem.classList.add('active-list-item');
    }
}

function selectListRoute(routeKey, spotId = null, fromMap = false) {
    const container = document.getElementById('bus-list');
    if (!container || !routeKey) return;

    selectedRouteKey = routeKey;

    if (fromMap) {
        topRouteKey = routeKey;

        const targetItem = Array.from(container.querySelectorAll('.bus-item'))
            .find(item => item.dataset.routeKey === routeKey);

        if (targetItem) {
            container.prepend(targetItem);

            listOrderKeys = [
                routeKey,
                ...listOrderKeys.filter(key => key !== routeKey)
            ];

            container.scrollTop = 0;
        }
    }

    applyListSelection(container);

    if (fromMap) {
        const targetItem = Array.from(container.querySelectorAll('.bus-item'))
            .find(item => item.dataset.routeKey === routeKey);

        if (targetItem) {
            void targetItem.offsetWidth;
            targetItem.classList.add('flash-highlight');

            setTimeout(() => {
                if (selectedRouteKey !== routeKey) return;

                targetItem.classList.remove('flash-highlight');
                targetItem.classList.add('active-list-item');
            }, 600);
        }
    }
}

function renderList(buses) {
    const container = document.getElementById('bus-list');
    if (!container) return;

    const groupedRoutes = getGroupedRoutes(buses);
    const emptyState = document.getElementById('empty-state');

    if (groupedRoutes.length === 0) {
        listOrderKeys = [];
        container.innerHTML = '';
        if (emptyState) emptyState.classList.remove('hidden');
        return;
    }

    if (emptyState) emptyState.classList.add('hidden');

    const orderedRoutes = buildStableListOrder(groupedRoutes);

    container.innerHTML = '';

    orderedRoutes.forEach(item => {
        const div = document.createElement('div');
        div.className = 'bus-item';
        div.dataset.routeKey = item.key;

        if (item.buses.length > 0) {
            div.dataset.spots = item.buses.map(b => b.spotId).join(',');
        }

        const displayUsers = item.users >= 999 ? 1 : (item.users || 1);
        const subtextHtml = `<span class="verified-text">Suggested by ${displayUsers} user${displayUsers !== 1 ? 's' : ''}</span>`;

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
                e.preventDefault();
                e.stopPropagation();

                window.ignoreMapTap = true;
                setTimeout(() => window.ignoreMapTap = false, 400);

                focusOnSpot(bObj.spotId);
                selectListRoute(item.key, bObj.spotId, false);
            });

            badgeGroup.appendChild(badge);
        });

        div.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            window.ignoreMapTap = true;
            setTimeout(() => window.ignoreMapTap = false, 400);

            if (item.buses.length > 0) { 
                focusOnSpot(item.buses[0].spotId);
                selectListRoute(item.key, item.buses[0].spotId, false);
            }
        });

        container.appendChild(div);
    });

    applyListSelection(container);
}

function highlightInList(spotId, fromMap = false) {
    const container = document.getElementById('bus-list');
    if (!container) return;

    const targetItem = Array.from(container.querySelectorAll('.bus-item')).find(item => {
        const spots = (item.dataset.spots || '')
            .split(',')
            .filter(Boolean);

        return spots.includes(spotId);
    });

    if (!targetItem) return;

    selectListRoute(
        targetItem.dataset.routeKey,
        spotId,
        fromMap
    );
}

// Persistent Search Bar Listener
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

    const cx = parseFloat(circle.getAttribute('cx'));
    const cy = parseFloat(circle.getAttribute('cy'));
    const contW = mapContainer.clientWidth;
    const contH = mapContainer.clientHeight;
    
    const viewBox = mapElement.viewBox.baseVal;
    const baseW = viewBox.width;
    const baseH = viewBox.height;

    const scaleRatio = Math.max(
        contW / baseW,
        contH / baseH
    );

    const svgActualW = baseW * scaleRatio;
    const svgActualH = baseH * scaleRatio;

    const offsetX = (svgActualW - contW) / 2;
    const offsetY = (svgActualH - contH) / 2;

    const busPixelX = (cx * scaleRatio) - offsetX;
    const busPixelY = (cy * scaleRatio) - offsetY;
    
    scale = 3.5;

    pointX =
        (contW / 2) -
        (busPixelX * scale);

    pointY =
        (contH * 0.45) -
        (busPixelY * scale); 
    
    mapElement.style.transition =
        'transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)';

    setTransform();

    setTimeout(() => {
        if (mapElement) {
            mapElement.style.transition = 'none';
        }
    }, 600);

    document
        .querySelectorAll('.active-target')
        .forEach(el => el.classList.remove(
            'active-target',
            'pop-animate'
        ));

    spotGroup.classList.add(
        'active-target',
        'pop-animate'
    );

    setTimeout(() => {
        if (spotGroup) {
            spotGroup.classList.remove('pop-animate');
        }
    }, 500);

    // --- ADDED FOR VALIDATION CARD ---
    // --- PRODUCTION VALIDATION CARD TRIGGER ---
    if (typeof showValidationCard === 'function') {
        const activeBusInfo = activeBuses.find(b => b.spotId === spotId);
        
        if (activeBusInfo && appState === 'VIEW') {
            showValidationCard(activeBusInfo);
        } else {
            hideValidationCard();
        }
    }
}

// --- 17. Modal UI & Multi-Step Logic ---
const modal = document.getElementById('modal-overlay');
const tabPark = document.getElementById('tab-park');
const tabDepart = document.getElementById('tab-depart');
const flowPark = document.getElementById('flow-park');
const flowDepart = document.getElementById('flow-depart');
const s1 = document.getElementById('step-1');
const s2 = document.getElementById('step-2');
const s3Confirm = document.getElementById('step-3-confirm');
const grid = document.getElementById('bus-grid');
const departList = document.getElementById('depart-bus-list');
const fixedFooter = document.getElementById('fixed-footer');
const selFooter = document.getElementById('selection-footer');
const topBar = document.querySelector('.top-bar');

const rSelect = document.getElementById('route-select');

if (rSelect) {
    rSelect.innerHTML = `
        <option value="" disabled selected>Select route destination...</option>
        <option value="UNASSIGNED">Route Not Confirmed</option>
    `;
    allRoutes.forEach(r => {
        rSelect.innerHTML +=
            `<option value="${r.num}">Route ${r.num} - ${r.name}</option>`;
    });
}

if (document.getElementById('btn-update-bus')) {
    document.getElementById('btn-update-bus').onclick = () => {
        if (modal) modal.classList.remove('hidden');

        switchTab('PARK');

        if (s1) s1.classList.remove('hidden'); 
        if (s2) s2.classList.add('hidden');
        if (s3Confirm) s3Confirm.classList.add('hidden');

        pendingUpdate = {
            route: null,
            busNo: null,
            spotId: null,
            isReplacement: false
        };
    };
}

if (document.getElementById('btn-close-modal')) {
    document.getElementById('btn-close-modal').onclick = () => {
        if (modal) modal.classList.add('hidden');
    };
}

function switchTab(mode) {
    if (mode === 'PARK') {
        if (tabPark) tabPark.classList.add('active');
        if (tabDepart) tabDepart.classList.remove('active');

        if (flowPark) flowPark.classList.remove('hidden');
        if (flowDepart) flowDepart.classList.add('hidden');

    } else {
        if (tabDepart) tabDepart.classList.add('active');
        if (tabPark) tabPark.classList.remove('active');

        if (flowDepart) flowDepart.classList.remove('hidden');
        if (flowPark) flowPark.classList.add('hidden');

        renderSimpleDepartList();
    }
}

if (tabPark) tabPark.onclick = () => switchTab('PARK');
if (tabDepart) tabDepart.onclick = () => switchTab('DEPART');

// --- 18. Departure Flow ---
function renderSimpleDepartList() {
    if (!departList) return;

    departList.innerHTML = '';

    const activeList = [];

    activeBuses.forEach(ab =>
        ab.busNos.forEach(b =>
            activeList.push({
                busNo: b,
                label: `Route ${ab.routeNum} - ${ab.name}`
            })
        )
    );

    unassignedBuses.forEach(ub =>
        activeList.push({
            busNo: ub.busNo,
            label: "Unassigned Spot"
        })
    );

    if (activeList.length === 0) {
        departList.innerHTML =
            `<p style="text-align:center;color:#727272;font-size:13px;padding:20px 0;">No active buses parked.</p>`;
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
                <svg class="ui-icon-white"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                </svg>
                <span>Mark Departed</span>
            </div>
        `;

        card.onclick = () => {
            const targetBus = item.busNo;

            if (modal) {
                modal.classList.add('hidden');
            }

            executeFastUnassign(targetBus);
        };

        departList.appendChild(card);
    });
}

async function executeFastUnassign(busNumber) {
    try {
        const [snapActive, snapUn] = await Promise.all([
            get(ref(db, 'activeBuses')),
            get(ref(db, 'unassignedBuses'))
        ]);

        const valActive = snapActive.val() || {};
        const valUn = snapUn.val() || {};

        let activeUpdates = {};
        let unassignedUpdates = {};

        Object.keys(valActive).forEach(sId => {
            let bList =
                valActive[sId].busNos ||
                (valActive[sId].busNo
                    ? [valActive[sId].busNo]
                    : []);

            if (bList.includes(busNumber)) {
                bList = bList.filter(b => b !== busNumber);

                if (bList.length === 0) {
                    activeUpdates[sId] = null;
                } else {
                    activeUpdates[`${sId}/busNos`] = bList;
                }
            }
        });

        Object.keys(valUn).forEach(sId => {
            if (valUn[sId].busNo === busNumber) {
                unassignedUpdates[sId] = null;
            }
        });

        if (Object.keys(activeUpdates).length > 0) {
            await update(
                ref(db, 'activeBuses'),
                activeUpdates
            );
        }

        if (Object.keys(unassignedUpdates).length > 0) {
            await update(
                ref(db, 'unassignedBuses'),
                unassignedUpdates
            );
        }

        addContributionPoints(5);

    } catch (e) {
        console.error(
            "Fast depart error:",
            e
        );
    }
}

// --- 19. Park Flow with Conditional Step 3 ---
if (document.getElementById('btn-skip-route')) {
    document.getElementById('btn-skip-route').onclick = () => {
        pendingUpdate.route = null;

        if (s1) s1.classList.add('hidden');
        if (s2) s2.classList.remove('hidden');

        if (document.getElementById('step-2-summary')) {
            document.getElementById('step-2-summary').textContent =
                `Unassigned Buses`;
        }

        populateBusGrid(true);
    };
}

if (document.getElementById('btn-next-1')) {
    document.getElementById('btn-next-1').onclick = () => {
        const selectedVal = rSelect.value;
        
        if (!selectedVal) {
            return alert("Please select a route destination.");
        }

        if (selectedVal === "UNASSIGNED") {
            pendingUpdate.route = null;
            if (s1) s1.classList.add('hidden');
            if (s2) s2.classList.remove('hidden');

            if (document.getElementById('step-2-summary')) {
                document.getElementById('step-2-summary').textContent = `Route Not Confirmed`;
            }
            populateBusGrid(true); // Loads unassigned bus numbers only
        } else {
            pendingUpdate.route = allRoutes.find(r => r.num === selectedVal);
            if (s1) s1.classList.add('hidden');
            if (s2) s2.classList.remove('hidden');

            if (document.getElementById('step-2-summary') && pendingUpdate.route) {
                document.getElementById('step-2-summary').textContent =
                    `Route ${pendingUpdate.route.num} - ${pendingUpdate.route.name}`;
            }
            populateBusGrid(false); // Loads all buses for assignment
        }
    };
}

function populateBusGrid(isUnassignedMode) {
    if (!grid) return;

    grid.innerHTML = '';

    const busesToShow =
        isUnassignedMode
            ? getUnassignedBusNumbers()
            : allBuses;

    if (busesToShow.length === 0) {
        grid.innerHTML =
            `<p style="grid-column:1/-1;text-align:center;color:#727272;font-size:13px;">All buses parked.</p>`;

        return;
    }

    busesToShow.forEach(bNo => {
        const isActive =
            activeBuses.find(
                ab => ab.busNos.includes(bNo)
            );

        const isSpottedUnassigned =
            unassignedBuses.find(
                ub => ub.busNo === bNo
            );

        const btn =
            document.createElement('div');

        btn.className =
            `grid-bus ${isActive ? 'green' : 'grey'}`;

        btn.textContent = bNo;

        btn.onclick = () => {
            grid
                .querySelectorAll('.grid-bus')
                .forEach(
                    el =>
                        el.classList.remove(
                            'yellow-active'
                        )
                );

            btn.classList.add('yellow-active');

            pendingUpdate.busNo = bNo;

            if (isSpottedUnassigned) {
                pendingUpdate.spotId =
                    isSpottedUnassigned.spotId;

            } else if (isActive) {
                pendingUpdate.spotId =
                    isActive.spotId;
            }
        };

        grid.appendChild(btn);
    });
}

if (document.getElementById('btn-prev-2')) {
    document.getElementById('btn-prev-2').onclick = () => {
        if (s2) s2.classList.add('hidden');
        if (s1) s1.classList.remove('hidden');
    };
}

if (document.getElementById('btn-next-2')) {
    document.getElementById('btn-next-2').onclick = () => {
        if (!pendingUpdate.busNo) {
            return alert("Please select a bus number.");
        }

        if (pendingUpdate.route) {
            const activeRouteSpots =
                activeBuses.filter(
                    ab =>
                        ab.routeNum ===
                        pendingUpdate.route.num
                );

            let isDifferentBus = false;

            if (activeRouteSpots.length > 0) {
                const existingBusesForRoute =
                    activeRouteSpots.flatMap(
                        spot => spot.busNos
                    );

                if (
                    existingBusesForRoute.length > 0 &&
                    !existingBusesForRoute.includes(
                        pendingUpdate.busNo
                    )
                ) {
                    isDifferentBus = true;
                }
            }

            if (isDifferentBus) {

                if (s2) {
                    s2.classList.add('hidden');
                }

                if (s3Confirm) {
                    s3Confirm.classList.remove('hidden');
                }

                if (
                    document.getElementById(
                        'step-3-confirm-summary'
                    )
                ) {
                    document.getElementById(
                        'step-3-confirm-summary'
                    ).textContent =
                        `Bus ${pendingUpdate.busNo} for Route ${pendingUpdate.route.num} - ${pendingUpdate.route.name}`;
                }

            } else {
                goToMapSelection(false);
            }

        } else {
            goToMapSelection(false);
        }
    };
}

if (document.getElementById('btn-prev-3-confirm')) {
    document.getElementById('btn-prev-3-confirm').onclick = () => {
        if (s3Confirm) {
            s3Confirm.classList.add('hidden');
        }

        if (s2) {
            s2.classList.remove('hidden');
        }
    };
}

if (document.getElementById('btn-replace-yes')) {
    document.getElementById('btn-replace-yes').onclick =
        () => goToMapSelection(true);
}

if (document.getElementById('btn-replace-no')) {
    document.getElementById('btn-replace-no').onclick =
        () => goToMapSelection(false);
}

function goToMapSelection(isReplacement) {

    pendingUpdate.isReplacement =
        isReplacement;

    appState = 'SELECTION';

    let summaryStr =
        pendingUpdate.route
            ? `(Route ${pendingUpdate.route.num})`
            : `(Unassigned Location)`;

    let extraText =
        (!isReplacement && pendingUpdate.route)
            ? `<br><span style="font-size:11.5px;color:#64748b;font-weight:600;line-height:1.5;display:block;margin-top:6px;">You are selecting an additional bus for ${pendingUpdate.route.name}</span>`
            : '';

    if (
        document.getElementById(
            'step-3-summary'
        )
    ) {
        document.getElementById(
            'step-3-summary'
        ).innerHTML =
            `Tap a slot on the map for <span style="color:#815FD7;">Bus ${pendingUpdate.busNo}</span> ${summaryStr}${extraText}`;
    }

    if (s3Confirm) {
        s3Confirm.classList.add('hidden');
    }

    if (s2) {
        s2.classList.add('hidden');
    }

    if (modal) {
        modal.classList.add('hidden');
    }

    if (fixedFooter) {
        fixedFooter.classList.add('hidden');
    }

    if (draggableSheet) {
        draggableSheet.style.transform =
            `translateY(150%)`;
    }

    if (topBar) {
        topBar.style.transform =
            `translateY(-150%)`;
    }

    if (selFooter) {
        selFooter.classList.remove('hidden');
    }

    scale = 1.6;
    pointX = 0;
    pointY = 0;

    if (mapElement) {
        mapElement.style.transition =
            'transform 0.4s';

        setTransform();

        setTimeout(() => {
            if (mapElement) {
                mapElement.style.transition = 'none';
            }
        }, 400);
    }

    renderMapSpots();
}

if (document.getElementById('btn-prev-3')) {
    document.getElementById('btn-prev-3').onclick = () => {

        appState = 'VIEW';

        if (selFooter) {
            selFooter.classList.add('hidden');
        }

        if (fixedFooter) {
            fixedFooter.classList.remove('hidden');
        }

        if (draggableSheet) {
            draggableSheet.style.transform =
                `translateY(${currentTranslate}px)`;
        }

        if (topBar) {
            topBar.style.transform =
                `translateY(0)`;
        }

        if (modal) {
            modal.classList.remove('hidden');
        }

        renderMapSpots();
    };
}

// Strict 1-Vote-Per-Route Ledger Commit
if (document.getElementById('btn-submit-update')) {
    document.getElementById('btn-submit-update').onclick = async () => {
        if (!pendingUpdate.spotId) {
            return alert("Tap a spot on the map!");
        }

        document.getElementById(
            'btn-submit-update'
        ).disabled = true;

        const targetSpot =
            pendingUpdate.spotId;

        const selectedBus =
            pendingUpdate.busNo;

        const targetRoute =
            pendingUpdate.route;

        appState = 'VIEW';

        if (selFooter) {
            selFooter.classList.add('hidden');
        }

        if (fixedFooter) {
            fixedFooter.classList.remove('hidden');
        }

        if (draggableSheet) {
            draggableSheet.style.transform =
                `translateY(${currentTranslate}px)`;
        }

        if (topBar) {
            topBar.style.transform =
                `translateY(0)`;
        }

        try {

            const [
                snapActive,
                snapUn
            ] =
                await Promise.all([
                    get(ref(db, 'activeBuses')),
                    get(ref(db, 'unassignedBuses'))
                ]);

            const activeData =
                snapActive.val() || {};

            const unData =
                snapUn.val() || {};

            const updates = {};

            let notificationUpdates = {};

            const timestamp =
                Date.now();

            let routeOldBus =
                null;

            let isNewRoute =
                true;

            let oldSpotForSelectedBus =
                null;

            if (targetRoute) {

                Object.keys(activeData).forEach(
                    sId => {

                        if (
                            activeData[sId] &&
                            activeData[sId].routeNum ===
                                targetRoute.num
                        ) {

                            isNewRoute = false;

                            routeOldBus =
                                (
                                    activeData[sId]
                                        .busNos ||
                                    [
                                        activeData[sId]
                                            .busNo
                                    ]
                                )[0];
                        }
                    }
                );
            }

            // --- STRICT SLOT OWNERSHIP BLOCK ---
            if (activeData[targetSpot]) {

                const existingRouteNum =
                    activeData[targetSpot]
                        .routeNum;

                if (
                    targetRoute &&
                    existingRouteNum !==
                        targetRoute.num
                ) {

                    alert(
                        `Slot occupied by Route ${existingRouteNum}. Please mark it departed first.`
                    );

                    document.getElementById(
                        'btn-submit-update'
                    ).disabled = false;

                    return;
                }

                if (!targetRoute) {

                    alert(
                        `Slot occupied by Route ${existingRouteNum}. Please mark it departed first.`
                    );

                    document.getElementById(
                        'btn-submit-update'
                    ).disabled = false;

                    return;
                }
            }

            Object.keys(activeData).forEach(
                sId => {

                    let spotData =
                        activeData[sId];

                    let bList =
                        spotData.busNos ||
                        (
                            spotData.busNo
                                ? [spotData.busNo]
                                : []
                        );

                    let voters =
                        spotData.votersLedger ||
                        {};

                    let modified = false;

                    if (
                        spotData.users >= 999 &&
                        Object.keys(voters).length === 0
                    ) {
                        voters = {
                            'admin_locked': true
                        };
                    }

                    // 1. Scrub selected bus from anywhere else globally
                    if (
                        bList.includes(
                            selectedBus
                        )
                    ) {

                        bList =
                            bList.filter(
                                b =>
                                    b !== selectedBus
                            );

                        modified = true;

                        if (
                            voters[
                                currentDeviceToken
                            ]
                        ) {
                            delete voters[
                                currentDeviceToken
                            ];
                        }
                    }

                    // 2. Replacing: clear previous buses
                    if (
                        targetRoute &&
                        pendingUpdate.isReplacement &&
                        spotData.routeNum ===
                            targetRoute.num
                    ) {

                        bList = [];

                        modified = true;

                        if (
                            voters[
                                currentDeviceToken
                            ]
                        ) {
                            delete voters[
                                currentDeviceToken
                            ];
                        }

                        if (
                            sId !== targetSpot
                        ) {

                            busLocationTracker[
                                selectedBus
                            ] = sId;
                        }
                    }

                    if (
                        modified &&
                        sId !== targetSpot
                    ) {

                        if (
                            bList.length === 0 ||
                            Object.keys(
                                voters
                            ).length === 0
                        ) {

                            updates[
                                `activeBuses/${sId}`
                            ] = null;

                        } else {

                            updates[
                                `activeBuses/${sId}/busNos`
                            ] = bList;

                            updates[
                                `activeBuses/${sId}/users`
                            ] =
                                spotData.users >= 999
                                    ? 999
                                    : Object.keys(
                                        voters
                                    ).length;

                            updates[
                                `activeBuses/${sId}/votersLedger`
                            ] =
                                voters;
                        }
                    }
                }
            );

            // Scrub unassigned
            Object.keys(unData).forEach(
                sId => {

                    if (
                        unData[sId].busNo ===
                        selectedBus
                    ) {

                        updates[
                            `unassignedBuses/${sId}`
                        ] = null;
                    }
                }
            );

            if (targetRoute) {

                let existingBusesAtSpot =
                    [];

                let existingVoters =
                    {};

                if (
                    activeData[targetSpot]
                ) {

                    if (
                        activeData[targetSpot]
                            .routeNum ===
                            targetRoute.num
                    ) {

                        existingBusesAtSpot =
                            activeData[targetSpot]
                                .busNos || [];

                        if (
                            pendingUpdate
                                .isReplacement
                        ) {
                            existingBusesAtSpot =
                                [];
                        }

                        existingVoters =
                            activeData[targetSpot]
                                .votersLedger || {};

                        if (
                            activeData[targetSpot]
                                .users >= 999 &&
                            Object.keys(
                                existingVoters
                            ).length === 0
                        ) {

                            existingVoters = {
                                'admin_locked': true
                            };
                        }

                    } else {

                        existingBusesAtSpot =
                            [];

                        existingVoters =
                            {};
                    }
                }

                existingBusesAtSpot =
                    existingBusesAtSpot.filter(
                        b => b !== selectedBus
                    );

                existingBusesAtSpot.push(
                    selectedBus
                );

                existingVoters[
                    currentDeviceToken
                ] = true;

                // Push Notification Logic
                if (
                    pendingUpdate
                        .isReplacement &&
                    !isNewRoute &&
                    routeOldBus &&
                    routeOldBus !==
                        selectedBus
                ) {

                    const notifId =
                        Date.now().toString() +
                        "_swap";

                    const numVoters =
                        existingVoters[
                            'admin_locked'
                        ]
                            ? 999
                            : Object.keys(
                                existingVoters
                            ).length;

                    const consensusStr =
                        numVoters === 1
                            ? " Reported by 1 user only, so can be wrong :(("
                            : "";

                    notificationUpdates[
                        notifId
                    ] = {
                        title:
                            "🔄 Bus Swap Alert!",

                        message:
                            `The bus for ${targetRoute.name} may have been changed from ${routeOldBus} to ${selectedBus}.${consensusStr}`,

                        createdAt:
                            Date.now()
                    };

                } else if (
                    oldSpotForSelectedBus &&
                    oldSpotForSelectedBus !==
                        targetSpot
                ) {

                    const notifId =
                        Date.now().toString() +
                        "_move";

                    notificationUpdates[
                        notifId
                    ] = {
                        title:
                            "📍 Bus Relocated!",

                        message:
                            `Bus ${selectedBus} for ${targetRoute.name} moved to a new parking slot. Tap to find it!`,

                        createdAt:
                            Date.now()
                    };
                }

                updates[
                    `activeBuses/${targetSpot}`
                ] = {

                    busNo:
                        selectedBus,

                    busNos:
                        existingBusesAtSpot,

                    routeNum:
                        targetRoute.num,

                    name:
                        targetRoute.name,

                    users:
                        existingVoters[
                            'admin_locked'
                        ]
                            ? 999
                            : Object.keys(
                                existingVoters
                            ).length,

                    votersLedger:
                        existingVoters,

                    updatedAt:
                        timestamp,

                    updatedBy:
                        currentDeviceToken
                };

            } else {

                updates[
                    `unassignedBuses/${targetSpot}`
                ] = {

                    busNo:
                        selectedBus,

                    updatedAt:
                        timestamp,

                    updatedBy:
                        currentDeviceToken
                };
            }

            await update(
                ref(db),
                updates
            );

            if (
                Object.keys(
                    notificationUpdates
                ).length > 0
            ) {
                await update(
                    ref(
                        db,
                        'broadcastNotifications'
                    ),
                    notificationUpdates
                );
            }

            await addContributionPoints(
                10
            );

        } catch (err) {

            console.error(
                "Sync error:",
                err
            );

        } finally {

            document.getElementById(
                'btn-submit-update'
            ).disabled = false;
        }
    };
}

// --- 20. Real-Time Bus Validation System ---

const valBubble = document.getElementById('bus-validation-bubble');
const valFab = document.getElementById('val-fab');
const valCard = document.getElementById('val-card');
const valBusDetails = document.getElementById('val-bus-details');
const btnValYes = document.getElementById('btn-val-yes');
const btnValNo = document.getElementById('btn-val-no');
const btnValCollapse = document.getElementById('val-btn-collapse');

let currentValidationBus = null;
let isValidationCardCollapsed = false;

// Stop map gestures from triggering while interacting with the card
if (valBubble) {
    ['touchstart', 'touchmove', 'touchend', 'mousedown', 'mousemove', 'mouseup', 'click', 'wheel'].forEach(evt => {
        valBubble.addEventListener(evt, (e) => e.stopPropagation(), { passive: false });
    });
}

function showValidationCard(busInfo) {
    if (!valBubble || !busInfo) return;

    // --- FUNCTIONAL REQ 5: Hide if already updated or validated by this user ---
    const voters = busInfo.votersLedger || {};
    const isAuthor = (busInfo.updatedBy === currentDeviceToken || busInfo.updatedBy === ('ADMIN_' + currentDeviceToken));
    const hasVoted = voters[currentDeviceToken] === true;

    // Temporarily comment out the 'return;' below if you want to test on your own screen
    // if (isAuthor || hasVoted) {
    //     hideValidationCard();
    //     return; 
    // }

    // --- FUNCTIONAL REQ 4: Auto-expand for newly tapped buses ---
    if (!currentValidationBus || currentValidationBus.spotId !== busInfo.spotId) {
        isValidationCardCollapsed = false; 
    }

    // --- CRITICAL FIX: Save the bus data so the YES/NO buttons work! ---
    currentValidationBus = busInfo;

    const busDisplay = busInfo.busNos ? busInfo.busNos.join(', ') : busInfo.busNo;
    
    // --- UI REQ 2: Updated description text format (Uses Destination Name) ---
    if (valBusDetails) {
        valBusDetails.textContent = `Bus number ${busDisplay} for ${busInfo.name} has been parked here.`;
    }

    valBubble.classList.remove('hidden');
    
    // Process expand/collapse UI state
    if (isValidationCardCollapsed) {
        if (valFab) valFab.classList.remove('hidden');
        if (valCard) valCard.classList.add('hidden');
    } else {
        if (valFab) valFab.classList.add('hidden');
        if (valCard) valCard.classList.remove('hidden');
    }
}

function hideValidationCard() {
    currentValidationBus = null;
    if (valBubble) valBubble.classList.add('hidden');
    if (valCard) valCard.classList.add('hidden');
    if (valFab) valFab.classList.add('hidden');
}

// Collapsible Toggle Logic
if (valFab) {
    valFab.onclick = () => {
        isValidationCardCollapsed = false;
        valFab.classList.add('hidden');
        valCard.classList.remove('hidden');
    };
}

if (btnValCollapse) {
    btnValCollapse.onclick = () => {
        isValidationCardCollapsed = true;
        valCard.classList.add('hidden');
        valFab.classList.remove('hidden');
    };
}

// YES Action: Confirm & validate
if (btnValYes) {
    btnValYes.onclick = async () => {
        if (!currentValidationBus) return;
        
        const spotId = currentValidationBus.spotId;
        const item = activeBuses.find(b => b.spotId === spotId);
        if (!item) {
            alert("This bus is no longer active at this slot.");
            hideValidationCard();
            return;
        }

        if (item.updatedBy === currentDeviceToken || item.updatedBy === ('ADMIN_' + currentDeviceToken)) {
            alert("You posted the latest update for this bus. Only others can validate it.");
            return;
        }

        const voters = item.votersLedger || {};
        if (voters[currentDeviceToken]) {
            alert("You have already confirmed this bus location.");
            return;
        }

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
        } catch (err) {
            console.error("Validation vote error:", err);
        } finally {
            btnValYes.disabled = false;
        }
    };
}

// NO Action: Pre-fill update form
if (btnValNo) {
    btnValNo.onclick = () => {
        if (!currentValidationBus) return;

        const targetBus = currentValidationBus;
        hideValidationCard();

        if (modal) modal.classList.remove('hidden');
        switchTab('PARK');

        pendingUpdate.route = allRoutes.find(r => r.num === targetBus.routeNum) || null;
        pendingUpdate.busNo = (targetBus.busNos && targetBus.busNos[0]) || targetBus.busNo || null;
        pendingUpdate.spotId = targetBus.spotId;
        pendingUpdate.isReplacement = false;

        if (rSelect && pendingUpdate.route) {
            rSelect.value = pendingUpdate.route.num;
        }

        if (s1) s1.classList.add('hidden');
        if (s2) s2.classList.remove('hidden');
        if (s3Confirm) s3Confirm.classList.add('hidden');

        if (document.getElementById('step-2-summary') && pendingUpdate.route) {
            document.getElementById('step-2-summary').textContent = `Route ${pendingUpdate.route.num} - ${pendingUpdate.route.name}`;
        }

        populateBusGrid(false);

        if (grid && pendingUpdate.busNo) {
            const activeBtn = Array.from(grid.querySelectorAll('.grid-bus')).find(el => el.textContent.trim() === pendingUpdate.busNo);
            if (activeBtn) activeBtn.classList.add('yellow-active');
        }
    };
}
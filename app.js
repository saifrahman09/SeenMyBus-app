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
let currentSearchQuery = ''; // <-- Holds active search query across background syncs

// Routes & Slots Registry
const allRoutes = [
    { num: "6", name: "Adityapur" }, { num: "7", name: "Mango chauk" },
    { num: "3", name: "Bistupur" }, { num: "9", name: "Dhatkidih" },
    { num: "5", name: "Telco Colony" }, { num: "2", name: "Lal Building" }
];
const allBuses = ["01", "02", "03", "04", "05", "10", "15", "19", "22", "25", "29", "30"];
const allSpots = ["spot-01", "spot-02", "spot-03", "spot-04", "spot-05", "spot-06", "spot-07", "spot-08", "spot-09", "spot-10", "spot-11"];

// --- 1. Admin Visibility Check ---
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

// --- 2. Triple-Tap Sidebar Logo Gesture ---
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

// --- 3. Simplified Device Identity ---
function getDeviceToken() {
    let token = localStorage.getItem('smb_device_token');
    if (!token) {
        token = 'dev_' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('smb_device_token', token);
    }
    return token;
}
const currentDeviceToken = getDeviceToken();

// --- 4. Real-Time Keepalive & Reconnect ---
const connectedRef = ref(db, ".info/connected");
onValue(connectedRef, (snap) => {
    if (snap.val() === true) console.log("SeenMyBus Realtime Connected");
});
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') goOnline(db);
});

// --- 5. Splash Screen Dismissal ---
function hideSplashScreen() {
    const splash = document.getElementById('splash-screen');
    if (splash && !splash.classList.contains('fade-out')) {
        splash.classList.add('fade-out');
        setTimeout(() => { if (splash.parentNode) splash.remove(); }, 500);
    }
}
setTimeout(hideSplashScreen, 1500);

// --- 6. Guide, Points & Ranks ---
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

// --- 7. Restored Notifications Listeners ---
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
    if ("Notification" in window && Notification.permission === "granted") {
        new Notification(title, { body: body, icon: "./logo.svg" });
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

// --- 8. Smooth SVG Relocation Transit Animation ---
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

// --- 9. Automated Purge Engine ---
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

// --- 10. Consent & Setup ---
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

// --- 11. Load Campus Map ---
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
                    if (activeBuses.length > 0) renderMapSpots();
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

// --- 12. Realtime & Auto-Refresh Syncing ---
function handleBusesData(data) {
    const skeleton = document.getElementById('skeleton-loader');
    const busListEl = document.getElementById('bus-list');
    if (skeleton) skeleton.classList.add('hidden');
    if (busListEl) busListEl.classList.remove('hidden');
    
    if (!data) {
        activeBuses = [];
        busLocationTracker = {};
        routeLocationTracker = {};
        if (mapElement && appState === 'VIEW') renderMapSpots();
        if (appState === 'VIEW') renderList([]);
        return;
    }
    
    checkShiftPurge(data);
    
    const newActiveBuses = Object.keys(data).map(spotId => {
        const item = data[spotId];
        const buses = item.busNos ? item.busNos : (item.busNo ? [item.busNo] : []);
        return { spotId, ...item, busNos: buses };
    });
    
    const newRouteLocationTracker = {};
    
    newActiveBuses.forEach(ab => {
        ab.busNos.forEach(bNo => {
            let prevSpot = busLocationTracker[bNo];
            if (!prevSpot && routeLocationTracker[ab.routeNum] && routeLocationTracker[ab.routeNum] !== ab.spotId) {
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
        // Renders only the filtered items if user has typed in search bar
        renderList(getFilteredBuses());
    }
}

function handleUnassignedData(data) {
    unassignedBuses = data ? Object.keys(data).map(spotId => ({ spotId, ...data[spotId] })) : [];
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

// --- 13. Map Render Logic ---
function renderMapSpots() {
    allSpots.forEach(spotId => {
        const g = document.getElementById(spotId);
        if (!g) return;
        g.querySelectorAll('text.spot-text').forEach(t => t.remove());
        g.className.baseVal = '';
        g.onclick = null;
        const busInfo = activeBuses.find(b => b.spotId === spotId);
        const unassignedInfo = unassignedBuses.find(b => b.spotId === spotId);

        if (appState === 'VIEW') {
            if (busInfo && busInfo.busNos.length > 0) {
                g.style.opacity = '1';
                g.classList.add('spot-yellow');
                addTextToSpot(g, busInfo.busNos.join(','), 'text-black');
                g.style.pointerEvents = 'all';
                g.style.cursor = 'pointer';
                g.onclick = (e) => {
                    e.stopPropagation();
                    focusOnSpot(spotId);
                    highlightInList(spotId);
                };
            } else if (unassignedInfo) {
                g.classList.add('spot-unassigned');
                addTextToSpot(g, unassignedInfo.busNo, 'text-black');
                g.style.pointerEvents = 'all';
                g.style.cursor = 'pointer';
                g.onclick = (e) => {
                    e.stopPropagation();
                    focusOnSpot(spotId);
                };
            } else {
                g.style.opacity = '0';
                g.style.pointerEvents = 'none';
            }
        } else if (appState === 'SELECTION') {
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
                e.stopPropagation();
                
                // --- STRICT 1-SLOT-1-BUS OWNERSHIP CHECK ---
                if (busInfo) {
                    const existingRouteNum = busInfo.routeNum;
                    if (pendingUpdate.isReplacement) {
                        if (pendingUpdate.route && existingRouteNum !== pendingUpdate.route.num) {
                            alert(`Slot occupied by Route ${existingRouteNum}. Please mark it departed first.`);
                            return;
                        }
                    } else {
                        const existingBuses = busInfo.busNos || [];
                        if (existingBuses.length > 0 && !existingBuses.includes(pendingUpdate.busNo)) {
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
                    const txt = g.querySelector('text');
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

// --- 14. Sheet Drag & Pure Pan Engine ---
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

let scale = 1, pointX = 0, pointY = 0, startX = 0, startY = 0, isPanning = false, initialPinchDist = null, initialScale = 1;

function applyBoundaries() {
    if (!mapContainer) return;
    const contW = mapContainer.clientWidth, contH = mapContainer.clientHeight;
    const scaledW = contW * scale, scaledH = contH * scale;
    pointX = Math.min(0, Math.max(pointX, contW - scaledW));
    pointY = Math.min(0, Math.max(pointY, contH - scaledH));
}

function setTransform() {
    if (!mapElement) return;
    applyBoundaries();
    mapElement.style.transform = `translate(${pointX}px, ${pointY}px) scale(${scale})`;
    scale >= 1.6 ? mapContainer.classList.add('is-zoomed-in') : mapContainer.classList.remove('is-zoomed-in');
}

function resetFocus() {
    if (!mapElement || !mapContainer) return;
    document.querySelectorAll('.active-target').forEach(el => el.classList.remove('active-target', 'pop-animate'));
    document.querySelectorAll('.flash-highlight').forEach(el => el.classList.remove('flash-highlight'));
    scale = 1; pointX = 0; pointY = 0;
    mapElement.style.transition = 'transform 0.4s ease';
    setTransform();
    setTimeout(() => { if (mapElement) mapElement.style.transition = 'none'; }, 400);
}

if (mapContainer) {
    mapContainer.addEventListener('mousedown', e => { isPanning = true; startX = e.clientX - pointX; startY = e.clientY - pointY; });
    window.addEventListener('mousemove', e => { if (isPanning) { pointX = e.clientX - startX; pointY = e.clientY - startY; setTransform(); } });
    window.addEventListener('mouseup', () => isPanning = false);
    window.addEventListener('mouseleave', () => isPanning = false);
    mapContainer.addEventListener('wheel', e => {
        e.preventDefault();
        const xs = (e.clientX - pointX) / scale, ys = (e.clientY - pointY) / scale;
        scale = Math.min(Math.max(1, -e.deltaY > 0 ? scale * 1.15 : scale / 1.15), 5);
        pointX = e.clientX - xs * scale; pointY = e.clientY - ys * scale; setTransform();
    }, { passive: false });
    mapContainer.addEventListener('touchstart', e => {
        if (e.touches.length === 1) { isPanning = true; startX = e.touches[0].clientX - pointX; startY = e.touches[0].clientY - pointY; }
        else if (e.touches.length === 2) { isPanning = false; initialPinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); initialScale = scale; }
    }, { passive: true });
    mapContainer.addEventListener('touchmove', e => {
        if (e.touches.length === 1 && isPanning) { pointX = e.touches[0].clientX - startX; pointY = e.touches[0].clientY - startY; setTransform(); }
        else if (e.touches.length === 2 && initialPinchDist) { scale = Math.min(Math.max(1, initialScale * (Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY) / initialPinchDist)), 5); setTransform(); }
    }, { passive: true });
    mapContainer.addEventListener('touchend', e => {
        if (e.touches.length === 0) isPanning = false;
    });
    
    mapContainer.addEventListener('click', (e) => {
        if (!e.target.closest('[id^="spot-"]')) resetFocus();
    });
}

// --- 15. Bus List UI & Flash Highlight ---
function getGroupedRoutes(buses) {
    const routeMap = {};
    buses.forEach(bus => {
        const key = `route_${bus.routeNum}_${bus.name}`;
        if (!routeMap[key]) routeMap[key] = { routeNum: bus.routeNum, name: bus.name, buses: [], users: bus.users || 1 };
        bus.busNos.forEach(bNo => {
            if (!routeMap[key].buses.some(b => b.busNo === bNo)) routeMap[key].buses.push({ busNo: bNo, spotId: bus.spotId });
        });
        routeMap[key].users = Math.max(routeMap[key].users, bus.users || 1);
    });
    return Object.values(routeMap).sort((a,b) => parseInt(a.routeNum) - parseInt(b.routeNum));
}

function renderList(buses) {
    const container = document.getElementById('bus-list');
    if (!container) return;
    container.innerHTML = '';
    
    let groupedRoutes = getGroupedRoutes(buses);
    const emptyState = document.getElementById('empty-state');
    if (groupedRoutes.length === 0) {
        if (emptyState) emptyState.classList.remove('hidden');
        return;
    }
    if (emptyState) emptyState.classList.add('hidden');
    
    groupedRoutes.forEach(item => {
        const div = document.createElement('div');
        div.className = 'bus-item';
        
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
                e.stopPropagation(); 
                focusOnSpot(bObj.spotId); 
                highlightInList(bObj.spotId); 
            });
            badgeGroup.appendChild(badge);
        });
        div.addEventListener('click', () => {
            if (item.buses.length > 0) { 
                focusOnSpot(item.buses[0].spotId); 
                highlightInList(item.buses[0].spotId); 
            }
        });
        container.appendChild(div);
    });
}

function highlightInList(spotId) {
    const container = document.getElementById('bus-list');
    if(!container) return;
    const items = Array.from(container.querySelectorAll('.bus-item'));
    const targetItem = items.find(item => item.dataset.spots && item.dataset.spots.includes(spotId));
    if (targetItem) {
        container.prepend(targetItem);
        targetItem.classList.remove('flash-highlight');
        void targetItem.offsetWidth; 
        targetItem.classList.add('flash-highlight');
        container.scrollTop = 0;
    }
}

// Persistent Search Bar Listener (Fixes the filter reset bug)
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
    
    const baseW = 421, baseH = 667;
    const scaleRatio = Math.max(contW / baseW, contH / baseH);
    const svgActualW = baseW * scaleRatio, svgActualH = baseH * scaleRatio;
    const offsetX = (svgActualW - contW) / 2, offsetY = (svgActualH - contH) / 2;
    const busPixelX = (cx * scaleRatio) - offsetX;
    const busPixelY = (cy * scaleRatio) - offsetY;
    
    scale = 3.5;
    pointX = (contW / 2) - (busPixelX * scale);
    pointY = (contH * 0.28) - (busPixelY * scale); 
    
    mapElement.style.transition = 'transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)';
    setTransform();
    setTimeout(() => { if (mapElement) mapElement.style.transition = 'none'; }, 600);
    document.querySelectorAll('.active-target').forEach(el => el.classList.remove('active-target', 'pop-animate'));
    spotGroup.classList.add('active-target', 'pop-animate');
    setTimeout(() => { if (spotGroup) spotGroup.classList.remove('pop-animate'); }, 500);
}

// --- 16. Modal UI & Multi-Step Logic ---
const modal = document.getElementById('modal-overlay');
const tabPark = document.getElementById('tab-park'), tabDepart = document.getElementById('tab-depart');
const flowPark = document.getElementById('flow-park'), flowDepart = document.getElementById('flow-depart');
const s1 = document.getElementById('step-1'), s2 = document.getElementById('step-2'), s3Confirm = document.getElementById('step-3-confirm');
const grid = document.getElementById('bus-grid'), departList = document.getElementById('depart-bus-list');
const fixedFooter = document.getElementById('fixed-footer'), selFooter = document.getElementById('selection-footer');
const topBar = document.querySelector('.top-bar');

const rSelect = document.getElementById('route-select');
if (rSelect) allRoutes.forEach(r => rSelect.innerHTML += `<option value="${r.num}">Route ${r.num} - ${r.name}</option>`);

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

// --- 17. Departure Flow ---
function renderSimpleDepartList() {
    if (!departList) return;
    departList.innerHTML = '';
    const activeList = [];
    activeBuses.forEach(ab => ab.busNos.forEach(b => activeList.push({ busNo: b, label: `Route ${ab.routeNum} - ${ab.name}` })));
    unassignedBuses.forEach(ub => activeList.push({ busNo: ub.busNo, label: "Unassigned Spot" }));
    if (activeList.length === 0) {
        departList.innerHTML = `<p style="text-align: center; color: #727272; font-size: 13px; padding: 20px 0;">No active buses parked.</p>`;
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
                <span>Mark Departed</span>
            </div>
        `;
        card.onclick = () => {
            const targetBus = item.busNo;
            if (modal) modal.classList.add('hidden');
            executeFastUnassign(targetBus);
        };
        departList.appendChild(card);
    });
}

async function executeFastUnassign(busNumber) {
    try {
        const [snapActive, snapUn] = await Promise.all([ get(ref(db, 'activeBuses')), get(ref(db, 'unassignedBuses')) ]);
        const valActive = snapActive.val() || {};
        const valUn = snapUn.val() || {};
        
        let activeUpdates = {}, unassignedUpdates = {};

        Object.keys(valActive).forEach(sId => {
            let bList = valActive[sId].busNos || (valActive[sId].busNo ? [valActive[sId].busNo] : []);
            if (bList.includes(busNumber)) {
                bList = bList.filter(b => b !== busNumber);
                if (bList.length === 0) activeUpdates[sId] = null;
                else activeUpdates[`${sId}/busNos`] = bList;
            }
        });
        Object.keys(valUn).forEach(sId => { if (valUn[sId].busNo === busNumber) unassignedUpdates[sId] = null; });
        
        if (Object.keys(activeUpdates).length > 0) await update(ref(db, 'activeBuses'), activeUpdates);
        if (Object.keys(unassignedUpdates).length > 0) await update(ref(db, 'unassignedBuses'), unassignedUpdates);
        addContributionPoints(5);
    } catch (e) { console.error("Fast depart error:", e); }
}

// --- 18. Park Flow with Conditional Step 3 ---
if (document.getElementById('btn-skip-route')) {
    document.getElementById('btn-skip-route').onclick = () => {
        pendingUpdate.route = null;
        if (s1) s1.classList.add('hidden'); if (s2) s2.classList.remove('hidden');
        if (document.getElementById('step-2-summary')) document.getElementById('step-2-summary').textContent = `Unassigned Buses`;
        populateBusGrid(true);
    };
}
if (document.getElementById('btn-next-1')) {
    document.getElementById('btn-next-1').onclick = () => {
        pendingUpdate.route = allRoutes.find(r => r.num === rSelect.value);
        if (s1) s1.classList.add('hidden'); if (s2) s2.classList.remove('hidden');
        if (document.getElementById('step-2-summary') && pendingUpdate.route) {
            document.getElementById('step-2-summary').textContent = `Route ${pendingUpdate.route.num} - ${pendingUpdate.route.name}`;
        }
        populateBusGrid(false); 
    };
}

function populateBusGrid(isUnassignedMode) {
    if (!grid) return;
    grid.innerHTML = '';
    const busesToShow = isUnassignedMode ? getUnassignedBusNumbers() : allBuses;
    if (busesToShow.length === 0) {
        grid.innerHTML = `<p style="grid-column: 1/-1; text-align: center; color: #727272; font-size: 13px;">All buses parked.</p>`;
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
            const activeRouteSpots = activeBuses.filter(ab => ab.routeNum === pendingUpdate.route.num);
            let isDifferentBus = false;
            
            if (activeRouteSpots.length > 0) {
                const existingBusesForRoute = activeRouteSpots.flatMap(spot => spot.busNos);
                if (existingBusesForRoute.length > 0 && !existingBusesForRoute.includes(pendingUpdate.busNo)) {
                    isDifferentBus = true;
                }
            }

            if (isDifferentBus) {
                if (s2) s2.classList.add('hidden');
                if (s3Confirm) s3Confirm.classList.remove('hidden');
                if (document.getElementById('step-3-confirm-summary')) {
                    document.getElementById('step-3-confirm-summary').textContent = `Bus ${pendingUpdate.busNo} for Route ${pendingUpdate.route.num} - ${pendingUpdate.route.name}`;
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
        if (s3Confirm) s3Confirm.classList.add('hidden');
        if (s2) s2.classList.remove('hidden');
    };
}

if (document.getElementById('btn-replace-yes')) document.getElementById('btn-replace-yes').onclick = () => goToMapSelection(true);
if (document.getElementById('btn-replace-no')) document.getElementById('btn-replace-no').onclick = () => goToMapSelection(false);

function goToMapSelection(isReplacement) {
    pendingUpdate.isReplacement = isReplacement;
    appState = 'SELECTION';
    
    let summaryStr = pendingUpdate.route ? `(Route ${pendingUpdate.route.num})` : `(Unassigned Location)`;
    let extraText = (!isReplacement && pendingUpdate.route) ? `<br><span style="font-size:11.5px; color:#64748b; font-weight:600; line-height:1.5; display:block; margin-top:6px;">You are selecting an additional bus for ${pendingUpdate.route.name}</span>` : '';
    
    if (document.getElementById('step-3-summary')) {
        document.getElementById('step-3-summary').innerHTML = `Tap a slot on the map for <span style="color:#815FD7;">Bus ${pendingUpdate.busNo}</span> ${summaryStr}${extraText}`;
    }
    
    if (s3Confirm) s3Confirm.classList.add('hidden');
    if (s2) s2.classList.add('hidden');
    
    if (modal) modal.classList.add('hidden');
    if (fixedFooter) fixedFooter.classList.add('hidden');
    if (draggableSheet) draggableSheet.style.transform = `translateY(150%)`; 
    if (topBar) topBar.style.transform = `translateY(-150%)`; 
    if (selFooter) selFooter.classList.remove('hidden');
    
    scale = 1.6; pointX = 0; pointY = 0; 
    if (mapElement) {
        mapElement.style.transition = 'transform 0.4s'; 
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

// Strict 1-Vote-Per-Route Ledger Commit
if (document.getElementById('btn-submit-update')) {
    document.getElementById('btn-submit-update').onclick = async () => {
        if (!pendingUpdate.spotId) return alert("Tap a spot on the map!");
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
            const [snapActive, snapUn] = await Promise.all([ get(ref(db, 'activeBuses')), get(ref(db, 'unassignedBuses')) ]);
            const activeData = snapActive.val() || {};
            const unData = snapUn.val() || {};
            const updates = {};
            let notificationUpdates = {};
            const timestamp = Date.now();

            let routeOldBus = null;
            let isNewRoute = true;
            
            if (targetRoute) {
                Object.keys(activeData).forEach(sId => {
                    if (activeData[sId] && activeData[sId].routeNum === targetRoute.num) {
                        isNewRoute = false;
                        routeOldBus = (activeData[sId].busNos || [activeData[sId].busNo])[0];
                    }
                });
            }

            // --- STRICT SLOT OWNERSHIP BLOCK (Backend Verification) ---
            if (activeData[targetSpot]) {
                const existingRouteNum = activeData[targetSpot].routeNum;
                if (targetRoute && existingRouteNum !== targetRoute.num) {
                    alert(`Slot occupied by Route ${existingRouteNum}. Please mark it departed first.`);
                    document.getElementById('btn-submit-update').disabled = false;
                    return;
                }
                if (!targetRoute) {
                    alert(`Slot occupied by Route ${existingRouteNum}. Please mark it departed first.`);
                    document.getElementById('btn-submit-update').disabled = false;
                    return;
                }
            }

            Object.keys(activeData).forEach(sId => {
                let spotData = activeData[sId];
                let bList = spotData.busNos || (spotData.busNo ? [spotData.busNo] : []);
                let voters = spotData.votersLedger || {};
                let modified = false;

                if (spotData.users >= 999 && Object.keys(voters).length === 0) voters = { 'admin_locked': true };

                if (bList.includes(selectedBus)) {
                    bList = bList.filter(b => b !== selectedBus);
                    modified = true;
                }

                if (targetRoute && spotData.routeNum === targetRoute.num && voters[currentDeviceToken]) {
                    delete voters[currentDeviceToken];
                    modified = true;
                }
                
                if (targetRoute && pendingUpdate.isReplacement && spotData.routeNum === targetRoute.num) {
                    bList = []; 
                    modified = true;
                    if (sId !== targetSpot) busLocationTracker[selectedBus] = sId; 
                }

                if (modified && sId !== targetSpot) {
                    if (bList.length === 0 || Object.keys(voters).length === 0) {
                        updates[`activeBuses/${sId}`] = null;
                    } else {
                        updates[`activeBuses/${sId}/busNos`] = bList;
                        updates[`activeBuses/${sId}/users`] = spotData.users >= 999 ? 999 : Object.keys(voters).length;
                        updates[`activeBuses/${sId}/votersLedger`] = voters;
                    }
                }
            });

            Object.keys(unData).forEach(sId => { 
                if (unData[sId].busNo === selectedBus) updates[`unassignedBuses/${sId}`] = null; 
            });

            if (targetRoute) {
                let existingBusesAtSpot = [selectedBus]; 
                let existingVoters = {};
                
                if (activeData[targetSpot] && activeData[targetSpot].routeNum === targetRoute.num) {
                    existingVoters = activeData[targetSpot].votersLedger || {};
                    if (activeData[targetSpot].users >= 999 && Object.keys(existingVoters).length === 0) {
                        existingVoters = { 'admin_locked': true };
                    }
                }
                
                existingVoters[currentDeviceToken] = true;

                if (pendingUpdate.isReplacement && !isNewRoute && routeOldBus && routeOldBus !== selectedBus) {
                    const notifId = Date.now().toString();
                    const numVoters = existingVoters['admin_locked'] ? 999 : Object.keys(existingVoters).length;
                    const consensusStr = numVoters === 1 ? " Reported by 1 user only, so can be wrong :((" : "";
                    notificationUpdates[notifId] = {
                        title: "Bus Change Alert",
                        message: `Dear user, The bus number for ${targetRoute.name} may have been changed from ${routeOldBus} to ${selectedBus}.${consensusStr}`,
                        createdAt: Date.now()
                    };
                }

                updates[`activeBuses/${targetSpot}`] = {
                    busNo: selectedBus, 
                    busNos: existingBusesAtSpot,
                    routeNum: targetRoute.num,
                    name: targetRoute.name,
                    users: existingVoters['admin_locked'] ? 999 : Object.keys(existingVoters).length,
                    votersLedger: existingVoters,
                    updatedAt: timestamp,
                    updatedBy: currentDeviceToken
                };
            } else {
                updates[`unassignedBuses/${targetSpot}`] = {
                    busNo: selectedBus,
                    updatedAt: timestamp,
                    updatedBy: currentDeviceToken
                };
            }

            await update(ref(db), updates);
            if (Object.keys(notificationUpdates).length > 0) await update(ref(db, 'broadcastNotifications'), notificationUpdates);
            await addContributionPoints(10);
        } catch (err) {
            console.error("Sync error:", err);
        } finally {
            document.getElementById('btn-submit-update').disabled = false;
        }
    };
}
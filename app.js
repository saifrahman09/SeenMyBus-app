// Import Firebase modular SDKs via CDN
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { getDatabase, ref, onValue, set, update, get } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-database.js";

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
let pendingUpdate = { route: null, busNo: null, spotId: null };
let previousBusMap = {};

// Routes & Slots Registry
const allRoutes = [
    { num: "6", name: "Adityapur" }, { num: "7", name: "Mango chauk" },
    { num: "3", name: "Bistupur" }, { num: "9", name: "Dhatkidih" },
    { num: "5", name: "Telco Colony" }, { num: "2", name: "Lal Building" }
];
const allBuses = ["01", "02", "03", "04", "05", "10", "15", "19", "22", "25", "29", "30"];
const allSpots = ["spot-01", "spot-02", "spot-03", "spot-04", "spot-05", "spot-06", "spot-07", "spot-08", "spot-09", "spot-10", "spot-11"];

// --- 1. Notification Engine (15-Second Delay) ---
function initNotificationSystem() {
    const notifBanner = document.getElementById('notif-banner');
    const isAsked = localStorage.getItem('smb_notif_asked');

    if (!isAsked && "Notification" in window && Notification.permission === 'default') {
        setTimeout(() => {
            if (!localStorage.getItem('smb_notif_asked')) {
                notifBanner.classList.remove('hidden');
            }
        }, 15000);
    }

    document.getElementById('btn-allow-notif').onclick = () => {
        Notification.requestPermission().then(() => {
            localStorage.setItem('smb_notif_asked', 'true');
            notifBanner.classList.add('hidden');
        });
    };

    document.getElementById('btn-dismiss-notif').onclick = () => {
        localStorage.setItem('smb_notif_asked', 'true');
        notifBanner.classList.add('hidden');
    };
}

function sendLocalNotification(title, body) {
    if ("Notification" in window && Notification.permission === "granted") {
        new Notification(title, {
            body: body,
            icon: "https://raw.githubusercontent.com/saifrahman09/SeenMyBus-app/main/icon.png"
        });
    }
}

// 15-Minute Reminder
function scheduleUnassignedReminder(busNo) {
    localStorage.setItem('smb_unassigned_remind_time', Date.now() + 15 * 60 * 1000);
    localStorage.setItem('smb_unassigned_bus_no', busNo);
}

setInterval(() => {
    const remindTime = localStorage.getItem('smb_unassigned_remind_time');
    const busNo = localStorage.getItem('smb_unassigned_bus_no');
    if (remindTime && Date.now() >= parseInt(remindTime, 10)) {
        localStorage.removeItem('smb_unassigned_remind_time');
        localStorage.removeItem('smb_unassigned_bus_no');
        sendLocalNotification("Spot Reminder 📍", `Did you notice which parking slot Bus ${busNo} moved to? Tap to update!`);
    }
}, 30000);

// --- 2. Monthly Contributor Engine (Resets 5th of Every Month) ---
function getDeviceToken() {
    let token = localStorage.getItem('device_token');
    if (!token) {
        token = 'dev_' + Math.random().toString(36).substring(2, 11);
        localStorage.setItem('device_token', token);
    }
    return token;
}

function getCurrentCycleKey() {
    const now = new Date();
    let year = now.getFullYear();
    let month = now.getMonth() + 1;
    const day = now.getDate();

    if (day < 5) {
        month -= 1;
        if (month === 0) { month = 12; year -= 1; }
    }
    return `cycle_${year}_${String(month).padStart(2, '0')}`;
}

async function addContributionPoints(points = 10) {
    const deviceToken = getDeviceToken();
    const cycleKey = getCurrentCycleKey();
    const userRef = ref(db, `userProfiles/${deviceToken}/${cycleKey}`);

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
    if (score >= 100) level = "Level 5 (Campus Legend 🌟)";
    else if (score >= 50) level = "Level 4 (Spotter Pro)";
    else if (score >= 25) level = "Level 3 (Regular Scout)";
    else if (score >= 10) level = "Level 2 (Active Contributor)";
    rankElem.textContent = `Score: ${score} pts • ${level}`;
}

async function loadUserRank() {
    const deviceToken = getDeviceToken();
    const cycleKey = getCurrentCycleKey();
    try {
        const snap = await get(ref(db, `userProfiles/${deviceToken}/${cycleKey}`));
        const data = snap.val() || { score: 0 };
        updateRankDisplay(data.score || 0);
    } catch (e) {}
}

// --- 3. Shift Purge & Expiry ---
function isDataStale(updatedAt) {
    if (!updatedAt) return false;
    return (Date.now() - updatedAt) > (90 * 60 * 1000); // 90 mins TTL
}

async function checkShiftPurge(data) {
    const now = new Date();
    const currentMins = now.getHours() * 60 + now.getMinutes();
    const cutoffs = [795, 975, 1140]; // 1:15 PM, 4:15 PM, 7:00 PM
    const updates = {};
    let needsPurge = false;

    Object.keys(data).forEach(spotId => {
        const item = data[spotId];
        if (item && item.updatedAt) {
            const itemDate = new Date(item.updatedAt);
            const itemMins = itemDate.getHours() * 60 + itemDate.getMinutes();
            const crossedCutoff = cutoffs.some(c => itemMins < c && currentMins >= c && (now.getDate() === itemDate.getDate()));
            if (isDataStale(item.updatedAt) || crossedCutoff) {
                updates[`activeBuses/${spotId}`] = null;
                needsPurge = true;
            }
        }
    });

    if (needsPurge) await update(ref(db), updates);
}

// --- Consent & Sidebar Navigation ---
const consentBanner = document.getElementById('consent-banner');
if (!localStorage.getItem('aju_consent')) consentBanner.classList.remove('hidden');

document.getElementById('btn-accept-cookies').onclick = () => {
    localStorage.setItem('aju_consent', 'true');
    consentBanner.classList.add('hidden');
    getDeviceToken();
    initNotificationSystem();
    loadUserRank();
};

if (localStorage.getItem('aju_consent')) {
    initNotificationSystem();
    loadUserRank();
}

const btnHam = document.getElementById('btn-hamburger');
const sidePanel = document.getElementById('side-panel');
const sideOverlay = document.getElementById('side-panel-overlay');
const closePanel = document.getElementById('btn-close-panel');

const togglePanel = () => {
    sidePanel.classList.toggle('open');
    sideOverlay.classList.toggle('hidden');
    if (sidePanel.classList.contains('open')) loadUserRank();
};
btnHam.onclick = togglePanel;
closePanel.onclick = togglePanel;
sideOverlay.onclick = togglePanel;

// Fetch Map
fetch('./ArkaJainUniversityBusMap.xml').then(res => res.text()).then(svgText => {
    mapContainer.innerHTML = svgText;
    setTimeout(() => {
        mapElement = mapContainer.querySelector('svg');
        if (mapElement) {
            mapElement.id = 'campus-map';
            mapElement.setAttribute('preserveAspectRatio', 'xMidYMid slice');
            mapElement.style.shapeRendering = 'geometricPrecision';
            const rootGroup = document.getElementById('campus-map-root');
            if(rootGroup) rootGroup.removeAttribute('clip-path');
            if (activeBuses.length > 0) renderMapSpots();
        }
    }, 100);
});

// --- Realtime Firebase Sync ---
onValue(ref(db, 'activeBuses'), (snapshot) => {
    const data = snapshot.val();
    if (!data) {
        activeBuses = [];
        if (appState === 'VIEW') {
            if(mapElement) renderMapSpots();
            renderList([]);
            document.getElementById('skeleton-loader').classList.add('hidden');
            document.getElementById('bus-list').classList.remove('hidden');
        }
        return;
    }

    checkShiftPurge(data);

    activeBuses = Object.keys(data).map(spotId => {
        const item = data[spotId];
        const buses = item.busNos ? item.busNos : (item.busNo ? [item.busNo] : []);
        return { spotId, ...item, busNos: buses };
    });

    // Consensus Alert
    activeBuses.forEach(ab => {
        ab.busNos.forEach(bNo => {
            if (previousBusMap[bNo] && previousBusMap[bNo].routeNum !== ab.routeNum && (ab.users >= 3)) {
                sendLocalNotification("Bus Updated 🔄", `Route ${ab.routeNum} (${ab.name}) is operating as Bus #${bNo}.`);
            }
            previousBusMap[bNo] = { routeNum: ab.routeNum, spotId: ab.spotId };
        });
    });

    if (appState === 'VIEW') {
        if(mapElement) renderMapSpots();
        renderList(activeBuses);
        document.getElementById('skeleton-loader').classList.add('hidden');
        document.getElementById('bus-list').classList.remove('hidden');
    }
});

onValue(ref(db, 'unassignedBuses'), (snapshot) => {
    const data = snapshot.val();
    unassignedBuses = data ? Object.keys(data).map(spotId => ({ spotId, ...data[spotId] })) : [];
    if(appState === 'VIEW' && mapElement) renderMapSpots();
});

function getUnassignedBusNumbers() {
    const assigned = new Set();
    activeBuses.forEach(ab => ab.busNos.forEach(b => assigned.add(b)));
    return allBuses.filter(bNo => !assigned.has(bNo));
}

// --- Map Render Logic ---
function renderMapSpots() {
    allSpots.forEach(spotId => {
        const g = document.getElementById(spotId);
        if(!g) return;
        
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
                    highlightBusInList(busInfo.busNos[0]);
                    focusOnSpot(spotId);
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
                allSpots.forEach(s => {
                    const sg = document.getElementById(s);
                    if(!sg) return;
                    sg.classList.remove('spot-yellow', 'spot-deep-green');
                    const txt = sg.querySelector('text');
                    if(txt && !sg.classList.contains('spot-green')) txt.remove();
                    if(txt && sg.classList.contains('spot-green')) txt.classList.replace('text-white', 'text-green');
                });

                pendingUpdate.spotId = spotId;
                if (busInfo) {
                    g.classList.add('spot-deep-green');
                    const txt = g.querySelector('text');
                    if(txt) txt.classList.replace('text-green', 'text-white');
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
    if(!circle) return;
    const cx = circle.getAttribute('cx'), cy = circle.getAttribute('cy');
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', cx); text.setAttribute('y', cy);
    text.setAttribute('text-anchor', 'middle'); text.setAttribute('dy', '0.35em'); 
    text.setAttribute('class', `spot-text ${colorClass}`);
    if (textContent.length > 3) text.style.fontSize = '3.8px';
    text.textContent = textContent;
    g.appendChild(text);
}

// --- Sheet Drag & Pan Engine ---
const draggableSheet = document.getElementById('draggable-sheet');
const dragHandle = document.getElementById('drag-handle-area');
const contentWrapper = document.getElementById('sheet-content-wrapper');
let currentTranslate = 0, sheetStartY = 0, isDraggingSheet = false;

dragHandle.addEventListener('touchstart', (e) => {
    sheetStartY = e.touches[0].clientY - currentTranslate;
    isDraggingSheet = true;
    draggableSheet.style.transition = 'none';
}, { passive: true });

dragHandle.addEventListener('touchmove', (e) => {
    if (!isDraggingSheet) return;
    const maxTranslate = contentWrapper.offsetHeight; 
    currentTranslate = Math.max(0, Math.min(e.touches[0].clientY - sheetStartY, maxTranslate));
    draggableSheet.style.transform = `translateY(${currentTranslate}px)`;
}, { passive: true });

dragHandle.addEventListener('touchend', () => {
    isDraggingSheet = false;
    draggableSheet.style.transition = 'transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1)';
    const maxTranslate = contentWrapper.offsetHeight;
    currentTranslate = (currentTranslate > maxTranslate / 3) ? maxTranslate : 0;
    draggableSheet.style.transform = `translateY(${currentTranslate}px)`;
});

let scale = 1, pointX = 0, pointY = 0, startX = 0, startY = 0, isPanning = false, initialPinchDist = null, initialScale = 1;

function applyBoundaries() {
    const contW = mapContainer.clientWidth, contH = mapContainer.clientHeight;
    const scaledW = contW * scale, scaledH = contH * scale;
    pointX = Math.min(0, Math.max(pointX, contW - scaledW));
    pointY = Math.min(0, Math.max(pointY, contH - scaledH));
}

function setTransform() {
    if(!mapElement) return;
    applyBoundaries(); 
    mapElement.style.transform = `translate(${pointX}px, ${pointY}px) scale(${scale})`;
    scale >= 1.6 ? mapContainer.classList.add('is-zoomed-in') : mapContainer.classList.remove('is-zoomed-in');
}

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
mapContainer.addEventListener('touchend', e => { if (e.touches.length === 0) isPanning = false; });

// --- Bus List UI ---
const listContainer = id => document.getElementById(id);

function renderList(buses, highlightBusNo = null) {
    const container = listContainer('bus-list');
    container.innerHTML = '';
    
    if (buses.length === 0) {
        document.getElementById('empty-state').classList.remove('hidden');
        return;
    }
    document.getElementById('empty-state').classList.add('hidden');

    buses.forEach(bus => {
        const div = document.createElement('div');
        const isHighlighted = highlightBusNo && bus.busNos.includes(highlightBusNo);
        div.className = `bus-item ${isHighlighted ? 'highlighted-bus' : ''}`;
        
        const badgesHtml = bus.busNos.map(num => `<div class="bus-circle-badge">${num}</div>`).join('');

        div.innerHTML = `
            <div class="bus-info-left">
                <span class="route-badge">Route ${bus.routeNum}</span>
                <span class="route-name">${bus.name}</span>
                <span class="verified-text">Suggested by ${bus.users || 1} users</span>
            </div>
            <div class="bus-badge-group">
                ${badgesHtml}
            </div>
        `;
        div.addEventListener('click', () => focusOnSpot(bus.spotId));
        container.appendChild(div);
    });
}

function highlightBusInList(busNo) {
    activeBuses.sort((a, b) => a.busNos.includes(busNo) ? -1 : b.busNos.includes(busNo) ? 1 : 0);
    currentTranslate = 0;
    draggableSheet.style.transition = 'transform 0.35s';
    draggableSheet.style.transform = `translateY(0)`;
    renderList(activeBuses, busNo);
    listContainer('bus-list').scrollTop = 0;
}

const searchInput = document.getElementById('search-input');
searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    const filtered = activeBuses.filter(bus => 
        bus.busNos.some(b => b.includes(query)) || 
        bus.name.toLowerCase().includes(query) || 
        bus.routeNum.includes(query)
    );
    renderList(filtered);
});

function focusOnSpot(spotId) {
    if(!mapElement) return;
    const spotGroup = document.getElementById(spotId);
    if(!spotGroup) return;

    const circle = spotGroup.querySelector('circle');
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
    setTimeout(() => mapElement.style.transition = 'none', 600);

    document.querySelectorAll('.active-target').forEach(el => el.classList.remove('active-target', 'pop-animate'));
    spotGroup.classList.add('active-target', 'pop-animate');
    setTimeout(() => { if(spotGroup) spotGroup.classList.remove('pop-animate'); }, 500); 
}

// --- Simplified Modal UI & Tab Switching ---
const modal = document.getElementById('modal-overlay');
const tabPark = document.getElementById('tab-park');
const tabDepart = document.getElementById('tab-depart');
const flowPark = document.getElementById('flow-park');
const flowDepart = document.getElementById('flow-depart');

const s1 = document.getElementById('step-1'), s2 = document.getElementById('step-2');
const grid = document.getElementById('bus-grid');
const departList = document.getElementById('depart-bus-list');
const fixedFooter = document.getElementById('fixed-footer');
const selFooter = document.getElementById('selection-footer');
const topBar = document.querySelector('.top-bar');

const rSelect = document.getElementById('route-select');
allRoutes.forEach(r => rSelect.innerHTML += `<option value="${r.num}">Route ${r.num} - ${r.name}</option>`);

// Open Main Modal
document.getElementById('btn-update-bus').onclick = () => {
    modal.classList.remove('hidden');
    switchTab('PARK');
    s1.classList.remove('hidden'); 
    s2.classList.add('hidden');
    pendingUpdate = { route: null, busNo: null, spotId: null };
};

document.getElementById('btn-close-modal').onclick = () => modal.classList.add('hidden');

function switchTab(mode) {
    if (mode === 'PARK') {
        tabPark.classList.add('active');
        tabDepart.classList.remove('active');
        flowPark.classList.remove('hidden');
        flowDepart.classList.add('hidden');
    } else {
        tabDepart.classList.add('active');
        tabPark.classList.remove('active');
        flowDepart.classList.remove('hidden');
        flowPark.classList.add('hidden');
        renderSimpleDepartList();
    }
}

tabPark.onclick = () => switchTab('PARK');
tabDepart.onclick = () => switchTab('DEPART');

// --- 1-TAP DEPARTURE LOGIC ---
function renderSimpleDepartList() {
    departList.innerHTML = '';
    const activeList = [];

    activeBuses.forEach(ab => {
        ab.busNos.forEach(b => activeList.push({ busNo: b, label: `Route ${ab.routeNum} - ${ab.name}` }));
    });
    unassignedBuses.forEach(ub => {
        activeList.push({ busNo: ub.busNo, label: "Unassigned Spot" });
    });

    if (activeList.length === 0) {
        departList.innerHTML = `<p style="text-align: center; color: #727272; font-size: 13px; padding: 20px 0;">No active buses currently parked.</p>`;
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
            <div class="depart-action-pill">Mark Departed 💨</div>
        `;

        card.onclick = () => {
            const targetBus = item.busNo;
            modal.classList.add('hidden');

            // Optimistic 0ms Local Update
            activeBuses.forEach(ab => { ab.busNos = ab.busNos.filter(b => b !== targetBus); });
            activeBuses = activeBuses.filter(ab => ab.busNos.length > 0);
            unassignedBuses = unassignedBuses.filter(ub => ub.busNo !== targetBus);
            
            renderMapSpots();
            renderList(activeBuses);

            // Asynchronous Firebase Write & Contributor Reward
            executeFastUnassign(targetBus);
            addContributionPoints(5);
        };
        departList.appendChild(card);
    });
}

async function executeFastUnassign(busNumber) {
    try {
        const updates = {};
        const [snapActive, snapUn] = await Promise.all([
            get(ref(db, 'activeBuses')),
            get(ref(db, 'unassignedBuses'))
        ]);

        const valActive = snapActive.val() || {};
        Object.keys(valActive).forEach(sId => {
            let bList = valActive[sId].busNos || (valActive[sId].busNo ? [valActive[sId].busNo] : []);
            if (bList.includes(busNumber)) {
                bList = bList.filter(b => b !== busNumber);
                if (bList.length === 0) updates[`activeBuses/${sId}`] = null;
                else updates[`activeBuses/${sId}/busNos`] = bList;
            }
        });

        const valUn = snapUn.val() || {};
        Object.keys(valUn).forEach(sId => {
            if (valUn[sId].busNo === busNumber) updates[`unassignedBuses/${sId}`] = null;
        });

        await update(ref(db), updates);
    } catch (e) {
        console.error("Fast depart error:", e);
    }
}

// --- PARK BUS WIZARD ---
document.getElementById('btn-skip-route').onclick = () => {
    pendingUpdate.route = null;
    s1.classList.add('hidden'); s2.classList.remove('hidden');
    document.getElementById('step-2-summary').textContent = `Unassigned Buses`;
    populateBusGrid(true);
};

document.getElementById('btn-next-1').onclick = () => {
    pendingUpdate.route = allRoutes.find(r => r.num === rSelect.value);
    s1.classList.add('hidden'); s2.classList.remove('hidden');
    document.getElementById('step-2-summary').textContent = `Route ${pendingUpdate.route.num} - ${pendingUpdate.route.name}`;
    populateBusGrid(false); 
};

function populateBusGrid(isUnassignedMode) {
    grid.innerHTML = '';
    const busesToShow = isUnassignedMode ? getUnassignedBusNumbers() : allBuses;

    if (busesToShow.length === 0) {
        grid.innerHTML = `<p style="grid-column: 1/-1; text-align: center; color: #727272; font-size: 13px;">All buses are currently parked.</p>`;
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

document.getElementById('btn-prev-2').onclick = () => { s2.classList.add('hidden'); s1.classList.remove('hidden'); };

document.getElementById('btn-next-2').onclick = () => {
    if(!pendingUpdate.busNo) return alert("Please select a bus number.");
    appState = 'SELECTION';
    
    const summaryStr = pendingUpdate.route ? `(Route ${pendingUpdate.route.num})` : `(Unassigned Location)`;
    document.getElementById('step-3-summary').innerHTML = `Tap a slot on the map for <span style="color:#815FD7;">Bus ${pendingUpdate.busNo}</span> ${summaryStr}`;

    modal.classList.add('hidden');
    fixedFooter.classList.add('hidden');
    draggableSheet.style.transform = `translateY(150%)`; 
    topBar.style.transform = `translateY(-150%)`; 
    selFooter.classList.remove('hidden');

    scale = 1.6; pointX = 0; pointY = 0; 
    mapElement.style.transition = 'transform 0.4s'; setTransform(); setTimeout(() => mapElement.style.transition = 'none', 400);
    renderMapSpots();
};

document.getElementById('btn-prev-3').onclick = () => {
    appState = 'VIEW';
    selFooter.classList.add('hidden');
    fixedFooter.classList.remove('hidden');
    draggableSheet.style.transform = `translateY(${currentTranslate}px)`;
    topBar.style.transform = `translateY(0)`;
    modal.classList.remove('hidden');
    renderMapSpots(); 
};

// Confirm Parking Slot
document.getElementById('btn-submit-update').onclick = async () => {
    if(!pendingUpdate.spotId) return alert("Tap a spot on the map!");
    const confirmBtn = document.getElementById('btn-submit-update');
    confirmBtn.disabled = true;

    const deviceToken = getDeviceToken();
    const targetSpot = pendingUpdate.spotId;
    const selectedBus = pendingUpdate.busNo;
    const targetRoute = pendingUpdate.route;

    if (!targetRoute) scheduleUnassignedReminder(selectedBus);

    // Instant optimistic close
    appState = 'VIEW';
    selFooter.classList.add('hidden'); 
    fixedFooter.classList.remove('hidden');
    draggableSheet.style.transform = `translateY(${currentTranslate}px)`; 
    topBar.style.transform = `translateY(0)`;

    try {
        const [snapActive, snapUn] = await Promise.all([
            get(ref(db, 'activeBuses')),
            get(ref(db, 'unassignedBuses'))
        ]);

        const activeData = snapActive.val() || {};
        const unData = snapUn.val() || {};
        const updates = {};
        const timestamp = Date.now();

        // Strip previous occurrences
        Object.keys(activeData).forEach(sId => {
            let bList = activeData[sId].busNos || (activeData[sId].busNo ? [activeData[sId].busNo] : []);
            if (bList.includes(selectedBus)) {
                bList = bList.filter(b => b !== selectedBus);
                if (bList.length === 0) updates[`activeBuses/${sId}`] = null;
                else updates[`activeBuses/${sId}/busNos`] = bList;
            }
        });

        Object.keys(unData).forEach(sId => {
            if (unData[sId].busNo === selectedBus) updates[`unassignedBuses/${sId}`] = null;
        });

        if (targetRoute) {
            let existingBusesAtSpot = [];
            if (activeData[targetSpot] && activeData[targetSpot].routeNum === targetRoute.num) {
                existingBusesAtSpot = activeData[targetSpot].busNos || (activeData[targetSpot].busNo ? [activeData[targetSpot].busNo] : []);
            }
            if (!existingBusesAtSpot.includes(selectedBus)) existingBusesAtSpot.push(selectedBus);

            updates[`activeBuses/${targetSpot}`] = {
                busNos: existingBusesAtSpot,
                routeNum: targetRoute.num,
                name: targetRoute.name,
                users: (activeData[targetSpot]?.users || 0) + 1,
                updatedAt: timestamp,
                updatedBy: deviceToken
            };
        } else {
            updates[`unassignedBuses/${targetSpot}`] = {
                busNo: selectedBus,
                updatedAt: timestamp,
                updatedBy: deviceToken
            };
        }

        await update(ref(db), updates);
        await addContributionPoints(10);
    } catch (err) {
        console.error("Sync error:", err);
    } finally {
        confirmBtn.disabled = false;
    }
};
// Import Firebase modular SDKs directly from the CDN
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { getDatabase, ref, onValue, set, update, get } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-database.js";

// --- FIREBASE CONFIGURATION ---
const firebaseConfig = {
    apiKey: "AIzaSyCXejNb5wgmZ6KJ3Q4r4BhBqw9KPn7iX5I",
    authDomain: "seenmybus.firebaseapp.com",
    // NOTE: This is the standard Realtime Database URL structure. Ensure it is correct for your region!
    databaseURL: "https://seenmybus-default-rtdb.asia-southeast1.firebasedatabase.app", 
    projectId: "seenmybus",
    storageBucket: "seenmybus.firebasestorage.app",
    messagingSenderId: "352466758419",
    appId: "1:352466758419:web:b86ed30eff7223910688e6",
    measurementId: "G-7RF7CK39M9"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// --- State Variables ---
const mapContainer = document.getElementById('map-container');
let mapElement = null;
let activeBuses = [];
let unassignedBuses = [];
let appState = 'VIEW'; 
let pendingUpdate = { route: null, busNo: null, spotId: null };

// --- Map Data Models ---
const allRoutes = [
    { num: "6", name: "Adityapur" }, { num: "7", name: "Mango chauk" },
    { num: "3", name: "Bistupur" }, { num: "9", name: "Dhatkidih" },
    { num: "5", name: "Telco Colony" }, { num: "2", name: "Lal Building" }
];
const allBuses = ["01", "02", "03", "04", "05", "10", "15", "19", "22", "25", "29", "30"];
const allSpots = ["spot-01", "spot-02", "spot-03", "spot-04", "spot-05", "spot-06", "spot-07", "spot-08", "spot-09", "spot-10", "spot-11"];

// --- Authentication & Consent ---
const consentBanner = document.getElementById('consent-banner');
if (!localStorage.getItem('aju_consent')) consentBanner.classList.remove('hidden');

document.getElementById('btn-accept-cookies').onclick = () => {
    localStorage.setItem('aju_consent', 'true');
    consentBanner.classList.add('hidden');
    generateDeviceToken();
};

function generateDeviceToken() {
    if(!localStorage.getItem('device_token')) {
        fetch('https://api.ipify.org?format=json').then(r=>r.json()).then(data => {
            const encryptedIp = btoa(data.ip + 'SeenMyBus_Salt_' + Date.now()).substring(0, 24);
            localStorage.setItem('device_token', encryptedIp);
        }).catch(() => {
            localStorage.setItem('device_token', 'anon_' + Math.random().toString(36).substr(2, 9));
        });
    }
}
if (localStorage.getItem('aju_consent')) generateDeviceToken();

// --- Navigation (Hamburger) ---
const btnHam = document.getElementById('btn-hamburger');
const sidePanel = document.getElementById('side-panel');
const sideOverlay = document.getElementById('side-panel-overlay');
const closePanel = document.getElementById('btn-close-panel');

const togglePanel = () => {
    sidePanel.classList.toggle('open');
    sideOverlay.classList.toggle('hidden');
};
btnHam.onclick = togglePanel;
closePanel.onclick = togglePanel;
sideOverlay.onclick = togglePanel;

// --- Map Fetch ---
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
            
            // Re-render UI now that Map exists
            if (activeBuses.length > 0) renderMapSpots();
        }
    }, 100);
});

// --- REAL-TIME FIREBASE SYNC LISTENERS ---
onValue(ref(db, 'activeBuses'), (snapshot) => {
    const data = snapshot.val();
    activeBuses = data ? Object.keys(data).map(spotId => ({ spotId, ...data[spotId] })) : [];
    if(appState === 'VIEW') {
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
    const activeBusNumbers = new Set(activeBuses.map(b => b.busNo));
    return allBuses.filter(bNo => !activeBusNumbers.has(bNo));
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
            if (busInfo) {
                g.style.opacity = '1';
                g.classList.add('spot-yellow');
                addTextToSpot(g, busInfo.busNo, 'text-black');
                g.style.pointerEvents = 'all';
                g.style.cursor = 'pointer';
                g.onclick = (e) => {
                    e.stopPropagation();
                    highlightBusInList(busInfo.busNo);
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

            if (busInfo) {
                g.classList.add('spot-green');
                addTextToSpot(g, busInfo.busNo, 'text-green');
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
    text.setAttribute('class', `spot-text ${colorClass}`); text.textContent = textContent;
    g.appendChild(text);
}

// --- Bottom Sheet Drag Logic ---
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

// --- Pan & Zoom Engine ---
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

// --- Main List UI ---
const listContainer = id => document.getElementById(id);

function renderList(buses, highlightBusNo = null) {
    const container = listContainer('bus-list');
    container.innerHTML = '';
    buses.forEach(bus => {
        const div = document.createElement('div');
        div.className = `bus-item ${highlightBusNo === bus.busNo ? 'highlighted-bus' : ''}`;
        div.innerHTML = `
            <div class="bus-info-left">
                <span class="route-badge">Route ${bus.routeNum}</span>
                <span class="route-name">${bus.name}</span>
                <span class="verified-text">Suggested by ${bus.users} users</span>
            </div>
            <div class="bus-circle-badge">${bus.busNo}</div>
        `;
        div.addEventListener('click', () => focusOnSpot(bus.spotId));
        container.appendChild(div);
    });
}

function highlightBusInList(busNo) {
    activeBuses.sort((a, b) => a.busNo === busNo ? -1 : b.busNo === busNo ? 1 : 0);
    currentTranslate = 0;
    draggableSheet.style.transition = 'transform 0.35s';
    draggableSheet.style.transform = `translateY(0)`;
    renderList(activeBuses, busNo);
    listContainer('bus-list').scrollTop = 0;
}

const searchInput = document.getElementById('search-input');
searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    const filtered = activeBuses.filter(bus => bus.busNo.includes(query) || bus.name.toLowerCase().includes(query) || bus.routeNum.includes(query));
    renderList(filtered);
    if (filtered.length === 0) document.getElementById('empty-state').classList.remove('hidden');
    else document.getElementById('empty-state').classList.add('hidden');
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

// --- Multi-Step Update Flow ---
const modal = document.getElementById('modal-overlay');
const s1 = document.getElementById('step-1'), s2 = document.getElementById('step-2');
const grid = document.getElementById('bus-grid');
const fixedFooter = document.getElementById('fixed-footer');
const selFooter = document.getElementById('selection-footer');
const topBar = document.querySelector('.top-bar');

const rSelect = document.getElementById('route-select');
allRoutes.forEach(r => rSelect.innerHTML += `<option value="${r.num}">Route ${r.num} - ${r.name}</option>`);

document.getElementById('btn-update-bus').onclick = () => {
    modal.classList.remove('hidden');
    s1.classList.remove('hidden'); s2.classList.add('hidden');
    pendingUpdate = { route: null, busNo: null, spotId: null };
};

document.getElementById('btn-close-modal').onclick = () => modal.classList.add('hidden');

document.getElementById('btn-skip-route').onclick = () => {
    pendingUpdate.route = null;
    s1.classList.add('hidden'); s2.classList.remove('hidden');
    document.getElementById('step-2-summary').textContent = `Unassigned Buses (Select Bus)`;
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
        grid.innerHTML = `<p style="grid-column: 1/-1; text-align: center; color: #727272; font-size: 13px;">All buses are currently assigned.</p>`;
        return;
    }

    busesToShow.forEach(bNo => {
        const isActive = activeBuses.find(ab => ab.busNo === bNo);
        const isSpottedUnassigned = unassignedBuses.find(ub => ub.busNo === bNo);
        
        const btn = document.createElement('div');
        btn.className = `grid-bus ${isActive ? 'green' : 'grey'}`;
        btn.textContent = bNo;
        
        btn.onclick = () => {
            grid.querySelectorAll('.grid-bus').forEach(el => el.classList.remove('yellow-active'));
            btn.classList.add('yellow-active');
            pendingUpdate.busNo = bNo;
            
            if (isSpottedUnassigned) {
                pendingUpdate.spotId = isSpottedUnassigned.spotId;
            } else if (isActive) {
                pendingUpdate.spotId = isActive.spotId;
            }
        };
        grid.appendChild(btn);
    });
}

document.getElementById('btn-prev-2').onclick = () => { s2.classList.add('hidden'); s1.classList.remove('hidden'); };

document.getElementById('btn-next-2').onclick = () => {
    if(!pendingUpdate.busNo) return alert("Please select a bus number.");
    appState = 'SELECTION';
    
    const summaryStr = pendingUpdate.route ? `(Route ${pendingUpdate.route.num})` : `(Unassigned Location)`;
    document.getElementById('step-3-summary').innerHTML = `Select location for <span style="color:#815FD7;">Bus ${pendingUpdate.busNo}</span> ${summaryStr}`;

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

// --- Modular Firebase Sync Calls ---
document.getElementById('btn-clear-bus').onclick = () => {
    get(ref(db, 'activeBuses')).then(snapshot => {
        const val = snapshot.val();
        if(val) {
            Object.keys(val).forEach(sId => {
                if(val[sId].busNo === pendingUpdate.busNo) set(ref(db, `activeBuses/${sId}`), null);
            });
        }
    });
    get(ref(db, 'unassignedBuses')).then(snapshot => {
        const val = snapshot.val();
        if(val) {
            Object.keys(val).forEach(sId => {
                if(val[sId].busNo === pendingUpdate.busNo) set(ref(db, `unassignedBuses/${sId}`), null);
            });
        }
    });

    appState = 'VIEW';
    selFooter.classList.add('hidden'); fixedFooter.classList.remove('hidden');
    draggableSheet.style.transform = `translateY(${currentTranslate}px)`; topBar.style.transform = `translateY(0)`;
    renderMapSpots();
    alert(`Bus ${pendingUpdate.busNo} cleared.`);
};

document.getElementById('btn-submit-update').onclick = () => {
    if(!pendingUpdate.spotId) return alert("Tap a spot on the map!");
    const deviceToken = localStorage.getItem('device_token') || 'anon';

    // Direct modular database transaction update
    const updates = {};
    updates[`activeBuses/${pendingUpdate.spotId}`] = pendingUpdate.route ? {
        busNo: pendingUpdate.busNo,
        routeNum: pendingUpdate.route.num,
        name: pendingUpdate.route.name,
        users: 1,
        score: 100,
        updatedBy: deviceToken
    } : null;

    if(!pendingUpdate.route) {
        updates[`unassignedBuses/${pendingUpdate.spotId}`] = {
            busNo: pendingUpdate.busNo,
            updatedBy: deviceToken
        };
    }

    update(ref(db), updates).then(() => {
        appState = 'VIEW';
        selFooter.classList.add('hidden'); 
        fixedFooter.classList.remove('hidden');
        draggableSheet.style.transform = `translateY(${currentTranslate}px)`; 
        topBar.style.transform = `translateY(0)`;
        renderMapSpots();
        alert(`Success! Database updated in real-time.`);
    }).catch((error) => {
        alert("Sync failed. Check database rules.");
    });
};
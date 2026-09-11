import { initializeApp } from "firebase/app";
import { getDatabase, ref, update, get } from "firebase/database";

const firebaseConfig = {
    apiKey: "AIzaSyCXejNb5wgmZ6KJ3Q4r4BhBqw9KPn7iX5I",
    authDomain: "seenmybus.firebaseapp.com",
    databaseURL: "https://seenmybus-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "seenmybus"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const TOTAL_VIRTUAL_USERS = 10000;
const TEST_DURATION_MS = 60000; // Runs for 60 seconds
const SPOTS = Array.from({ length: 41 }, (_, i) => `spot-${String(i + 1).padStart(2, '0')}`);
const BUSES = Array.from({ length: 45 }, (_, i) => String(i + 1).padStart(2, '0'));
const ROUTES = [
    { num: "6", name: "Hostel" },
    { num: "3", name: "Bistupur" },
    { num: "7", name: "Mango chowk" },
    { num: "1", name: "Sakchi" },
    { num: "12", name: "Golmuri" }
];

// Generate 10,000 unique simulated student device tokens
const userTokens = Array.from({ length: TOTAL_VIRTUAL_USERS }, (_, i) => `sim_user_${i}_${Math.random().toString(36).substr(2, 6)}`);

console.log(`Starting stress test simulating ${TOTAL_VIRTUAL_USERS} users...`);

async function simulateTraffic() {
    const startTime = Date.now();
    let writeCount = 0;

    const interval = setInterval(async () => {
        if (Date.now() - startTime > TEST_DURATION_MS) {
            clearInterval(interval);
            console.log(`Test complete. Executed ${writeCount} realtime operations.`);
            process.exit(0);
        }

        // Pick a batch of random virtual users to perform an action every 500ms
        const batchSize = Math.floor(Math.random() * 25) + 15;
        for (let j = 0; j < batchSize; j++) {
            const token = userTokens[Math.floor(Math.random() * userTokens.length)];
            const isVoteAction = Math.random() < 0.70;

            if (isVoteAction) {
                await simulateVote(token);
            } else {
                await simulateBusUpdate(token);
            }
            writeCount++;
        }
        console.log(`[${new Date().toLocaleTimeString()}] Operations dispatched: ${writeCount}`);
    }, 500);
}

// Simulates a student voting 'Yes' to verify a bus slot
async function simulateVote(userToken) {
    try {
        const snap = await get(ref(db, 'activeBuses'));
        const active = snap.val();
        if (!active) return;

        const spotKeys = Object.keys(active).filter(k => k.startsWith('spot-'));
        if (spotKeys.length === 0) return;

        const randomSpot = spotKeys[Math.floor(Math.random() * spotKeys.length)];
        const busData = active[randomSpot];
        const voters = busData.votersLedger || {};

        if (!voters[userToken]) {
            voters[userToken] = true;
            await update(ref(db, `activeBuses/${randomSpot}`), {
                votersLedger: voters,
                users: Object.keys(voters).length
            });
        }
    } catch (e) {}
}

// Simulates a student reporting/updating a bus spot
async function simulateBusUpdate(userToken) {
    try {
        const randomSpot = SPOTS[Math.floor(Math.random() * SPOTS.length)];
        const randomBus = BUSES[Math.floor(Math.random() * BUSES.length)];
        const randomRoute = ROUTES[Math.floor(Math.random() * ROUTES.length)];

        const voters = {};
        voters[userToken] = true;

        await update(ref(db, `activeBuses/${randomSpot}`), {
            busNo: randomBus,
            busNos: [randomBus],
            routeNum: randomRoute.num,
            name: randomRoute.name,
            routes: [{ num: randomRoute.num, name: randomRoute.name }],
            users: 1,
            votersLedger: voters,
            updatedAt: Date.now(),
            updatedBy: userToken
        });
    } catch (e) {}
}

simulateTraffic();
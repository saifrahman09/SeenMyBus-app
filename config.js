// config.js - Single Source of Truth for SeenMyBus

export const ALL_ROUTES = [
    { num: "1", name: "Sonari" },
    { num: "2", name: "Hudco" },
    { num: "3", name: "Telco" },
    { num: "4", name: "New Baridih" },
    { num: "6", name: "Station" },
    { num: "9", name: "Chepapul (Mango)" },
    { num: "10", name: "Dimna Chowk" },
    { num: "11", name: "Hostel" }
];

// Generate bus numbers "01" to "45" dynamically
export const ALL_BUSES = Array.from({ length: 45 }, (_, i) => String(i + 1).padStart(2, '0'));

// Generate map spot IDs "spot-01" to "spot-41" dynamically
export const ALL_SPOTS = Array.from({ length: 41 }, (_, i) => `spot-${String(i + 1).padStart(2, '0')}`);
// config.js - Single Source of Truth for SeenMyBus

export const ALL_ROUTES = [
    { num: "1", name: "Sonari" },
    { num: "1", name: "Kadma" },
    { num: "2", name: "Telco (Anna Chowk)" },
    { num: "2", name: "Telco (Chandih Chowk)" },
    { num: "4", name: "New Baridih" },
    { num: "4", name: "Mercy Hospital" },
    { num: "6", name: "R.D. Tata Square (Station)" },
    { num: "6", name: "Khasmahal (Station)" },
    { num: "9", name: "Chepapul (Mango)" },
    { num: "10", name: "Dimna Chowk" },
    { num: "11", name: "Girls' Hostel (Adityapur)" },
    { num: "11", name: "Boys' Hostel (Adityapur)" },
];

// Generate bus numbers "01" to "45" dynamically
export const ALL_BUSES = Array.from({ length: 45 }, (_, i) => String(i + 1).padStart(2, '0'));

// Generate map spot IDs "spot-01" to "spot-41" dynamically
export const ALL_SPOTS = Array.from({ length: 41 }, (_, i) => `spot-${String(i + 1).padStart(2, '0')}`);
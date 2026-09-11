# 🚌 SeenMyBus

### Live, crowdsourced bus tracking for Arka Jain University students.

[![Live App](https://img.shields.io/badge/Live%20App-seenmybus.vercel.app-815fd7?style=for-the-badge)](https://seenmybus.vercel.app/)
[![Built With](https://img.shields.io/badge/Built%20With-Vanilla%20JS-F7DF1E?style=for-the-badge\&logo=javascript\&logoColor=black)](https://github.com/saifrahman09/SeenMyBus-app)

**Live Application:** https://seenmybus.vercel.app/

---

## What is SeenMyBus?

SeenMyBus is a small web app I built for students at **Arka Jain University** to make finding campus buses a little less frustrating.

After classes, one question comes up again and again:

> *“Which bus is going to my route, and where is it parked?”*

The problem is that buses can change throughout the day, parking positions are not always obvious, and the campus parking area is large enough that finding one particular bus can mean walking around, checking windshield cards, or calling a friend who might already be there.

So instead of trying to build another expensive GPS fleet-tracking system, I wanted to try something simpler:

**Let the students help each other.**

A student can report where a bus is parked, other students can verify that information, and the app gradually builds a more reliable picture of what's happening on campus.

---

## ✨ What it can do

### 🗺️ Interactive Campus Map

The app has an interactive vector map of the campus parking area.

Students can zoom in, move around the map, and check individual parking spots without dealing with a huge static image.

### 🚍 Live Bus & Departure Information

SeenMyBus shows the currently relevant bus assignments along with departure information and countdowns.

The idea is to give students the information they actually need when they're standing at the gate or leaving class.

### 👥 Community-Verified Bus Locations

Instead of pretending the app always knows where every bus is, SeenMyBus uses **crowdsourcing**.

A student can report a bus location and other students can confirm whether it is correct.

When enough students agree, the report becomes **community confirmed**.

### ⏰ Automatic Shift Handling

Bus assignments can change during the day.

SeenMyBus automatically handles shift cutoffs so old assignments don't continue appearing after they are no longer relevant.

### 📱 Installable PWA

The app works as a Progressive Web App, so it can be installed on a phone like a normal application.

It also includes offline handling and cached assets to make the experience more usable on weaker connections.

---

## 💡 Why I chose crowdsourcing instead of GPS

GPS tracking sounds like the obvious solution, but in a college environment it creates a different set of problems.

You would need hardware, maintenance, reliable installation across buses, and a system that can continuously provide accurate location data.

SeenMyBus takes a different approach:

**The students are already there.**

Someone walking through the parking area can simply report what they see. Another student can confirm it a few minutes later.

It's not intended to replace a proper fleet-management system. It's a lightweight community tool designed around the reality of a university campus.

---

## 🛠️ Tech Stack

**Frontend**

* Vanilla JavaScript (ES6 Modules)
* HTML5
* CSS3
* SVG for the interactive campus map

**Backend**

* Firebase Realtime Database
* Firebase Authentication

**Notifications**

* Firebase Cloud Messaging (FCM)
* Cloudflare Worker endpoints
* Web Push

**Hosting**

* Vercel

I intentionally kept the frontend lightweight instead of using React, Next.js, or a large UI framework.

The goal was simple:

**Open the app → get the information → move on.**

That also helps the app load reasonably well on weaker mobile networks.

---

## 🧠 Some interesting engineering problems

Building the app wasn't just about putting a map on a webpage. A few things became surprisingly challenging once multiple students started interacting with it.

### 1. Too many realtime updates

Firebase Realtime Database can push changes very quickly.

During testing, frequent updates were causing the map and timetable UI to re-render repeatedly, which resulted in noticeable lag on mobile devices.

I solved this by adding a small **250ms debounce** around the realtime listeners.

Instead of repainting the interface for every single update, changes are grouped together and rendered at a controlled rate.

---

### 2. Everyone cleaning up data at the same time

Bus shifts have specific cutoff times.

The first implementation allowed every connected client to notice the cutoff and try to clean up expired data simultaneously.

That meant potentially hundreds of students could trigger writes at almost exactly the same moment.

To avoid that, clients use a small randomized **0–15 second jitter** before performing stale-data checks.

It is a tiny change, but it prevents a predictable burst of simultaneous writes.

---

### 3. Accuracy without pretending to have perfect data

Crowdsourced information is useful, but it can obviously be wrong.

Someone can mistype a bus number, misunderstand a parking position, or simply report something incorrectly.

So the app uses a simple validation flow:

**Report → Verify → Confirm**

A new report starts as a user-submitted update.

Other students can verify it, and once enough people agree, the information becomes **community confirmed**.

Administrative overrides can also take priority when necessary.

The goal isn't to claim that the data is perfect.

The goal is to make it **more trustworthy through multiple people seeing the same thing.**

---

## 📁 Project Structure

```text
SeenMyBus-app/
│
├── index.html
├── admin-dashboard.html
├── faq.html
│
├── app.js
├── config.js
│
├── main.css
├── map.css
│
├── sw.js
├── firebase-messaging-sw.js
├── manifest.json
│
└── ArkaJainUniversityBusMap.xml
```

### A few important files

| File                       | Purpose                                                   |
| -------------------------- | --------------------------------------------------------- |
| `index.html`               | Main application                                          |
| `app.js`                   | Application logic, map interactions and database handling |
| `config.js`                | Route and parking-spot configuration                      |
| `main.css`                 | Main UI styling and animations                            |
| `map.css`                  | Parking map styling and viewport behaviour                |
| `sw.js`                    | Service worker and offline caching                        |
| `firebase-messaging-sw.js` | Background push notification handling                     |
| `admin-dashboard.html`     | Admin controls                                            |
| `faq.html`                 | Help, FAQ and usage information                           |

---

## 🚀 Running it locally

Clone the repository:

```bash
git clone https://github.com/saifrahman09/SeenMyBus-app.git
cd SeenMyBus-app
```

Because SeenMyBus uses native ES6 modules, it should be served through a local HTTP server rather than opened directly with `file://`.

For example:

```bash
npx serve .
```

Or use the **Live Server** extension in VS Code.

Then open the local URL provided by the server, usually something like:

```text
http://localhost:3000
```

---

## ⚠️ A small but important note

SeenMyBus is **crowdsourced**.

That means the information shown in the app can sometimes be inaccurate, delayed, or incomplete.

The app does **not** have continuous GPS tracking for every bus, and it does not receive official real-time updates from the university authorities.

So treat the information as a helpful indication rather than an official source.

---

## 🏫 Not affiliated with Arka Jain University

SeenMyBus is an **independent student-made project**.

It is not an official Arka Jain University application and is not affiliated with, operated by, or endorsed by the university.

The project was created independently to experiment with a practical problem faced by students on campus.

---

## ❤️ Why I built it

This started with a pretty simple thought:

**If students are already helping each other find buses, why not make that easier?**

SeenMyBus is my attempt at turning that small everyday problem into a useful piece of software.

It's still a work in progress, and there are definitely things I'd like to improve.

But seeing students actually use something I built to find their bus makes the whole project worth it.

---

## 👨‍💻 Author

**Saif Rahman**

Diploma in Computer Science & Engineering
Arka Jain University, Jamshedpur

[GitHub](https://github.com/saifrahman09)

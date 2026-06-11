// Minimal service worker for basic PWA installability (taskbar / "add to desktop").
// Does not cache /api/* (see privacy note in original triage); this SW is primarily
// to satisfy PWA criteria for registration + standalone display.
// For full offline, would add workbox or careful caching rules, but out of scope for minimal.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  self.clients.claim();
});
// No fetch handler: network-first by default (safe for local privacy app).

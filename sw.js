/* =========================================================
   PLANORA — SERVICE WORKER
   Caches the app shell (HTML/CSS/JS/fonts) so the pages
   themselves load with no connection at all. Never touches
   /api/* requests — those are handled (with their own
   offline fallback) inside api.js.
========================================================= */

const CACHE_NAME = "planora-shell-v1";

// Best-effort list. Anything that 404s here is just skipped —
// it won't stop the rest of the shell from being cached, and
// pages you add later just get picked up at runtime instead.
const PRECACHE_URLS = [
    "/",
    "/index.html",
    "/login.html",
    "/login.css",
    "/login.js",
    "/numchange.js",
    "/base.css",
    "/api.js",
    "/homepage.html",
    "/homepage.css",
    "/homepage-extra.css",
    "/homepage.js",
    "/profile.html",
    "/profile.css",
    "/profile.js",
    "/admin.html",
    "/admin.css",
    "/admin.js",
    "/fonts/Gotham.ttf",
    "/fonts/vhs-gothic.ttf",
    "/fonts/BelieveStrongerPersonalUseOnlyRegular-aYdXK.ttf",
    "/fonts/StarShieldV2-9M52K.ttf",
    "/fonts/Gothikka.ttf",
    "/icons/planora.png"
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            await Promise.all(
                PRECACHE_URLS.map((url) => cache.add(url).catch(() => {}))
            );
        })
    );
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((names) =>
            Promise.all(
                names
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => caches.delete(name))
            )
        )
    );
    self.clients.claim();
});

self.addEventListener("fetch", (event) => {
    const { request } = event;

    // Only plain same-origin GETs for the app shell. Never
    // intercept /api/* — that has its own offline handling
    // in api.js, closer to where the data actually gets used.
    if (request.method !== "GET") return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith("/api/")) return;

    event.respondWith(
        caches.match(request).then((cached) => {
            if (cached) {
                // serve the cached copy instantly, refresh it
                // quietly in the background for next time
                fetch(request)
                    .then((response) => {
                        if (response && response.ok) {
                            caches.open(CACHE_NAME).then((cache) => cache.put(request, response));
                        }
                    })
                    .catch(() => {});
                return cached;
            }

            return fetch(request).then((response) => {
                if (response && response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                }
                return response;
            });
        })
    );
});

/* =========================================================
   PLANORA — SERVICE WORKER
   Keeps the app shell (HTML/CSS/JS/fonts) available with no
   connection at all. Never touches /api/* requests — those
   are handled (with their own offline fallback) inside api.js.

   How files are served:
     - pages, CSS and JS: NETWORK FIRST. You always get the
       newest deploy when you're online; the cached copy is only
       used when the network fails.
     - fonts and icons: CACHE FIRST. They never change and are
       big, so there's no reason to re-download them.
========================================================= */

// Bump this number whenever you want every visitor's old cache thrown away.
const CACHE_NAME = "planora-shell-v2";

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
    "/mode-effects.js",
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

function saveCopy(request, response) {
    if (response && response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
    }
    return response;
}

self.addEventListener("fetch", (event) => {
    const { request } = event;

    // Only plain same-origin GETs for the app shell. Never
    // intercept /api/* — that has its own offline handling
    // in api.js, closer to where the data actually gets used.
    if (request.method !== "GET") return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith("/api/")) return;

    const isStaticAsset =
        url.pathname.startsWith("/fonts/") || url.pathname.startsWith("/icons/");

    if (isStaticAsset) {
        // cache first: fonts and icons don't change
        event.respondWith(
            caches.match(request).then((cached) => {
                return cached || fetch(request).then((response) => saveCopy(request, response));
            })
        );
        return;
    }

    // network first: always the newest deploy when online,
    // falling back to the saved copy when offline
    event.respondWith(
        fetch(request)
            .then((response) => saveCopy(request, response))
            .catch(() => caches.match(request))
    );
});

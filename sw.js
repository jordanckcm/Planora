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

const CACHE_NAME = "planora-shell-v3";

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
    "/homepage-readability-qol.css",
    "/homepage.js",
    "/mode-effects.js",
    "/planora-ui.css",
    "/planora-shell.css",
    "/planora-nav.js",
    "/settings.css",
    "/settings.js",
    "/feed.js",
    "/profile.html",
    "/profile.css",
    "/profile.js",
    "/admin.html",
    "/admin.css",
    "/admin.js",
    "/directory.html",
    "/directory.css",
    "/directory.js",
    "/fonts/Gotham.ttf",
    "/fonts/vhs-gothic.ttf",
    "/fonts/BelieveStrongerPersonalUseOnlyRegular-aYdXK.ttf",
    "/fonts/StarShieldV2-9M52K.ttf",
    "/fonts/Gothikka.ttf",
    "/icon-192.png",
    "/icon-512.png"
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

    if (request.method !== "GET") return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith("/api/")) return;

    const isStaticAsset =
        url.pathname.startsWith("/fonts/") ||
        url.pathname === "/icon-192.png" ||
        url.pathname === "/icon-512.png";

    if (isStaticAsset) {
        event.respondWith(
            caches.match(request).then((cached) => {
                return cached || fetch(request).then((response) => saveCopy(request, response));
            })
        );
        return;
    }

    event.respondWith(
        fetch(request)
            .then((response) => saveCopy(request, response))
            .catch(() => caches.match(request))
    );
});

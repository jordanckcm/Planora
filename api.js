/* =========================================================
   PLANORA — API CLIENT
   Talks to the Flask backend (app.py) instead of localStorage.
   Everyone's data now lives on the server, in plain lists.
========================================================= */

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        // best-effort — if this fails, the app just works exactly
        // like it did before, with no offline support
        navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
}


/* =========================
   THEME / MOTION BOOTSTRAP
   Applied as early as possible (see the inline <script> in each page's
   <head>, which does this same read-and-apply before any CSS paints) and
   again here, in case a page didn't get the inline snippet. Re-applied
   for real once getCurrentUser() below returns the server's copy, so a
   preference changed on another device still wins once the network
   catches up — the localStorage copy is just a same-tab head start.
========================= */

function applyThemePreference(pref) {
    const root = document.documentElement;
    if (pref === "light" || pref === "dark") {
        root.setAttribute("data-theme", pref);
    } else {
        root.removeAttribute("data-theme"); // "system" — follow prefers-color-scheme
    }
}

function applyReduceMotion(on) {
    document.documentElement.toggleAttribute("data-reduce-motion", Boolean(on));
}

(function bootstrapThemeFromCache() {
    try {
        const cached = JSON.parse(localStorage.getItem("planora_cached_me") || "null");
        if (cached) {
            applyThemePreference(cached.themePreference || "system");
            applyReduceMotion(cached.reduceMotion);
        }
    } catch (e) { /* no cache yet, or it's corrupt — fine, defaults apply */ }
})();

/* Link style for @mentions, injected here so it works on every page that
   loads api.js (homepage, profile, notifications, ...). */
(function injectMentionStyle() {
    const s = document.createElement("style");
    s.textContent = "a.mention{color:#c9a227;font-weight:600;text-decoration:none}a.mention:hover{text-decoration:underline}";
    document.head.appendChild(s);
})();


async function apiRequest(url, options = {}) {
    let response;
    try {
        response = await fetch(url, {
            method: options.method || "GET",
            headers: { "Content-Type": "application/json" },
            body: options.body ? JSON.stringify(options.body) : undefined
        });
    } catch (networkErr) {
        // fetch() itself only throws when the request never reached
        // the server at all — i.e. you're offline
        const offlineError = new Error("No connection right now.");
        offlineError.isOffline = true;
        throw offlineError;
    }

    // Read the body as text first instead of calling response.json()
    // directly. Most responses are valid JSON, but if the server ever
    // sends back something that isn't — an unhandled error slipping
    // past app.py's error handlers, a dev-server hiccup, a proxy
    // stepping in — response.json() throws a raw "Unexpected token
    // ... in JSON" straight from the browser's parser. That's cryptic
    // and, worse, surfaces even when the request itself (like a
    // delete) already succeeded server-side. Parsing it ourselves lets
    // us turn that into a message that actually explains what happened.
    const raw = await response.text();
    let data = {};
    if (raw) {
        try {
            data = JSON.parse(raw);
        } catch (parseErr) {
            throw new Error(`The server sent back something unexpected (status ${response.status}). Try again.`);
        }
    }

    if (!response.ok) {
        throw new Error(data.error || "Something went wrong.");
    }

    return data;
}


/* =========================
   ACCOUNTS / SESSIONS
========================= */

const Planora = (() => {

    function escapeHTML(str) {
        const div = document.createElement("div");
        div.textContent = str ?? "";
        return div.innerHTML;
    }

    /* Escapes text, then turns confirmed @mentions into profile links
       (HTML string version). `mentions` is the array the server sends back
       on comments/events - only those names get linked. */
    function renderMentions(text, mentions = []) {
        const safe = escapeHTML(text);
        const names = new Set((mentions || []).map(n => n.toLowerCase()));
        if (!names.size) return safe;
        return safe.replace(/(^|[^\w@.])@([A-Za-z0-9_.]{3,40})/g, (whole, lead, raw) => {
            let name = raw;
            if (!names.has(name.toLowerCase())) name = raw.replace(/\.+$/, "");
            if (!names.has(name.toLowerCase())) return whole;
            const trailing = raw.slice(name.length);
            return `${lead}<a class="mention" href="profile.html?u=${encodeURIComponent(name)}" data-profile-hover="${name}">@${name}</a>${trailing}`;
        });
    }

    /* Same idea, DOM version - the one the pages use, since they build
       everything with textContent instead of innerHTML. Appends `text`
       into `container`, linking server-confirmed @mentions. */
    function appendWithMentions(container, text, mentions = [], className = "mention") {
        text = text || "";
        const names = new Set((mentions || []).map(n => n.toLowerCase()));
        const re = /(^|[^\w@.])@([A-Za-z0-9_.]{3,40})/g;
        let last = 0, match;
        while ((match = re.exec(text))) {
            const raw = match[2];
            let name = raw;
            if (!names.has(name.toLowerCase())) name = raw.replace(/\.+$/, "");
            if (!names.has(name.toLowerCase())) continue;

            const at = match.index + match[1].length; // where the "@" is
            if (at > last) container.appendChild(document.createTextNode(text.slice(last, at)));
            const a = document.createElement("a");
            a.className = className;
            a.href = "profile.html?u=" + encodeURIComponent(name);
            a.dataset.profileHover = name;
            a.textContent = "@" + name;
            container.appendChild(a);
            last = at + 1 + name.length;
            re.lastIndex = last;
        }
        if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
    }

    function passwordStrength(password) {
        if (password.length < 8) return { ok: false, message: "At least 8 characters." };
        if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
            return { ok: false, message: "Mix letters and numbers." };
        }
        return { ok: true, message: "" };
    }

    async function signup(username, displayName, password) {
        return apiRequest("/api/signup", { method: "POST", body: { username, displayName, password } });
    }

    async function login(username, password, remember) {
        return apiRequest("/api/login", { method: "POST", body: { username, password, remember } });
    }

    async function logout() {
        const result = await apiRequest("/api/logout", { method: "POST" });
        localStorage.removeItem("planora_started");
        localStorage.removeItem("planora_cached_me");
        return result;
    }

    async function getCurrentUser() {
        try {
            const user = await apiRequest("/api/me");
            // avatarImage and bannerImage can each be ~1MB; the offline
            // identity cache doesn't need them (nothing reads them from the
            // cached copy but the name/role/etc used for the "you're
            // offline" experience), and keeping them out leaves headroom in
            // localStorage's ~5MB budget for the event cache in
            // PlanoraData.getEvents below.
            const { avatarImage, bannerImage, ...cacheable } = user;
            try { localStorage.setItem("planora_cached_me", JSON.stringify(cacheable)); } catch (e) { /* storage full/unavailable — safe to ignore */ }

            // reconcile the instant, cache-based guess from bootstrapThemeFromCache
            // above with whatever the server actually has on file — matters
            // the first time a browser sees this account, and any time the
            // preference was changed from a different device
            applyThemePreference(user.themePreference || "system");
            applyReduceMotion(user.reduceMotion);

            return user;
        } catch (err) {
            // Only fall back to the cached identity when we couldn't reach
            // the server at all. A real 401 (actually logged out) should
            // still send you to login, even if a stale cache exists.
            if (err.isOffline) {
                const cached = localStorage.getItem("planora_cached_me");
                if (cached) {
                    try { return JSON.parse(cached); } catch (e) { /* fall through */ }
                }
            }
            return null;
        }
    }

    // Call at the top of a protected page. Redirects to login if
    // there's no session, otherwise resolves with the user.
    async function requireAuth() {
        const user = await getCurrentUser();
        if (!user) {
            window.location.href = "login.html";
            return null;
        }
        return user;
    }

    async function updateProfile(updates) {
        return apiRequest("/api/me", { method: "PUT", body: updates });
    }

    // Thin wrapper around the same PUT /api/me endpoint, used by
    // settings.js for the appearance panel (theme / reduce motion) so
    // that file doesn't need to know the endpoint shape itself.
    async function updateAccountPreferences({ theme, reduceMotion } = {}) {
        const payload = {};
        if (theme !== undefined) payload.theme = theme;
        if (reduceMotion !== undefined) payload.reduceMotion = reduceMotion;
        return apiRequest("/api/me", { method: "PUT", body: payload });
    }

    // Self-service account deletion — settings.js's danger zone.
    async function deleteAccount() {
        const result = await apiRequest("/api/me", { method: "DELETE" });
        localStorage.removeItem("planora_started");
        localStorage.removeItem("planora_cached_me");
        return result;
    }

    /* Someone's public profile: their details, stats and public events.
       Yours also includes your private events. Used by profile.js. */
    async function getProfile(username) {
        return apiRequest(`/api/users/${encodeURIComponent(username)}`);
    }

    /* The discovery directory — everyone on Planora, optionally narrowed
       by a text search and/or a single interest tag. Used by
       directory.js, by the "click an interest chip" link on a
       profile (which just points here with ?interest=<tag>), and by
       the @mention autocomplete. */
    async function searchUsers({ q = "", interest = "" } = {}) {
        const params = new URLSearchParams();
        if (q) params.set("q", q);
        if (interest) params.set("interest", interest);
        return apiRequest(`/api/users?${params.toString()}`);
    }

    // Same char-count limit the server enforces (app.py's MAX_IMAGE_CHARS)
    // on the base64 string it receives - checked here too so a GIF that's
    // too big fails fast instead of round-tripping to the server first.
    // IMPORTANT: this must stay in sync with MAX_IMAGE_CHARS in app.py,
    // and with the matching check in profile.js's resizeBanner() — all
    // three should agree, or a file can pass one check and get rejected
    // by another later in the flow.
    const MAX_IMAGE_DATA_CHARS = 1400000;

    /* Shared by the profile-picture/banner pickers (profile.js) and the
       event-cover picker (homepage.js): turns a chosen file into a data
       URL ready to send to the server.

       Static images (JPEG/PNG/WebP) are shrunk to at most `maxWidth` and
       recompressed as JPEG, so uploads stay small and fast regardless of
       the source photo's size.

       A GIF is handled differently: running it through the <canvas> pipe
       above would flatten it to its first frame and throw away the
       animation, so when `allowGif` is true a GIF is read through as-is
       instead - full quality, no resizing, since there's no safe way to
       downscale an animated GIF client-side without breaking it. If it's
       over the server's size limit, this rejects with a clear message
       rather than silently truncating it. When `allowGif` is false (the
       caller decides this from the signed-in user's role), a GIF is
       rejected outright with the same message the server would give, so
       the person finds out before waiting on an upload that's just going
       to bounce. */
    function resizeImage(file, { allowGif = false, maxWidth = 900, quality = 0.75 } = {}) {
        return new Promise((resolve, reject) => {
            if (!file.type.startsWith("image/")) {
                reject(new Error("That file isn't an image."));
                return;
            }

            if (file.type === "image/gif") {
                if (!allowGif) {
                    reject(new Error("GIFs need a Community+ or Admin account."));
                    return;
                }
                const reader = new FileReader();
                reader.onerror = () => reject(new Error("Couldn't read that file."));
                reader.onload = () => {
                    if (reader.result.length > MAX_IMAGE_DATA_CHARS) {
                        reject(new Error("That GIF is too big. Try a smaller one (under ~1MB)."));
                        return;
                    }
                    resolve(reader.result);
                };
                reader.readAsDataURL(file);
                return;
            }

            const reader = new FileReader();
            reader.onerror = () => reject(new Error("Couldn't read that file."));
            reader.onload = () => {
                const img = new Image();
                img.onerror = () => reject(new Error("Couldn't open that image."));
                img.onload = () => {
                    const scale = Math.min(1, maxWidth / img.width);
                    const canvas = document.createElement("canvas");
                    canvas.width = Math.round(img.width * scale);
                    canvas.height = Math.round(img.height * scale);

                    const ctx = canvas.getContext("2d");
                    ctx.fillStyle = "#131313"; // transparent PNGs land on the page color
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

                    resolve(canvas.toDataURL("image/jpeg", quality));
                };
                img.src = reader.result;
            };
            reader.readAsDataURL(file);
        });
    }

    function canUseGif(user) {
        return Boolean(user) && (user.role === "community_plus" || user.role === "admin");
    }

    return {
        escapeHTML,
        renderMentions,
        appendWithMentions,
        passwordStrength,
        signup,
        login,
        logout,
        getCurrentUser,
        requireAuth,
        updateProfile,
        updateAccountPreferences,
        deleteAccount,
        getProfile,
        searchUsers,
        resizeImage,
        canUseGif,
        applyThemePreference,
        applyReduceMotion
    };

})();


/* =========================
   EVENTS / COMMENTS / NOTIFICATIONS
========================= */

const PlanoraData = (() => {

    async function getEvents(mode, year) {
        const cacheKey = `planora_cached_events_${mode}_${year}`;

        try {
            const events = await apiRequest(`/api/events?mode=${encodeURIComponent(mode)}&year=${encodeURIComponent(year)}`);
            if (mode === "local") {
                // leave images out of the offline copy — they're big, and
                // localStorage only holds about 5 MB for the whole site
                const withoutImages = events.map(e => ({ ...e, image: "" }));
                try { localStorage.setItem(cacheKey, JSON.stringify(withoutImages)); } catch (e) { /* storage full/unavailable — safe to ignore */ }
            }
            return events;
        } catch (err) {
            // Global still needs the server — only Near/local falls back
            // to whatever we last saw for this year.
            if (err.isOffline && mode === "local") {
                const cached = localStorage.getItem(cacheKey);
                if (cached) {
                    try {
                        const events = JSON.parse(cached);
                        events.fromCache = true; // lets the UI mention it's stale
                        return events;
                    } catch (e) { /* fall through to the throw below */ }
                }
            }
            throw err;
        }
    }

    async function addEvent(event) {
        return apiRequest("/api/events", { method: "POST", body: event });
    }

    // Edits an event's content (title, description, date/time, image,
    // icon, color). Only works on an event you own and didn't just add
    // from someone else's Global post - see the server's own docstring.
    async function editEvent(eventId, event) {
        return apiRequest(`/api/events/${eventId}`, { method: "PUT", body: event });
    }

    // Flip one of your own calendar events between "private" and "public".
    async function setEventVisibility(eventId, visibility) {
        return apiRequest(`/api/events/${eventId}/visibility`, { method: "PUT", body: { visibility } });
    }

    async function addToMyCalendar(eventId) {
        return apiRequest(`/api/events/${eventId}/add`, { method: "POST" });
    }

    async function deleteEvent(eventId) {
        return apiRequest(`/api/events/${eventId}`, { method: "DELETE" });
    }

    // Admin-only: remove an event you don't own (e.g. moderating Global).
    // Goes through apiRequest like everything else here, so it gets the
    // same offline handling and safe JSON parsing.
    async function adminDeleteEvent(eventId) {
        return apiRequest(`/api/admin/events/${eventId}`, { method: "DELETE" });
    }

    async function getComments(eventId) {
        return apiRequest(`/api/events/${eventId}/comments`);
    }

    // parentId is optional: pass a comment's id to reply to it.
    async function addComment(eventId, text, parentId = null) {
        const body = { text };
        if (parentId !== null && parentId !== undefined) body.parentId = parentId;
        return apiRequest(`/api/events/${eventId}/comments`, { method: "POST", body });
    }

    async function deleteComment(eventId, commentId) {
        return apiRequest(`/api/events/${eventId}/comments/${commentId}`, { method: "DELETE" });
    }

    async function editComment(eventId, commentId, text) {
        return apiRequest(`/api/events/${eventId}/comments/${commentId}`, { method: "PUT", body: { text } });
    }

    async function getStats() {
        return apiRequest("/api/stats");
    }

    /* ----- notifications ----- */

    // { notifications: [...], actors: { username: {...} }, unreadCount }
    async function getNotifications() {
        return apiRequest("/api/notifications");
    }

    // just the number - cheap enough for the nav to poll
    async function getUnreadCount() {
        const result = await apiRequest("/api/notifications/unread-count");
        return result.unreadCount;
    }

    async function markNotificationRead(id) {
        return apiRequest(`/api/notifications/${id}/read`, { method: "POST" });
    }

    async function markAllNotificationsRead() {
        return apiRequest("/api/notifications/read-all", { method: "POST" });
    }

    async function deleteNotification(id) {
        return apiRequest(`/api/notifications/${id}`, { method: "DELETE" });
    }

    async function clearNotifications() {
        return apiRequest("/api/notifications", { method: "DELETE" });
    }

    async function getFriends() {
        return apiRequest("/api/friends");
    }
    async function sendFriendRequest(username) {
        return apiRequest(`/api/friends/request/${encodeURIComponent(username)}`, { method: "POST" });
    }
    async function acceptFriendRequest(username) {
        return apiRequest(`/api/friends/accept/${encodeURIComponent(username)}`, { method: "POST" });
    }
    async function removeFriendship(username) {
        return apiRequest(`/api/friends/${encodeURIComponent(username)}`, { method: "DELETE" });
    }

    return {
        getEvents,
        addEvent,
        editEvent,
        setEventVisibility,
        addToMyCalendar,
        deleteEvent,
        adminDeleteEvent,
        getComments,
        addComment,
        deleteComment,
        editComment,
        getStats,
        getNotifications,
        getUnreadCount,
        markNotificationRead,
        markAllNotificationsRead,
        deleteNotification,
        clearNotifications,
        getFriends,
        sendFriendRequest,
        acceptFriendRequest,
        removeFriendship
    };

})();

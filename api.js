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
            // avatarImage and bannerImage can each be ~200KB; the offline
            // identity cache doesn't need them (nothing reads them from the
            // cached copy but the name/role/etc used for the "you're
            // offline" experience), and keeping them out leaves headroom in
            // localStorage's ~5MB budget for the event cache in
            // PlanoraData.getEvents below.
            const { avatarImage, bannerImage, ...cacheable } = user;
            try { localStorage.setItem("planora_cached_me", JSON.stringify(cacheable)); } catch (e) { /* storage full/unavailable — safe to ignore */ }
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

    /* Someone's public profile: their details, stats and public events.
       Yours also includes your private events. Used by profile.js. */
    async function getProfile(username) {
        return apiRequest(`/api/users/${encodeURIComponent(username)}`);
    }

    /* Shared by the profile-picture picker (profile.js) and the event-cover
       picker (homepage.js): shrinks a chosen image to at most `maxWidth`
       and returns a JPEG data URL, so uploads stay small and fast no
       matter what the source photo's original size was. */
    function resizeImage(file, maxWidth = 900, quality = 0.75) {
        return new Promise((resolve, reject) => {
            if (!file.type.startsWith("image/")) {
                reject(new Error("That file isn't an image."));
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

    return {
        escapeHTML,
        passwordStrength,
        signup,
        login,
        logout,
        getCurrentUser,
        requireAuth,
        updateProfile,
        getProfile,
        resizeImage
    };

})();


/* =========================
   EVENTS / COMMENTS
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

    return {
        getEvents,
        addEvent,
        setEventVisibility,
        addToMyCalendar,
        deleteEvent,
        adminDeleteEvent,
        getComments,
        addComment,
        deleteComment,
        editComment,
        getStats
    };

})();

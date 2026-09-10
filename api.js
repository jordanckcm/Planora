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
            try { localStorage.setItem("planora_cached_me", JSON.stringify(user)); } catch (e) { /* storage full/unavailable — safe to ignore */ }
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

    return {
        escapeHTML,
        passwordStrength,
        signup,
        login,
        logout,
        getCurrentUser,
        requireAuth,
        updateProfile
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
                try { localStorage.setItem(cacheKey, JSON.stringify(events)); } catch (e) { /* storage full/unavailable — safe to ignore */ }
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

    async function addComment(eventId, text) {
        return apiRequest(`/api/events/${eventId}/comments`, { method: "POST", body: { text } });
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

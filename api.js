/* =========================================================
   PLANORA — API CLIENT
   Talks to the Flask backend (app.py) instead of localStorage.
   Everyone's data now lives on the server, in plain lists.
========================================================= */

async function apiRequest(url, options = {}) {
    const response = await fetch(url, {
        method: options.method || "GET",
        headers: { "Content-Type": "application/json" },
        body: options.body ? JSON.stringify(options.body) : undefined
    });

    const data = await response.json();

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
        return apiRequest("/api/logout", { method: "POST" });
    }

    async function getCurrentUser() {
        try {
            return await apiRequest("/api/me");
        } catch (err) {
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
        return apiRequest(`/api/events?mode=${encodeURIComponent(mode)}&year=${encodeURIComponent(year)}`);
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

    async function getComments(eventId) {
        return apiRequest(`/api/events/${eventId}/comments`);
    }

    async function addComment(eventId, text) {
        return apiRequest(`/api/events/${eventId}/comments`, { method: "POST", body: { text } });
    }

    async function getStats() {
        return apiRequest("/api/stats");
    }

    return {
        getEvents,
        addEvent,
        addToMyCalendar,
        deleteEvent,
        getComments,
        addComment,
        getStats
    };

})();

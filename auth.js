/* =========================================================
   PLANORA — AUTH
   Everything here runs entirely in the browser (there is no
   server yet), so "security" means: never store passwords in
   plain text, never trust stored data enough to render it as
   raw HTML, and keep sessions separate from the account store.

   Storage layout (all in localStorage unless noted):
     planora.users        { [usernameLower]: UserRecord }
     planora.session       SessionRecord    (localStorage if "remember me", else sessionStorage)
     planora.lockouts      { [usernameLower]: LockoutRecord }
========================================================= */

const Planora = (() => {

    const USERS_KEY = "planora.users";
    const LOCKOUT_KEY = "planora.lockouts";
    const SESSION_KEY = "planora.session";

    const SESSION_LENGTH_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
    const MAX_ATTEMPTS = 5;
    const LOCKOUT_MS = 60 * 1000; // 60 seconds


    /* =========================
       LOW-LEVEL STORAGE
    ========================= */

    function readJSON(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (err) {
            return fallback;
        }
    }

    function writeJSON(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
    }


    /* =========================
       SANITIZATION
       Anything a user typed (event titles, comments, bios)
       must never be inserted as raw HTML. This is used by
       every page that renders stored text into the DOM.
    ========================= */

    function escapeHTML(str) {
        const div = document.createElement("div");
        div.textContent = str ?? "";
        return div.innerHTML;
    }


    /* =========================
       PASSWORD HASHING
       SHA-256 with a random per-user salt via the browser's
       native WebCrypto — never store or compare raw passwords.
    ========================= */

    function randomHex(byteLength) {
        const bytes = new Uint8Array(byteLength);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    }

    async function hashPassword(password, saltHex) {
        const encoder = new TextEncoder();
        const data = encoder.encode(saltHex + ":" + password);
        const digest = await crypto.subtle.digest("SHA-256", data);
        return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
    }

    function passwordStrength(password) {
        if (password.length < 8) return { ok: false, message: "At least 8 characters." };
        if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
            return { ok: false, message: "Mix letters and numbers." };
        }
        return { ok: true, message: "" };
    }


    /* =========================
       ACCOUNTS
    ========================= */

    function getUsers() {
        return readJSON(USERS_KEY, {});
    }

    function findUser(username) {
        const users = getUsers();
        return users[username.trim().toLowerCase()] || null;
    }

    function usernameTaken(username) {
        return !!findUser(username);
    }

    async function signup(username, displayName, password) {
        username = username.trim();
        displayName = displayName.trim() || username;

        if (username.length < 3) {
            throw new Error("Username needs to be at least 3 characters.");
        }
        if (!/^[a-zA-Z0-9_.]+$/.test(username)) {
            throw new Error("Usernames can only use letters, numbers, \".\" and \"_\".");
        }
        if (usernameTaken(username)) {
            throw new Error("That username is already taken.");
        }

        const strength = passwordStrength(password);
        if (!strength.ok) {
            throw new Error(strength.message);
        }

        const salt = randomHex(16);
        const hash = await hashPassword(password, salt);

        const users = getUsers();
        const key = username.toLowerCase();

        users[key] = {
            username,
            displayName,
            salt,
            hash,
            bio: "",
            avatarColor: pickAvatarColor(username),
            createdAt: Date.now()
        };

        writeJSON(USERS_KEY, users);

        return users[key];
    }

    async function login(username, password, remember) {
        const key = username.trim().toLowerCase();
        const lockouts = readJSON(LOCKOUT_KEY, {});
        const lock = lockouts[key];

        if (lock && lock.lockedUntil && Date.now() < lock.lockedUntil) {
            const secondsLeft = Math.ceil((lock.lockedUntil - Date.now()) / 1000);
            throw new Error(`Too many attempts. Try again in ${secondsLeft}s.`);
        }

        const user = findUser(username);

        if (!user) {
            registerFailedAttempt(key);
            throw new Error("Incorrect username or password.");
        }

        const hash = await hashPassword(password, user.salt);

        if (hash !== user.hash) {
            registerFailedAttempt(key);
            throw new Error("Incorrect username or password.");
        }

        // success — clear lockout history
        delete lockouts[key];
        writeJSON(LOCKOUT_KEY, lockouts);

        createSession(user.username, remember);

        return user;
    }

    function registerFailedAttempt(key) {
        const lockouts = readJSON(LOCKOUT_KEY, {});
        const record = lockouts[key] || { count: 0, lockedUntil: 0 };

        record.count += 1;

        if (record.count >= MAX_ATTEMPTS) {
            record.lockedUntil = Date.now() + LOCKOUT_MS;
            record.count = 0;
        }

        lockouts[key] = record;
        writeJSON(LOCKOUT_KEY, lockouts);
    }

    function pickAvatarColor(seed) {
        const palette = ["#c9a227", "#489c48", "#b6453f", "#4a7fc9", "#9a56c9", "#c96f2e"];
        let hash = 0;
        for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
        return palette[hash % palette.length];
    }


    /* =========================
       SESSIONS
       A session is a random token, not the password hash, and
       lives separately from the account record. "Remember me"
       decides whether it survives closing the tab.
    ========================= */

    function createSession(username, remember) {
        const session = {
            username,
            token: randomHex(24),
            expiresAt: Date.now() + SESSION_LENGTH_MS
        };

        // Clear any session in the other store first.
        localStorage.removeItem(SESSION_KEY);
        sessionStorage.removeItem(SESSION_KEY);

        const store = remember ? localStorage : sessionStorage;
        store.setItem(SESSION_KEY, JSON.stringify(session));

        return session;
    }

    function getSession() {
        const raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
        if (!raw) return null;

        try {
            const session = JSON.parse(raw);
            if (!session.expiresAt || Date.now() > session.expiresAt) {
                logout();
                return null;
            }
            return session;
        } catch (err) {
            return null;
        }
    }

    function getCurrentUser() {
        const session = getSession();
        if (!session) return null;
        return findUser(session.username);
    }

    function logout() {
        localStorage.removeItem(SESSION_KEY);
        sessionStorage.removeItem(SESSION_KEY);
    }

    /*
        Call at the top of any protected page. Redirects to
        login if there's no valid session, and returns the
        current user record otherwise.
    */
    function requireAuth() {
        const user = getCurrentUser();
        if (!user) {
            window.location.href = "login.html";
            return null;
        }
        return user;
    }

    function updateProfile(username, updates) {
        const users = getUsers();
        const key = username.trim().toLowerCase();
        if (!users[key]) throw new Error("User not found.");

        Object.assign(users[key], updates);
        writeJSON(USERS_KEY, users);

        return users[key];
    }

    return {
        escapeHTML,
        signup,
        login,
        logout,
        getSession,
        getCurrentUser,
        requireAuth,
        usernameTaken,
        passwordStrength,
        updateProfile,
        findUser
    };

})();

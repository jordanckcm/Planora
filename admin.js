/* =========================================================
   PLANORA — ADMIN PANEL
   Talks directly to the /api/admin/* routes added in app.py.
   Those routes are server-side gated to role === "admin", so
   this page redirects non-admins straight back to the
   homepage — but the real enforcement lives in app.py, not here.
========================================================= */

const ROLES = ["community", "community_plus", "admin"];

const ROLE_COLORS = {
    admin: "#c9a227",
    community_plus: "#4a7fc9",
    community: "#7a8290"
};

let allUsers = [];
let allEvents = [];
let currentUsername = "";

function toast(message, type = "") {
    const stack = document.getElementById("toastStack");
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 3200);
}

async function apiGet(url) {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
}

async function apiSend(url, method, body) {
    const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
}

/* themed replacement for window.confirm() */
function confirmDialog(message) {
    return new Promise(resolve => {
        const overlay = document.getElementById("confirmOverlay");
        const yesBtn = document.getElementById("confirmYesBtn");
        const noBtn = document.getElementById("confirmNoBtn");

        document.getElementById("confirmMessage").textContent = message;
        overlay.classList.add("open");

        function cleanup(result) {
            overlay.classList.remove("open");
            yesBtn.removeEventListener("click", onYes);
            noBtn.removeEventListener("click", onNo);
            overlay.removeEventListener("click", onOverlay);
            resolve(result);
        }
        function onYes() { cleanup(true); }
        function onNo() { cleanup(false); }
        function onOverlay(e) { if (e.target === overlay) cleanup(false); }

        yesBtn.addEventListener("click", onYes);
        noBtn.addEventListener("click", onNo);
        overlay.addEventListener("click", onOverlay);
    });
}

function cell(labelText, className) {
    const span = document.createElement("span");
    if (labelText) span.dataset.label = labelText;
    if (className) span.className = className;
    return span;
}

/* Wraps multi-part cell content (e.g. dot + text) into one group, so on
   mobile it sits as a single value next to the label instead of each
   part getting spread out by the label/value space-between rule. */
function cellGroup(className) {
    const span = document.createElement("span");
    span.className = className ? `cell-group ${className}` : "cell-group";
    return span;
}

function formatJoined(ms) {
    if (!ms) return "—";
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

(async function start() {
    const user = await Planora.requireAuth();
    if (!user) return;

    if (user.role !== "admin") {
        toast("Admins only.", "error");
        window.location.href = "homepage.html";
        return;
    }

    currentUsername = user.username;

    document.querySelector(".profile").style.background =
        `linear-gradient(135deg, ${user.avatarColor}, #111)`;

    document.getElementById("backButton").addEventListener("click", () => {
        window.location.href = "homepage.html";
    });

    document.getElementById("usersSearch").addEventListener("input", (e) => {
        renderUsers(filterUsers(allUsers, e.target.value));
    });

    document.getElementById("eventsSearch").addEventListener("input", (e) => {
        renderEvents(filterEvents(allEvents, e.target.value));
    });

    await loadUsers();
    await loadEvents();
})();


/* =========================
   STATS
========================= */

function updateStats() {
    document.getElementById("statTotalUsers").textContent = allUsers.length;
    document.getElementById("statAdmins").textContent =
        allUsers.filter(u => u.role === "admin").length;
    document.getElementById("statTotalEvents").textContent = allEvents.length;
    document.getElementById("statGlobalEvents").textContent =
        allEvents.filter(e => e.visibility === "global").length;
}


/* =========================
   USERS
========================= */

function filterUsers(users, query) {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(u =>
        u.username.toLowerCase().includes(q) ||
        u.displayName.toLowerCase().includes(q) ||
        roleLabel(u.role).toLowerCase().includes(q)
    );
}

async function loadUsers() {
    const table = document.getElementById("usersTable");
    table.querySelectorAll(".admin-row:not(.admin-row-head)").forEach(row => row.remove());

    const loadingRow = document.createElement("div");
    loadingRow.className = "admin-loading-row";
    loadingRow.textContent = "Loading users…";
    table.appendChild(loadingRow);

    try {
        allUsers = await apiGet("/api/admin/users");
    } catch (err) {
        toast(err.message, "error");
        allUsers = [];
    }

    updateStats();
    renderUsers(filterUsers(allUsers, document.getElementById("usersSearch").value));
}

function renderUsers(users) {
    const table = document.getElementById("usersTable");
    table.querySelectorAll(".admin-row:not(.admin-row-head)").forEach(row => row.remove());

    if (users.length === 0) {
        const empty = document.createElement("div");
        empty.className = "admin-empty-row";
        empty.textContent = allUsers.length === 0 ? "No users yet." : "No users match your search.";
        table.appendChild(empty);
        return;
    }

    users.forEach(user => {
        const row = document.createElement("div");
        row.className = "admin-row";

        const idCell = cell("User");
        const idGroup = cellGroup("user-id-cell");
        const dot = document.createElement("span");
        dot.className = "avatar-dot";
        dot.style.background = user.avatarColor || "#555";
        const nameSpan = document.createElement("span");
        nameSpan.textContent = "@" + user.username;
        idGroup.appendChild(dot);
        idGroup.appendChild(nameSpan);
        idCell.appendChild(idGroup);

        const nameCell = cell("Display name");
        nameCell.textContent = user.displayName;

        const roleCell = cell("Role");
        const roleGroup = cellGroup("role-cell");
        const roleDot = document.createElement("span");
        roleDot.className = "role-dot";
        roleDot.style.background = ROLE_COLORS[user.role] || ROLE_COLORS.community;

        const select = document.createElement("select");
        select.className = "role-select";
        ROLES.forEach(role => {
            const opt = document.createElement("option");
            opt.value = role;
            opt.textContent = roleLabel(role);
            if (role === user.role) opt.selected = true;
            select.appendChild(opt);
        });
        select.addEventListener("change", async () => {
            try {
                await apiSend(`/api/admin/users/${user.username}/role`, "PUT", { role: select.value });
                user.role = select.value;
                roleDot.style.background = ROLE_COLORS[user.role] || ROLE_COLORS.community;
                toast(`${user.username} is now ${roleLabel(select.value)}.`, "success");
                updateStats();
            } catch (err) {
                toast(err.message, "error");
                select.value = user.role; // revert on failure
            }
        });
        roleGroup.appendChild(roleDot);
        roleGroup.appendChild(select);
        roleCell.appendChild(roleGroup);

        const joinedCell = cell("Joined");
        joinedCell.textContent = formatJoined(user.createdAt);

        const actionCell = cell();
        if (user.username.toLowerCase() !== currentUsername.toLowerCase()) {
            const deleteBtn = document.createElement("button");
            deleteBtn.className = "admin-danger-btn";
            deleteBtn.textContent = "Delete";
            deleteBtn.addEventListener("click", async () => {
                const ok = await confirmDialog(`Delete @${user.username}? This also removes their events and comments.`);
                if (!ok) return;
                try {
                    await apiSend(`/api/admin/users/${user.username}`, "DELETE");
                    toast(`@${user.username} deleted.`);
                    allUsers = allUsers.filter(u => u.username !== user.username);
                    renderUsers(filterUsers(allUsers, document.getElementById("usersSearch").value));
                    updateStats();
                    await loadEvents(); // their events are gone too
                } catch (err) {
                    toast(err.message, "error");
                }
            });
            actionCell.appendChild(deleteBtn);
        }

        row.appendChild(idCell);
        row.appendChild(nameCell);
        row.appendChild(roleCell);
        row.appendChild(joinedCell);
        row.appendChild(actionCell);
        table.appendChild(row);
    });
}

function roleLabel(role) {
    if (role === "admin") return "Admin";
    if (role === "community_plus") return "Community+";
    return "Community";
}


/* =========================
   EVENTS
========================= */

function filterEvents(events, query) {
    const q = query.trim().toLowerCase();
    if (!q) return events;
    return events.filter(e =>
        e.title.toLowerCase().includes(q) ||
        e.owner.toLowerCase().includes(q) ||
        e.visibility.toLowerCase().includes(q)
    );
}

async function loadEvents() {
    const table = document.getElementById("eventsTable");
    table.querySelectorAll(".admin-row:not(.admin-row-head)").forEach(row => row.remove());

    const loadingRow = document.createElement("div");
    loadingRow.className = "admin-loading-row";
    loadingRow.textContent = "Loading events…";
    table.appendChild(loadingRow);

    try {
        allEvents = await apiGet("/api/admin/events");
    } catch (err) {
        toast(err.message, "error");
        allEvents = [];
    }

    allEvents.sort((a, b) => new Date(a.date) - new Date(b.date));

    updateStats();
    renderEvents(filterEvents(allEvents, document.getElementById("eventsSearch").value));
}

function renderEvents(events) {
    const table = document.getElementById("eventsTable");
    table.querySelectorAll(".admin-row:not(.admin-row-head)").forEach(row => row.remove());

    if (events.length === 0) {
        const empty = document.createElement("div");
        empty.className = "admin-empty-row";
        empty.textContent = allEvents.length === 0 ? "No events yet." : "No events match your search.";
        table.appendChild(empty);
        return;
    }

    events.forEach(event => {
        const row = document.createElement("div");
        row.className = "admin-row";

        const titleCell = cell("Title");
        const titleGroup = cellGroup("event-title-cell");
        const colorMark = document.createElement("span");
        colorMark.className = "event-color-mark";
        colorMark.style.background = event.color || "#555";
        const titleText = document.createElement("span");
        titleText.className = "event-title-text";
        titleText.textContent = `${event.icon ? event.icon + " " : ""}${event.title}`;
        titleGroup.appendChild(colorMark);
        titleGroup.appendChild(titleText);
        titleCell.appendChild(titleGroup);

        const ownerCell = cell("Owner");
        ownerCell.textContent = "@" + event.owner;

        const dateCell = cell("Date");
        dateCell.textContent = event.date;

        const visCell = cell("Visibility");
        const badge = document.createElement("span");
        badge.className = event.visibility === "global" ? "badge badge-global" : "badge badge-local";
        badge.textContent = event.visibility === "global" ? "Global" : "Local";
        visCell.appendChild(badge);

        const actionCell = cell();
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "admin-danger-btn";
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", async () => {
            const ok = await confirmDialog(`Delete "${event.title}"?`);
            if (!ok) return;
            try {
                await apiSend(`/api/admin/events/${event.id}`, "DELETE");
                toast("Event deleted.");
                allEvents = allEvents.filter(e => e.id !== event.id);
                renderEvents(filterEvents(allEvents, document.getElementById("eventsSearch").value));
                updateStats();
            } catch (err) {
                toast(err.message, "error");
            }
        });
        actionCell.appendChild(deleteBtn);

        row.appendChild(titleCell);
        row.appendChild(ownerCell);
        row.appendChild(dateCell);
        row.appendChild(visCell);
        row.appendChild(actionCell);
        table.appendChild(row);
    });
}

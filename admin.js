/* =========================================================
   PLANORA — ADMIN PANEL
   Talks directly to the /api/admin/* routes added in app.py.
   Those routes are server-side gated to role === "admin", so
   this page redirects non-admins straight back to the
   homepage — but the real enforcement lives in app.py, not here.
========================================================= */

const ROLES = ["community", "community_plus", "admin"];

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

(async function start() {
    const currentUser = await Planora.requireAuth();
    if (!currentUser) return;

    if (currentUser.role !== "admin") {
        toast("Admins only.", "error");
        window.location.href = "homepage.html";
        return;
    }

    document.querySelector(".profile").style.background =
        `linear-gradient(135deg, ${currentUser.avatarColor}, #111)`;

    document.getElementById("backButton").addEventListener("click", () => {
        window.location.href = "homepage.html";
    });

    await loadUsers(currentUser.username);
    await loadEvents();
})();


/* =========================
   USERS
========================= */

async function loadUsers(currentUsername) {
    const table = document.getElementById("usersTable");

    // clear everything except the header row
    table.querySelectorAll(".admin-row:not(.admin-row-head)").forEach(row => row.remove());

    let users;
    try {
        users = await apiGet("/api/admin/users");
    } catch (err) {
        toast(err.message, "error");
        return;
    }

    users.forEach(user => {
        const row = document.createElement("div");
        row.className = "admin-row";

        const usernameCell = document.createElement("span");
        usernameCell.textContent = "@" + user.username;

        const nameCell = document.createElement("span");
        nameCell.textContent = user.displayName;

        const roleCell = document.createElement("span");
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
                toast(`${user.username} is now ${roleLabel(select.value)}.`, "success");
            } catch (err) {
                toast(err.message, "error");
                select.value = user.role; // revert on failure
            }
        });
        roleCell.appendChild(select);

        const actionCell = document.createElement("span");
        if (user.username.toLowerCase() !== currentUsername.toLowerCase()) {
            const deleteBtn = document.createElement("button");
            deleteBtn.className = "admin-danger-btn";
            deleteBtn.textContent = "Delete";
            deleteBtn.addEventListener("click", async () => {
                if (!confirm(`Delete @${user.username}? This also removes their events and comments.`)) return;
                try {
                    await apiSend(`/api/admin/users/${user.username}`, "DELETE");
                    toast(`@${user.username} deleted.`);
                    row.remove();
                    await loadEvents(); // their events are gone too
                } catch (err) {
                    toast(err.message, "error");
                }
            });
            actionCell.appendChild(deleteBtn);
        }

        row.appendChild(usernameCell);
        row.appendChild(nameCell);
        row.appendChild(roleCell);
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

async function loadEvents() {
    const table = document.getElementById("eventsTable");
    table.querySelectorAll(".admin-row:not(.admin-row-head)").forEach(row => row.remove());

    let events;
    try {
        events = await apiGet("/api/admin/events");
    } catch (err) {
        toast(err.message, "error");
        return;
    }

    events
        .sort((a, b) => new Date(a.date) - new Date(b.date))
        .forEach(event => {
            const row = document.createElement("div");
            row.className = "admin-row";

            const titleCell = document.createElement("span");
            titleCell.textContent = event.title;

            const ownerCell = document.createElement("span");
            ownerCell.textContent = "@" + event.owner;

            const dateCell = document.createElement("span");
            dateCell.textContent = event.date;

            const visCell = document.createElement("span");
            visCell.textContent = event.visibility === "global" ? "Global" : "Local";

            const actionCell = document.createElement("span");
            const deleteBtn = document.createElement("button");
            deleteBtn.className = "admin-danger-btn";
            deleteBtn.textContent = "Delete";
            deleteBtn.addEventListener("click", async () => {
                if (!confirm(`Delete "${event.title}"?`)) return;
                try {
                    await apiSend(`/api/admin/events/${event.id}`, "DELETE");
                    toast("Event deleted.");
                    row.remove();
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
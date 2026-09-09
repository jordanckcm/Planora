/* =========================================================
   PLANORA — PROFILE PAGE
========================================================= */

let user = null;

const AVATAR_COLORS = ["#c9a227", "#489c48", "#b6453f", "#4a7fc9", "#9a56c9", "#c96f2e"];

(async function start() {
    user = await Planora.requireAuth();
    if (!user) return;

    await render();
    bindActions();
})();

function toast(message, type = "") {
    const stack = document.getElementById("toastStack");
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 3200);
}

async function render() {
    document.getElementById("avatarBig").style.background =
        `linear-gradient(135deg, ${user.avatarColor}, #1b1b1b)`;

    document.getElementById("displayNameView").textContent = user.displayName;
    document.getElementById("usernameView").textContent = "@" + user.username;

    document.getElementById("displayNameInput").value = user.displayName;
    document.getElementById("bioInput").value = user.bio || "";

    try {
        const stats = await PlanoraData.getStats();
        document.getElementById("statEvents").textContent = stats.events;
        document.getElementById("statComments").textContent = stats.comments;
    } catch (err) {
        // stats are a nice-to-have, don't block the rest of the page if they fail
    }

    const since = new Date(user.createdAt);
    document.getElementById("statSince").textContent =
        since.toLocaleDateString(undefined, { month: "short", year: "numeric" });

    const colorRow = document.getElementById("colorRow");
    colorRow.innerHTML = "";

    AVATAR_COLORS.forEach(color => {
        const dot = document.createElement("button");
        dot.className = "color-dot" + (color === user.avatarColor ? " selected" : "");
        dot.style.background = color;
        dot.addEventListener("click", async () => {
            user = await Planora.updateProfile({ avatarColor: color });
            render();
        });
        colorRow.appendChild(dot);
    });
}

function bindActions() {

    document.getElementById("backButton").addEventListener("click", () => {
        window.location.href = "homepage.html";
    });

    document.getElementById("logoutButton").addEventListener("click", doLogout);
    document.getElementById("logoutButtonSecondary").addEventListener("click", doLogout);

    async function doLogout() {
        await Planora.logout();
        window.location.href = "login.html";
    }

    document.getElementById("saveProfile").addEventListener("click", async () => {
        const displayName = document.getElementById("displayNameInput").value.trim();
        const bio = document.getElementById("bioInput").value.trim();

        if (!displayName) {
            toast("Display name can't be empty.", "error");
            return;
        }

        try {
            user = await Planora.updateProfile({ displayName, bio });
            await render();

            const note = document.getElementById("saveNote");
            note.textContent = "Saved.";
            setTimeout(() => { note.textContent = ""; }, 2000);
        } catch (err) {
            toast(err.message, "error");
        }
    });
}

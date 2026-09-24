/* PLANORA — FRIENDS PAGE
   Three lists: Friends, Requests (incoming — accept/decline), Sent
   (outgoing — cancel). Reads/writes go through PlanoraData.*Friend*,
   which just wrap the /api/friends endpoints. */

(async function () {
    const user = await Planora.requireAuth();
    if (!user) return;

    const listEl = document.getElementById("frList");
    const emptyEl = document.getElementById("frEmpty");
    const errorEl = document.getElementById("frError");
    const incomingCountEl = document.getElementById("frIncomingCount");
    const state = { friends: [], incoming: [], outgoing: [], tab: "friends" };

    const EMPTY_TEXT = {
        friends: "No friends yet. Visit someone's profile to send a request.",
        incoming: "No pending requests.",
        outgoing: "You haven't sent any requests."
    };

    function showError(message) {
        errorEl.textContent = message;
        errorEl.hidden = false;
    }

    function safeImage(value) {
        return /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value || "") ? value : "";
    }

    function buildAvatar(person) {
        const el = document.createElement("a");
        el.className = "fr-avatar";
        el.href = "profile.html?u=" + encodeURIComponent(person.username);
        const img = safeImage(person.avatarImage);
        if (img) {
            const pos = person.avatarPosition || { x: 50, y: 50 };
            el.style.background = `${pos.x}% ${pos.y}% / cover no-repeat url("${img}")`;
        } else {
            el.style.background = `linear-gradient(135deg, ${person.avatarColor || "#c9a227"}, #1b1b1b)`;
            el.textContent = (person.displayName || person.username).charAt(0).toUpperCase();
        }
        return el;
    }

    function buildRow(person) {
        const row = document.createElement("div");
        row.className = "fr-row";

        const body = document.createElement("div");
        body.className = "fr-body";

        const name = document.createElement("a");
        name.className = "fr-name";
        name.href = "profile.html?u=" + encodeURIComponent(person.username);
        name.textContent = person.displayName || person.username;

        const handle = document.createElement("div");
        handle.className = "fr-handle";
        handle.textContent = "@" + person.username;

        body.append(name, handle);

        const actions = document.createElement("div");
        actions.className = "fr-actions";

        if (state.tab === "friends") {
            const removeBtn = document.createElement("button");
            removeBtn.type = "button";
            removeBtn.className = "danger";
            removeBtn.textContent = "Unfriend";
            removeBtn.addEventListener("click", () => act(removeBtn, person, "remove"));
            actions.append(removeBtn);
        } else if (state.tab === "incoming") {
            const acceptBtn = document.createElement("button");
            acceptBtn.type = "button";
            acceptBtn.className = "primary";
            acceptBtn.textContent = "Accept";
            acceptBtn.addEventListener("click", () => act(acceptBtn, person, "accept"));

            const declineBtn = document.createElement("button");
            declineBtn.type = "button";
            declineBtn.textContent = "Decline";
            declineBtn.addEventListener("click", () => act(declineBtn, person, "remove"));

            actions.append(acceptBtn, declineBtn);
        } else {
            const cancelBtn = document.createElement("button");
            cancelBtn.type = "button";
            cancelBtn.textContent = "Cancel";
            cancelBtn.addEventListener("click", () => act(cancelBtn, person, "remove"));
            actions.append(cancelBtn);
        }

        row.append(buildAvatar(person), body, actions);
        return row;
    }

    async function act(button, person, kind) {
        const row = button.closest(".fr-row");
        row.querySelectorAll("button").forEach((b) => (b.disabled = true));
        try {
            if (kind === "accept") {
                await PlanoraData.acceptFriendRequest(person.username);
            } else {
                await PlanoraData.removeFriendship(person.username);
            }
            await load();
        } catch (err) {
            showError(err.message);
            row.querySelectorAll("button").forEach((b) => (b.disabled = false));
        }
    }

    function currentList() {
        return state[state.tab] || [];
    }

    function render() {
        errorEl.hidden = true;
        const items = currentList();
        listEl.replaceChildren(...items.map(buildRow));
        emptyEl.textContent = EMPTY_TEXT[state.tab];
        emptyEl.hidden = items.length > 0;
        incomingCountEl.textContent = state.incoming.length > 0 ? `(${state.incoming.length})` : "";
    }

    async function load() {
        try {
            const data = await PlanoraData.getFriends();
            state.friends = data.friends;
            state.incoming = data.incoming;
            state.outgoing = data.outgoing;
            render();
        } catch (err) {
            listEl.replaceChildren();
            emptyEl.hidden = true;
            showError(err.message);
        }
    }

    document.getElementById("frTabs").addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-tab]");
        if (!btn) return;
        state.tab = btn.dataset.tab;
        document.querySelectorAll("#frTabs button").forEach((b) => b.classList.toggle("on", b === btn));
        render();
    });

    document.getElementById("frBack").addEventListener("click", () => {
        window.location.href = "homepage.html";
    });

    await load();
    setInterval(() => { if (!document.hidden) load(); }, 30000);
})();

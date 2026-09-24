/* PLANORA — NOTIFICATIONS PAGE
   Loads after api.js and planora-nav.js. Lists your notifications
   (mentions, replies, comments on your events), with All / Unread /
   Mentions filters, mark-all-read, dismiss, and clear-all.
   Tapping one marks it read and opens the post on the homepage
   (feed.js handles ?post=ID&comment=ID). */

(async function () {
    const user = await Planora.requireAuth();
    if (!user) return;

    const listEl = document.getElementById("ntList");
    const emptyEl = document.getElementById("ntEmpty");
    const errorEl = document.getElementById("ntError");
    const state = { items: [], actors: {}, filter: "all" };

    const EMPTY_TEXT = {
        all: "You're all caught up.",
        unread: "No unread notifications.",
        mention: "Nobody has mentioned you yet."
    };

    function showError(message) {
        errorEl.textContent = message;
        errorEl.hidden = false;
    }

    function verb(n) {
        if (n.type === "friend_request") return "sent you a friend request";
        if (n.type === "friend_accept") return "accepted your friend request";
        if (n.type === "mention") return n.commentId ? "mentioned you in a comment on" : "mentioned you in the description of";
        if (n.type === "reply") return "replied to your comment on";
        return "commented on your event";
    }

    function timeAgo(ms) {
        const s = Math.floor((Date.now() - ms) / 1000);
        if (s < 60) return "just now";
        const m = Math.floor(s / 60); if (m < 60) return m + "m ago";
        const h = Math.floor(m / 60); if (h < 24) return h + "h ago";
        const d = Math.floor(h / 24); if (d < 7) return d + "d ago";
        return new Date(ms).toLocaleDateString();
    }

    function buildAvatar(username) {
        const actor = state.actors[username] || {};
        const el = document.createElement("span");
        el.className = "nt-avatar";
        const name = actor.displayName || username;
        const safeImg = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(actor.avatarImage || "");
        if (safeImg) {
            const pos = actor.avatarPosition || { x: 50, y: 50 };
            el.style.background = `${pos.x}% ${pos.y}% / cover no-repeat url("${actor.avatarImage}")`;
        } else {
            el.style.background = `linear-gradient(135deg, ${actor.avatarColor || "#c9a227"}, #1b1b1b)`;
            el.textContent = name.charAt(0).toUpperCase();
        }
        return el;
    }

    function buildRow(n) {
        const actor = state.actors[n.actor] || {};
        const row = document.createElement("div");
        row.className = "nt-row" + (n.read ? "" : " unread");
        row.tabIndex = 0;
        row.setAttribute("role", "link");

        const body = document.createElement("div");
        body.className = "nt-body";

        const line = document.createElement("div");
        line.className = "nt-line";
        const who = document.createElement("strong");
        who.textContent = actor.displayName || n.actor;

        if (n.type === "friend_request" || n.type === "friend_accept") {
            line.append(who, " " + verb(n));
        } else {
            const title = document.createElement("em");
            title.textContent = n.type === "comment" ? ": " + (n.eventTitle || "") : " " + (n.eventTitle || "an event");
            line.append(who, " " + verb(n), title);
        }

        const time = document.createElement("div");
        time.className = "nt-time";
        time.textContent = timeAgo(n.createdAt);

        body.append(line);
        if (n.text) {
            const snippet = document.createElement("div");
            snippet.className = "nt-snippet";
            snippet.textContent = n.text;
            body.append(snippet);
        }
        body.append(time);

        const x = document.createElement("button");
        x.className = "nt-x";
        x.type = "button";
        x.setAttribute("aria-label", "Dismiss");
        x.textContent = "×";
        x.addEventListener("click", (e) => { e.stopPropagation(); dismiss(n); });

        row.append(buildAvatar(n.actor), body, x);
        row.addEventListener("click", () => open(n));
        row.addEventListener("keydown", (e) => { if (e.key === "Enter") open(n); });
        return row;
    }

    function render() {
        errorEl.hidden = true;
        const shown = state.items.filter((n) =>
            state.filter === "unread" ? !n.read : state.filter === "mention" ? n.type === "mention" : true);
        listEl.replaceChildren(...shown.map(buildRow));
        emptyEl.textContent = EMPTY_TEXT[state.filter];
        emptyEl.hidden = shown.length > 0;
    }

    function syncBadge(count) {
        if (window.PlanoraNav) PlanoraNav.setUnread(count);
    }

    async function load() {
        try {
            const data = await PlanoraData.getNotifications();
            state.items = data.notifications;
            state.actors = data.actors;
            render();
            syncBadge(data.unreadCount);
        } catch (err) {
            listEl.replaceChildren();
            emptyEl.hidden = true;
            showError(err.message);
        }
    }

    async function open(n) {
        if (!n.read) { try { await PlanoraData.markNotificationRead(n.id); } catch (e) { /* still navigate */ } }

        if (n.type === "friend_request" || n.type === "friend_accept") {
            location.href = "profile.html?u=" + encodeURIComponent(n.actor);
            return;
        }

        const p = new URLSearchParams({ post: n.eventId });
        if (n.commentId) p.set("comment", n.commentId);
        location.href = "homepage.html?" + p.toString();
    }

    async function dismiss(n) {
        try {
            const res = await PlanoraData.deleteNotification(n.id);
            state.items = state.items.filter((x) => x.id !== n.id);
            render();
            syncBadge(res.unreadCount);
        } catch (err) { showError(err.message); }
    }

    document.getElementById("ntMarkAll").addEventListener("click", async () => {
        try {
            await PlanoraData.markAllNotificationsRead();
            state.items.forEach((n) => { n.read = true; });
            render();
            syncBadge(0);
        } catch (err) { showError(err.message); }
    });

    document.getElementById("ntClear").addEventListener("click", async () => {
        if (!state.items.length || !confirm("Clear all notifications?")) return;
        try {
            await PlanoraData.clearNotifications();
            state.items = [];
            render();
            syncBadge(0);
        } catch (err) { showError(err.message); }
    });

    document.getElementById("ntTabs").addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-filter]");
        if (!btn) return;
        state.filter = btn.dataset.filter;
        document.querySelectorAll("#ntTabs button").forEach((b) => b.classList.toggle("on", b === btn));
        render();
    });

    await load();
    setInterval(() => { if (!document.hidden) load(); }, 30000);
})();

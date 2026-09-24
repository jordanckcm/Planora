/* PLANORA — LIVE WIRING
   Load LAST on every page:
     <script src="api.js"></script> ... <script src="push.js"></script>
     <script src="sound.js"></script>
     <script src="live.js"></script>
     <script src="planora-nav.js"></script>
     <script src="feed.js"></script>                  (homepage only)
     <script src="planora-live-wire.js"></script>

   Homepage: new posts / comments / profile changes show up by themselves, a
   "↑ New updates" pill appears instead of jumping the page when you're scrolled
   down or typing, and a "You're all caught up · Refresh" footer sits at the bottom.
   Other pages: the notification badge updates live.
   Everywhere: a "Turn on notifications" item appears in the burger menu (until on).

   It never wipes something you're typing: a comment box with text in it is left alone. */
(function () {
    // Planora / PlanoraData are top-level consts in api.js (not window properties), so test them with typeof
    if (!window.PlanoraLive || typeof Planora === "undefined") return;

    const onHome = Boolean(document.getElementById("timelineContainer"));
    const hooks = window.PlanoraFeedHooks || null;   // exposed by feed.js
    let dirty = false;                               // feed changed while a post was open

    /* ---------- little helpers ---------- */

    function setUnread(n) {
        if (window.PlanoraNav) PlanoraNav.setUnread(n);
    }

    function refreshView() {
        // feed.js wraps render(): it reloads the feed, or the Local/Global/Timeline view
        if (typeof window.render === "function") return window.render();
    }

    function modalOpen() {
        return Boolean(hooks && hooks.modal);
    }

    // true while a refresh would throw away something the person is doing
    function busy() {
        if (document.querySelector(".event-form.show, .confirm-overlay, .settings-overlay.show")) return true;
        return Array.from(document.querySelectorAll(
            ".comment-input, .comment-edit-input, .post-composer input, .pd-composer input"
        )).some((field) => field.value.trim() !== "");
    }

    // reload one comment area, unless its box has half-typed text in it
    async function reloadIfIdle(container, reload) {
        if (!container || !container.isConnected) return;
        const input = container.querySelector("input, textarea");
        if (input && input.value.trim()) return;
        const hadFocus = input && document.activeElement === input;
        await reload();
        if (hadFocus) {
            const next = container.querySelector("input, textarea");
            if (next) next.focus();
        }
    }

    // keep the "Comments (n)" number honest on posts whose comment panel is closed
    async function refreshCounts(ids) {
        if (!document.body.classList.contains("feed-on")) return;
        for (const id of ids) {
            if (id === null || (hooks && hooks.panels.has(id))) continue;
            const post = document.querySelector(`.post[data-post-id="${id}"]`);
            const button = post && Array.from(post.querySelectorAll(".post-btn"))
                .find((b) => b.textContent.startsWith("Comments ("));
            if (!button) continue;
            try {
                const list = await PlanoraData.getComments(id);
                button.textContent = `Comments (${list.length})`;
            } catch (e) { /* leave it */ }
        }
    }

    /* ---------- what to do when something changes ---------- */

    function onEvents() {
        // a post is open: refresh when it's closed instead of pulling the page out from under them
        if (modalOpen()) { dirty = true; return; }
        refreshView();
    }

    function onComments(ids) {
        const any = ids.includes(null);

        if (hooks && hooks.modal && (any || ids.includes(hooks.modal.id))) {
            reloadIfIdle(hooks.modal.composer, hooks.modal.reload);
        }
        if (hooks) {
            hooks.panels.forEach((entry, id) => {
                if (any || ids.includes(id)) reloadIfIdle(entry.panel, entry.reload);
            });
        }

        refreshCounts(ids);

        // Global month view: comments live inside the cards, so redraw if one of them changed
        const inGlobalMonths = document.body.classList.contains("mode-global")
            && !document.body.classList.contains("feed-on");
        if (inGlobalMonths && !busy() && !modalOpen()
            && ids.some((id) => id === null || document.querySelector(`.event[data-event-id="${id}"]`))) {
            refreshView();
        }
    }

    function onProfiles() {
        // avatars/names changed somewhere: only redraw when it can't disturb anything
        if (!busy() && !modalOpen() && window.scrollY < 200) refreshView();
    }

    /* ---------- "Turn on notifications" in the burger menu ---------- */

    function addPushMenuItem() {
        if (!window.PlanoraPush || !PlanoraPush.supported) return;

        PlanoraPush.status().then((state) => {
            if (state !== "off" && state !== "needs-install") return; // already on, or blocked/unsupported

            const drawer = document.querySelector(".pl-drawer");
            const logout = drawer && drawer.querySelector('[data-key="logout"]');
            if (!logout || drawer.querySelector('[data-key="push"]')) return;

            const item = document.createElement("button");
            item.type = "button";
            item.className = "pl-item";
            item.dataset.key = "push";
            item.textContent = "Turn on notifications";
            // sits just above the divider that precedes "Log out"
            drawer.insertBefore(item, logout.previousElementSibling);

            item.addEventListener("click", async () => {
                item.disabled = true;
                item.textContent = "Turning on…";
                let result;
                try { result = await PlanoraPush.enable(); }
                catch (e) { result = { ok: false, reason: "error" }; }

                if (result.ok) {
                    item.textContent = "Notifications on ✓";
                    setTimeout(() => item.remove(), 2500);
                    return;
                }
                item.disabled = false;
                item.textContent =
                    result.reason === "needs-install" ? "First: Share → Add to Home Screen"
                    : result.reason === "denied" ? "Blocked — allow it in browser settings"
                    : "Couldn't turn on — tap to retry";
            });
        });
    }

    /* ---------- start, once we know who's signed in ---------- */

    Planora.getCurrentUser().then((user) => {
        if (!user) return;

        if (window.PlanoraPush) PlanoraPush.sync();   // the server forgets devices on every deploy
        addPushMenuItem();

        if (!onHome) {
            PlanoraLive.start({ onNotifications: setUnread });
            return;
        }

        // when a post that was open closes, catch up on whatever changed meanwhile
        if (hooks) {
            hooks.onModalClose = () => {
                if (dirty) {
                    dirty = false;
                    if (!busy()) refreshView();
                }
            };
        }

        // the "You're all caught up · Refresh" footer, at the very bottom of every view
        const footerHost = document.createElement("div");
        footerHost.id = "liveFooter";
        const toastStack = document.getElementById("toastStack");
        document.body.insertBefore(footerHost, toastStack);
        PlanoraLive.endOfFeed(footerHost, { refresh: () => refreshView() });

        PlanoraLive.start({
            onEvents,
            onComments,
            onProfiles,
            onNotifications: setUnread,
            isBusy: busy,
            pillText: "↑ New updates",
        });
    });
})();

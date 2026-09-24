/* PLANORA — SHARED NAV
   Burger on the left, PLANORA on the right. Include on any page AFTER api.js.
   On the homepage, Local/Global/Timeline/Home switch views in place (via feed.js);
   everywhere else they link to homepage.html?view=...
   Also shows an unread-notifications badge on the Notifications item
   (and a dot on the burger while the menu is closed). */

(function () {
    // Load the shared stylesheet from the same folder as this script, so one
    // <script> tag is enough on any page (profile, directory, admin, ...).
    // ---- Loading cover -------------------------------------------------
    // Covers the page while it's still unstyled / fetching, so nothing
    // half-built (like the raw menu) ever flashes on screen. It self-styles
    // with its own <style> so it works even before planora-shell.css arrives.
    let cssReady = false;
    let pageLoaded = document.readyState === "complete";
    let inflight = 0;
    let lastActivity = Date.now();

    const realFetch = window.fetch.bind(window);
    window.fetch = function () {
        inflight++;
        lastActivity = Date.now();
        return realFetch.apply(null, arguments).finally(() => {
            inflight--;
            lastActivity = Date.now();
        });
    };
    window.addEventListener("load", () => { pageLoaded = true; });

    const loaderStyle = document.createElement("style");
    loaderStyle.textContent =
        "#plLoader{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;" +
        "background:#131313;opacity:1;transition:opacity .2s ease}" +
        "#plLoader.off{opacity:0;pointer-events:none}" +
        "#plLoader i{width:34px;height:34px;border-radius:50%;border:3px solid rgba(255,255,255,.15);" +
        "border-top-color:#fff;animation:plSpin .7s linear infinite}" +
        "@keyframes plSpin{to{transform:rotate(360deg)}}" +
        "@media(prefers-reduced-motion:reduce){#plLoader i{animation-duration:2s}}";
    document.head.appendChild(loaderStyle);

    const loader = document.createElement("div");
    loader.id = "plLoader";
    loader.setAttribute("role", "status");
    loader.setAttribute("aria-label", "Loading");
    loader.innerHTML = "<i></i>";
    document.body.appendChild(loader);

    function showLoader() { loader.classList.remove("off"); }
    function hideLoader() { loader.classList.add("off"); }

    // Resolves once styles are in, the page has loaded and requests have been
    // quiet for a moment (or after 6s, so it can never get stuck).
    function settle(minMs) {
        const started = Date.now();
        return new Promise((resolve) => {
            (function check() {
                const waited = Date.now() - started;
                const quiet = inflight === 0 && Date.now() - lastActivity > 300;
                if ((quiet && waited > minMs && cssReady && pageLoaded) || waited > 6000) return resolve();
                setTimeout(check, 60);
            })();
        });
    }

    // coming back with the browser's Back button can restore the page as-is
    window.addEventListener("pageshow", (e) => { if (e.persisted) hideLoader(); });

    // Load the shared stylesheet from the same folder as this script, so one
    // <script> tag is enough on any page (profile, directory, admin, ...).
    const existingLink = document.querySelector('link[href*="planora-shell.css"]');
    if (existingLink) {
        cssReady = Boolean(existingLink.sheet);
        existingLink.addEventListener("load", () => { cssReady = true; });
        existingLink.addEventListener("error", () => { cssReady = true; });
    } else {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = document.currentScript
            ? document.currentScript.src.replace(/planora-nav\.js.*$/, "planora-shell.css")
            : "planora-shell.css";
        link.addEventListener("load", () => { cssReady = true; });
        link.addEventListener("error", () => { cssReady = true; });
        document.head.appendChild(link);
    }

    settle(350).then(hideLoader);

    const onHome = Boolean(document.getElementById("timelineContainer"));
    const page = location.pathname.split("/").pop();
    const params = new URLSearchParams(location.search);

    const items = [
        { key: "home", label: "Home" },
        { key: "local", label: "Local" },
        { key: "global", label: "Global" },
        { key: "timeline", label: "Timeline" },
        { divider: true },
        { key: "discover", label: "Discover" },
        { key: "friends", label: "Friends" },
        { key: "notifications", label: "Notifications" },
        { key: "profile", label: "My profile" }
    ];

    const bar = document.createElement("header");
    bar.className = "pl-nav";
    bar.innerHTML = `
        <button class="pl-burger" type="button" aria-label="Open menu" aria-expanded="false">
            <span></span><span></span><span></span>
            <i class="pl-dot" hidden></i>
        </button>
        <a class="pl-brand" href="homepage.html">PLANORA</a>`;

    const overlay = document.createElement("div");
    overlay.className = "pl-overlay";

    const drawer = document.createElement("aside");
    drawer.className = "pl-drawer";
    drawer.setAttribute("aria-label", "Menu");

    // Discord-style profile card at the top of the drawer -> opens your profile
    const card = document.createElement("button");
    card.type = "button";
    card.className = "pl-profile";
    card.hidden = true; // shown once we know who's signed in
    card.innerHTML = `
        <span class="pl-profile-avatar"></span>
        <span class="pl-profile-text">
            <span class="pl-profile-name"></span>
            <span class="pl-profile-sub">Edit profile
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>
                </svg>
            </span>
        </span>`;
    card.addEventListener("click", () => go("profile"));
    drawer.appendChild(card);

    function addItem(item, beforeNode) {
        if (item.divider) {
            const d = document.createElement("div");
            d.className = "pl-divider";
            drawer.insertBefore(d, beforeNode || null);
            return;
        }
        const b = document.createElement("button");
        b.type = "button";
        b.className = "pl-item" + (item.danger ? " danger" : "");
        b.dataset.key = item.key;
        b.textContent = item.label;
        if (item.key === "notifications") {
            const badge = document.createElement("span");
            badge.className = "pl-badge";
            badge.hidden = true;
            b.appendChild(badge);
        }
        b.addEventListener("click", () => go(item.key));
        drawer.insertBefore(b, beforeNode || null);
    }
    items.forEach((i) => addItem(i));
    addItem({ divider: true });
    addItem({ key: "logout", label: "Log out", danger: true });

    document.body.prepend(bar);
    document.body.append(overlay, drawer);

    const burger = bar.querySelector(".pl-burger");
    function setOpen(open) {
        drawer.classList.toggle("open", open);
        overlay.classList.toggle("open", open);
        burger.setAttribute("aria-expanded", String(open));
    }
    burger.addEventListener("click", () => setOpen(!drawer.classList.contains("open")));
    overlay.addEventListener("click", () => setOpen(false));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });

    function setActive(key) {
        drawer.querySelectorAll(".pl-item").forEach((el) => el.classList.toggle("active", el.dataset.key === key));
    }

    /* ---- unread notifications badge ---- */
    const notifStyle = document.createElement("style");
    notifStyle.textContent =
        ".pl-badge{display:inline-block;margin-left:8px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;" +
        "background:#b6453f;color:#fff;font-size:11px;font-weight:700;line-height:18px;text-align:center;vertical-align:middle}" +
        ".pl-dot{position:absolute;top:6px;right:6px;width:9px;height:9px;border-radius:50%;background:#b6453f}" +
        ".pl-badge[hidden],.pl-dot[hidden]{display:none}";
    document.head.appendChild(notifStyle);

    const burgerDot = bar.querySelector(".pl-dot");

    function setUnread(n) {
        const badge = drawer.querySelector('[data-key="notifications"] .pl-badge');
        if (badge) {
            badge.textContent = n > 99 ? "99+" : String(n);
            badge.hidden = n === 0;
        }
        // the dot is absolutely positioned, so the burger has to be a positioning context
        if (n > 0 && getComputedStyle(burger).position === "static") burger.style.position = "relative";
        burgerDot.hidden = n === 0;
    }

    async function refreshUnread() {
        if (document.hidden) return;
        try { setUnread(await PlanoraData.getUnreadCount()); }
        catch (e) { /* offline or signed out - leave the badge as it was */ }
    }

    async function go(key) {
        setOpen(false);
        showLoader();
        if (key === "logout") {
            await Planora.logout();
            location.href = "login.html";
        } else if (key === "discover") {
            location.href = "directory.html";
        } else if (key === "notifications") {
            location.href = "notifications.html";
        } else if (key === "profile") {
            location.href = "profile.html";
        } else if (key === "admin") {
            location.href = "admin.html";
        } else if (onHome && window.__planoraSetView) {
            window.__planoraSetView(key);
            settle(250).then(hideLoader);
        } else {
            location.href = "homepage.html" + (key === "home" ? "" : "?view=" + key);
        }
    }

    // initial highlight (feed.js updates it on the homepage)
    if (page === "directory.html") setActive("discover");
    else if (page === "notifications.html") setActive("notifications");
    else if (page === "profile.html" && !params.get("u")) setActive("profile");

    // who's signed in + admin link
    Planora.getCurrentUser().then((u) => {
        if (!u) return;

        refreshUnread();
        setInterval(refreshUnread, 30000);
        document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshUnread(); });

        const name = u.displayName || u.username;
        card.querySelector(".pl-profile-name").textContent = name;

        const avatar = card.querySelector(".pl-profile-avatar");
        const safeImg = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(u.avatarImage || "");
        if (safeImg) {
            const pos = u.avatarPosition || { x: 50, y: 50 };
            avatar.style.background = `${pos.x}% ${pos.y}% / cover no-repeat url("${u.avatarImage}")`;
        } else {
            avatar.style.background = `linear-gradient(135deg, ${u.avatarColor || "#c9a227"}, #1b1b1b)`;
            avatar.textContent = name.charAt(0).toUpperCase();
        }
        card.hidden = false;
        if (u.role === "admin") {
            const logout = drawer.querySelector('[data-key="logout"]');
            addItem({ key: "admin", label: "Admin panel" }, logout.previousElementSibling);
        }
    });

    // Old top bars (directory, admin, ...) may not use the .topbar class.
    // Hide any other sticky/fixed bar pinned to the top of the page.
    function hideLegacyBars() {
        Array.from(document.body.children).forEach((n) => {
            if (n === bar || n === overlay || n === drawer || n.tagName === "SCRIPT") return;
            const cs = getComputedStyle(n);
            const pinned = (cs.position === "sticky" || cs.position === "fixed") && parseFloat(cs.top) === 0;
            const looksLikeBar = n.tagName === "HEADER" || /top-?bar|header|navbar/i.test(n.className);
            if ((pinned || looksLikeBar) && n.offsetHeight > 0 && n.offsetHeight < 110) {
                n.style.display = "none";
            }
        });
    }
    hideLegacyBars();
    setTimeout(hideLegacyBars, 500); // in case a page builds its bar after load

    window.PlanoraNav = { setActive, setUnread, refreshUnread };
})();

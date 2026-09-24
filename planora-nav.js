/* PLANORA — SHARED NAV
   Burger on the left, PLANORA on the right. Include on any page AFTER api.js.
   On the homepage, Local/Global/Timeline/Home switch views in place (via feed.js);
   everywhere else they link to homepage.html?view=... */

(function () {
    // Load the shared stylesheet from the same folder as this script, so one
    // <script> tag is enough on any page (profile, directory, admin, ...).
    if (!document.querySelector('link[href*="planora-shell.css"]')) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = document.currentScript
            ? document.currentScript.src.replace(/planora-nav\.js.*$/, "planora-shell.css")
            : "planora-shell.css";
        document.head.appendChild(link);
    }

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
        { key: "profile", label: "My profile" }
    ];

    const bar = document.createElement("header");
    bar.className = "pl-nav";
    bar.innerHTML = `
        <button class="pl-burger" type="button" aria-label="Open menu" aria-expanded="false">
            <span></span><span></span><span></span>
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

    async function go(key) {
        setOpen(false);
        if (key === "logout") {
            await Planora.logout();
            location.href = "login.html";
        } else if (key === "discover") {
            location.href = "directory.html";
        } else if (key === "profile") {
            location.href = "profile.html";
        } else if (key === "admin") {
            location.href = "admin.html";
        } else if (onHome && window.__planoraSetView) {
            window.__planoraSetView(key);
        } else {
            location.href = "homepage.html" + (key === "home" ? "" : "?view=" + key);
        }
    }

    // initial highlight (feed.js updates it on the homepage)
    if (page === "directory.html") setActive("discover");
    else if (page === "profile.html" && !params.get("u")) setActive("profile");

    // who's signed in + admin link
    Planora.getCurrentUser().then((u) => {
        if (!u) return;
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

    window.PlanoraNav = { setActive };
})();

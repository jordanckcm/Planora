/* PLANORA — SHARED NAV
   Burger on the left, PLANORA on the right. Include on any page AFTER api.js.
   On the homepage, Local/Global/Timeline/Home switch views in place (via feed.js);
   everywhere else they link to homepage.html?view=... */

(function () {
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

    const userLine = document.createElement("div");
    userLine.className = "pl-drawer-user";
    drawer.appendChild(userLine);

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
        userLine.textContent = "@" + u.username;
        if (u.role === "admin") {
            const logout = drawer.querySelector('[data-key="logout"]');
            addItem({ key: "admin", label: "Admin panel" }, logout.previousElementSibling);
        }
    });

    window.PlanoraNav = { setActive };
})();

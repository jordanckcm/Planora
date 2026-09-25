/* PLANORA — PROFILE HOVER CARD
   Mark any element with data-profile-hover="username" (a comment author
   link, an avatar, a friend row, an @mention, ...) and hovering it after
   a short delay shows a small card with that person's banner, avatar,
   role, bio and join date - fetched from GET /api/users/<username> via
   Planora.getProfile and cached per username so a repeat hover is free.

   Include this <script> tag after api.js on any page that has profile
   links: profile.html, friends.html, notifications.html, homepage.html,
   directory.html, etc. Animated GIF avatars/banners play automatically -
   browsers animate a GIF the moment it's rendered as a CSS background,
   same as everywhere else in the app that shows one. */

(function () {
    if (window.PlanoraProfileHover) return; // don't double-init if included on a page twice

    // Skip entirely on touch-only devices - there's no "hover" there, and
    // mouseover/mouseout fire in odd, tap-triggered ways that would just
    // pop the card up and leave it stuck.
    if (window.matchMedia && !window.matchMedia("(hover: hover)").matches) return;

    const SHOW_DELAY = 350;   // ms of dwell before the card appears
    const HIDE_DELAY = 200;   // ms grace period so moving mouse->card doesn't close it
    const CARD_WIDTH = 260;
    const IMAGE_DATA_URL = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;
    const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

    // username (lowercase) -> profile object | null (404/failed) | Promise (in flight)
    const cache = new Map();

    const style = document.createElement("style");
    style.textContent = `
        .pl-hovercard{position:fixed;z-index:5000;width:${CARD_WIDTH}px;overflow:hidden;
            background:#1b1b1b;border:1px solid rgba(255,255,255,.12);border-radius:14px;
            box-shadow:0 15px 40px rgba(0,0,0,.5);opacity:0;transform:translateY(4px);
            pointer-events:none;transition:opacity .12s ease,transform .12s ease;
            font-family:inherit;}
        .pl-hovercard.show{opacity:1;transform:none;pointer-events:auto;}
        .pl-hc-banner{height:64px;background-size:cover;background-position:center;}
        .pl-hc-body{padding:0 14px 14px;}
        .pl-hc-avatar{width:52px;height:52px;margin-top:-26px;border-radius:50%;
            border:3px solid #1b1b1b;background-size:cover;background-position:center;
            display:flex;align-items:center;justify-content:center;font-weight:700;
            font-size:18px;color:#fff;}
        .pl-hc-name-row{display:flex;align-items:center;gap:6px;margin-top:8px;flex-wrap:wrap;}
        .pl-hc-name{font-size:14px;font-weight:700;color:#f2f2f2;overflow-wrap:anywhere;}
        .pl-hc-role{flex:none;font-size:9px;padding:2px 7px;border:1px solid #c9a227;
            border-radius:999px;color:#c9a227;}
        .pl-hc-handle{font-size:11px;color:rgba(255,255,255,.55);margin-top:1px;}
        .pl-hc-bio{font-size:12px;line-height:1.5;color:rgba(255,255,255,.85);margin-top:8px;
            white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;
            -webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
        .pl-hc-joined{font-size:10.5px;color:rgba(255,255,255,.5);margin-top:8px;}
        .pl-hc-loading{padding:22px 14px;font-size:12px;color:rgba(255,255,255,.5);text-align:center;}
    `;
    document.head.appendChild(style);

    const card = document.createElement("div");
    card.className = "pl-hovercard";
    document.body.appendChild(card);

    let showTimer = null;
    let hideTimer = null;
    let currentUsername = null;

    function safeImage(v) {
        return IMAGE_DATA_URL.test(v || "") ? v : "";
    }
    function safeColor(v) {
        return HEX_COLOR.test(v || "") ? v : "#c9a227";
    }
    function roleLabel(role) {
        if (role === "admin") return "Admin";
        if (role === "community_plus") return "Community+";
        return "";
    }

    function renderLoading() {
        card.innerHTML = '<div class="pl-hc-loading">Loading…</div>';
    }

    function renderProfile(p) {
        const banner = safeImage(p.bannerImage);
        const avatar = safeImage(p.avatarImage);
        const initial = (p.displayName || p.username || "?").charAt(0).toUpperCase();
        const role = roleLabel(p.role);
        const joined = p.createdAt
            ? new Date(p.createdAt).toLocaleDateString(undefined, { month: "short", year: "numeric" })
            : "";

        card.innerHTML = "";

        const bannerEl = document.createElement("div");
        bannerEl.className = "pl-hc-banner";
        if (banner) {
            const pos = p.bannerPosition || { x: 50, y: 50 };
            bannerEl.style.backgroundImage = `url("${banner}")`;
            bannerEl.style.backgroundPosition = `${pos.x}% ${pos.y}%`;
        } else {
            bannerEl.style.background = `linear-gradient(135deg, ${safeColor(p.accent)}, #1b1b1b)`;
        }

        const body = document.createElement("div");
        body.className = "pl-hc-body";

        const avatarEl = document.createElement("div");
        avatarEl.className = "pl-hc-avatar";
        if (avatar) {
            const pos = p.avatarPosition || { x: 50, y: 50 };
            avatarEl.style.background = `${pos.x}% ${pos.y}% / cover no-repeat url("${avatar}")`;
        } else {
            avatarEl.style.background = `linear-gradient(135deg, ${safeColor(p.avatarColor)}, #1b1b1b)`;
            avatarEl.textContent = initial;
        }

        const nameRow = document.createElement("div");
        nameRow.className = "pl-hc-name-row";
        const nameEl = document.createElement("span");
        nameEl.className = "pl-hc-name";
        nameEl.textContent = p.displayName || p.username;
        nameRow.appendChild(nameEl);
        if (role) {
            const roleEl = document.createElement("span");
            roleEl.className = "pl-hc-role";
            roleEl.textContent = role;
            nameRow.appendChild(roleEl);
        }

        const handleEl = document.createElement("div");
        handleEl.className = "pl-hc-handle";
        handleEl.textContent = "@" + p.username;

        body.append(avatarEl, nameRow, handleEl);

        if (p.bio) {
            const bioEl = document.createElement("div");
            bioEl.className = "pl-hc-bio";
            bioEl.textContent = p.bio;
            body.appendChild(bioEl);
        }

        if (joined) {
            const joinedEl = document.createElement("div");
            joinedEl.className = "pl-hc-joined";
            joinedEl.textContent = "Joined " + joined;
            body.appendChild(joinedEl);
        }

        card.append(bannerEl, body);
    }

    function position(trigger) {
        const rect = trigger.getBoundingClientRect();
        const margin = 10;

        let left = rect.left;
        if (left + CARD_WIDTH + margin > window.innerWidth) {
            left = window.innerWidth - CARD_WIDTH - margin;
        }
        if (left < margin) left = margin;

        let top = rect.bottom + 8;
        const estimatedHeight = card.offsetHeight || 190;
        if (top + estimatedHeight + margin > window.innerHeight) {
            // flip above the trigger if there's no room below
            const above = rect.top - estimatedHeight - 8;
            top = above < margin ? margin : above;
        }

        card.style.left = left + "px";
        card.style.top = top + "px";
    }

    async function fetchProfile(username) {
        const key = username.toLowerCase();
        if (cache.has(key)) {
            const cached = cache.get(key);
            return cached && typeof cached.then === "function" ? cached : cached;
        }
        const promise = (window.Planora && Planora.getProfile
            ? Planora.getProfile(username)
            : fetch(`/api/users/${encodeURIComponent(username)}`).then((r) => (r.ok ? r.json() : null))
        ).catch(() => null);
        cache.set(key, promise);
        const result = await promise;
        cache.set(key, result); // replace the in-flight promise with the resolved value
        return result;
    }

    function cancelTimers() {
        if (showTimer) { clearTimeout(showTimer); showTimer = null; }
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    }

    function hide() {
        card.classList.remove("show");
        currentUsername = null;
    }

    function scheduleHide() {
        cancelTimers();
        hideTimer = setTimeout(hide, HIDE_DELAY);
    }

    async function show(trigger, username) {
        currentUsername = username;
        renderLoading();
        position(trigger);
        card.classList.add("show");

        const profile = await fetchProfile(username);

        // the mouse may have moved to a different trigger while this loaded
        if (currentUsername !== username) return;

        if (!profile) {
            hide();
            return;
        }
        renderProfile(profile);
        position(trigger);
    }

    document.addEventListener("mouseover", (e) => {
        const trigger = e.target.closest("[data-profile-hover]");
        if (!trigger) return;
        const username = trigger.dataset.profileHover;
        if (!username) return;
        if (currentUsername === username && card.classList.contains("show")) {
            cancelTimers();
            return;
        }
        cancelTimers();
        showTimer = setTimeout(() => show(trigger, username), SHOW_DELAY);
    });

    document.addEventListener("mouseout", (e) => {
        const trigger = e.target.closest("[data-profile-hover]");
        if (!trigger) return;
        // moving to a child of the same trigger isn't "leaving" it
        if (trigger.contains(e.relatedTarget)) return;
        scheduleHide();
    });

    card.addEventListener("mouseenter", cancelTimers);
    card.addEventListener("mouseleave", scheduleHide);

    // position would go stale mid-scroll - just close it, it'll reopen on next hover
    window.addEventListener("scroll", () => { if (card.classList.contains("show")) hide(); }, true);

    window.PlanoraProfileHover = { hide };
})();

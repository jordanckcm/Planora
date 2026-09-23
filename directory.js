/* =========================================================
   PLANORA — DISCOVERY / DIRECTORY
   Search by name/username and/or filter by a single interest tag
   (arrived at either by typing here, or by clicking an interest chip
   on someone's profile, which links here with ?interest=<tag>).
========================================================= */

let viewer = null;
let searchQuery = "";
let activeInterest = "";
let searchDebounceTimer = null;

const $ = (id) => document.getElementById(id);

const IMAGE_DATA_URL = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_ACCENT = "#c9a227";

function safeImage(value) {
    return typeof value === "string" && IMAGE_DATA_URL.test(value) ? value : "";
}

function safeColor(value) {
    return HEX_COLOR.test(value || "") ? value : DEFAULT_ACCENT;
}

function toast(message, type = "") {
    const stack = $("toastStack");
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 3200);
}

function profileHref(username) {
    return "profile.html?u=" + encodeURIComponent(username);
}

function directoryHref(interest) {
    return "directory.html?interest=" + encodeURIComponent(interest);
}

function roleLabel(role) {
    if (role === "admin") return "Admin";
    if (role === "community_plus") return "Community+";
    return "";
}


(async function start() {
    viewer = await Planora.requireAuth();
    if (!viewer) return;

    activeInterest = new URLSearchParams(window.location.search).get("interest") || "";

    bindStaticActions();
    bindSearch();
    updateActiveFilterUI();
    await runSearch();
})();

function bindStaticActions() {
    $("backButton").addEventListener("click", () => {
        window.location.href = "homepage.html";
    });

    $("logoutButton").addEventListener("click", async () => {
        await Planora.logout();
        window.location.href = "login.html";
    });

    $("settingsButton").addEventListener("click", () => {
        Planora.Settings.open(viewer);
    });
}

function bindSearch() {
    const input = $("directorySearch");
    const clearBtn = $("clearDirectorySearch");

    input.addEventListener("input", () => {
        searchQuery = input.value;
        clearBtn.style.display = searchQuery ? "flex" : "none";

        // debounced so every keystroke doesn't fire its own request
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(runSearch, 250);
    });

    clearBtn.addEventListener("click", () => {
        input.value = "";
        searchQuery = "";
        clearBtn.style.display = "none";
        input.focus();
        runSearch();
    });

    $("clearInterestFilter").addEventListener("click", () => {
        activeInterest = "";
        updateActiveFilterUI();
        history.replaceState(null, "", "directory.html");
        runSearch();
    });
}

function updateActiveFilterUI() {
    const wrap = $("activeInterestFilter");
    wrap.hidden = !activeInterest;
    if (activeInterest) {
        $("activeInterestLabel").textContent = activeInterest;
    }
}

function setInterestFilter(tag) {
    activeInterest = activeInterest.toLowerCase() === tag.toLowerCase() ? "" : tag;
    updateActiveFilterUI();

    const url = new URL(window.location.href);
    if (activeInterest) {
        url.searchParams.set("interest", activeInterest);
    } else {
        url.searchParams.delete("interest");
    }
    history.replaceState(null, "", url.pathname + url.search);

    runSearch();
}

async function runSearch() {
    const grid = $("directoryGrid");

    let results;
    try {
        results = await Planora.searchUsers({ q: searchQuery.trim(), interest: activeInterest });
    } catch (err) {
        toast(err.message, "error");
        return;
    }

    grid.textContent = "";

    if (results.length === 0) {
        grid.appendChild(emptyState());
        return;
    }

    results.forEach(user => grid.appendChild(userCard(user)));
}

function emptyState() {
    const box = document.createElement("div");
    box.className = "directory-empty";

    const title = document.createElement("div");
    title.className = "directory-empty-title";
    title.textContent = "No one matches";

    const text = document.createElement("p");
    text.style.margin = "0";
    text.textContent = activeInterest || searchQuery.trim()
        ? "Try a different search or clear the interest filter."
        : "No one's signed up yet.";

    box.append(title, text);
    return box;
}

function userCard(user) {
    const card = document.createElement("article");
    card.className = "directory-card";
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");

    const head = document.createElement("div");
    head.className = "directory-card-head";

    const avatar = document.createElement("div");
    avatar.className = "directory-card-avatar";
    const img = safeImage(user.avatarImage);
    if (img) {
        avatar.style.background = `center / cover no-repeat url("${img}")`;
    } else {
        avatar.style.background = `linear-gradient(135deg, ${safeColor(user.avatarColor)}, #1b1b1b)`;
        avatar.textContent = (user.displayName || user.username || "?").charAt(0).toUpperCase();
    }

    const identity = document.createElement("div");

    const name = document.createElement("div");
    name.className = "directory-card-name";
    name.textContent = user.displayName;

    const handle = document.createElement("div");
    handle.className = "directory-card-handle";
    handle.textContent = "@" + user.username;

    identity.append(name, handle);

    if (roleLabel(user.role)) {
        const role = document.createElement("div");
        role.className = "directory-role-chip";
        role.textContent = roleLabel(user.role);
        identity.appendChild(role);
    }

    head.append(avatar, identity);
    card.appendChild(head);

    if (user.bio) {
        const bio = document.createElement("div");
        bio.className = "directory-card-bio";
        bio.textContent = user.bio;
        card.appendChild(bio);
    }

    if (user.interests && user.interests.length > 0) {
        const chips = document.createElement("div");
        chips.className = "directory-card-chips";
        user.interests.forEach(tag => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "directory-chip";
            if (activeInterest && activeInterest.toLowerCase() === tag.toLowerCase()) {
                chip.classList.add("active");
            }
            chip.textContent = tag;
            chip.addEventListener("click", (e) => {
                e.stopPropagation(); // don't also trigger the card's own click-through
                setInterestFilter(tag);
            });
            chips.appendChild(chip);
        });
        card.appendChild(chips);
    }

    function goToProfile() {
        window.location.href = profileHref(user.username);
    }
    card.addEventListener("click", goToProfile);
    card.addEventListener("keydown", (e) => {
        if (e.key === "Enter") goToProfile();
    });

    return card;
}

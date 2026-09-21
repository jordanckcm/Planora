/* =========================================================
   PLANORA — PROFILE PAGE

   One page, two modes:
     profile.html            -> your own profile (with the editor)
     profile.html?u=someone  -> someone else's profile (read only)

   You usually land on someone else's by clicking their name on a comment.
   Public events show for everyone; the Private tab and the Edit button
   only exist on your own profile, and the server enforces that too.
========================================================= */

const ACCENT_PALETTE = [
    "#c9a227", "#489c48", "#b6453f", "#4a7fc9", "#9a56c9", "#c96f2e",
    "#e05d8f", "#2fb8b0", "#7a8cff", "#8fbf3f", "#e0c341", "#9aa0a6"
];

const DEFAULT_ACCENT = "#c9a227";
const IMAGE_DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

let viewer = null;      // who is signed in
let profile = null;     // whose page this is
let activeTab = "public";
let draft = null;       // the editor's unsaved copy

const $ = (id) => document.getElementById(id);


/* ---------- startup ---------- */

(async function start() {
    viewer = await Planora.requireAuth();
    if (!viewer) return;

    bindStaticActions();
    await loadProfile();
})();

function requestedUsername() {
    const fromUrl = new URLSearchParams(window.location.search).get("u");
    return (fromUrl || viewer.username).trim();
}

async function loadProfile() {
    try {
        profile = await api(`/api/users/${encodeURIComponent(requestedUsername())}`);
    } catch (err) {
        $("profileContent").hidden = true;
        $("notFound").hidden = false;
        return;
    }

    $("notFound").hidden = true;
    $("profileContent").hidden = false;

    render();
}


/* ---------- small helpers ---------- */

async function api(path, options = {}) {
    const response = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        ...options
    });

    let data = {};
    try { data = await response.json(); } catch (err) { /* empty body */ }

    if (!response.ok) throw new Error(data.error || "Something went wrong. Try again.");
    return data;
}

function toast(message, type = "") {
    const stack = $("toastStack");
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 3200);
}

function safeColor(value) {
    return HEX_COLOR.test(value || "") ? value : DEFAULT_ACCENT;
}

function safeImage(value) {
    return typeof value === "string" && IMAGE_DATA_URL.test(value) ? value : "";
}

function initialOf(name, username) {
    return (name || username || "?").charAt(0).toUpperCase();
}

/* Paints an avatar element: the photo if there is one, otherwise the
   color + first letter. Used by the hero and by the editor preview so
   the two can never disagree. */
function paintAvatar(el, image, color, initial) {
    const img = safeImage(image);
    el.textContent = "";

    if (img) {
        el.style.background = `center / cover no-repeat url("${img}")`;
    } else {
        el.style.background = `linear-gradient(135deg, ${safeColor(color)}, #1b1b1b)`;
        el.textContent = initial;
    }
}

function paintBanner(el, image) {
    const img = safeImage(image);
    el.style.backgroundImage = img ? `url("${img}")` : "";
}

function formatEventDate(event) {
    const [y, m, d] = event.date.split("-").map(Number);
    const start = new Date(y, m - 1, d);
    const opts = { month: "short", day: "numeric" };
    let text = start.toLocaleDateString(undefined, { ...opts, year: "numeric" });

    if (event.end_date && event.end_date !== event.date) {
        const [ey, em, ed] = event.end_date.split("-").map(Number);
        text = `${start.toLocaleDateString(undefined, opts)} – ${new Date(ey, em - 1, ed).toLocaleDateString(undefined, { ...opts, year: "numeric" })}`;
    }

    if (event.start_time) {
        text += ` · ${event.start_time}${event.end_time ? "–" + event.end_time : ""}`;
    }
    return text;
}

function roleLabel(role) {
    if (role === "admin") return "Admin";
    if (role === "community_plus") return "Community+";
    return "";
}


/* ---------- rendering the profile ---------- */

function render() {
    const p = profile;
    const shell = $("profileShell");

    shell.style.setProperty("--accent", safeColor(p.accent));
    document.title = `${p.displayName} · Planora`;

    paintBanner($("heroBanner"), p.bannerImage);
    paintAvatar($("avatarBig"), p.avatarImage, p.avatarColor, initialOf(p.displayName, p.username));

    $("displayNameView").textContent = p.displayName;
    $("usernameView").textContent = "@" + p.username;

    const pronouns = $("pronounsView");
    pronouns.textContent = p.pronouns;
    pronouns.hidden = !p.pronouns;

    const chip = $("roleChip");
    chip.textContent = roleLabel(p.role);
    chip.hidden = !roleLabel(p.role);

    $("editProfileButton").hidden = !p.isSelf;

    // status
    const hasStatus = Boolean(p.statusEmoji || p.statusText);
    $("statusPill").hidden = !hasStatus;
    $("statusEmoji").textContent = p.statusEmoji;
    $("statusEmoji").hidden = !p.statusEmoji;
    $("statusText").textContent = p.statusText;

    // bio
    const bio = $("bioView");
    bio.textContent = p.bio;
    bio.hidden = !p.bio;

    // location / link / joined
    const location = $("locationView");
    location.textContent = p.location ? "📍 " + p.location : "";
    location.hidden = !p.location;

    const link = $("linkView");
    if (/^https?:\/\//i.test(p.link || "")) {
        link.href = p.link;
        link.textContent = p.link.replace(/^https?:\/\//i, "").replace(/\/$/, "");
        link.hidden = false;
    } else {
        link.hidden = true;
    }

    $("joinedView").textContent = "Joined " +
        new Date(p.createdAt).toLocaleDateString(undefined, { month: "short", year: "numeric" });

    // interests
    const chips = $("interestChips");
    chips.textContent = "";
    (p.interests || []).forEach((tag) => {
        const el = document.createElement("span");
        el.className = "chip";
        el.textContent = tag;
        chips.appendChild(el);
    });

    // stats
    $("statPublic").textContent = p.stats.publicEvents;
    $("statEvents").textContent = p.stats.events;
    $("statComments").textContent = p.stats.comments;

    // now listening
    const hasSong = Boolean(p.nowSong);
    $("nowPlaying").hidden = !hasSong;
    $("npSong").textContent = p.nowSong;
    $("npArtist").textContent = p.nowArtist;

    // tabs: the Private tab is only ever yours
    $("tabPrivate").hidden = !p.isSelf;
    if (!p.isSelf) activeTab = "public";
    renderTabs();
    renderEvents();
}

function renderTabs() {
    const isPublic = activeTab === "public";

    $("tabPublic").classList.toggle("active", isPublic);
    $("tabPublic").setAttribute("aria-selected", String(isPublic));
    $("tabPrivate").classList.toggle("active", !isPublic);
    $("tabPrivate").setAttribute("aria-selected", String(!isPublic));

    if (isPublic) {
        $("tabNote").textContent = profile.isSelf
            ? "Anyone who visits your profile can see these."
            : "";
    } else {
        $("tabNote").textContent = "Only you can see these.";
    }
}

function renderEvents() {
    const grid = $("eventGrid");
    grid.textContent = "";

    const isPublic = activeTab === "public";
    const list = isPublic ? profile.publicEvents : (profile.privateEvents || []);

    if (!list.length) {
        grid.appendChild(emptyState(isPublic));
        return;
    }

    list.forEach((event) => grid.appendChild(eventTile(event, !isPublic)));
}

function emptyState(isPublic) {
    const box = document.createElement("div");
    box.className = "empty-state";

    const title = document.createElement("div");
    title.className = "empty-title";

    const text = document.createElement("p");

    if (isPublic && profile.isSelf) {
        title.textContent = "No public events yet";
        text.textContent = "Press + on the calendar and switch the event to Public to show it here.";
    } else if (isPublic) {
        title.textContent = "No public events yet";
        text.textContent = `${profile.displayName} hasn't shared any events.`;
    } else {
        title.textContent = "No private events";
        text.textContent = "Private events stay on your calendar and never show on your profile.";
    }

    box.append(title, text);
    return box;
}

function eventTile(event, showLock) {
    const tile = document.createElement("article");
    tile.className = "event-tile";

    const cover = document.createElement("div");
    cover.className = "tile-cover";

    const img = safeImage(event.image);
    if (img) {
        cover.style.backgroundImage = `url("${img}")`;
    } else {
        cover.style.background = `linear-gradient(135deg, ${safeColor(event.color)}, #1b1b1b)`;
        cover.textContent = event.icon;
    }

    if (showLock) {
        const lock = document.createElement("span");
        lock.className = "tile-lock";
        lock.textContent = "Private";
        cover.appendChild(lock);
    }

    const body = document.createElement("div");
    body.className = "tile-body";

    const title = document.createElement("div");
    title.className = "tile-title";
    title.textContent = event.title;

    const date = document.createElement("div");
    date.className = "tile-date";
    date.textContent = formatEventDate(event);

    body.append(title, date);

    if (event.description) {
        const desc = document.createElement("div");
        desc.className = "tile-desc";
        desc.textContent = event.description;
        body.appendChild(desc);
    }

    tile.append(cover, body);
    return tile;
}


/* ---------- page-level actions ---------- */

function bindStaticActions() {
    $("backButton").addEventListener("click", () => {
        window.location.href = "homepage.html";
    });

    $("logoutButton").addEventListener("click", async () => {
        await Planora.logout();
        window.location.href = "login.html";
    });

    $("tabPublic").addEventListener("click", () => { activeTab = "public"; renderTabs(); renderEvents(); });
    $("tabPrivate").addEventListener("click", () => { activeTab = "private"; renderTabs(); renderEvents(); });

    $("editProfileButton").addEventListener("click", openEditor);
    $("closeEditor").addEventListener("click", closeEditor);
    $("cancelEditor").addEventListener("click", closeEditor);
    $("editorOverlay").addEventListener("click", closeEditor);

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && $("editor").classList.contains("open")) closeEditor();
    });

    bindEditorInputs();
}


/* =========================================================
   EDITOR
========================================================= */

function openEditor() {
    const p = profile;

    draft = {
        displayName: p.displayName,
        pronouns: p.pronouns,
        bio: p.bio,
        location: p.location,
        link: p.link,
        statusEmoji: p.statusEmoji,
        statusText: p.statusText,
        nowSong: p.nowSong,
        nowArtist: p.nowArtist,
        interests: (p.interests || []).join(", "),
        accent: safeColor(p.accent),
        avatarImage: p.avatarImage || "",
        bannerImage: p.bannerImage || ""
    };

    $("displayNameInput").value = draft.displayName;
    $("pronounsInput").value = draft.pronouns;
    $("bioInput").value = draft.bio;
    $("locationInput").value = draft.location;
    $("linkInput").value = draft.link;
    $("statusEmojiInput").value = draft.statusEmoji;
    $("statusTextInput").value = draft.statusText;
    $("nowSongInput").value = draft.nowSong;
    $("nowArtistInput").value = draft.nowArtist;
    $("interestsInput").value = draft.interests;

    buildSwatches();
    updateEditorPreview();

    $("editorOverlay").hidden = false;
    $("editor").classList.add("open");
    $("editor").setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    $("displayNameInput").focus();
}

function closeEditor() {
    $("editor").classList.remove("open");
    $("editor").setAttribute("aria-hidden", "true");
    $("editorOverlay").hidden = true;
    document.body.style.overflow = "";
    $("editProfileButton").focus();
}

function buildSwatches() {
    const row = $("swatchRow");
    row.textContent = "";

    ACCENT_PALETTE.forEach((color) => {
        const swatch = document.createElement("button");
        swatch.type = "button";
        swatch.className = "swatch";
        swatch.style.background = color;
        swatch.setAttribute("aria-label", `Accent ${color}`);
        swatch.dataset.color = color;
        swatch.addEventListener("click", () => setAccent(color));
        row.appendChild(swatch);
    });
}

function setAccent(color) {
    draft.accent = safeColor(color);
    updateEditorPreview();
}

function readInputsIntoDraft() {
    draft.displayName = $("displayNameInput").value;
    draft.pronouns = $("pronounsInput").value;
    draft.bio = $("bioInput").value;
    draft.location = $("locationInput").value;
    draft.link = $("linkInput").value;
    draft.statusEmoji = $("statusEmojiInput").value;
    draft.statusText = $("statusTextInput").value;
    draft.nowSong = $("nowSongInput").value;
    draft.nowArtist = $("nowArtistInput").value;
    draft.interests = $("interestsInput").value;
}

function updateEditorPreview() {
    const name = draft.displayName.trim() || profile.username;

    $("previewCard").style.setProperty("--accent", draft.accent);
    paintBanner($("previewBanner"), draft.bannerImage);
    paintAvatar($("previewAvatar"), draft.avatarImage, profile.avatarColor, initialOf(name, profile.username));

    $("previewName").textContent = name;
    $("previewHandle").textContent = "@" + profile.username + (draft.pronouns.trim() ? "  ·  " + draft.pronouns.trim() : "");
    $("previewStatus").textContent = `${draft.statusEmoji.trim()} ${draft.statusText.trim()}`.trim();

    $("bioCount").textContent = `${draft.bio.length}/200`;

    $("removeAvatarImage").style.display = draft.avatarImage ? "inline-flex" : "none";
    $("removeBannerImage").style.display = draft.bannerImage ? "inline-flex" : "none";

    document.querySelectorAll(".swatch").forEach((swatch) => {
        swatch.classList.toggle("selected", swatch.dataset.color.toLowerCase() === draft.accent.toLowerCase());
    });
    $("customAccent").value = draft.accent;
}

function bindEditorInputs() {
    [
        "displayNameInput", "pronounsInput", "bioInput", "locationInput", "linkInput",
        "statusEmojiInput", "statusTextInput", "nowSongInput", "nowArtistInput", "interestsInput"
    ].forEach((id) => {
        $(id).addEventListener("input", () => {
            readInputsIntoDraft();
            updateEditorPreview();
        });
    });

    $("customAccent").addEventListener("input", (event) => setAccent(event.target.value));

    // avatar photo (same resizer the old page used)
    const avatarInput = $("avatarImageInput");
    avatarInput.addEventListener("change", async () => {
        const file = avatarInput.files[0];
        if (!file) return;

        try {
            draft.avatarImage = await Planora.resizeImage(file);
            updateEditorPreview();
        } catch (err) {
            toast(err.message, "error");
        }
        avatarInput.value = ""; // lets you pick the same file twice in a row
    });

    $("removeAvatarImage").addEventListener("click", () => {
        draft.avatarImage = "";
        updateEditorPreview();
    });

    // banner photo
    const bannerInput = $("bannerImageInput");
    bannerInput.addEventListener("change", async () => {
        const file = bannerInput.files[0];
        if (!file) return;

        try {
            draft.bannerImage = await resizeBanner(file);
            updateEditorPreview();
        } catch (err) {
            toast(err.message, "error");
        }
        bannerInput.value = "";
    });

    $("removeBannerImage").addEventListener("click", () => {
        draft.bannerImage = "";
        updateEditorPreview();
    });

    $("saveProfile").addEventListener("click", saveProfile);
}

/* Crops to a wide 3:1 strip and shrinks it, so it fits under the
   server's image size limit no matter what got picked. */
function resizeBanner(file) {
    return new Promise((resolve, reject) => {
        if (!file.type.startsWith("image/")) {
            reject(new Error("Pick an image file."));
            return;
        }

        const url = URL.createObjectURL(file);
        const img = new Image();

        img.onload = () => {
            URL.revokeObjectURL(url);

            const width = 900;
            const height = 300;
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");

            // "cover" crop: scale until the strip is full, center the rest
            const scale = Math.max(width / img.width, height / img.height);
            const drawW = img.width * scale;
            const drawH = img.height * scale;
            ctx.drawImage(img, (width - drawW) / 2, (height - drawH) / 2, drawW, drawH);

            resolve(canvas.toDataURL("image/jpeg", 0.8));
        };

        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("Couldn't read that image."));
        };

        img.src = url;
    });
}

function parseInterests(text) {
    const seen = [];
    text.split(",").forEach((raw) => {
        const tag = raw.trim().replace(/^#+/, "").trim().slice(0, 20);
        if (tag && !seen.some((t) => t.toLowerCase() === tag.toLowerCase())) seen.push(tag);
    });
    return seen.slice(0, 5);
}

async function saveProfile() {
    readInputsIntoDraft();

    const displayName = draft.displayName.trim();
    if (!displayName) {
        toast("Display name can't be empty.", "error");
        $("displayNameInput").focus();
        return;
    }

    let link = draft.link.trim();
    if (link && !/^https?:\/\//i.test(link)) link = "https://" + link;

    const saveButton = $("saveProfile");
    saveButton.disabled = true;

    try {
        await api("/api/me", {
            method: "PUT",
            body: JSON.stringify({
                displayName,
                pronouns: draft.pronouns.trim(),
                bio: draft.bio.trim(),
                location: draft.location.trim(),
                link,
                statusEmoji: draft.statusEmoji.trim(),
                statusText: draft.statusText.trim(),
                nowSong: draft.nowSong.trim(),
                nowArtist: draft.nowArtist.trim(),
                interests: parseInterests(draft.interests),
                accent: draft.accent,
                avatarImage: draft.avatarImage,
                bannerImage: draft.bannerImage
            })
        });

        await loadProfile();
        closeEditor();
        toast("Profile saved.");
    } catch (err) {
        toast(err.message, "error");
    } finally {
        saveButton.disabled = false;
    }
}

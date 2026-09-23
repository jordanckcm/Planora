/* =========================================================
   PLANORA — PROFILE PAGE

   One page, two modes:
     profile.html            -> your own profile (with the editor)
     profile.html?u=someone  -> someone else's profile (read only)

   You usually land on someone else's by clicking their name on a comment.
   Public events show for everyone; Edit button only exists on your own
   profile, and the server enforces that too.
========================================================= */

const ACCENT_PALETTE = [
    "#c9a227", "#489c48", "#b6453f", "#4a7fc9", "#9a56c9", "#c96f2e",
    "#e05d8f", "#2fb8b0", "#7a8cff", "#8fbf3f", "#e0c341", "#9aa0a6"
];

const DEFAULT_ACCENT = "#c9a227";
const IMAGE_DATA_URL = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

let viewer = null;      // who is signed in
let profile = null;     // whose page this is
let draft = null;       // the editor's unsaved copy

const $ = (id) => document.getElementById(id);


/* ---------- startup ---------- */

(async function start() {
    viewer = await Planora.requireAuth();
    if (!viewer) return;

    bindStaticActions();
    bindPostModal();
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

const DEFAULT_POSITION = { x: 50, y: 50 };

function safePosition(pos) {
    if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number") return DEFAULT_POSITION;
    return {
        x: Math.min(100, Math.max(0, pos.x)),
        y: Math.min(100, Math.max(0, pos.y))
    };
}

/* Paints an avatar element: the photo if there is one, otherwise the
   color + first letter. Used by the hero and by the editor preview so
   the two can never disagree. `position` is the focal point chosen in
   the reposition control - {x, y} percentages, defaulting to center. */
function paintAvatar(el, image, color, initial, position) {
    const img = safeImage(image);
    el.textContent = "";

    if (img) {
        const pos = safePosition(position);
        el.style.background = `${pos.x}% ${pos.y}% / cover no-repeat url("${img}")`;
    } else {
        el.style.background = `linear-gradient(135deg, ${safeColor(color)}, #1b1b1b)`;
        el.textContent = initial;
    }
}

function paintBanner(el, image, position) {
    const img = safeImage(image);
    if (img) {
        const pos = safePosition(position);
        el.style.backgroundImage = `url("${img}")`;
        el.style.backgroundPosition = `${pos.x}% ${pos.y}%`;
    } else {
        el.style.backgroundImage = "";
        el.style.backgroundPosition = "";
    }
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
    // the post modal and confirm dialog render as siblings of .profile-shell
    // (appended near the end of <body>), so they need the accent set here
    // too - otherwise they'd fall back to nothing rather than inheriting it
    document.documentElement.style.setProperty("--accent", safeColor(p.accent));
    document.title = `${p.displayName} · Planora`;

    paintBanner($("heroBanner"), p.bannerImage, p.bannerPosition);
    paintAvatar($("avatarBig"), p.avatarImage, p.avatarColor, initialOf(p.displayName, p.username), p.avatarPosition);

    $("displayNameView").textContent = p.displayName;
    $("usernameView").textContent = "@" + p.username;

    const chip = $("roleChip");
    chip.textContent = roleLabel(p.role);
    chip.hidden = !roleLabel(p.role);

    $("editProfileButton").hidden = !p.isSelf;

    // bio
    const bio = $("bioView");
    bio.textContent = p.bio;
    bio.hidden = !p.bio;

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

    $("tabNote").textContent = p.isSelf
        ? "Anyone who visits your profile can see these."
        : "";

    renderEvents();
}

function renderEvents() {
    const grid = $("eventGrid");
    grid.textContent = "";

    const list = profile.publicEvents || [];

    if (!list.length) {
        grid.appendChild(emptyState());
        return;
    }

    list.forEach((event) => grid.appendChild(eventTile(event)));
}

function emptyState() {
    const box = document.createElement("div");
    box.className = "empty-state";

    const title = document.createElement("div");
    title.className = "empty-title";
    title.textContent = "No public events yet";

    const text = document.createElement("p");
    text.textContent = profile.isSelf
        ? "Press + on the calendar and switch the event to Public to show it here."
        : `${profile.displayName} hasn't shared any events.`;

    box.append(title, text);
    return box;
}

function eventTile(event) {
    const tile = document.createElement("article");
    tile.className = "event-tile";
    tile.setAttribute("role", "button");
    tile.setAttribute("tabindex", "0");

    const cover = document.createElement("div");
    cover.className = "tile-cover";

    const img = safeImage(event.image);
    if (img) {
        const pos = safePosition(event.image_position);
        cover.style.backgroundImage = `url("${img}")`;
        cover.style.backgroundPosition = `${pos.x}% ${pos.y}%`;
    } else {
        cover.style.background = `linear-gradient(135deg, ${safeColor(event.color)}, #1b1b1b)`;
        cover.textContent = event.icon;
    }

    // Quick add-to-calendar, right on the tile - only for someone else's
    // public event you haven't already added. Your own tiles and ones
    // you've already added don't get this.
    if (!profile.isSelf && !event.addedByMe) {
        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "tile-add-button";
        addBtn.textContent = "+";
        addBtn.setAttribute("aria-label", "Add to your calendar");
        addBtn.title = "Add to your calendar";
        addBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            quickAddToCalendar(event, addBtn);
        });
        cover.appendChild(addBtn);
    } else if (!profile.isSelf && event.addedByMe) {
        const addedMark = document.createElement("span");
        addedMark.className = "tile-added-mark";
        addedMark.textContent = "✓";
        addedMark.title = "Already on your calendar";
        cover.appendChild(addedMark);
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

    tile.addEventListener("click", () => openPost(event));
    tile.addEventListener("keydown", (e) => {
        if (e.key === "Enter") openPost(event);
    });

    return tile;
}

async function quickAddToCalendar(event, button) {
    button.disabled = true;
    try {
        await api(`/api/events/${event.id}/add`, { method: "POST" });
        event.addedByMe = true;
        toast(`Added "${event.title}" to your calendar.`, "success");
        renderEvents();
    } catch (err) {
        toast(err.message, "error");
        button.disabled = false;
    }
}


/* =========================================================
   POST VIEW (Instagram-style)
   Opens from a public event tile: the event's banner across the
   top, then its full comment thread below - same comment/reply
   system the homepage's Global feed uses, talking to the same
   endpoints, just laid out as a single post instead of a card in
   a list.
========================================================= */

let currentPostEvent = null;
let postReplyingTo = null;
let postComments = [];

function formatRelativeShort(ms) {
    const diffSeconds = Math.round((Date.now() - ms) / 1000);
    if (diffSeconds < 60) return "just now";
    if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m`;
    if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h`;
    if (diffSeconds < 7 * 86400) return `${Math.floor(diffSeconds / 86400)}d`;
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatFullTimestamp(ms) {
    return new Date(ms).toLocaleString(undefined, {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit"
    });
}

function profileHref(username) {
    return "profile.html?u=" + encodeURIComponent(username);
}

/* A themed "are you sure?" dialog, same pattern as the homepage's -
   used before deleting a comment or a reply. Resolves true/false. */
function confirmAction({ title, message, confirmLabel = "Delete" }) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "confirm-overlay";

        const box = document.createElement("div");
        box.className = "confirm-box";
        box.setAttribute("role", "alertdialog");
        box.setAttribute("aria-modal", "true");

        const titleEl = document.createElement("div");
        titleEl.className = "confirm-title";
        titleEl.textContent = title;

        const messageEl = document.createElement("p");
        messageEl.className = "confirm-message";
        messageEl.textContent = message;

        const buttons = document.createElement("div");
        buttons.className = "confirm-buttons";

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "confirm-cancel";
        cancelBtn.textContent = "Cancel";

        const confirmBtn = document.createElement("button");
        confirmBtn.type = "button";
        confirmBtn.className = "confirm-confirm";
        confirmBtn.textContent = confirmLabel;

        buttons.append(cancelBtn, confirmBtn);
        box.append(titleEl, messageEl, buttons);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        function close(result) {
            overlay.classList.remove("show");
            document.removeEventListener("keydown", onKeydown);
            setTimeout(() => overlay.remove(), 180);
            resolve(result);
        }
        function onKeydown(e) { if (e.key === "Escape") close(false); }

        cancelBtn.addEventListener("click", () => close(false));
        confirmBtn.addEventListener("click", () => close(true));
        overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
        document.addEventListener("keydown", onKeydown);

        requestAnimationFrame(() => {
            overlay.classList.add("show");
            cancelBtn.focus();
        });
    });
}

async function openPost(event) {
    currentPostEvent = event;
    postReplyingTo = null;

    const pos = safePosition(event.image_position);
    const banner = $("postBanner");
    if (safeImage(event.image)) {
        banner.style.backgroundImage = `url("${safeImage(event.image)}")`;
        banner.style.backgroundPosition = `${pos.x}% ${pos.y}%`;
        banner.classList.remove("no-image");
        banner.textContent = "";
    } else {
        banner.style.backgroundImage = "";
        banner.classList.add("no-image");
        banner.style.background = `linear-gradient(135deg, ${safeColor(event.color)}, #1b1b1b)`;
        banner.textContent = event.icon || "";
    }

    paintAvatar($("postAvatar"), profile.avatarImage, profile.avatarColor, initialOf(profile.displayName, profile.username), profile.avatarPosition);
    $("postAuthor").textContent = profile.displayName;
    $("postAuthor").href = profileHref(profile.username);
    $("postDate").textContent = formatEventDate(event);
    $("postTitle").textContent = event.title;

    const caption = $("postCaption");
    caption.textContent = event.description || "";
    caption.hidden = !event.description;

    const addButton = $("postAddButton");
    const addedTag = $("postAddedTag");
    if (!profile.isSelf && !event.addedByMe) {
        addButton.style.display = "";
        addedTag.style.display = "none";
        addButton.disabled = false;
        addButton.textContent = "Add to calendar";
    } else if (!profile.isSelf && event.addedByMe) {
        addButton.style.display = "none";
        addedTag.style.display = "";
    } else {
        addButton.style.display = "none";
        addedTag.style.display = "none";
    }

    resetPostComposer();

    $("postOverlay").hidden = false;
    $("postModal").classList.add("open");
    $("postModal").setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";

    $("postCommentList").innerHTML = "";
    await loadPostComments();
}

function closePost() {
    $("postModal").classList.remove("open");
    $("postModal").setAttribute("aria-hidden", "true");
    $("postOverlay").hidden = true;
    document.body.style.overflow = "";
    currentPostEvent = null;
}

async function loadPostComments() {
    if (!currentPostEvent) return;
    try {
        postComments = await api(`/api/events/${currentPostEvent.id}/comments`);
    } catch (err) {
        postComments = [];
    }
    renderPostComments();
}

function renderPostComments() {
    const list = $("postCommentList");
    list.innerHTML = "";

    if (postComments.length === 0) {
        const empty = document.createElement("div");
        empty.className = "comment-empty";
        empty.textContent = "No comments yet — say something.";
        list.appendChild(empty);
        return;
    }

    const knownIds = new Set(postComments.map(c => c.id));
    const topLevel = postComments.filter(c => !c.parent_id || !knownIds.has(c.parent_id));

    topLevel.forEach(top => {
        list.appendChild(postCommentRow(top, false));
        postComments
            .filter(r => r.parent_id === top.id)
            .forEach(reply => list.appendChild(postCommentRow(reply, true)));
    });
}

function postCommentRow(comment, isReply) {
    const row = document.createElement("div");
    row.className = "comment" + (isReply ? " comment-reply" : "");

    const isAuthor = viewer.username.toLowerCase() === comment.author.toLowerCase();
    const canModerate = viewer.role === "admin" || viewer.username.toLowerCase() === profile.username.toLowerCase();
    const canEdit = isAuthor;
    const canDelete = isAuthor || canModerate;

    const displayName = comment.authorDisplayName || comment.author;

    const avatar = document.createElement("a");
    avatar.className = "comment-avatar";
    avatar.href = profileHref(comment.author);
    avatar.title = displayName;
    if (safeImage(comment.authorAvatarImage)) {
        avatar.style.background = `center / cover no-repeat url("${comment.authorAvatarImage}")`;
    } else {
        avatar.style.background = `linear-gradient(135deg, ${safeColor(comment.authorAvatarColor)}, #1b1b1b)`;
        avatar.textContent = displayName.charAt(0).toUpperCase();
    }

    const author = document.createElement("a");
    author.className = "comment-author";
    author.href = profileHref(comment.author);
    author.textContent = "@" + comment.author;

    const time = document.createElement("span");
    time.className = "comment-time";
    time.dataset.timestamp = comment.created_at;
    time.textContent = formatRelativeShort(comment.created_at);
    time.title = formatFullTimestamp(comment.created_at);

    const text = document.createElement("span");
    text.className = "comment-text";
    if (comment.reply_to) {
        const mention = document.createElement("a");
        mention.className = "comment-mention";
        mention.href = profileHref(comment.reply_to);
        mention.textContent = "@" + comment.reply_to;
        text.appendChild(mention);
        text.appendChild(document.createTextNode(" "));
    }
    text.appendChild(document.createTextNode(comment.text));

    const body = document.createElement("span");
    body.className = "comment-body";
    body.append(author, time, text);

    if (comment.edited) {
        const edited = document.createElement("span");
        edited.className = "comment-edited";
        edited.textContent = "(edited)";
        body.appendChild(edited);
    }

    const actions = document.createElement("span");
    actions.className = "comment-actions";

    const replyBtn = document.createElement("button");
    replyBtn.type = "button";
    replyBtn.className = "comment-reply-button";
    replyBtn.textContent = "Reply";
    replyBtn.addEventListener("click", () => startPostReply(comment));
    actions.appendChild(replyBtn);

    if (canEdit) {
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "comment-reply-button";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", () => enterPostCommentEdit(comment, row, body));
        actions.appendChild(editBtn);
    }

    if (canDelete) {
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "comment-reply-button danger";
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", async () => {
            const replyCount = isReply ? 0 : postComments.filter(r => r.parent_id === comment.id).length;
            const confirmed = await confirmAction({
                title: isReply ? "Delete this reply?" : "Delete this comment?",
                message: replyCount > 0
                    ? `This will also delete ${replyCount === 1 ? "its 1 reply" : `its ${replyCount} replies`}. This can't be undone.`
                    : "This can't be undone.",
                confirmLabel: "Delete"
            });
            if (!confirmed) return;
            try {
                await api(`/api/events/${currentPostEvent.id}/comments/${comment.id}`, { method: "DELETE" });
                toast(isReply ? "Reply deleted." : "Comment deleted.");
                await loadPostComments();
            } catch (err) {
                toast(err.message, "error");
            }
        });
        actions.appendChild(deleteBtn);
    }

    body.appendChild(actions);
    row.append(avatar, body);
    return row;
}

function enterPostCommentEdit(comment, row, body) {
    const editInput = document.createElement("input");
    editInput.className = "comment-edit-input";
    editInput.value = comment.text;
    editInput.maxLength = 240;

    const saveBtn = document.createElement("button");
    saveBtn.className = "comment-edit-save";
    saveBtn.textContent = "Save";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "comment-edit-cancel";
    cancelBtn.textContent = "Cancel";

    const editRow = document.createElement("div");
    editRow.className = "comment-edit-row";
    editRow.append(editInput, saveBtn, cancelBtn);

    body.replaceWith(editRow);
    editInput.focus();
    editInput.setSelectionRange(editInput.value.length, editInput.value.length);

    async function save() {
        if (!editInput.value.trim()) return;
        try {
            await api(`/api/events/${currentPostEvent.id}/comments/${comment.id}`, {
                method: "PUT",
                body: JSON.stringify({ text: editInput.value })
            });
            toast("Comment updated.");
            await loadPostComments();
        } catch (err) {
            toast(err.message, "error");
        }
    }

    saveBtn.addEventListener("click", save);
    cancelBtn.addEventListener("click", () => renderPostComments());
    editInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape") renderPostComments();
    });
}

function startPostReply(comment) {
    postReplyingTo = comment;
    $("postReplyLabel").textContent = `Replying to @${comment.author}`;
    $("postReplyBanner").classList.add("show");
    $("postCommentInput").placeholder = `Reply to @${comment.author}...`;
    $("postCommentInput").focus();
}

function cancelPostReply() {
    postReplyingTo = null;
    $("postReplyBanner").classList.remove("show");
    $("postCommentInput").placeholder = "Add a comment...";
}

function resetPostComposer() {
    postReplyingTo = null;
    $("postReplyBanner").classList.remove("show");
    const input = $("postCommentInput");
    input.value = "";
    input.style.height = "auto";
    input.placeholder = "Add a comment...";
    input.disabled = false;
    updatePostCommentCounter();
}

function updatePostCommentCounter() {
    const input = $("postCommentInput");
    const counter = $("postCommentCounter");
    const submit = $("postCommentSubmit");
    const remaining = input.maxLength - input.value.length;
    counter.textContent = remaining <= 40 ? String(remaining) : "";
    counter.classList.toggle("low", remaining <= 20);
    submit.disabled = input.value.trim().length === 0;
}

function autosizePostInput() {
    const input = $("postCommentInput");
    input.style.height = "auto";
    const next = Math.min(input.scrollHeight, 120);
    input.style.height = next + "px";
    input.style.overflowY = input.scrollHeight > 120 ? "auto" : "hidden";
}

async function submitPostComment() {
    const input = $("postCommentInput");
    const submit = $("postCommentSubmit");
    const text = input.value;
    if (!text.trim() || submit.disabled) return;

    const wasReply = Boolean(postReplyingTo);
    input.disabled = true;
    submit.disabled = true;
    submit.textContent = "Posting…";

    try {
        await api(`/api/events/${currentPostEvent.id}/comments`, {
            method: "POST",
            body: JSON.stringify({ text, parentId: postReplyingTo ? postReplyingTo.id : null })
        });
        toast(wasReply ? "Reply posted." : "Comment posted.", "success");
        resetPostComposer();
        submit.textContent = "Post";
        await loadPostComments();
    } catch (err) {
        toast(err.message, "error");
        input.disabled = false;
        submit.textContent = "Post";
        updatePostCommentCounter();
    }
}

function bindPostModal() {
    $("postClose").addEventListener("click", closePost);
    $("postOverlay").addEventListener("click", closePost);
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && $("postModal").classList.contains("open")) closePost();
    });

    $("postReplyCancel").addEventListener("click", cancelPostReply);

    const input = $("postCommentInput");
    input.addEventListener("input", () => {
        autosizePostInput();
        updatePostCommentCounter();
    });
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            submitPostComment();
        }
        if (e.key === "Escape" && postReplyingTo) cancelPostReply();
    });
    $("postCommentSubmit").addEventListener("click", submitPostComment);

    $("postAddButton").addEventListener("click", async () => {
        const button = $("postAddButton");
        button.disabled = true;
        try {
            await api(`/api/events/${currentPostEvent.id}/add`, { method: "POST" });
            currentPostEvent.addedByMe = true;
            button.style.display = "none";
            $("postAddedTag").style.display = "";
            toast(`Added "${currentPostEvent.title}" to your calendar.`, "success");
            renderEvents();
        } catch (err) {
            toast(err.message, "error");
            button.disabled = false;
        }
    });

    // refresh comment timestamps periodically, same idea as the homepage
    setInterval(() => {
        document.querySelectorAll("#postCommentList .comment-time[data-timestamp]").forEach(el => {
            el.textContent = formatRelativeShort(Number(el.dataset.timestamp));
        });
    }, 60000);
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
        bio: p.bio,
        interests: (p.interests || []).join(", "),
        accent: safeColor(p.accent),
        avatarImage: p.avatarImage || "",
        avatarPosition: safePosition(p.avatarPosition),
        bannerImage: p.bannerImage || "",
        bannerPosition: safePosition(p.bannerPosition)
    };

    $("displayNameInput").value = draft.displayName;
    $("bioInput").value = draft.bio;
    $("interestsInput").value = draft.interests;

    $("gifAllowedTag").style.display = Planora.canUseGif(viewer) ? "" : "none";

    updateAvatarRepositionVisual();
    updateBannerRepositionVisual();

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
    draft.bio = $("bioInput").value;
    draft.interests = $("interestsInput").value;
}

function updateEditorPreview() {
    const name = draft.displayName.trim() || profile.username;

    $("previewCard").style.setProperty("--accent", draft.accent);
    paintBanner($("previewBanner"), draft.bannerImage, draft.bannerPosition);
    paintAvatar($("previewAvatar"), draft.avatarImage, profile.avatarColor, initialOf(name, profile.username), draft.avatarPosition);

    $("previewName").textContent = name;
    $("previewHandle").textContent = "@" + profile.username;

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
        "displayNameInput", "bioInput", "interestsInput"
    ].forEach((id) => {
        $(id).addEventListener("input", () => {
            readInputsIntoDraft();
            updateEditorPreview();
        });
    });

    $("customAccent").addEventListener("input", (event) => setAccent(event.target.value));

    // avatar photo
    const avatarInput = $("avatarImageInput");
    avatarInput.addEventListener("change", async () => {
        const file = avatarInput.files[0];
        if (!file) return;

        try {
            draft.avatarImage = await Planora.resizeImage(file, { allowGif: Planora.canUseGif(viewer) });
            draft.avatarPosition = { x: 50, y: 50 };
            updateAvatarRepositionVisual();
            updateEditorPreview();
        } catch (err) {
            toast(err.message, "error");
        }
        avatarInput.value = ""; // lets you pick the same file twice in a row
    });

    $("removeAvatarImage").addEventListener("click", () => {
        draft.avatarImage = "";
        draft.avatarPosition = { x: 50, y: 50 };
        updateAvatarRepositionVisual();
        updateEditorPreview();
    });

    // banner photo
    const bannerInput = $("bannerImageInput");
    bannerInput.addEventListener("change", async () => {
        const file = bannerInput.files[0];
        if (!file) return;

        try {
            draft.bannerImage = await resizeBanner(file, Planora.canUseGif(viewer));
            draft.bannerPosition = { x: 50, y: 50 };
            updateBannerRepositionVisual();
            updateEditorPreview();
        } catch (err) {
            toast(err.message, "error");
        }
        bannerInput.value = "";
    });

    $("removeBannerImage").addEventListener("click", () => {
        draft.bannerImage = "";
        draft.bannerPosition = { x: 50, y: 50 };
        updateBannerRepositionVisual();
        updateEditorPreview();
    });

    bindRepositionDrag($("avatarFrame"), () => draft.avatarImage, (pos) => {
        draft.avatarPosition = pos;
        updateAvatarRepositionVisual();
    }, updateEditorPreview);

    bindRepositionDrag($("bannerFrame"), () => draft.bannerImage, (pos) => {
        draft.bannerPosition = pos;
        updateBannerRepositionVisual();
    }, updateEditorPreview);

    $("saveProfile").addEventListener("click", saveProfile);
}

/* Shared by the avatar and banner drag frames (and by the create/edit
   event form's own cover-image frame, conceptually - this is the profile
   page's copy of the same idea). Pointer Events cover mouse and touch in
   one path. `onMove` fires continuously while dragging for live visual
   feedback; `onEnd` fires once when the drag finishes. */
function bindRepositionDrag(frame, hasImage, onMove, onEnd) {
    let dragging = false;

    function positionFromPointer(e) {
        const rect = frame.getBoundingClientRect();
        const x = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
        const y = Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100));
        return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
    }

    frame.addEventListener("pointerdown", (e) => {
        if (!hasImage()) return;
        dragging = true;
        frame.setPointerCapture(e.pointerId);
        onMove(positionFromPointer(e));
    });
    frame.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        onMove(positionFromPointer(e));
    });
    function end() {
        if (!dragging) return;
        dragging = false;
        onEnd();
    }
    frame.addEventListener("pointerup", end);
    frame.addEventListener("pointercancel", end);
}

function updateAvatarRepositionVisual() {
    const wrap = $("avatarReposition");
    const photo = $("avatarPhoto");
    const crosshair = $("avatarCrosshair");
    const img = safeImage(draft.avatarImage);

    wrap.style.display = img ? "block" : "none";
    if (!img) return;

    const pos = safePosition(draft.avatarPosition);
    photo.style.backgroundImage = `url("${img}")`;
    photo.style.backgroundPosition = `${pos.x}% ${pos.y}%`;
    crosshair.style.left = `${pos.x}%`;
    crosshair.style.top = `${pos.y}%`;
}

function updateBannerRepositionVisual() {
    const wrap = $("bannerReposition");
    const photo = $("bannerPhoto");
    const crosshair = $("bannerCrosshair");
    const img = safeImage(draft.bannerImage);

    wrap.style.display = img ? "block" : "none";
    if (!img) return;

    const pos = safePosition(draft.bannerPosition);
    photo.style.backgroundImage = `url("${img}")`;
    photo.style.backgroundPosition = `${pos.x}% ${pos.y}%`;
    crosshair.style.left = `${pos.x}%`;
    crosshair.style.top = `${pos.y}%`;
}

/* Crops to a wide 3:1 strip and shrinks it, so it fits under the
   server's image size limit no matter what got picked. A GIF skips this
   entirely when allowed - resizing it through <canvas> would flatten it
   to a single frame and throw away the animation, so an allowed GIF is
   read through as-is instead (still subject to the server's size limit). */
function resizeBanner(file, allowGif) {
    return new Promise((resolve, reject) => {
        if (!file.type.startsWith("image/")) {
            reject(new Error("Pick an image file."));
            return;
        }

        if (file.type === "image/gif") {
            if (!allowGif) {
                reject(new Error("GIFs need a Community+ or Admin account."));
                return;
            }
            const reader = new FileReader();
            reader.onerror = () => reject(new Error("Couldn't read that file."));
            reader.onload = () => {
                if (reader.result.length > 300000) {
                    reject(new Error("That GIF is too big. Try a smaller one (under ~220KB)."));
                    return;
                }
                resolve(reader.result);
            };
            reader.readAsDataURL(file);
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

    const saveButton = $("saveProfile");
    saveButton.disabled = true;

    try {
        await api("/api/me", {
            method: "PUT",
            body: JSON.stringify({
                displayName,
                bio: draft.bio.trim(),
                interests: parseInterests(draft.interests),
                accent: draft.accent,
                avatarImage: draft.avatarImage,
                avatarPosition: draft.avatarPosition,
                bannerImage: draft.bannerImage,
                bannerPosition: draft.bannerPosition
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

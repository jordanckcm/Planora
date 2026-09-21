/* =========================================================
   PLANORA — PROFILE PAGE
   The avatar color picker is gone — avatarColor is still set
   automatically at signup (app.py's pick_avatar_color) and used
   as the fallback behind initials when there's no photo, but
   it's no longer something you choose here. Upload a photo
   instead; "Remove" goes back to the color+initial fallback.
========================================================= */

let user = null;

// staged, not yet saved — becomes real on "Save changes",
// same as displayName/bio already worked
let pendingAvatarImage = "";

(async function start() {
    user = await Planora.requireAuth();
    if (!user) return;

    await render();
    bindActions();
})();

function toast(message, type = "") {
    const stack = document.getElementById("toastStack");
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 3200);
}

/* Applies whatever avatar (image, or color+initial) to a given element —
   used for both the big header avatar and the picker's live preview, so
   the two never disagree about what "no photo" looks like. */
function paintAvatar(el, imageDataUrl, color, initial) {
    el.textContent = "";
    if (imageDataUrl) {
        el.style.background = `center / cover no-repeat url("${imageDataUrl}")`;
    } else {
        el.style.background = `linear-gradient(135deg, ${color}, #1b1b1b)`;
        el.textContent = initial;
    }
}

async function render() {
    const initial = (user.displayName || user.username || "?").charAt(0).toUpperCase();

    paintAvatar(document.getElementById("avatarBig"), user.avatarImage, user.avatarColor, initial);

    document.getElementById("displayNameView").textContent = user.displayName;
    document.getElementById("usernameView").textContent = "@" + user.username;

    document.getElementById("displayNameInput").value = user.displayName;
    document.getElementById("bioInput").value = user.bio || "";

    pendingAvatarImage = user.avatarImage || "";
    setAvatarPreview(pendingAvatarImage, initial);

    try {
        const stats = await PlanoraData.getStats();
        document.getElementById("statEvents").textContent = stats.events;
        document.getElementById("statComments").textContent = stats.comments;
    } catch (err) {
        // stats are a nice-to-have, don't block the rest of the page if they fail
    }

    const since = new Date(user.createdAt);
    document.getElementById("statSince").textContent =
        since.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function setAvatarPreview(imageDataUrl, initial) {
    const preview = document.getElementById("avatarImagePreview");
    const removeBtn = document.getElementById("removeAvatarImage");

    paintAvatar(preview, imageDataUrl, user.avatarColor, initial);
    preview.classList.toggle("show", true); // always visible here, unlike the event-cover picker
    removeBtn.style.display = imageDataUrl ? "inline-flex" : "none";
}

function bindActions() {

    document.getElementById("backButton").addEventListener("click", () => {
        window.location.href = "homepage.html";
    });

    document.getElementById("logoutButton").addEventListener("click", doLogout);
    document.getElementById("logoutButtonSecondary").addEventListener("click", doLogout);

    async function doLogout() {
        await Planora.logout();
        window.location.href = "login.html";
    }

    const imageInput = document.getElementById("avatarImageInput");
    imageInput.addEventListener("change", async () => {
        const file = imageInput.files[0];
        if (!file) return;

        const initial = (user.displayName || user.username || "?").charAt(0).toUpperCase();
        try {
            pendingAvatarImage = await Planora.resizeImage(file);
            setAvatarPreview(pendingAvatarImage, initial);
        } catch (err) {
            toast(err.message, "error");
        }
        imageInput.value = ""; // lets you pick the same file twice in a row
    });

    document.getElementById("removeAvatarImage").addEventListener("click", () => {
        pendingAvatarImage = "";
        const initial = (user.displayName || user.username || "?").charAt(0).toUpperCase();
        setAvatarPreview("", initial);
    });

    document.getElementById("saveProfile").addEventListener("click", async () => {
        const displayName = document.getElementById("displayNameInput").value.trim();
        const bio = document.getElementById("bioInput").value.trim();

        if (!displayName) {
            toast("Display name can't be empty.", "error");
            return;
        }

        try {
            user = await Planora.updateProfile({
                displayName,
                bio,
                avatarImage: pendingAvatarImage
            });
            await render();

            const note = document.getElementById("saveNote");
            note.textContent = "Saved.";
            setTimeout(() => { note.textContent = ""; }, 2000);
        } catch (err) {
            toast(err.message, "error");
        }
    });
}

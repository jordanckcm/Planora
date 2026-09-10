/* =========================================================
   PLANORA — HOMEPAGE
   Works with the original homepage.html/css. "Local" and
   "Global" double as the local/global switch, and the add
   button + form + comments are all built here in JS, same
   as the original file did for the add button and form.

   ROLE NOTES:
   currentUser.role is one of "community" | "community_plus" | "admin".
   The UI below hides/disables things based on role purely for a
   nicer experience — the server (app.py) is what actually enforces
   permissions and limits, so nothing here is a security boundary.
========================================================= */

let currentUser = null;
let currentYear = new Date().getFullYear();
let mode = "local"; // "local" | "global"
let openMonth = null;
let shownOfflineToast = false;

const monthButtons = document.querySelectorAll(".month-events-container");
const yearDisplay = document.getElementById("year");
const localButton = document.querySelector(".local-button");
const globalButton = document.querySelector(".global-button");


function toast(message, type = "") {
    const stack = document.getElementById("toastStack");
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 3200);
}


/* =========================
   STARTUP
========================= */

(async function start() {
    currentUser = await Planora.requireAuth();
    if (!currentUser) return; // requireAuth already redirected to login

    document.querySelector(".profile").style.background =
        `linear-gradient(135deg, ${currentUser.avatarColor}, #111)`;

    buildProfileMenu();
    showRoleBadge();
    enhanceMonthHeaders();
    bindModeButtons();
    bindYearButtons();
    buildAddEventUI();

    setActiveModeButton();
    await render();
})();


/* =========================
   ROLE-BASED UI
   Purely cosmetic — the server enforces the real limits and
   permissions no matter what the UI shows or hides.
========================= */

function roleLabel(role) {
    if (role === "admin") return "Admin";
    if (role === "community_plus") return "Community+";
    return "Community";
}

function showRoleBadge() {
    const badge = document.getElementById("roleBadge");
    if (badge) badge.textContent = roleLabel(currentUser.role);
}

/* Groups .event-count with a little chevron that rotates when a
   month is open, without disturbing the header's left/right layout. */
function enhanceMonthHeaders() {
    monthButtons.forEach(monthEl => {
        const countEl = monthEl.querySelector(".event-count");

        const meta = document.createElement("div");
        meta.className = "month-meta";
        monthEl.insertBefore(meta, countEl);
        meta.appendChild(countEl);

        const chevron = document.createElement("span");
        chevron.className = "month-chevron";
        chevron.textContent = "⌄";
        chevron.setAttribute("aria-hidden", "true");
        meta.appendChild(chevron);
    });
}


/* =========================
   PROFILE MENU
   Avatar opens a small dropdown (View profile / Admin panel /
   Log out) instead of separate topbar buttons, which is what
   used to break the layout on narrow screens.
========================= */

function buildProfileMenu() {
    const profileButton = document.getElementById("profileButton");
    const dropdown = document.getElementById("profileDropdown");

    if (currentUser.role === "admin") {
        const adminItem = document.createElement("button");
        adminItem.className = "profile-dropdown-item";
        adminItem.id = "adminItem";
        adminItem.textContent = "Admin panel";
        adminItem.addEventListener("click", () => {
            window.location.href = "admin.html";
        });
        dropdown.insertBefore(adminItem, dropdown.querySelector(".profile-dropdown-divider"));
    }

    function openDropdown() {
        dropdown.classList.add("show");
        profileButton.setAttribute("aria-expanded", "true");
    }

    function closeDropdown() {
        dropdown.classList.remove("show");
        profileButton.setAttribute("aria-expanded", "false");
    }

    profileButton.addEventListener("click", (e) => {
        e.stopPropagation();
        dropdown.classList.contains("show") ? closeDropdown() : openDropdown();
    });

    document.addEventListener("click", (e) => {
        if (!dropdown.contains(e.target) && e.target !== profileButton) {
            closeDropdown();
        }
    });

    document.getElementById("viewProfileItem").addEventListener("click", () => {
        window.location.href = "profile.html";
    });

    document.getElementById("logoutItem").addEventListener("click", async () => {
        await Planora.logout();
        window.location.href = "login.html";
    });
}

function bindModeButtons() {
    localButton.addEventListener("click", () => {
        mode = "local";
        setActiveModeButton();
        openMonth = null;
        render();
    });

    globalButton.addEventListener("click", () => {
        mode = "global";
        setActiveModeButton();
        openMonth = null;
        render();
    });
}

function setActiveModeButton() {
    localButton.classList.toggle("mode-active", mode === "local");
    globalButton.classList.toggle("mode-active", mode === "global");

    document.body.classList.toggle("mode-local", mode === "local");
    document.body.classList.toggle("mode-global", mode === "global");
}

function bindYearButtons() {
    document.getElementById("previousYear").addEventListener("click", () => {
        currentYear--;
        openMonth = null;
        animateYearSwitch("prev");
        render();
    });

    document.getElementById("nextYear").addEventListener("click", () => {
        currentYear++;
        openMonth = null;
        animateYearSwitch("next");
        render();
    });
}

function animateYearSwitch(direction) {
    const yearClass = direction === "next" ? "year-animate-next" : "year-animate-prev";

    // remove + force reflow so the animation restarts even if you
    // mash the arrows quickly
    yearDisplay.classList.remove("year-animate-next", "year-animate-prev");
    void yearDisplay.offsetWidth;
    yearDisplay.classList.add(yearClass);

    document.querySelectorAll(".month-wrapper").forEach((wrapper, i) => {
        wrapper.classList.remove("month-animate");
        void wrapper.offsetWidth;
        wrapper.style.animationDelay = `${i * 35}ms`;
        wrapper.classList.add("month-animate");
    });
}


/* =========================
   MONTH CLICK
========================= */

monthButtons.forEach(monthEl => {
    monthEl.addEventListener("click", () => {
        // quick tactile press bounce — restart it even on rapid taps
        monthEl.classList.remove("month-press");
        void monthEl.offsetWidth;
        monthEl.classList.add("month-press");

        const monthNumber = Number(monthEl.dataset.month);
        openMonth = openMonth === monthNumber ? null : monthNumber;
        render();
    });
});


/* =========================
   RENDER
========================= */

async function render() {
    yearDisplay.textContent = currentYear;

    let events;
    try {
        events = await PlanoraData.getEvents(mode, currentYear);
        if (events.fromCache) {
            if (!shownOfflineToast) {
                toast("You're offline — showing your last saved local events.");
                shownOfflineToast = true;
            }
        } else {
            shownOfflineToast = false;
        }
    } catch (err) {
        toast(err.message, "error");
        return;
    }

    for (const monthEl of monthButtons) {
        const monthNumber = Number(monthEl.dataset.month);
        const countEl = monthEl.querySelector(".event-count");
        const container = monthEl.parentElement.querySelector(".events-container");
        const isOpen = openMonth === monthNumber;

        const monthEvents = events
            .filter(e => new Date(e.date).getMonth() + 1 === monthNumber)
            .sort((a, b) => new Date(a.date) - new Date(b.date));

        countEl.textContent = monthEvents.length === 0
            ? "NO EVENTS"
            : monthEvents.length === 1
                ? "01 EVENT"
                : String(monthEvents.length).padStart(2, "0") + " EVENTS";

        monthEl.classList.toggle("month-open", isOpen);
        container.classList.toggle("open", isOpen);

        if (!isOpen) {
            // leave old content in place — it's fully clipped by the
            // collapsed grid row, and gets rebuilt fresh next time it opens
            continue;
        }

        await renderMonthEvents(container, monthEvents);
    }
}

async function renderMonthEvents(container, monthEvents) {
    let inner = container.querySelector(".events-inner");
    if (!inner) {
        inner = document.createElement("div");
        inner.className = "events-inner";
        container.appendChild(inner);
    }
    inner.innerHTML = "";

    if (monthEvents.length === 0) {
        const empty = document.createElement("div");
        empty.className = "no-events";
        empty.textContent = mode === "local"
            ? "Nothing here yet — tap + to add something."
            : "No one's posted to the table this month yet.";
        inner.appendChild(empty);
        return;
    }

    for (const event of monthEvents) {
        inner.appendChild(await buildEventCard(event));
    }
}

async function buildEventCard(event) {
    const day = new Date(event.date).getDate();

    const card = document.createElement("div");
    card.className = "event";

    const main = document.createElement("div");
    main.className = "event-main";

    const dayEl = document.createElement("div");
    dayEl.className = "event-day";
    dayEl.textContent = day;

    const info = document.createElement("div");
    info.className = "event-info";

    const titleRow = document.createElement("div");
    titleRow.className = "event-title-row";

    const titleEl = document.createElement("div");
    titleEl.className = "event-title";
    titleEl.textContent = event.title; // textContent, never innerHTML, for user-typed text
    titleRow.appendChild(titleEl);

    if (mode === "global") {
        const authorEl = document.createElement("div");
        authorEl.className = "event-author";
        authorEl.textContent = event.isMine ? "you" : "@" + event.owner;
        titleRow.appendChild(authorEl);
    }

    info.appendChild(titleRow);

    if (event.description) {
        const descEl = document.createElement("div");
        descEl.className = "event-description";
        descEl.textContent = event.description;
        info.appendChild(descEl);
    }

    const dateEl = document.createElement("div");
    dateEl.className = "event-date";
    dateEl.textContent = event.date;
    info.appendChild(dateEl);

    main.appendChild(dayEl);
    main.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "event-actions";

    // Deleting your own event: everyone can do this, any role, any mode.
    if (event.isMine) {
        const removeBtn = document.createElement("button");
        removeBtn.className = "event-action-btn danger";
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            try {
                await PlanoraData.deleteEvent(event.id);
                toast("Removed from your calendar.");
                render();
            } catch (err) {
                toast(err.message, "error");
            }
        });
        actions.appendChild(removeBtn);
    }

    // Admins can also remove events posted by other people in Global.
    if (mode === "global" && !event.isMine && currentUser.role === "admin") {
        const adminRemoveBtn = document.createElement("button");
        adminRemoveBtn.className = "event-action-btn danger";
        adminRemoveBtn.textContent = "Remove (admin)";
        adminRemoveBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            try {
                // Direct fetch since this hits a new admin-only endpoint
                // that isn't in api.js yet — add a PlanoraData.adminDeleteEvent
                // helper there if you'd rather keep this consistent with
                // the rest of your data calls.
                const res = await fetch(`/api/admin/events/${event.id}`, { method: "DELETE" });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || "Couldn't remove that event.");
                toast("Removed by admin.");
                render();
            } catch (err) {
                toast(err.message, "error");
            }
        });
        actions.appendChild(adminRemoveBtn);
    }

    if (mode === "global" && !event.isMine) {
        const addBtn = document.createElement("button");
        addBtn.className = "event-action-btn";
        addBtn.textContent = "Add to my calendar";
        addBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            try {
                await PlanoraData.addToMyCalendar(event.id);
                toast(`Added "${event.title}" to your calendar.`, "success");
                addBtn.textContent = "Added ✓";
                addBtn.classList.add("added");
                addBtn.disabled = true;
            } catch (err) {
                toast(err.message, "error");
            }
        });
        actions.appendChild(addBtn);
    }

    main.appendChild(actions);
    card.appendChild(main);

    if (mode === "global") {
        card.appendChild(await buildComments(event));
    }

    return card;
}


/* =========================
   COMMENTS
========================= */

async function buildComments(event) {
    const wrap = document.createElement("div");
    wrap.className = "comments";

    const list = document.createElement("div");
    list.className = "comment-list";

    let comments = [];
    try {
        comments = await PlanoraData.getComments(event.id);
    } catch (err) {
        // if this fails we just show an empty thread instead of breaking the page
    }

    if (comments.length === 0) {
        const empty = document.createElement("div");
        empty.className = "comment-empty";
        empty.textContent = "No comments yet — say something.";
        list.appendChild(empty);
    } else {
        const canModerate = currentUser.role === "admin"
            || currentUser.username.toLowerCase() === event.owner.toLowerCase();

        comments.forEach(comment => {
            const c = document.createElement("div");
            c.className = "comment";

            const isAuthor = currentUser.username.toLowerCase() === comment.author.toLowerCase();
            const canEdit = isAuthor;
            const canDelete = isAuthor || canModerate;

            const author = document.createElement("span");
            author.className = "comment-author";
            author.textContent = "@" + comment.author;

            const text = document.createElement("span");
            text.className = "comment-text";
            text.textContent = comment.text;

            const body = document.createElement("span");
            body.className = "comment-body";
            body.appendChild(author);
            body.appendChild(text);

            if (comment.edited) {
                const edited = document.createElement("span");
                edited.className = "comment-edited";
                edited.textContent = "(edited)";
                body.appendChild(edited);
            }

            function enterEditMode() {
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
                editRow.appendChild(editInput);
                editRow.appendChild(saveBtn);
                editRow.appendChild(cancelBtn);

                body.replaceWith(editRow);
                editInput.focus();
                editInput.setSelectionRange(editInput.value.length, editInput.value.length);

                async function save() {
                    if (!editInput.value.trim()) return;
                    try {
                        await PlanoraData.editComment(event.id, comment.id, editInput.value);
                        render();
                    } catch (err) {
                        toast(err.message, "error");
                    }
                }

                saveBtn.addEventListener("click", (e) => { e.stopPropagation(); save(); });
                cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); render(); });
                editInput.addEventListener("click", (e) => e.stopPropagation());
                editInput.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") save();
                    if (e.key === "Escape") render();
                });
            }

            if (canEdit || canDelete) {
                const menuWrap = document.createElement("div");
                menuWrap.className = "comment-menu";

                const menuButton = document.createElement("button");
                menuButton.className = "comment-menu-button";
                menuButton.textContent = "⋮";
                menuButton.setAttribute("aria-label", "Comment options");
                menuButton.setAttribute("aria-haspopup", "true");

                const dropdown = document.createElement("div");
                dropdown.className = "comment-dropdown";

                if (canEdit) {
                    const editItem = document.createElement("button");
                    editItem.className = "comment-dropdown-item";
                    editItem.textContent = "Edit";
                    editItem.addEventListener("click", (e) => {
                        e.stopPropagation();
                        dropdown.classList.remove("show");
                        enterEditMode();
                    });
                    dropdown.appendChild(editItem);
                }

                if (canDelete) {
                    const deleteItem = document.createElement("button");
                    deleteItem.className = "comment-dropdown-item danger";
                    deleteItem.textContent = "Delete";
                    deleteItem.addEventListener("click", async (e) => {
                        e.stopPropagation();
                        try {
                            await PlanoraData.deleteComment(event.id, comment.id);
                            render();
                        } catch (err) {
                            toast(err.message, "error");
                        }
                    });
                    dropdown.appendChild(deleteItem);
                }

                menuButton.addEventListener("click", (e) => {
                    e.stopPropagation();
                    dropdown.classList.toggle("show");
                });

                menuWrap.appendChild(menuButton);
                menuWrap.appendChild(dropdown);
                c.appendChild(menuWrap);
            }

            c.appendChild(body);
            list.appendChild(c);
        });
    }

    const form = document.createElement("div");
    form.className = "comment-form";

    const input = document.createElement("input");
    input.className = "comment-input";
    input.placeholder = "Add a comment...";
    input.maxLength = 240;

    const submit = document.createElement("button");
    submit.className = "comment-submit";
    submit.textContent = "Post";

    async function postComment() {
        if (!input.value.trim()) return;
        try {
            await PlanoraData.addComment(event.id, input.value);
            input.value = "";
            render();
        } catch (err) {
            toast(err.message, "error");
        }
    }

    submit.addEventListener("click", (e) => { e.stopPropagation(); postComment(); });
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") postComment();
    });

    form.appendChild(input);
    form.appendChild(submit);

    wrap.appendChild(list);
    wrap.appendChild(form);

    return wrap;
}


/* =========================
   SCROLL-AWARE + BUTTON
   Hides the add-event button while scrolling down, brings it
   back as soon as the user scrolls up even a little.
========================= */

function bindScrollHide(button) {
    let lastY = window.scrollY;
    let ticking = false;

    function onScroll() {
        const currentY = window.scrollY;
        const scrolledDown = currentY > lastY;
        const pastTopBuffer = currentY > 80; // never hide it right near the top

        if (scrolledDown && pastTopBuffer) {
            button.classList.add("hide-on-scroll");
        } else {
            button.classList.remove("hide-on-scroll");
        }

        lastY = currentY;
        ticking = false;
    }

    window.addEventListener("scroll", () => {
        if (!ticking) {
            requestAnimationFrame(onScroll);
            ticking = true;
        }
    }, { passive: true });
}


/* =========================
   ADD EVENT
========================= */

function buildAddEventUI() {

    const addButton = document.createElement("button");
    addButton.className = "add-event-button";
    addButton.textContent = "+";
    document.body.appendChild(addButton);

    bindScrollHide(addButton);

    const eventForm = document.createElement("div");
    eventForm.className = "event-form";
    eventForm.innerHTML = `
        <div class="event-form-box">
            <div class="form-title">Create event</div>

            <input type="text" id="eventTitle" placeholder="Event name" maxlength="80">
            <textarea id="eventDescription" placeholder="Description" maxlength="400"></textarea>
            <input type="date" id="eventDate">

            <div class="visibility-row">
                <input type="checkbox" id="eventVisibility">
                <label for="eventVisibility">Post to Global (everyone can see this)</label>
            </div>
            <div class="visibility-locked-hint" id="visibilityLockedHint" style="display:none;">
                Global posting needs Community+ or Admin. Ask an admin to upgrade your account.
            </div>

            <div class="form-buttons">
                <button id="cancelEvent">Cancel</button>
                <button id="saveEvent">Create</button>
            </div>
        </div>
    `;
    document.body.appendChild(eventForm);

    // Community accounts can't post to Global — hide the option rather
    // than let them pick it and get a 403 back from the server.
    if (currentUser.role === "community") {
        eventForm.querySelector(".visibility-row").style.display = "none";
        eventForm.querySelector("#visibilityLockedHint").style.display = "block";
    }

    addButton.addEventListener("click", () => {
        eventForm.classList.add("show");
        document.getElementById("eventTitle").value = "";
        document.getElementById("eventDescription").value = "";
        document.getElementById("eventDate").value = "";
        document.getElementById("eventVisibility").checked = false;
    });

    document.getElementById("cancelEvent").addEventListener("click", () => {
        eventForm.classList.remove("show");
    });

    document.getElementById("saveEvent").addEventListener("click", async () => {
        const title = document.getElementById("eventTitle").value.trim();
        const description = document.getElementById("eventDescription").value.trim();
        const date = document.getElementById("eventDate").value;
        const isPublic = currentUser.role !== "community"
            && document.getElementById("eventVisibility").checked;

        if (!title || !date) {
            toast("Add a name and date first.", "error");
            return;
        }

        try {
            await PlanoraData.addEvent({
                title,
                description,
                date,
                visibility: isPublic ? "global" : "local"
            });
        } catch (err) {
            toast(err.message, "error");
            return;
        }

        eventForm.classList.remove("show");

        currentYear = new Date(date).getFullYear();
        openMonth = new Date(date).getMonth() + 1;
        mode = "local";
        setActiveModeButton();

        toast(isPublic ? "Posted to Global and your calendar." : "Added to your calendar.", "success");
        render();
    });
}

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

// same palette as the profile avatar picker, reused for event color-tags
const EVENT_COLORS = ["#c9a227", "#489c48", "#b6453f", "#4a7fc9", "#9a56c9", "#c96f2e"];
const EVENT_ICONS = ["🎉", "🎮", "🎵", "🍕", "🏀", "🎨", "📚", "🌙", "🔥", "🎬"];

let selectedEventColor = EVENT_COLORS[0];
let selectedEventIcon = EVENT_ICONS[0];


function toast(message, type = "") {
    const stack = document.getElementById("toastStack");
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 3200);
}

/* "Today" / "Tomorrow" / "In 4 days" close to now, falls back to a
   normal short date further out. */
function formatEventDate(dateStr) {
    const eventDate = new Date(dateStr + "T00:00:00");
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const diffDays = Math.round((eventDate - today) / 86400000);

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Tomorrow";
    if (diffDays === -1) return "Yesterday";
    if (diffDays > 1 && diffDays <= 6) return `In ${diffDays} days`;
    if (diffDays < -1 && diffDays >= -6) return `${Math.abs(diffDays)} days ago`;

    return eventDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function isRecentlyPosted(event) {
    return Date.now() - event.created_at < 24 * 60 * 60 * 1000;
}

/* "7:30 PM" from a 24h "19:30" input value. */
function formatTime(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    const period = h >= 12 ? "PM" : "AM";
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

/* Combines the date/date-range with the start/end time, whichever of
   those the event actually has. All of it is optional, so this reads
   fine whether an event has a full range or just a single plain date. */
function formatEventWhen(event) {
    let dateLabel;

    if (event.end_date && event.end_date !== event.date) {
        const start = new Date(event.date + "T00:00:00");
        const end = new Date(event.end_date + "T00:00:00");
        const days = Math.round((end - start) / 86400000) + 1;
        const startLabel = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
        const endLabel = end.toLocaleDateString(undefined, { month: "short", day: "numeric" });
        dateLabel = `${startLabel} – ${endLabel} · ${days} days`;
    } else {
        dateLabel = formatEventDate(event.date);
    }

    if (event.start_time) {
        const timeLabel = event.end_time
            ? `${formatTime(event.start_time)} – ${formatTime(event.end_time)}`
            : formatTime(event.start_time);
        return `${dateLabel} · ${timeLabel}`;
    }

    return dateLabel;
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
    if (isRecentlyPosted(event)) card.classList.add("event-new");

    const cover = document.createElement("div");
    cover.className = "event-cover";
    cover.style.background = `${event.color || EVENT_COLORS[0]}26`; // ~15% tint
    cover.textContent = event.icon || EVENT_ICONS[0];
    card.appendChild(cover);

    const main = document.createElement("div");
    main.className = "event-main";

    const dayEl = document.createElement("div");
    dayEl.className = "event-day";
    dayEl.textContent = day;
    dayEl.style.color = event.color || EVENT_COLORS[0];

    const info = document.createElement("div");
    info.className = "event-info";

    const titleRow = document.createElement("div");
    titleRow.className = "event-title-row";

    const titleEl = document.createElement("div");
    titleEl.className = "event-title";
    titleEl.textContent = event.title; // textContent, never innerHTML, for user-typed text
    titleRow.appendChild(titleEl);

    if (isRecentlyPosted(event)) {
        const newBadge = document.createElement("span");
        newBadge.className = "event-new-badge";
        newBadge.textContent = "NEW";
        titleRow.appendChild(newBadge);
    }

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
    dateEl.textContent = formatEventWhen(event);
    info.appendChild(dateEl);

    if (mode === "global" && event.addedBy && event.addedBy.length > 0) {
        const goingRow = document.createElement("div");
        goingRow.className = "event-going";

        const stack = document.createElement("div");
        stack.className = "event-going-avatars";
        event.addedBy.slice(0, 5).forEach(person => {
            const dot = document.createElement("div");
            dot.className = "event-going-avatar";
            dot.style.background = person.avatarColor;
            dot.title = "@" + person.username;
            stack.appendChild(dot);
        });
        goingRow.appendChild(stack);

        const count = document.createElement("span");
        count.className = "event-going-count";
        count.textContent = event.addedBy.length === 1 ? "1 going" : `${event.addedBy.length} going`;
        goingRow.appendChild(count);

        info.appendChild(goingRow);
    }

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
                await PlanoraData.adminDeleteEvent(event.id);
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

            <div class="field-label">Starts</div>
            <input type="date" id="eventDate">

            <div class="field-label">Ends (optional — leave blank for a single day)</div>
            <input type="date" id="eventEndDate">

            <div class="field-label">Time (optional)</div>
            <div class="time-grid">
                <input type="time" id="eventStartTime">
                <input type="time" id="eventEndTime">
            </div>

            <div class="field-label">Icon</div>
            <div class="event-icon-row" id="eventIconRow"></div>

            <div class="field-label">Color</div>
            <div class="event-color-row" id="eventColorRow"></div>

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

    const iconRow = eventForm.querySelector("#eventIconRow");
    EVENT_ICONS.forEach(icon => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "event-icon-dot" + (icon === selectedEventIcon ? " selected" : "");
        btn.textContent = icon;
        btn.addEventListener("click", () => {
            selectedEventIcon = icon;
            iconRow.querySelectorAll(".event-icon-dot").forEach(el => el.classList.remove("selected"));
            btn.classList.add("selected");
        });
        iconRow.appendChild(btn);
    });

    const colorRow = eventForm.querySelector("#eventColorRow");
    EVENT_COLORS.forEach(color => {
        const dot = document.createElement("button");
        dot.type = "button";
        dot.className = "event-color-dot" + (color === selectedEventColor ? " selected" : "");
        dot.style.background = color;
        dot.addEventListener("click", () => {
            selectedEventColor = color;
            colorRow.querySelectorAll(".event-color-dot").forEach(el => el.classList.remove("selected"));
            dot.classList.add("selected");
        });
        colorRow.appendChild(dot);
    });

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
        document.getElementById("eventEndDate").value = "";
        document.getElementById("eventStartTime").value = "";
        document.getElementById("eventEndTime").value = "";
        document.getElementById("eventVisibility").checked = false;

        selectedEventIcon = EVENT_ICONS[0];
        selectedEventColor = EVENT_COLORS[0];
        iconRow.querySelectorAll(".event-icon-dot").forEach((el, i) => el.classList.toggle("selected", i === 0));
        colorRow.querySelectorAll(".event-color-dot").forEach((el, i) => el.classList.toggle("selected", i === 0));
    });

    document.getElementById("cancelEvent").addEventListener("click", () => {
        eventForm.classList.remove("show");
    });

    document.getElementById("saveEvent").addEventListener("click", async () => {
        const title = document.getElementById("eventTitle").value.trim();
        const description = document.getElementById("eventDescription").value.trim();
        const date = document.getElementById("eventDate").value;
        const endDate = document.getElementById("eventEndDate").value;
        const startTime = document.getElementById("eventStartTime").value;
        const endTime = document.getElementById("eventEndTime").value;
        const isPublic = currentUser.role !== "community"
            && document.getElementById("eventVisibility").checked;

        if (!title || !date) {
            toast("Add a name and date first.", "error");
            return;
        }

        if (endDate && endDate < date) {
            toast("End date can't be before the start date.", "error");
            return;
        }

        try {
            await PlanoraData.addEvent({
                title,
                description,
                date,
                endDate,
                startTime,
                endTime,
                visibility: isPublic ? "global" : "local",
                icon: selectedEventIcon,
                color: selectedEventColor
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

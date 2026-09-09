/* =========================================================
   PLANORA — HOMEPAGE
   Works with the original homepage.html/css. "Near" and
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

const monthButtons = document.querySelectorAll(".month-events-container");
const yearDisplay = document.getElementById("year");
const nearButton = document.querySelector(".near-button");
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

    addLogoutButton();
    addAdminLinkIfAdmin();
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

function addAdminLinkIfAdmin() {
    if (currentUser.role !== "admin") return;

    const button = document.createElement("button");
    button.className = "custom-button admin-button";
    button.textContent = "Admin";
    button.addEventListener("click", () => {
        window.location.href = "admin.html";
    });
    document.querySelector(".topbar").appendChild(button);
}

function roleLabel(role) {
    if (role === "admin") return "Admin";
    if (role === "community_plus") return "Community+";
    return "Community";
}


/* =========================
   TOP BAR EXTRAS
========================= */

function addLogoutButton() {
    const button = document.createElement("button");
    button.className = "custom-button logout-button";
    button.textContent = "Log out";
    button.addEventListener("click", async () => {
        await Planora.logout();
        window.location.href = "login.html";
    });
    document.querySelector(".topbar").appendChild(button);

    document.querySelector(".profile").addEventListener("click", () => {
        window.location.href = "profile.html";
    });
}

function bindModeButtons() {
    nearButton.addEventListener("click", () => {
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
    nearButton.classList.toggle("mode-active", mode === "local");
    globalButton.classList.toggle("mode-active", mode === "global");
}

function bindYearButtons() {
    document.getElementById("previousYear").addEventListener("click", () => {
        currentYear--;
        openMonth = null;
        render();
    });

    document.getElementById("nextYear").addEventListener("click", () => {
        currentYear++;
        openMonth = null;
        render();
    });
}


/* =========================
   MONTH CLICK
========================= */

monthButtons.forEach(monthEl => {
    monthEl.addEventListener("click", () => {
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
    } catch (err) {
        toast(err.message, "error");
        return;
    }

    for (const monthEl of monthButtons) {
        const monthNumber = Number(monthEl.dataset.month);
        const countEl = monthEl.querySelector(".event-count");
        const container = monthEl.parentElement.querySelector(".events-container");

        const monthEvents = events
            .filter(e => new Date(e.date).getMonth() + 1 === monthNumber)
            .sort((a, b) => new Date(a.date) - new Date(b.date));

        countEl.textContent = monthEvents.length === 0
            ? "NO EVENTS"
            : monthEvents.length === 1
                ? "01 EVENT"
                : String(monthEvents.length).padStart(2, "0") + " EVENTS";

        if (openMonth !== monthNumber) {
            container.innerHTML = "";
            continue;
        }

        await renderMonthEvents(container, monthEvents);
    }
}

async function renderMonthEvents(container, monthEvents) {
    container.innerHTML = "";

    if (monthEvents.length === 0) {
        const empty = document.createElement("div");
        empty.className = "no-events";
        empty.textContent = mode === "local"
            ? "Nothing here yet — tap + to add something."
            : "No one's posted to the table this month yet.";
        container.appendChild(empty);
        return;
    }

    for (const event of monthEvents) {
        container.appendChild(await buildEventCard(event));
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
        comments.forEach(comment => {
            const c = document.createElement("div");
            c.className = "comment";

            const author = document.createElement("span");
            author.className = "comment-author";
            author.textContent = "@" + comment.author;

            const text = document.createElement("span");
            text.textContent = comment.text;

            c.appendChild(author);
            c.appendChild(text);
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
   ADD EVENT
========================= */

function buildAddEventUI() {

    const addButton = document.createElement("button");
    addButton.className = "add-event-button";
    addButton.textContent = "+";
    document.body.appendChild(addButton);

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
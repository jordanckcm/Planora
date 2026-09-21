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

   EVENT ACTIONS:
   Every per-event action (Add to calendar / Remove / admin removal)
   lives in a ⋮ menu in the card's top-right corner — the same portal
   machinery the comment menus use. Cards with nothing you're allowed
   to do simply don't get a ⋮.
========================================================= */

let currentUser = null;
let currentYear = new Date().getFullYear();
let mode = "local"; // "local" | "global" | "timeline"
let openMonth = null;
let shownOfflineToast = false;
let searchQuery = "";

const monthButtons = document.querySelectorAll(".month-events-container");
const yearDisplay = document.getElementById("year");
const localButton = document.querySelector(".local-button");
const globalButton = document.querySelector(".global-button");
const timelineButton = document.querySelector(".timeline-button");
const timelineContainer = document.getElementById("timelineContainer");

// same palette as the profile avatar picker, reused for event color-tags
const EVENT_COLORS = ["#c9a227", "#489c48", "#b6453f", "#4a7fc9", "#9a56c9", "#c96f2e"];
const EVENT_ICONS = ["🎉", "🎮", "🎵", "🍕", "🏀", "🎨", "📚", "🌙", "🔥", "🎬"];

let selectedEventColor = EVENT_COLORS[0];
let selectedEventIcon = EVENT_ICONS[0];
let selectedEventImage = "";


/* Shrinks a picked image to at most 900px wide and returns a JPEG data URL
   (usually 60-150 KB), so uploads stay small and fast. */
function resizeImage(file, maxWidth = 900, quality = 0.75) {
    return new Promise((resolve, reject) => {
        if (!file.type.startsWith("image/")) {
            reject(new Error("That file isn't an image."));
            return;
        }

        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Couldn't read that file."));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error("Couldn't open that image."));
            img.onload = () => {
                const scale = Math.min(1, maxWidth / img.width);
                const canvas = document.createElement("canvas");
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);

                const ctx = canvas.getContext("2d");
                ctx.fillStyle = "#131313"; // transparent PNGs land on the page color
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

                resolve(canvas.toDataURL("image/jpeg", quality));
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}


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

/* "2026-06-14" is parsed as UTC midnight by `new Date(str)`, which lands on
   the 13th anywhere west of Greenwich. Always go through this so the day,
   month and sort order all agree on the date the user actually typed. */
function parseEventDate(dateStr) {
    return new Date(dateStr + "T00:00:00");
}


/* =========================
   TIMEZONES
   Events store the organizer's IANA zone (e.g. "Asia/Manila") alongside
   a plain wall-clock time ("19:30"). Nothing here rewrites what the
   organizer typed - buildEventCard/formatEventWhen show that alongside
   the viewer's own converted time, so both sides always see the truth.
   Only events WITH a start_time carry a timezone: an all-day event
   ("June 14th", no clock time) is the same day everywhere, so there's
   no instant to convert and the server drops any timezone sent for one.
========================= */

const VIEWER_TZ = (() => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
        return "";
    }
})();

/* Interprets `timeStr` on `dateStr` as wall-clock time IN `zone`, and
   returns the actual instant (a Date) that represents. Asks the zone what
   offset applies at roughly that moment rather than assuming a fixed one,
   so this comes out right across a DST boundary too. */
function zonedWallTimeToInstant(dateStr, timeStr, zone) {
    const [y, mo, d] = dateStr.split("-").map(Number);
    const [h, mi] = timeStr.split(":").map(Number);
    const guessUTC = Date.UTC(y, mo - 1, d, h, mi);

    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).formatToParts(new Date(guessUTC)).reduce((acc, p) => {
        acc[p.type] = p.value;
        return acc;
    }, {});

    const hour = parts.hour === "24" ? 0 : Number(parts.hour);
    const asIfUTC = Date.UTC(
        Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        hour, Number(parts.minute), Number(parts.second)
    );
    return new Date(guessUTC - (asIfUTC - guessUTC));
}

function instantToZonedParts(instant, zone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone, hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit"
    }).formatToParts(instant).reduce((acc, p) => {
        acc[p.type] = p.value;
        return acc;
    }, {});
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        time: `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`
    };
}

/* Re-expresses an event's date/end-date/start/end time in the VIEWER's
   own timezone. Can land on a different calendar date than what the
   organizer typed - that's correct, not a bug, and is exactly why the
   month grid, day number and sort order all go through this too rather
   than reading event.date directly. Falls through unchanged for all-day
   events and for events saved before timezones were tracked (empty
   event.timezone) - there's nothing to convert either way. */
function toViewerLocal(event) {
    const passthrough = {
        date: event.date,
        endDate: event.end_date || event.date,
        startTime: event.start_time || "",
        endTime: event.end_time || "",
        converted: false
    };

    if (!event.start_time || !event.timezone || !VIEWER_TZ) return passthrough;
    if (event.timezone === VIEWER_TZ) return passthrough;

    const start = instantToZonedParts(
        zonedWallTimeToInstant(event.date, event.start_time, event.timezone),
        VIEWER_TZ
    );

    let endDate = event.end_date || event.date;
    let endTime = "";
    if (event.end_time) {
        const end = instantToZonedParts(
            zonedWallTimeToInstant(event.end_date || event.date, event.end_time, event.timezone),
            VIEWER_TZ
        );
        endDate = end.date;
        endTime = end.time;
    }

    return { date: start.date, endDate, startTime: start.time, endTime, converted: true };
}

function isRecentlyPosted(event) {
    return Date.now() - event.created_at < 24 * 60 * 60 * 1000;
}

/* Compact relative time for comment/post stamps — "just now", "5m",
   "3h", "2d" — falling back to a short date further out. The full
   date/time always goes in the caller's title attribute so hovering
   gives the exact moment. */
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


/* =========================
   DROPDOWN PORTAL
   Used by both the comment ⋮ menus and the event ⋮ menus.
   These used to be position:absolute inside the month card,
   which has its own stacking context AND clips overflow — so
   a menu near the bottom of a long list could get visually
   buried under the NEXT month card, or cut off entirely.
   Moving the open menu to a fixed-position child of <body>
   sidesteps both problems: it always paints above everything
   else and is never clipped by an ancestor. On close it goes
   back where it came from, so a re-render doesn't strand
   orphaned menus on <body>.
========================= */

function openDropdownMenu(dropdown, trigger) {
    closeAllDropdownMenus();

    dropdown._home = dropdown.parentElement;
    document.body.appendChild(dropdown);
    dropdown.classList.add("show", "dropdown-portal");

    const rect = trigger.getBoundingClientRect();
    dropdown.style.position = "fixed";
    dropdown.style.top = `${rect.bottom + 6}px`;
    dropdown.style.left = `${rect.left}px`;

    // now that it's actually in the DOM we can measure it, and pull
    // it back onto the screen if it would spill off the right edge
    const menuWidth = dropdown.offsetWidth;
    const overflowRight = rect.left + menuWidth - (window.innerWidth - 8);
    if (overflowRight > 0) {
        dropdown.style.left = `${Math.max(8, rect.left - overflowRight)}px`;
    }
}

function closeDropdownMenu(dropdown) {
    dropdown.classList.remove("show", "dropdown-portal");
    dropdown.style.position = "";
    dropdown.style.top = "";
    dropdown.style.left = "";

    if (dropdown._home && dropdown._home.isConnected) {
        dropdown._home.appendChild(dropdown);
    } else {
        dropdown.remove();
    }
    dropdown._home = null;
}

function closeAllDropdownMenus() {
    document.querySelectorAll(".menu-dropdown.show").forEach(closeDropdownMenu);
}

/* Bound once at startup — a fresh listener isn't added per comment or
   per card, so this stays cheap no matter how many times render()
   rebuilds the lists. */
function bindDropdownDismissal() {
    document.addEventListener("click", (e) => {
        document.querySelectorAll(".menu-dropdown.show").forEach(dropdown => {
            if (!dropdown.contains(e.target) && dropdown._trigger !== e.target) {
                closeDropdownMenu(dropdown);
            }
        });
    });

    // scrolling would leave a fixed-position menu pointing at empty
    // space, so just close it rather than trying to track it
    window.addEventListener("scroll", closeAllDropdownMenus, true);

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeAllDropdownMenus();
    });
}

/* Builds a ⋮ button + menu from a list of {label, danger, run} items.
   Returns null when there's nothing the user can do, so the caller can
   skip the ⋮ entirely rather than show an empty menu. */
function buildDotsMenu(items, { buttonClass, dropdownClass, ariaLabel }) {
    if (items.length === 0) return null;

    const wrap = document.createElement("div");
    wrap.className = buttonClass + "-wrap";

    const button = document.createElement("button");
    button.type = "button";
    button.className = buttonClass;
    button.textContent = "⋮";
    button.setAttribute("aria-label", ariaLabel);
    button.setAttribute("aria-haspopup", "true");

    const dropdown = document.createElement("div");
    dropdown.className = `${dropdownClass} menu-dropdown`;
    dropdown._trigger = button;

    items.forEach(item => {
        const el = document.createElement("button");
        el.type = "button";
        el.className = `${dropdownClass}-item` + (item.danger ? " danger" : "");
        el.textContent = item.label;
        el.addEventListener("click", async (e) => {
            e.stopPropagation();
            closeDropdownMenu(dropdown);
            await item.run();
        });
        dropdown.appendChild(el);
    });

    button.addEventListener("click", (e) => {
        e.stopPropagation();
        if (dropdown.classList.contains("show")) {
            closeDropdownMenu(dropdown);
        } else {
            openDropdownMenu(dropdown, button);
        }
    });

    wrap.appendChild(button);
    wrap.appendChild(dropdown);
    return wrap;
}

/* "7:30 PM" from a 24h "19:30" input value. */
function formatTime(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    const period = h >= 12 ? "PM" : "AM";
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

/* Combines the date/date-range with the start/end time, whichever of
   those the event actually has, IN THE VIEWER'S OWN TIMEZONE when the
   event has one on record (see toViewerLocal). If that conversion also
   shifted the calendar date, the date shown here follows it. When the
   viewer's zone differs from the organizer's, the organizer's original
   wall-clock time is appended in parentheses, same way a lot of chat
   apps show a converted time next to the sender's own. */
function formatEventWhen(event, viewerLocal) {
    const vl = viewerLocal || toViewerLocal(event);

    let dateLabel;
    if (vl.endDate && vl.endDate !== vl.date) {
        const start = parseEventDate(vl.date);
        const end = parseEventDate(vl.endDate);
        const days = Math.round((end - start) / 86400000) + 1;
        const startLabel = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
        const endLabel = end.toLocaleDateString(undefined, { month: "short", day: "numeric" });
        dateLabel = `${startLabel} – ${endLabel} · ${days} days`;
    } else {
        dateLabel = formatEventDate(vl.date);
    }

    if (!vl.startTime) return dateLabel;

    const timeLabel = vl.endTime
        ? `${formatTime(vl.startTime)} – ${formatTime(vl.endTime)}`
        : formatTime(vl.startTime);

    if (vl.converted) {
        const originalLabel = event.end_time
            ? `${formatTime(event.start_time)} – ${formatTime(event.end_time)}`
            : formatTime(event.start_time);
        return `${dateLabel} · ${timeLabel} (${originalLabel} organizer's time)`;
    }

    return `${dateLabel} · ${timeLabel}`;
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
    bindTodayButton();
    bindSearch();
    buildAddEventUI();
    bindDropdownDismissal();

    // A "Copy link" URL (?event=123&mode=global&year=2026) can set the
    // mode/year before the first render, then we open + scroll to the
    // specific card once everything's on the page. The button that made
    // those links is gone, but old links people already sent still work.
    const deepLinkEventId = applyDeepLinkFromURL();

    setActiveModeButton();
    await render();

    if (deepLinkEventId !== null) {
        await focusEvent(deepLinkEventId);
    }
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

    timelineButton.addEventListener("click", () => {
        mode = "timeline";
        setActiveModeButton();
        render();
    });
}

function setActiveModeButton() {
    localButton.classList.toggle("mode-active", mode === "local");
    globalButton.classList.toggle("mode-active", mode === "global");
    timelineButton.classList.toggle("mode-active", mode === "timeline");

    document.body.classList.toggle("mode-local", mode === "local");
    document.body.classList.toggle("mode-global", mode === "global");
    document.body.classList.toggle("mode-timeline", mode === "timeline");
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
   TODAY BUTTON
========================= */

function bindTodayButton() {
    document.getElementById("todayButton").addEventListener("click", async () => {
        const now = new Date();
        const targetYear = now.getFullYear();
        const targetMonth = now.getMonth() + 1;

        // a stale search could hide the very month we're jumping to
        clearSearchIfActive();

        // the timeline view has no months to scroll to, so jump back
        // into the month grid first
        if (mode === "timeline") {
            mode = "local";
            setActiveModeButton();
        }

        if (targetYear !== currentYear) {
            const direction = targetYear > currentYear ? "next" : "prev";
            currentYear = targetYear;
            animateYearSwitch(direction);
        }

        openMonth = targetMonth;
        await render();
        scrollToMonth(targetMonth);
    });
}

function scrollToMonth(monthNumber) {
    const monthEl = [...monthButtons].find(el => Number(el.dataset.month) === monthNumber);
    const wrapper = monthEl && monthEl.closest(".month-wrapper");
    if (wrapper) {
        wrapper.scrollIntoView({ behavior: "smooth", block: "start" });
    }
}


/* =========================
   SEARCH
   Filters events by title/description across every month at
   once. Matching months auto-expand; months with nothing
   matching collapse out of the way instead of making you
   click through all twelve to find something. In Timeline
   mode, it just filters the dot list the same way.
========================= */

function bindSearch() {
    const input = document.getElementById("eventSearch");
    const clearBtn = document.getElementById("clearSearch");

    input.addEventListener("input", () => {
        searchQuery = input.value;
        clearBtn.style.display = searchQuery ? "flex" : "none";
        render();
    });

    clearBtn.addEventListener("click", () => {
        input.value = "";
        searchQuery = "";
        clearBtn.style.display = "none";
        input.focus();
        render();
    });

    // "/" jumps into search from anywhere on the page (unless you're
    // already typing somewhere), Escape backs out of it.
    document.addEventListener("keydown", (e) => {
        if (e.key === "/" && document.activeElement !== input
            && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
            e.preventDefault();
            input.focus();
        } else if (e.key === "Escape" && document.activeElement === input) {
            input.value = "";
            searchQuery = "";
            clearBtn.style.display = "none";
            input.blur();
            render();
        }
    });
}

function clearSearchIfActive() {
    if (!searchQuery) return;
    searchQuery = "";
    const input = document.getElementById("eventSearch");
    const clearBtn = document.getElementById("clearSearch");
    if (input) input.value = "";
    if (clearBtn) clearBtn.style.display = "none";
}


/* =========================
   SHARED EVENT LINKS
   ?event=123&mode=global&year=2026 — on load we read that,
   switch into the right mode/year, then scroll to and briefly
   highlight the matching card once it's rendered.
========================= */

function applyDeepLinkFromURL() {
    const params = new URLSearchParams(location.search);
    const eventIdParam = params.get("event");
    if (!eventIdParam || Number.isNaN(Number(eventIdParam))) return null;

    mode = params.get("mode") === "local" ? "local" : "global";

    const yearParam = Number(params.get("year"));
    if (yearParam) currentYear = yearParam;

    // clean the URL so refreshing or hitting Today later doesn't
    // keep re-triggering the same jump
    history.replaceState(null, "", location.pathname);

    return Number(eventIdParam);
}

async function focusEvent(eventId) {
    let events;
    try {
        events = await PlanoraData.getEvents(mode, currentYear);
    } catch (err) {
        toast(err.message, "error");
        return;
    }

    const target = events.find(e => e.id === eventId);
    if (!target) {
        toast("Couldn't find that event — it may be from a different year.", "error");
        return;
    }

    openMonth = parseEventDate(toViewerLocal(target).date).getMonth() + 1;
    await render();

    const card = document.querySelector(`.event[data-event-id="${eventId}"]`);
    if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.add("event-highlight");
        setTimeout(() => card.classList.remove("event-highlight"), 1800);
    } else {
        scrollToMonth(openMonth);
    }
}


/* =========================
   MONTH CLICK
========================= */

monthButtons.forEach(monthEl => {
    monthEl.addEventListener("click", () => {
        if (searchQuery.trim()) return; // search already controls which months are open

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
    closeAllDropdownMenus();

    // Timeline has no local/global split of its own — it always shows
    // your personal calendar's events, just laid out as a chronological
    // roadmap instead of grouped by month.
    const isTimeline = mode === "timeline";
    const fetchMode = isTimeline ? "local" : mode;

    let events;
    try {
        events = await PlanoraData.getEvents(fetchMode, currentYear);
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

    const query = searchQuery.trim().toLowerCase();
    const isSearching = query.length > 0;

    const monthWrapperEls = document.querySelectorAll(".month-wrapper");

    if (isTimeline) {
        monthWrapperEls.forEach(wrapper => wrapper.style.display = "none");
        timelineContainer.classList.add("active");
        renderTimeline(events, query);
        return;
    }

    monthWrapperEls.forEach(wrapper => wrapper.style.display = "");
    timelineContainer.classList.remove("active");

    for (const monthEl of monthButtons) {
        const monthNumber = Number(monthEl.dataset.month);
        const countEl = monthEl.querySelector(".event-count");
        const wrapper = monthEl.closest(".month-wrapper");
        const container = monthEl.parentElement.querySelector(".events-container");

        // Grouped and sorted by each event's date AS THE VIEWER WOULD SEE
        // IT, not the raw stored date - a 11PM event in the organizer's
        // zone can land on the viewer's next calendar day.
        let monthEvents = events
            .filter(e => parseEventDate(toViewerLocal(e).date).getMonth() + 1 === monthNumber)
            .sort((a, b) => parseEventDate(toViewerLocal(a).date) - parseEventDate(toViewerLocal(b).date));

        if (isSearching) {
            monthEvents = monthEvents.filter(e =>
                e.title.toLowerCase().includes(query) ||
                (e.description && e.description.toLowerCase().includes(query))
            );
        }

        countEl.textContent = monthEvents.length === 0
            ? (isSearching ? "NO MATCHES" : "NO EVENTS")
            : monthEvents.length === 1
                ? (isSearching ? "01 MATCH" : "01 EVENT")
                : String(monthEvents.length).padStart(2, "0") + (isSearching ? " MATCHES" : " EVENTS");

        // while searching, months with hits auto-open and months
        // without just disappear — otherwise it's the normal accordion
        const isOpen = isSearching ? monthEvents.length > 0 : openMonth === monthNumber;

        wrapper.classList.toggle("search-hidden", isSearching && monthEvents.length === 0);

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
            ? "No schedules made, tap + to add something."
            : "No one's posted a global event this month yet.";
        inner.appendChild(empty);
        return;
    }

    for (const event of monthEvents) {
        inner.appendChild(await buildEventCard(event));
    }
}


/* =========================
   TIMELINE VIEW
   A flat, chronological "roadmap" of every event on your
   calendar for the selected year — a dot per event, connected
   by a line, in the order they happen.
========================= */

function renderTimeline(events, query) {
    let list = events.slice().sort((a, b) =>
        parseEventDate(toViewerLocal(a).date) - parseEventDate(toViewerLocal(b).date)
    );

    if (query) {
        list = list.filter(e =>
            e.title.toLowerCase().includes(query) ||
            (e.description && e.description.toLowerCase().includes(query))
        );
    }

    timelineContainer.innerHTML = "";

    if (list.length === 0) {
        const empty = document.createElement("div");
        empty.className = "no-events";
        empty.textContent = query
            ? "No matches."
            : "No events yet — tap + to add something.";
        timelineContainer.appendChild(empty);
        return;
    }

    list.forEach(event => {
        const entry = document.createElement("div");
        entry.className = "timeline-entry";
        entry.dataset.eventId = event.id;

        const track = document.createElement("div");
        track.className = "timeline-track";

        const dot = document.createElement("div");
        dot.className = "timeline-dot";
        dot.style.color = event.color || EVENT_COLORS[0];

        const line = document.createElement("div");
        line.className = "timeline-line";

        track.appendChild(dot);
        track.appendChild(line);

        const body = document.createElement("div");
        body.className = "timeline-body";
        body.style.cursor = "pointer";

        if (event.image) {
            body.classList.add("has-image");
            body.style.setProperty("--tl-image", `url("${event.image}")`);
        }

        const titleEl = document.createElement("div");
        titleEl.className = "timeline-title";
        titleEl.textContent = `${event.icon || EVENT_ICONS[0]}  ${event.title}`;

        const dateEl = document.createElement("div");
        dateEl.className = "timeline-date";
        dateEl.textContent = formatEventWhen(event);

        body.appendChild(titleEl);
        if (event.description) {
            const descEl = document.createElement("div");
            descEl.className = "event-description";
            descEl.style.marginTop = "4px";
            descEl.textContent = event.description;
            body.appendChild(descEl);
        }
        body.appendChild(dateEl);

        // tapping a dot/card jumps you into the normal month view for
        // that event, same destination as a search hit would land on
        body.addEventListener("click", () => {
            mode = "local";
            setActiveModeButton();
            openMonth = parseEventDate(toViewerLocal(event).date).getMonth() + 1;
            render().then(() => {
                const card = document.querySelector(`.event[data-event-id="${event.id}"]`);
                if (card) {
                    card.scrollIntoView({ behavior: "smooth", block: "center" });
                    card.classList.add("event-highlight");
                    setTimeout(() => card.classList.remove("event-highlight"), 1800);
                } else {
                    scrollToMonth(openMonth);
                }
            });
        });

        entry.appendChild(track);
        entry.appendChild(body);
        timelineContainer.appendChild(entry);
    });
}


/* =========================
   EVENT ACTIONS (⋮ menu)
   One menu in the card's top-right corner instead of a row of
   buttons. What's in it depends on the card:

     your own event          → Remove
     someone's global post   → Add to calendar
     ...and if you're admin  → Remove (admin)

   Nothing applicable means no ⋮ at all.
========================= */

function buildEventMenu(event) {
    const items = [];

    if (mode === "global" && !event.isMine) {
        items.push({
            label: "Add to calendar",
            run: async () => {
                try {
                    await PlanoraData.addToMyCalendar(event.id);
                    toast(`Added "${event.title}" to your calendar.`, "success");
                    render();
                } catch (err) {
                    toast(err.message, "error");
                }
            }
        });
    }

    // Deleting your own event: everyone can do this, any role, any mode.
    if (event.isMine) {
        items.push({
            label: "Remove",
            danger: true,
            run: async () => {
                try {
                    await PlanoraData.deleteEvent(event.id);
                    toast("Removed from your calendar.");
                    render();
                } catch (err) {
                    toast(err.message, "error");
                }
            }
        });
    }

    // Admins can also remove events posted by other people in Global.
    if (mode === "global" && !event.isMine && currentUser.role === "admin") {
        items.push({
            label: "Remove (admin)",
            danger: true,
            run: async () => {
                try {
                    await PlanoraData.adminDeleteEvent(event.id);
                    toast("Removed by admin.");
                    render();
                } catch (err) {
                    toast(err.message, "error");
                }
            }
        });
    }

    return buildDotsMenu(items, {
        buttonClass: "event-menu-button",
        dropdownClass: "event-dropdown",
        ariaLabel: "Event options"
    });
}

async function buildEventCard(event) {
    const viewerLocal = toViewerLocal(event);
    const day = parseEventDate(viewerLocal.date).getDate();

    const card = document.createElement("div");
    card.className = "event";
    card.dataset.eventId = event.id;
    if (isRecentlyPosted(event)) card.classList.add("event-new");

    const menu = buildEventMenu(event);
    if (menu) card.appendChild(menu);

    const cover = document.createElement("div");
    cover.className = "event-cover";
    // backgroundColor (not the `background` shorthand) so the image can show
    cover.style.backgroundColor = `${event.color || EVENT_COLORS[0]}26`; // ~15% tint
    cover.textContent = event.icon || EVENT_ICONS[0];
    if (event.image) {
        cover.classList.add("has-image");
        cover.style.setProperty("--cover-image", `url("${event.image}")`);
    }
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
        authorEl.title = `Posted ${formatFullTimestamp(event.created_at)}`;
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
    dateEl.textContent = formatEventWhen(event, viewerLocal);
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
            if (person.avatarImage) {
                dot.style.backgroundImage = `url("${person.avatarImage}")`;
                dot.style.backgroundSize = "cover";
                dot.style.backgroundPosition = "center";
            }
            dot.title = person.addedAt
                ? `@${person.username} · added ${formatFullTimestamp(person.addedAt)}`
                : "@" + person.username;
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

            const time = document.createElement("span");
            time.className = "comment-time";
            time.textContent = formatRelativeShort(comment.created_at);
            time.title = formatFullTimestamp(comment.created_at);

            const text = document.createElement("span");
            text.className = "comment-text";
            text.textContent = comment.text;

            const body = document.createElement("span");
            body.className = "comment-body";
            body.appendChild(author);
            body.appendChild(time);
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

                function exitEditMode() {
                    document.removeEventListener("click", cancelOnOutsideClick);
                    render();
                }

                async function save() {
                    if (!editInput.value.trim()) return;
                    try {
                        await PlanoraData.editComment(event.id, comment.id, editInput.value);
                        toast("Comment updated.");
                        exitEditMode();
                    } catch (err) {
                        toast(err.message, "error");
                    }
                }

                saveBtn.addEventListener("click", (e) => { e.stopPropagation(); save(); });
                cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); exitEditMode(); });
                editInput.addEventListener("click", (e) => e.stopPropagation());
                editInput.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") save();
                    if (e.key === "Escape") exitEditMode();
                });

                // clicking anywhere else on the page cancels the edit,
                // same principle as the dropdown menus dismissing on
                // outside click
                function cancelOnOutsideClick(e) {
                    if (!editRow.contains(e.target)) exitEditMode();
                }
                setTimeout(() => document.addEventListener("click", cancelOnOutsideClick), 0);
            }

            const items = [];
            if (canEdit) items.push({ label: "Edit", run: () => enterEditMode() });
            if (canDelete) {
                items.push({
                    label: "Delete",
                    danger: true,
                    run: async () => {
                        try {
                            await PlanoraData.deleteComment(event.id, comment.id);
                            toast("Comment deleted.");
                            render();
                        } catch (err) {
                            toast(err.message, "error");
                        }
                    }
                });
            }

            const menu = buildDotsMenu(items, {
                buttonClass: "comment-menu-button",
                dropdownClass: "comment-dropdown",
                ariaLabel: "Comment options"
            });
            if (menu) c.appendChild(menu);

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
            toast("Comment posted.", "success");
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

            <div class="field-label">Cover image (optional)</div>
            <div class="image-picker">
                <label class="image-pick-button" for="eventImage">Choose image</label>
                <input type="file" id="eventImage" accept="image/*" hidden>
                <button type="button" class="image-remove" id="removeEventImage" style="display:none;">Remove</button>
                <div class="image-preview" id="imagePreview"></div>
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

    const imageInput = eventForm.querySelector("#eventImage");
    const imagePreview = eventForm.querySelector("#imagePreview");
    const removeImageBtn = eventForm.querySelector("#removeEventImage");

    function setEventImage(dataUrl) {
        selectedEventImage = dataUrl;
        imagePreview.style.backgroundImage = dataUrl ? `url("${dataUrl}")` : "";
        imagePreview.classList.toggle("show", Boolean(dataUrl));
        removeImageBtn.style.display = dataUrl ? "inline-flex" : "none";
        imageInput.value = ""; // lets you pick the same file twice in a row
    }

    imageInput.addEventListener("change", async () => {
        const file = imageInput.files[0];
        if (!file) return;
        try {
            setEventImage(await resizeImage(file));
        } catch (err) {
            toast(err.message, "error");
        }
    });

    removeImageBtn.addEventListener("click", () => setEventImage(""));

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
        setEventImage("");

        selectedEventIcon = EVENT_ICONS[0];
        selectedEventColor = EVENT_COLORS[0];
        iconRow.querySelectorAll(".event-icon-dot").forEach((el, i) => el.classList.toggle("selected", i === 0));
        colorRow.querySelectorAll(".event-color-dot").forEach((el, i) => el.classList.toggle("selected", i === 0));
    });

    document.getElementById("cancelEvent").addEventListener("click", () => {
        eventForm.classList.remove("show");
    });

    // Enter submits from any single-line field (title, date, time) —
    // skips the description textarea so Enter still just makes a new line there.
    eventForm.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
            e.preventDefault();
            document.getElementById("saveEvent").click();
        }
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
                // only matters when there's a clock time to convert; the
                // server drops it for all-day events regardless
                timezone: startTime ? VIEWER_TZ : "",
                visibility: isPublic ? "global" : "local",
                icon: selectedEventIcon,
                color: selectedEventColor,
                image: selectedEventImage
            });
        } catch (err) {
            toast(err.message, "error");
            return;
        }

        eventForm.classList.remove("show");

        currentYear = parseEventDate(date).getFullYear();
        openMonth = parseEventDate(date).getMonth() + 1;
        mode = "local";
        setActiveModeButton();

        toast(isPublic ? "Posted to Global and your calendar." : "Added to your calendar.", "success");
        render();
    });
}

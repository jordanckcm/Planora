/* =========================================================
   PLANORA — DATA
   Events and comments live in one shared table (simulating
   what a real backend would hold), keyed by an id. Every
   event has an owner and a visibility of "local" or "global".

     Local view   -> only events where owner === you
     Global view  -> every event with visibility === "global",
                     from any account, with an "add to my
                     calendar" action that clones it into your
                     own local events.

   Since there's no real server yet, "global" is simulated:
   it's shared storage in THIS browser only, seeded with a
   few demo posts from other accounts so the table doesn't
   look empty on a fresh install. Swapping this file for real
   API calls later won't require changing the pages that use it.
========================================================= */

const PlanoraData = (() => {

    const EVENTS_KEY = "planora.events";
    const COMMENTS_KEY = "planora.comments";
    const SEEDED_KEY = "planora.seeded";

    function readJSON(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (err) {
            return fallback;
        }
    }

    function writeJSON(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
    }

    function uid() {
        return crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(16).slice(2);
    }


    /* =========================
       SEED DEMO DATA
       Runs once per browser so a brand-new account still has
       something on the Global table to look at and comment on.
    ========================= */

    function seedIfNeeded() {
        if (localStorage.getItem(SEEDED_KEY)) return;

        const year = new Date().getFullYear();

        const demoEvents = [
            {
                id: uid(), owner: "sable", title: "Rooftop Card Night",
                description: "Bring your own deck, we'll bring the snacks.",
                date: `${year}-06-14`, visibility: "global", createdAt: Date.now()
            },
            {
                id: uid(), owner: "vex", title: "Open Mic @ The Landing",
                description: "Sign-ups open 30 minutes before doors.",
                date: `${year}-07-02`, visibility: "global", createdAt: Date.now()
            },
            {
                id: uid(), owner: "juno", title: "City Marathon",
                description: "Route closes at 1PM sharp — start early!",
                date: `${year}-10-11`, visibility: "global", createdAt: Date.now()
            }
        ];

        const events = readJSON(EVENTS_KEY, []);
        writeJSON(EVENTS_KEY, events.concat(demoEvents));

        const comments = readJSON(COMMENTS_KEY, {});
        comments[demoEvents[0].id] = [
            { id: uid(), author: "vex", text: "I'm in, calling dibs on the good chair.", createdAt: Date.now() }
        ];
        writeJSON(COMMENTS_KEY, comments);

        localStorage.setItem(SEEDED_KEY, "1");
    }


    /* =========================
       EVENTS
    ========================= */

    function getAllEvents() {
        return readJSON(EVENTS_KEY, []);
    }

    function getLocalEvents(username) {
        return getAllEvents().filter(e => e.owner.toLowerCase() === username.toLowerCase());
    }

    function getGlobalEvents() {
        return getAllEvents().filter(e => e.visibility === "global");
    }

    function addEvent({ owner, title, description, date, visibility }) {
        const events = getAllEvents();

        const event = {
            id: uid(),
            owner,
            title: title.trim(),
            description: description.trim(),
            date,
            visibility,
            createdAt: Date.now()
        };

        events.push(event);
        writeJSON(EVENTS_KEY, events);

        return event;
    }

    /*
        Clones a global event into the current user's own local
        events, so they can track it without editing the original
        or affecting its author's copy.
    */
    function addToMyCalendar(eventId, username) {
        const events = getAllEvents();
        const source = events.find(e => e.id === eventId);
        if (!source) throw new Error("Event not found.");

        const alreadyAdded = events.some(e =>
            e.owner.toLowerCase() === username.toLowerCase() && e.clonedFrom === eventId
        );
        if (alreadyAdded) return null;

        const clone = {
            id: uid(),
            owner: username,
            title: source.title,
            description: source.description,
            date: source.date,
            visibility: "local",
            clonedFrom: eventId,
            createdAt: Date.now()
        };

        events.push(clone);
        writeJSON(EVENTS_KEY, events);

        return clone;
    }

    function deleteEvent(eventId, username) {
        const events = getAllEvents();
        const target = events.find(e => e.id === eventId);
        if (!target || target.owner.toLowerCase() !== username.toLowerCase()) return false;

        writeJSON(EVENTS_KEY, events.filter(e => e.id !== eventId));
        return true;
    }


    /* =========================
       COMMENTS
       Comments only make sense on the shared Global table.
    ========================= */

    function getComments(eventId) {
        const comments = readJSON(COMMENTS_KEY, {});
        return comments[eventId] || [];
    }

    function addComment(eventId, author, text) {
        text = text.trim();
        if (!text) return null;

        const comments = readJSON(COMMENTS_KEY, {});
        const list = comments[eventId] || [];

        const comment = { id: uid(), author, text, createdAt: Date.now() };
        list.push(comment);

        comments[eventId] = list;
        writeJSON(COMMENTS_KEY, comments);

        return comment;
    }

    function commentCountFor(eventId) {
        return getComments(eventId).length;
    }

    function countByOwner(username) {
        return getAllEvents().filter(e => e.owner.toLowerCase() === username.toLowerCase()).length;
    }

    function countCommentsByAuthor(username) {
        const comments = readJSON(COMMENTS_KEY, {});
        let total = 0;
        Object.values(comments).forEach(list => {
            total += list.filter(c => c.author.toLowerCase() === username.toLowerCase()).length;
        });
        return total;
    }

    return {
        seedIfNeeded,
        getAllEvents,
        getLocalEvents,
        getGlobalEvents,
        addEvent,
        addToMyCalendar,
        deleteEvent,
        getComments,
        addComment,
        commentCountFor,
        countByOwner,
        countCommentsByAuthor
    };

})();

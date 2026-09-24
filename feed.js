/* PLANORA — HOME FEED
   Load on homepage.html AFTER homepage.js and planora-nav.js.
   Home = scrollable feed of Global + Public events (GET /api/feed).
   Local / Global / Timeline still use homepage.js as-is; this file only
   decides whether render() shows the feed or hands off to the original. */

(function () {
    const view = new URLSearchParams(location.search).get("view");
    let feedActive = !["local", "global", "timeline"].includes(view);
    if (!feedActive) mode = view; // homepage.js's mode, set before its first render

    const feed = document.createElement("div");
    feed.id = "feedContainer";
    document.body.insertBefore(feed, document.getElementById("toastStack"));

    const baseRender = window.render;
    window.render = async function () {
        document.body.classList.toggle("feed-on", feedActive);
        if (window.PlanoraNav) PlanoraNav.setActive(feedActive ? "home" : mode);
        if (feedActive) return loadFeed();
        return baseRender();
    };

    window.__planoraSetView = function (key) {
        feedActive = key === "home";
        if (feedActive) return window.render();
        document.querySelector("." + key + "-button").click(); // homepage.js sets mode + renders
    };

    async function loadFeed() {
        let posts;
        try {
            posts = await apiRequest("/api/feed");
        } catch (err) {
            toast(err.message, "error");
            return;
        }
        feed.textContent = "";
        if (!posts.length) {
            const empty = document.createElement("div");
            empty.className = "feed-empty";
            empty.textContent = "Nothing here yet. Tap + and post a Public or Global event.";
            feed.appendChild(empty);
            return;
        }
        posts.forEach((p) => feed.appendChild(buildPost(p)));
    }

    function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    }

    function buildPost(p) {
        const post = el("article", "post");

        // header
        const head = el("div", "post-head");
        const avatar = el("a", "post-avatar");
        avatar.href = profileUrl(p.owner);
        if (p.ownerAvatarImage) {
            avatar.style.background = `center / cover no-repeat url("${p.ownerAvatarImage}")`;
        } else {
            avatar.style.background = `linear-gradient(135deg, ${p.ownerAvatarColor}, #1b1b1b)`;
            avatar.textContent = (p.ownerDisplayName || p.owner).charAt(0).toUpperCase();
        }
        const names = el("div", "post-names");
        const who = el("a", "post-who", p.ownerDisplayName || p.owner);
        who.href = profileUrl(p.owner);
        names.append(who, el("span", "post-handle", "@" + p.owner));
        head.append(avatar, names, el("span", "post-tag", p.visibility === "global" ? "Global" : "Public"),
                    el("span", "post-time", formatRelativeShort(p.created_at)));
        post.appendChild(head);

        // title + description sit right under the profile row
        const body = el("div", "post-body");
        body.appendChild(el("div", "post-title", p.title));
        if (p.description) body.appendChild(el("div", "post-desc", p.description));
        body.appendChild(el("div", "post-when", formatEventWhen(p)));
        post.appendChild(body);

        // media
        const media = el("div", "post-media");
        if (p.image) {
            const pos = p.image_position || { x: 50, y: 50 };
            media.style.backgroundImage = `url("${p.image}")`;
            media.style.backgroundPosition = `${pos.x}% ${pos.y}%`;
        } else {
            media.style.background = `linear-gradient(135deg, ${p.color || EVENT_COLORS[0]}, #1b1b1b)`;
            media.textContent = p.icon || EVENT_ICONS[0];
        }
        post.appendChild(media);

        // actions
        const actions = el("div", "post-actions");
        if (!p.isMine) {
            const add = el("button", "post-btn" + (p.addedByMe ? " done" : ""), p.addedByMe ? "On your calendar" : "Add to calendar");
            add.type = "button";
            add.disabled = p.addedByMe;
            add.addEventListener("click", async () => {
                add.disabled = true;
                try {
                    await PlanoraData.addToMyCalendar(p.id);
                    add.textContent = "On your calendar";
                    add.classList.add("done");
                    toast(`Added "${p.title}" to your calendar.`, "success");
                } catch (err) {
                    toast(err.message, "error");
                    add.disabled = false;
                }
            });
            actions.appendChild(add);
        }
        if (p.isMine) {
            // opens the same slide-in drawer as "+", filled in with this post
            const edit = el("button", "post-btn", "Edit");
            edit.type = "button";
            edit.addEventListener("click", () => {
                if (typeof openEventFormRef === "function") openEventFormRef(p);
            });
            actions.appendChild(edit);
        }
        const count = el("button", "post-btn", `Comments (${p.commentCount})`);
        count.type = "button";
        actions.appendChild(count);
        post.appendChild(actions);

        // comments (opens on demand)
        let panel = null;
        count.addEventListener("click", async () => {
            if (panel) { panel.remove(); panel = null; return; }
            panel = el("div", "post-comments");
            post.appendChild(panel);
            await fillComments(panel, p, count);
        });

        return post;
    }

    async function fillComments(panel, p, countBtn) {
        panel.textContent = "";
        let list = [];
        try { list = await PlanoraData.getComments(p.id); } catch (err) { /* show empty */ }
        countBtn.textContent = `Comments (${list.length})`;

        list.forEach((c) => {
            const row = el("div", "post-comment");
            const a = el("a", "", "@" + c.author);
            a.href = profileUrl(c.author);
            row.append(a, document.createTextNode((c.reply_to ? "@" + c.reply_to + " " : "") + c.text));
            panel.appendChild(row);
        });

        const form = el("div", "post-composer");
        const input = el("input");
        input.placeholder = "Add a comment...";
        input.maxLength = 240;
        const send = el("button", "post-btn", "Post");
        send.type = "button";
        async function submit() {
            if (!input.value.trim()) return;
            send.disabled = true;
            try {
                await PlanoraData.addComment(p.id, input.value);
                await fillComments(panel, p, countBtn);
            } catch (err) {
                toast(err.message, "error");
                send.disabled = false;
            }
        }
        send.addEventListener("click", submit);
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
        form.append(input, send);
        panel.appendChild(form);
    }
})();


/* Create/edit event form -> slide-in drawer, same structure as the profile editor:
   header (title + close), scrolling body, pinned footer. Nodes are moved, not
   rebuilt, so every id and listener homepage.js set up keeps working. */
(function () {
    function mk(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    }

    function drawerize() {
        const form = document.querySelector(".event-form");
        const box = form && form.querySelector(".event-form-box");
        if (!box) return false;
        if (box.dataset.drawer) return true;
        box.dataset.drawer = "1";

        const title = box.querySelector(".form-title");
        const buttons = box.querySelector(".form-buttons");
        const head = mk("div", "ef-head");
        const scroll = mk("div", "ef-scroll");
        Array.from(box.children).forEach((c) => { if (c !== title && c !== buttons) scroll.appendChild(c); });

        const close = mk("button", "ef-close", "×");
        close.type = "button";
        close.setAttribute("aria-label", "Close");
        const cancel = () => document.getElementById("cancelEvent").click();
        close.addEventListener("click", cancel);

        head.append(title, close);
        box.append(head, scroll, buttons);

        form.addEventListener("click", (e) => { if (e.target === form) cancel(); }); // click the dark area
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && form.classList.contains("show")) cancel();
        });
        return true;
    }

    if (!drawerize()) {
        // the form is built after login check, so wait for it to appear
        const obs = new MutationObserver(() => { if (drawerize()) obs.disconnect(); });
        obs.observe(document.body, { childList: true });
    }
})();

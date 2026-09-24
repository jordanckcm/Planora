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
        if (p.isMine) {
            const menu = buildDotsMenu(
                [{ label: "Edit", run: () => { if (typeof openEventFormRef === "function") openEventFormRef(p); } }],
                { buttonClass: "post-menu", dropdownClass: "event-dropdown", ariaLabel: "Post options" }
            );
            if (menu) head.appendChild(menu);
        }
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

    function paintAv(node, image, color, name) {
        if (image) {
            node.style.background = `center / cover no-repeat url("${image}")`;
        } else {
            node.style.background = `linear-gradient(135deg, ${color || EVENT_COLORS[0]}, #1b1b1b)`;
            node.textContent = (name || "?").charAt(0).toUpperCase();
        }
    }

    // Instagram-style comments: avatar + username, time / Reply underneath,
    // replies tucked under their comment behind "View N replies".
    async function fillComments(panel, p, countBtn, expandId) {
        panel.textContent = "";
        let list = [];
        try { list = await PlanoraData.getComments(p.id); } catch (err) { /* show empty */ }
        countBtn.textContent = `Comments (${list.length})`;

        let replyTo = null;
        const input = el("input");
        const banner = el("div", "cm-replying");
        const bannerText = el("span");
        const bannerX = el("button", "cm-x", "×");
        bannerX.type = "button";
        banner.append(bannerText, bannerX);
        banner.hidden = true;

        function setReply(c) {
            replyTo = c;
            banner.hidden = !c;
            input.placeholder = c ? `Reply to @${c.author}...` : "Add a comment...";
            if (c) {
                bannerText.textContent = `Replying to @${c.author}`;
                input.focus();
            }
        }
        bannerX.addEventListener("click", () => setReply(null));

        function row(c, isReply) {
            const r = el("div", "cm" + (isReply ? " cm-reply" : ""));

            const av = el("a", "cm-avatar");
            av.href = profileUrl(c.author);
            paintAv(av, c.authorAvatarImage, c.authorAvatarColor, c.authorDisplayName || c.author);

            const line = el("div", "cm-line");
            const name = el("a", "cm-name", c.author);
            name.href = profileUrl(c.author);
            line.appendChild(name);
            if (c.reply_to) {
                const m = el("a", "cm-mention", "@" + c.reply_to);
                m.href = profileUrl(c.reply_to);
                line.appendChild(m);
            }
            line.appendChild(document.createTextNode(c.text));

            const meta = el("div", "cm-meta");
            const when = el("span", "", formatRelativeShort(c.created_at));
            when.title = formatFullTimestamp(c.created_at);
            const reply = el("button", "cm-reply-btn", "Reply");
            reply.type = "button";
            reply.addEventListener("click", () => setReply(c));
            meta.append(when, reply);

            const body = el("div", "cm-body");
            body.append(line, meta);
            r.append(av, body);
            return r;
        }

        const listEl = el("div", "cm-list");
        if (!list.length) listEl.appendChild(el("div", "cm-empty", "No comments yet. Start the conversation."));

        const known = new Set(list.map((c) => c.id));
        list.filter((c) => !c.parent_id || !known.has(c.parent_id)).forEach((top) => {
            const thread = el("div", "cm-thread");
            thread.appendChild(row(top, false));

            const replies = list.filter((r) => r.parent_id === top.id);
            if (replies.length) {
                const box = el("div", "cm-replies");
                replies.forEach((r) => box.appendChild(row(r, true)));

                const toggle = el("button", "cm-toggle");
                toggle.type = "button";
                let open = top.id === expandId;
                const sync = () => {
                    box.hidden = !open;
                    toggle.textContent = open ? "Hide replies" : `View ${replies.length} ${replies.length === 1 ? "reply" : "replies"}`;
                };
                toggle.addEventListener("click", () => { open = !open; sync(); });
                sync();
                thread.append(toggle, box);
            }
            listEl.appendChild(thread);
        });
        panel.appendChild(listEl);
        panel.appendChild(banner);

        const form = el("div", "post-composer");
        const me = el("span", "cm-avatar");
        paintAv(me, currentUser.avatarImage, currentUser.avatarColor, currentUser.displayName || currentUser.username);
        input.placeholder = "Add a comment...";
        input.maxLength = 240;
        const send = el("button", "post-btn", "Post");
        send.type = "button";
        async function submit() {
            if (!input.value.trim()) return;
            send.disabled = true;
            try {
                const created = await PlanoraData.addComment(p.id, input.value, replyTo ? replyTo.id : null);
                await fillComments(panel, p, countBtn, created.parent_id);
            } catch (err) {
                toast(err.message, "error");
                send.disabled = false;
            }
        }
        send.addEventListener("click", submit);
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
        form.append(me, input, send);
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

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
        const who = el("a", "post-who", p.isMine ? "You" : "@" + p.owner);
        who.href = profileUrl(p.owner);
        head.append(avatar, who, el("span", "post-tag", p.visibility === "global" ? "Global" : "Public"),
                    el("span", "post-time", formatRelativeShort(p.created_at)));
        post.appendChild(head);

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

        // caption
        const body = el("div", "post-body");
        body.appendChild(el("b", "", p.title));
        if (p.description) body.appendChild(document.createTextNode(p.description));
        body.appendChild(el("div", "post-when", formatEventWhen(p)));
        post.appendChild(body);

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

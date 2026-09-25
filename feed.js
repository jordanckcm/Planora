/* PLANORA — HOME FEED
   Load on homepage.html AFTER homepage.js and planora-nav.js.
   Home = scrollable feed of Global + Public events (GET /api/feed).
   Local / Global / Timeline still use homepage.js as-is; this file only
   decides whether render() shows the feed or hands off to the original.

   Comments: the inline panel on a post shows just the first top-level
   comment plus a "View all comments" link. Tapping that (or the post
   image) opens a full-screen post-detail modal with every comment,
   threaded replies, and Reply/Edit/Delete on your own comments —
   mirroring an Instagram-style post lightbox.

   Notifications: a link like homepage.html?post=ID&comment=ID opens that
   post's modal straight away, scrolls to the comment and flashes it.

   POST-LEVEL ACTIONS: a single ⋮ sits at the top-RIGHT of each post (and
   of the post-detail modal). If you own the post, it holds "Edit". If
   you don't, it holds just "Copy link".

   REACTIONS: a star button + count (server-side, one per person per
   post, toggled via POST /api/events/<id>/star) sits next to a
   "N going" count (how many other people have the post on their
   calendar) in the actions row.

   SEARCH: a small search bar above the feed filters the already-loaded
   posts by title/description/owner, client-side — matching the calendar
   page's search but scoped to Home. */

(function () {
    const hooks = window.PlanoraFeedHooks = { panels: new Map(), modal: null, onModalClose: null };
    const urlParams = new URLSearchParams(location.search);
    const view = urlParams.get("view");

    // ?post=ID&comment=ID comes from a notification: open that post's modal
    let pendingOpen = Number(urlParams.get("post"))
        ? { eventId: Number(urlParams.get("post")), commentId: Number(urlParams.get("comment")) || null }
        : null;
    if (pendingOpen) history.replaceState(null, "", location.pathname);

    let feedActive = pendingOpen !== null || !["local", "global", "timeline"].includes(view);
    if (!feedActive) mode = view; // homepage.js's mode, set before its first render

    const feed = document.createElement("div");
    feed.id = "feedContainer";
    document.body.insertBefore(feed, document.getElementById("toastStack"));

    // === FEED SEARCH ===
    // Filters the posts already fetched for this load of the feed — same
    // idea as the calendar's search, just scoped to titles/descriptions/
    // owners of Home posts instead of calendar events.
    const feedSearchBar = document.createElement("div");
    feedSearchBar.className = "search-bar feed-search-bar";
    feedSearchBar.innerHTML = `
        <input type="text" id="feedSearch" class="search-input" placeholder="Search posts…" autocomplete="off" maxlength="80">
        <button type="button" id="feedClearSearch" class="clear-search" aria-label="Clear search" style="display:none;">×</button>
    `;
    document.body.insertBefore(feedSearchBar, feed);

    const feedSearchInput = feedSearchBar.querySelector("#feedSearch");
    const feedClearBtn = feedSearchBar.querySelector("#feedClearSearch");
    let feedQuery = "";
    let latestPosts = [];

    feedSearchInput.addEventListener("input", () => {
        feedQuery = feedSearchInput.value.trim().toLowerCase();
        feedClearBtn.style.display = feedQuery ? "flex" : "none";
        renderFeedList();
    });
    feedClearBtn.addEventListener("click", () => {
        feedSearchInput.value = "";
        feedQuery = "";
        feedClearBtn.style.display = "none";
        feedSearchInput.focus();
        renderFeedList();
    });

    const baseRender = window.render;
    window.render = async function () {
        document.body.classList.toggle("feed-on", feedActive);
        feedSearchBar.style.display = feedActive ? "flex" : "none";
        if (window.PlanoraNav) PlanoraNav.setActive(feedActive ? "home" : mode);
        if (feedActive) { await loadFeed(); openPendingPost(); return; }
        return baseRender();
    };

    window.__planoraSetView = function (key) {
        feedActive = key === "home";
        if (feedActive) return window.render();
        document.querySelector("." + key + "-button").click(); // homepage.js sets mode + renders
    };

    async function loadFeed() {
        try {
            latestPosts = await apiRequest("/api/feed");
        } catch (err) {
            toast(err.message, "error");
            return;
        }
        renderFeedList();
    }

    function renderFeedList() {
        hooks.panels.clear();
        feed.textContent = "";

        const query = feedQuery;
        const posts = query
            ? latestPosts.filter(p =>
                p.title.toLowerCase().includes(query) ||
                (p.description && p.description.toLowerCase().includes(query)) ||
                p.owner.toLowerCase().includes(query))
            : latestPosts;

        if (!latestPosts.length) {
            const empty = document.createElement("div");
            empty.className = "feed-empty";
            empty.textContent = "Nothing here yet. Tap + and post a Public or Global event.";
            feed.appendChild(empty);
            return;
        }

        if (!posts.length) {
            const empty = document.createElement("div");
            empty.className = "feed-empty";
            empty.textContent = "No posts match your search.";
            feed.appendChild(empty);
            return;
        }

        posts.forEach((p) => feed.appendChild(buildPost(p)));
    }

    // Opens the post a notification points at. The feed only holds the 20
    // newest posts, so this asks the server for that one post directly.
    async function openPendingPost() {
        if (!pendingOpen) return;
        const target = pendingOpen;
        pendingOpen = null;
        try {
            const post = await apiRequest(`/api/events/${target.eventId}`);
            openPostDetail(post, target.commentId);
        } catch (err) {
            toast("That post isn't available anymore.", "error");
        }
    }

    function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    }

    // True once a post or comment has been changed after it was created.
    // Looks for either an explicit `edited` flag or an `updated_at` that
    // differs from `created_at` — whichever the API actually provides.
    function wasEdited(item) {
        return Boolean(item.edited) ||
            Boolean(item.updated_at && item.created_at && item.updated_at !== item.created_at);
    }

    // Turns "@username" tokens in plain text into profile links - but only
    // for names the server confirmed are real users (the `mentions` array
    // on the comment/event). Appended into `container` in order,
    // interleaved with the surrounding plain-text nodes.
    function appendTextWithMentions(container, text, mentions) {
        Planora.appendWithMentions(container, text, mentions, "cm-mention");
    }

    // position defaults to dead center when none is on record
    function paintAv(node, image, color, name, position) {
        if (image) {
            const pos = position || { x: 50, y: 50 };
            node.style.background = `${pos.x}% ${pos.y}% / cover no-repeat url("${image}")`;
        } else {
            node.style.background = `linear-gradient(135deg, ${color || EVENT_COLORS[0]}, #1b1b1b)`;
            node.textContent = (name || "?").charAt(0).toUpperCase();
        }
    }

    // "Copy link" — used by the post menu, on both the card and the modal.
    function copyPostLink(p) {
        const url = `${location.origin}${location.pathname}?post=${p.id}`;
        if (!navigator.clipboard || !navigator.clipboard.writeText) {
            toast("Copying isn't supported in this browser.", "error");
            return;
        }
        navigator.clipboard.writeText(url)
            .then(() => toast("Link copied to clipboard.", "success"))
            .catch(() => toast("Couldn't copy the link.", "error"));
    }

    // Single top-right ⋮ menu for a post. Owners get "Edit"; everyone
    // else gets just "Copy link". buttonClass lets the card and the
    // modal each use their own styling hook.
    function buildPostMenu(p, onEdit, buttonClass = "post-menu") {
        const items = p.isMine
            ? [{ label: "Edit", run: onEdit }]
            : [{ label: "Copy link", run: () => copyPostLink(p) }];

        return buildDotsMenu(items, {
            buttonClass,
            dropdownClass: "event-dropdown",
            ariaLabel: "Post options"
        });
    }

    // Star button + live count, shared shape between the card and the modal.
    function buildStarButton(p) {
        const starBtn = el("button", "post-btn post-star" + (p.starredByMe ? " starred" : ""));
        starBtn.type = "button";

        function paint() {
            starBtn.textContent = (p.starredByMe ? "★" : "☆") + " " + (p.starCount || 0);
            starBtn.classList.toggle("starred", Boolean(p.starredByMe));
        }
        paint();

        starBtn.addEventListener("click", async () => {
            starBtn.disabled = true;
            try {
                const result = await apiRequest(`/api/events/${p.id}/star`, { method: "POST" });
                p.starredByMe = result.starred;
                p.starCount = result.starCount;
                paint();
            } catch (err) {
                toast(err.message, "error");
            } finally {
                starBtn.disabled = false;
            }
        });

        return starBtn;
    }

    function buildPost(p) {
        const post = el("article", "post");
        post.dataset.postId = p.id;

        // header — avatar/name/tag/time, then the single top-right ⋮ menu
        // (Edit for your own posts, Copy link for everyone else's)
        const head = el("div", "post-head");

        const avatar = el("a", "post-avatar");
        avatar.href = profileUrl(p.owner);
        avatar.dataset.profileHover = p.owner;
        if (p.ownerAvatarImage) {
            const pos = p.ownerAvatarPosition || { x: 50, y: 50 };
            avatar.style.background = `${pos.x}% ${pos.y}% / cover no-repeat url("${p.ownerAvatarImage}")`;
        } else {
            avatar.style.background = `linear-gradient(135deg, ${p.ownerAvatarColor}, #1b1b1b)`;
            avatar.textContent = (p.ownerDisplayName || p.owner).charAt(0).toUpperCase();
        }
        const names = el("div", "post-names");
        const who = el("a", "post-who", p.ownerDisplayName || p.owner);
        who.href = profileUrl(p.owner);
        who.dataset.profileHover = p.owner;
        names.append(who, el("span", "post-handle", "@" + p.owner));
        head.append(avatar, names, el("span", "post-tag", p.visibility === "global" ? "Global" : "Public"),
                    el("span", "post-time", formatRelativeShort(p.created_at)));
        if (wasEdited(p)) head.appendChild(el("span", "post-time", "Edited"));

        const menu = buildPostMenu(p, () => {
            if (typeof openEventFormRef === "function") openEventFormRef(p);
        });
        if (menu) head.appendChild(menu);

        post.appendChild(head);

        // title + description sit right under the profile row
        const body = el("div", "post-body");
        body.appendChild(el("div", "post-title", p.title));
        if (p.description) {
            const desc = el("div", "post-desc");
            appendTextWithMentions(desc, p.description, p.mentions);
            body.appendChild(desc);
        }
        body.appendChild(el("div", "post-when", formatEventWhen(p)));
        post.appendChild(body);

        // media — tapping it opens the full post detail modal
        const media = el("div", "post-media");
        media.style.cursor = "pointer";
        if (p.image) {
            const pos = p.image_position || { x: 50, y: 50 };
            media.style.backgroundImage = `url("${p.image}")`;
            media.style.backgroundPosition = `${pos.x}% ${pos.y}%`;
        } else {
            media.style.background = `linear-gradient(135deg, ${p.color || EVENT_COLORS[0]}, #1b1b1b)`;
            media.textContent = p.icon || EVENT_ICONS[0];
        }
        media.addEventListener("click", () => openPostDetail(p));
        post.appendChild(media);

        // actions — star + going count, then Comments. "Add to calendar"
        // is not offered from the post card; use the calendar/global view
        // to add someone else's post if needed.
        const actions = el("div", "post-actions");

        actions.appendChild(buildStarButton(p));

        if (p.goingCount > 0) {
            actions.appendChild(el("span", "post-going-count", `${p.goingCount} going`));
        }

        const count = el("button", "post-btn", `Comments (${p.commentCount})`);
        count.type = "button";
        actions.appendChild(count);
        post.appendChild(actions);

        // inline preview panel: just the first comment + "View all comments"
        let panel = null;
        count.addEventListener("click", async () => {
            if (panel) { panel.remove(); panel = null; hooks.panels.delete(p.id); return; }
            panel = el("div", "post-comments");
            post.appendChild(panel);
            const panelEl = panel;
            const opts = { full: false, focusId: null, listEl: panelEl, formEl: panelEl, countBtn: count };
            hooks.panels.set(p.id, { panel: panelEl, reload: () => renderComments(p, opts) });
            await renderComments(p, opts);
        });

        return post;
    }

    /* ---------- Shared comments renderer ----------
       full=false  -> inline preview: first top-level comment + "View all comments"
       full=true   -> full-screen modal: every comment, all threads open-able
       Renders into listEl (comment list + reply banner) and formEl (composer).
       For the inline panel these are the same node; for the modal they're
       the scrolling body and the pinned footer, respectively.
       focusId (modal only): a comment id to open the thread of. */
    async function renderComments(post, { full, focusId, listEl: listContainer, formEl: composerContainer, countBtn }) {
        let list = [];
        try { list = await PlanoraData.getComments(post.id); } catch (err) { /* show empty */ }
        if (countBtn) countBtn.textContent = `Comments (${list.length})`;

        listContainer.textContent = "";
        composerContainer.textContent = "";

        let mode = null; // { type: "reply" | "edit", comment }
        const input = el("input");
        input.dataset.mentions = "1"; // @mention autocomplete (planora-mentions.js)
        const banner = el("div", "cm-replying");
        const bannerText = el("span");
        const bannerX = el("button", "cm-x", "×");
        bannerX.type = "button";
        banner.append(bannerText, bannerX);
        banner.hidden = true;

        function setMode(next) {
            mode = next;
            banner.hidden = !mode;
            if (!mode) {
                input.value = "";
                input.placeholder = "Add a comment...";
                send.textContent = "Post";
                return;
            }
            if (mode.type === "reply") {
                input.value = "";
                input.placeholder = `Reply to @${mode.comment.author}...`;
                bannerText.textContent = `Replying to @${mode.comment.author}`;
                send.textContent = "Post";
            } else {
                input.value = mode.comment.text;
                input.placeholder = "Edit comment...";
                bannerText.textContent = "Editing comment";
                send.textContent = "Save";
            }
            input.focus();
        }
        bannerX.addEventListener("click", () => setMode(null));

        function refresh(nextFocusId) {
            return renderComments(post, {
                full, focusId: nextFocusId, listEl: listContainer, formEl: composerContainer, countBtn,
            });
        }

        function row(c, isReply) {
            const r = el("div", "cm" + (isReply ? " cm-reply" : ""));
            r.dataset.commentId = c.id;

            const av = el("a", "cm-avatar");
            av.href = profileUrl(c.author);
            av.dataset.profileHover = c.author;
            paintAv(av, c.authorAvatarImage, c.authorAvatarColor, c.authorDisplayName || c.author, c.authorAvatarPosition);

            const line = el("div", "cm-line");
            const name = el("a", "cm-name", c.author);
            name.href = profileUrl(c.author);
            name.dataset.profileHover = c.author;
            line.appendChild(name);
            if (c.reply_to) {
                const m = el("a", "cm-mention", "@" + c.reply_to);
                m.href = profileUrl(c.reply_to);
                m.dataset.profileHover = c.reply_to;
                line.appendChild(m);
            }
            appendTextWithMentions(line, c.text, c.mentions);

            const meta = el("div", "cm-meta");
            const when = el("span", "", formatRelativeShort(c.created_at));
            when.title = formatFullTimestamp(c.created_at);
            meta.appendChild(when);
            if (wasEdited(c)) meta.appendChild(el("span", "", "Edited"));

            const reply = el("button", "cm-reply-btn", "Reply");
            reply.type = "button";
            reply.addEventListener("click", () => setMode({ type: "reply", comment: c }));
            meta.appendChild(reply);

            if (c.author === currentUser.username) {
                const editBtn = el("button", "cm-reply-btn", "Edit");
                editBtn.type = "button";
                editBtn.addEventListener("click", () => setMode({ type: "edit", comment: c }));
                meta.appendChild(editBtn);

                const delBtn = el("button", "cm-reply-btn", "Delete");
                delBtn.type = "button";
                delBtn.addEventListener("click", async () => {
                    if (!confirm("Delete this comment?")) return;
                    try {
                        await PlanoraData.deleteComment(post.id, c.id);
                        await refresh(null);
                    } catch (err) {
                        toast(err.message, "error");
                    }
                });
                meta.appendChild(delBtn);
            }

            const bodyEl = el("div", "cm-body");
            bodyEl.append(line, meta);
            r.append(av, bodyEl);
            return r;
        }

        const listWrap = el("div", "cm-list");
        const known = new Set(list.map((c) => c.id));
        const topLevel = list.filter((c) => !c.parent_id || !known.has(c.parent_id));

        if (!topLevel.length) {
            listWrap.appendChild(el("div", "cm-empty", "No comments yet. Start the conversation."));
        } else {
            const visibleTop = full ? topLevel : topLevel.slice(0, 1);
            visibleTop.forEach((top) => {
                const thread = el("div", "cm-thread");
                thread.appendChild(row(top, false));

                const replies = list.filter((r) => r.parent_id === top.id);
                if (replies.length) {
                    const box = el("div", "cm-replies");
                    replies.forEach((r) => box.appendChild(row(r, true)));

                    const toggle = el("button", "cm-toggle");
                    toggle.type = "button";
                    // open the thread if it IS the focused comment, or contains it
                    // (a notification can point at a reply inside a collapsed thread)
                    let open = top.id === focusId || replies.some((r) => r.id === focusId);
                    const sync = () => {
                        box.hidden = !open;
                        toggle.textContent = open ? "Hide replies" : `View ${replies.length} ${replies.length === 1 ? "reply" : "replies"}`;
                    };
                    toggle.addEventListener("click", () => { open = !open; sync(); });
                    sync();
                    thread.append(toggle, box);
                }
                listWrap.appendChild(thread);
            });

            if (!full && topLevel.length > visibleTop.length) {
                const viewAll = el("button", "cm-toggle cm-viewall", `View all ${list.length} comments`);
                viewAll.type = "button";
                viewAll.addEventListener("click", () => openPostDetail(post, focusId));
                listWrap.appendChild(viewAll);
            }
        }

        listContainer.appendChild(listWrap);
        listContainer.appendChild(banner);

        const form = el("div", "post-composer");
        const me = el("span", "cm-avatar");
        paintAv(me, currentUser.avatarImage, currentUser.avatarColor, currentUser.displayName || currentUser.username, currentUser.avatarPosition);
        input.placeholder = "Add a comment...";
        input.maxLength = 240;
        const send = el("button", "post-btn", "Post");
        send.type = "button";
        async function submit() {
            const text = input.value.trim();
            if (!text) return;
            send.disabled = true;
            try {
                if (mode && mode.type === "edit") {
                    await PlanoraData.editComment(post.id, mode.comment.id, text);
                    await refresh(null);
                } else {
                    const created = await PlanoraData.addComment(post.id, text, mode && mode.type === "reply" ? mode.comment.id : null);
                    await refresh(created.parent_id);
                }
            } catch (err) {
                toast(err.message, "error");
                send.disabled = false;
            }
        }
        send.addEventListener("click", submit);
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
        form.append(me, input, send);
        composerContainer.appendChild(form);
    }

    /* ----------

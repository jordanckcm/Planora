/* PLANORA — @mention autocomplete.
   Include AFTER api.js, at the end of <body>.
   Any <input>/<textarea data-mentions> gets a dropdown when you type @name,
   including ones created later (a MutationObserver watches for them).
   Needs at least one typed character after "@" before it searches, so it
   never pulls the whole user list. Exposes PlanoraMentions.attach(el) for
   fields that already exist in the HTML. */
(function () {
    const SELECTOR = "input[data-mentions], textarea[data-mentions]";

    const style = document.createElement("style");
    style.textContent =
        ".pl-mention-menu{position:fixed;z-index:10001;min-width:210px;max-width:300px;padding:4px;border-radius:10px;" +
        "background:#1b1b1b;color:#fff;border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 24px rgba(0,0,0,.4)}" +
        ".pl-mention-row{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:7px;cursor:pointer;font-size:14px}" +
        ".pl-mention-row.active,.pl-mention-row:hover{background:rgba(255,255,255,.1)}" +
        ".pl-mention-row small{opacity:.6;margin-left:auto}" +
        ".pl-mention-dot{width:18px;height:18px;border-radius:50%;flex:none}";
    document.head.appendChild(style);

    function attach(input) {
        if (input.dataset.mentionsAttached) return;
        input.dataset.mentionsAttached = "1";

        let menu = null, matches = [], index = 0, seq = 0, timer = null;

        function hide() {
            if (menu) { menu.remove(); menu = null; }
            matches = [];
        }

        // the "@partial" right before the caret, if any
        function currentToken() {
            const pos = input.selectionStart;
            const m = /(^|[^\w@.])@([A-Za-z0-9_.]{0,40})$/.exec(input.value.slice(0, pos));
            return m ? { start: pos - m[2].length - 1, end: pos, query: m[2] } : null;
        }

        function render() {
            if (!menu) {
                menu = document.createElement("div");
                menu.className = "pl-mention-menu";
                menu.setAttribute("role", "listbox");
                document.body.appendChild(menu);
            }
            menu.innerHTML = "";
            matches.forEach((u, i) => {
                const row = document.createElement("div");
                row.className = "pl-mention-row" + (i === index ? " active" : "");
                row.setAttribute("role", "option");

                const dot = document.createElement("span");
                dot.className = "pl-mention-dot";
                dot.style.background = u.avatarColor || "#c9a227";

                const name = document.createElement("span");
                name.textContent = u.displayName;
                const handle = document.createElement("small");
                handle.textContent = "@" + u.username;

                row.append(dot, name, handle);
                // mousedown is swallowed so the input keeps focus; the click does the picking.
                // stopPropagation so "click outside cancels the edit" handlers don't fire.
                row.addEventListener("mousedown", (e) => e.preventDefault());
                row.addEventListener("click", (e) => { e.stopPropagation(); choose(i); });
                menu.appendChild(row);
            });

            const r = input.getBoundingClientRect();
            menu.style.left = r.left + "px";
            // flip above the input when there's no room below (e.g. a composer pinned to the bottom)
            const below = r.bottom + 4;
            menu.style.top = (below + menu.offsetHeight > window.innerHeight
                ? Math.max(4, r.top - menu.offsetHeight - 4)
                : below) + "px";
        }

        function choose(i) {
            const user = matches[i];
            const token = currentToken();
            if (!user || !token) return hide();
            const insert = "@" + user.username + " ";
            input.value = input.value.slice(0, token.start) + insert + input.value.slice(token.end);
            const caret = token.start + insert.length;
            input.setSelectionRange(caret, caret);
            hide();
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.focus();
        }

        input.addEventListener("input", () => {
            clearTimeout(timer);
            const token = currentToken();
            if (!token || token.query.length < 1) return hide();
            const mySeq = ++seq;
            const q = token.query.toLowerCase();
            timer = setTimeout(async () => {
                try {
                    const users = await Planora.searchUsers({ q: token.query });
                    if (mySeq !== seq) return; // a newer keystroke superseded this one
                    users.sort((a, b) =>
                        Number(b.username.toLowerCase().startsWith(q)) - Number(a.username.toLowerCase().startsWith(q)));
                    matches = users.slice(0, 5);
                    index = 0;
                    matches.length ? render() : hide();
                } catch (e) { hide(); }
            }, 150);
        });

        // capture phase, so Enter/Tab picks a person instead of submitting the comment
        input.addEventListener("keydown", (e) => {
            if (!menu) return;
            if (e.key === "ArrowDown") { e.preventDefault(); index = (index + 1) % matches.length; render(); }
            else if (e.key === "ArrowUp") { e.preventDefault(); index = (index - 1 + matches.length) % matches.length; render(); }
            else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); e.stopImmediatePropagation(); choose(index); }
            else if (e.key === "Escape") { hide(); }
        }, true);

        input.addEventListener("blur", hide);
    }

    function scan(root) {
        if (root.matches && root.matches(SELECTOR)) attach(root);
        if (root.querySelectorAll) root.querySelectorAll(SELECTOR).forEach(attach);
    }

    new MutationObserver((records) => {
        records.forEach((r) => r.addedNodes.forEach((n) => { if (n.nodeType === 1) scan(n); }));
    }).observe(document.body, { childList: true, subtree: true });
    scan(document.body);

    window.PlanoraMentions = { attach };
})();

/*
  Planora live updates  ->  <script src="/live.js"></script> on every page that should stay fresh.

  It asks the server "what changed?" every few seconds (tiny answer: ids and usernames only),
  then calls YOUR functions so you can re-fetch just that part. Nothing to install.

  PlanoraLive.start({
    onEvents(ids)         // posts/events were added, edited or deleted. ids may contain null = "some".
                          // Re-fetch your feed / calendar here. If the person has scrolled down (or
                          // isBusy() is true) this is held back behind a "New posts" pill instead,
                          // so the page never jumps under their thumb.
    onComments(ids)       // comments changed on these event ids (null = any). Reload the open post's comments.
    onProfiles(usernames) // these people changed their profile (or signed up / were removed).
    onNotifications(n)    // the unread count (n) - call your bell update. Fires when it changes.
    onReset()             // optional: too much was missed / server restarted. Default: calls the above with null.
    isBusy()              // optional: return true while the person is typing a comment etc.
    pillText              // optional, default "↑ New posts"
    sound: false          // optional: set false to stop live.js chiming (needs sound.js loaded to chime at all)
  });

  PlanoraLive.stop();
  PlanoraLive.refreshNow();                       // check immediately
  PlanoraLive.endOfFeed(containerEl, { refresh }) // "You're all caught up" footer with a Refresh button
                                                  // refresh = your function that reloads the feed (may be async)
*/
(function () {
  const POLL_MS = 8000;          // while the tab is visible
  const HIDDEN_POLL_MS = 60000;  // while it's in the background
  const PILL_SCROLL_PX = 200;    // scrolled further than this -> hold updates behind the pill

  let opts = {};
  let seq = null;
  let timer = null;
  let running = false;
  let busy = false;
  let failures = 0;
  let lastOk = 0;
  let lastUnread = null;
  let pillEl = null;
  let pendingEvents = null;      // ids waiting behind the pill
  const listeners = new Set();   // footers listening for status changes

  // ---------- polling ----------
  function schedule() {
    clearTimeout(timer);
    if (!running) return;
    const base = document.hidden ? HIDDEN_POLL_MS : POLL_MS;
    const delay = Math.min(base * Math.pow(2, Math.min(failures, 3)), 60000); // back off when failing
    timer = setTimeout(poll, delay);
  }

  async function poll() {
    if (busy || !running) return;
    busy = true;
    try {
      const url = "/api/changes" + (seq === null ? "" : "?since=" + seq);
      const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
      if (res.status === 401) { stop(); return; }   // signed out
      if (!res.ok) throw new Error("bad status " + res.status);
      const data = await res.json();
      failures = 0;
      lastOk = Date.now();
      handle(data);
    } catch (e) {
      failures += 1;
    } finally {
      busy = false;
      notify();
      schedule();
    }
  }

  function call(fn, ...args) {
    if (typeof fn !== "function") return;
    try { fn(...args); } catch (e) { console.error("[PlanoraLive]", e); }
  }

  function handle(data) {
    const first = seq === null;
    seq = data.seq;

    if (first) {                       // just learn the position + unread count
      lastUnread = data.unread;
      call(opts.onNotifications, data.unread);
      return;
    }

    if (data.reset) {                  // missed too much: everything may be stale
      if (opts.onReset) call(opts.onReset);
      else {
        offerEvents([null]);
        call(opts.onComments, [null]);
        call(opts.onProfiles, []);
      }
      lastUnread = data.unread;
      call(opts.onNotifications, data.unread);
      return;
    }

    if (data.events.length) offerEvents(data.events);
    if (data.comments.length) call(opts.onComments, data.comments);
    if (data.profiles.length) call(opts.onProfiles, data.profiles);
    if (data.notifications || data.unread !== lastUnread) {
      // a new notification arrived: chime (only if sound.js is loaded, and never on first load)
      if (window.PlanoraSound && opts.sound !== false && lastUnread !== null && data.unread > lastUnread) {
        window.PlanoraSound.play("message");
      }
      lastUnread = data.unread;
      call(opts.onNotifications, data.unread);
    }
  }

  // ---------- "New posts" pill ----------
  function shouldHold() {
    if (window.scrollY > PILL_SCROLL_PX) return true;
    return typeof opts.isBusy === "function" && !!opts.isBusy();
  }

  function offerEvents(ids) {
    if (shouldHold()) {
      pendingEvents = ids;
      showPill();
    } else {
      hidePill();
      call(opts.onEvents, ids);
    }
  }

  function showPill() {
    if (pillEl) return;
    pillEl = document.createElement("button");
    pillEl.type = "button";
    pillEl.className = "planora-pill";
    pillEl.textContent = opts.pillText || "↑ New posts";
    pillEl.addEventListener("click", () => {
      const ids = pendingEvents || [null];
      hidePill();
      window.scrollTo({ top: 0, behavior: "smooth" });
      call(opts.onEvents, ids);
    });
    document.body.appendChild(pillEl);
  }

  function hidePill() {
    pendingEvents = null;
    if (pillEl) { pillEl.remove(); pillEl = null; }
  }

  // Scrolling back to the top with updates waiting: just apply them.
  window.addEventListener("scroll", () => {
    if (pendingEvents && window.scrollY <= PILL_SCROLL_PX && !shouldHold()) {
      const ids = pendingEvents;
      hidePill();
      call(opts.onEvents, ids);
    }
  }, { passive: true });

  // ---------- start / stop ----------
  function start(options) {
    opts = options || {};
    if (running) return;
    running = true;
    seq = null;
    failures = 0;
    poll();
  }

  function stop() {
    running = false;
    clearTimeout(timer);
    hidePill();
    notify();
  }

  function refreshNow() {
    if (!running) return Promise.resolve();
    clearTimeout(timer);
    return poll();
  }

  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshNow(); });
  window.addEventListener("online", refreshNow);
  // a push just arrived (see sw.js) - that's a strong hint something changed
  window.addEventListener("planora:push", refreshNow);

  // ---------- end-of-feed footer ----------
  function ago(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 10) return "just now";
    if (s < 60) return s + "s ago";
    const m = Math.round(s / 60);
    return m < 60 ? m + " min ago" : Math.round(m / 60) + " hr ago";
  }

  function notify() { listeners.forEach((fn) => fn()); }

  function endOfFeed(container, options) {
    const refresh = (options && options.refresh) || function () {};

    const box = document.createElement("div");
    box.className = "planora-end";
    const msg = document.createElement("div");
    msg.className = "planora-end-msg";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "planora-end-btn";
    btn.textContent = "Refresh";
    const sub = document.createElement("div");
    sub.className = "planora-end-sub";
    box.append(msg, btn, sub);
    container.appendChild(box);

    function render() {
      const paused = failures >= 3 || !running;
      msg.textContent = paused ? "Live updates paused" : "You're all caught up";
      btn.textContent = paused ? "Retry" : "Refresh";
      sub.textContent = paused
        ? (navigator.onLine ? "Can't reach Planora right now." : "You're offline.")
        : (lastOk ? "Checked " + ago(lastOk) : "");
    }

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Refreshing…";
      try {
        if (!running && opts && Object.keys(opts).length) start(opts);
        await refresh();
        await refreshNow();
      } finally {
        btn.disabled = false;
        render();
      }
    });

    const tick = setInterval(render, 15000);   // keeps "Checked 2 min ago" honest
    listeners.add(render);
    render();

    return {
      destroy() { clearInterval(tick); listeners.delete(render); box.remove(); },
    };
  }

  // ---------- tiny default styling (works on light and dark; override freely) ----------
  const css = document.createElement("style");
  css.textContent = `
    .planora-pill{position:fixed;top:calc(env(safe-area-inset-top,0px) + 64px);left:50%;transform:translateX(-50%);
      z-index:1000;padding:.5rem 1rem;border:0;border-radius:999px;font:inherit;font-weight:600;cursor:pointer;
      background:var(--gold,var(--accent,#c9a227));color:#111;box-shadow:0 4px 14px rgba(0,0,0,.3)}
    body.pd-lock .planora-pill{display:none}
    .planora-end{text-align:center;padding:2rem 1rem 3rem;opacity:.9}
    .planora-end-msg{font-weight:600;margin-bottom:.75rem}
    .planora-end-btn{padding:.5rem 1.25rem;border-radius:999px;border:1px solid rgba(128,128,128,.5);
      background:transparent;color:inherit;font:inherit;cursor:pointer}
    .planora-end-btn:disabled{opacity:.6;cursor:default}
    .planora-end-sub{margin-top:.6rem;font-size:.8em;opacity:.65}
  `;
  document.head.appendChild(css);

  window.PlanoraLive = { start, stop, refreshNow, endOfFeed };
})();

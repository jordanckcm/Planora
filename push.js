/*
  Planora push helper  ->  <script src="/push.js"></script> on every page.

  window.PlanoraPush.
    supported            true if this browser can do web push at all
    needsInstall()       true on iPhone/iPad when Planora isn't added to the home screen yet
                         (iOS only allows push for installed web apps - show "Add to Home Screen" help)
    status()             "unsupported" | "needs-install" | "blocked" | "off" | "on"
    enable()             ask permission + subscribe. CALL THIS FROM A BUTTON CLICK.
    disable()            unsubscribe this device
    sync()               call on every page load once signed in: re-registers this
                         device (the server forgets everyone when it restarts)
    logoutCleanup()      call right BEFORE fetch("/api/logout"); returns the body to send
    sendTest()           asks the server to push a test notification to your devices

  Events on window:
    "planora:push"  detail = the push payload; use it to refresh the bell / unread count.
*/
(function () {
  const OFF_FLAG = "planora_push_off";   // set when the person turned notifications off on purpose

  const supported =
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  function needsInstall() {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone = window.navigator.standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches;
    return ios && !standalone;
  }

  function urlB64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((ch) => ch.charCodeAt(0)));
  }

  async function post(url, data) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(data || {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "Request failed");
    return json;
  }

  async function registration() {
    await navigator.serviceWorker.register("/sw.js");
    return navigator.serviceWorker.ready;
  }

  async function currentSubscription() {
    if (!supported) return null;
    const reg = await registration();
    return reg.pushManager.getSubscription();
  }

  async function subscribeAndSend() {
    const reg = await registration();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { key } = await (await fetch("/api/push/vapid-public-key")).json();
      if (!key) throw new Error("Push isn't set up on the server yet.");
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(key),
      });
    }
    await post("/api/push/subscribe", { subscription: sub.toJSON() });
    return sub;
  }

  async function status() {
    if (!supported) return "unsupported";
    if (needsInstall()) return "needs-install";
    if (Notification.permission === "denied") return "blocked";
    if (Notification.permission !== "granted") return "off";
    if (localStorage.getItem(OFF_FLAG)) return "off";
    return (await currentSubscription()) ? "on" : "off";
  }

  async function enable() {
    if (!supported) return { ok: false, reason: "unsupported" };
    if (needsInstall()) return { ok: false, reason: "needs-install" };

    const permission = await Notification.requestPermission();
    if (permission !== "granted") return { ok: false, reason: permission };  // "denied" | "default"

    localStorage.removeItem(OFF_FLAG);
    await subscribeAndSend();

    // send their time zone along so quiet hours and reminders line up with their clock
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await fetch("/api/push/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ timezone: tz, enabled: true }),
      });
    } catch (e) { /* not fatal */ }

    return { ok: true };
  }

  async function disable() {
    localStorage.setItem(OFF_FLAG, "1");
    const sub = await currentSubscription();
    if (sub) {
      try { await post("/api/push/unsubscribe", { endpoint: sub.endpoint }); } catch (e) {}
      await sub.unsubscribe();
    }
    return { ok: true };
  }

  async function sync() {
    if (!supported || needsInstall()) return;
    if (Notification.permission !== "granted" || localStorage.getItem(OFF_FLAG)) return;
    try { await subscribeAndSend(); } catch (e) { /* signed out or offline - try next load */ }
  }

  // Sign-out on a shared computer shouldn't leave the old account's
  // notifications arriving on it.
  async function logoutCleanup() {
    try {
      const sub = await currentSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        return { pushEndpoint: endpoint };
      }
    } catch (e) {}
    return {};
  }

  async function sendTest() {
    return post("/api/push/test", {});
  }

  if (supported) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data && event.data.type === "push") {
        window.dispatchEvent(new CustomEvent("planora:push", { detail: event.data.payload }));
      }
    });
  }

  window.PlanoraPush = { supported, needsInstall, status, enable, disable, sync, logoutCleanup, sendTest };
})();

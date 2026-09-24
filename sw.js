/*
  Planora service worker  ->  save as sw.js next to app.py (it must be served
  from the site root, i.e. https://yoursite/sw.js, so it can control every page).

  Push payload from the server:
    { title, body, url, tag, kind, eventId, eventTitle, badge, ts }
  kind is "mention" | "reply" | "comment" | "reminder" | "test".
*/

const ICON = "/icon-192.png";        // put a 192x192 PNG here
const BADGE_ICON = "/badge-72.png";  // optional: small monochrome PNG for the Android status bar

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));


self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Planora", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(showPush(data));
});


async function showPush(d) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

  // Let any open tab refresh its bell right away.
  windows.forEach((c) => c.postMessage({ type: "push", payload: d }));

  // App-icon badge (installed PWAs on Android, desktop, iOS).
  if (typeof d.badge === "number" && self.navigator && self.navigator.setAppBadge) {
    try {
      if (d.badge > 0) await self.navigator.setAppBadge(d.badge);
      else await self.navigator.clearAppBadge();
    } catch (e) { /* badge is optional */ }
  }

  // If they're looking at Planora right now, the in-app bell is enough - so show
  // the notification quietly and take it away after a few seconds. (Don't skip
  // showing it entirely: Safari cancels a site's push subscription if pushes
  // arrive without a visible notification.)
  const looking = windows.some((c) => c.visibilityState === "visible");

  // Collapse a burst about the same post into one notification:
  // "3 new notifications in Movie Night" instead of three buzzes.
  let title = d.title || "Planora";
  let body = d.body || "";
  let count = 1;
  const groupable = d.tag && d.kind !== "reminder" && d.kind !== "test";

  if (groupable) {
    const existing = await self.registration.getNotifications({ tag: d.tag });
    if (existing.length) {
      count = ((existing[0].data && existing[0].data.count) || 1) + 1;
      existing.forEach((n) => n.close());
      title = `${count} new notifications in ${d.eventTitle || "Planora"}`;
      body = d.body ? `Latest: ${d.body}` : "";
    }
  }

  const options = {
    body,
    icon: ICON,
    badge: BADGE_ICON,
    tag: d.tag || undefined,
    renotify: !!d.tag,               // a new push on the same tag still alerts
    timestamp: d.ts || Date.now(),
    silent: looking,
    data: { url: d.url || "/", count, kind: d.kind },
  };

  await self.registration.showNotification(title, options);

  if (looking) {
    setTimeout(async () => {
      const shown = await self.registration.getNotifications({ tag: d.tag || undefined });
      shown.forEach((n) => n.close());
    }, 5000);
  }
}


self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of windows) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        if ("navigate" in c) await c.navigate(target);
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});


// The browser can rotate a subscription on its own. Re-register the new one.
function urlB64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((ch) => ch.charCodeAt(0)));
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    try {
      const res = await fetch("/api/push/vapid-public-key");
      const { key } = await res.json();
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(key),
      });
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
    } catch (e) { /* they'll be re-subscribed next time they open the app */ }
  })());
});

/* PLANORA — PUSH NOTIFICATIONS
   Asks for permission and subscribes once, after login. Safe to include
   on every page that already loads api.js + a service worker. */

(function () {
    function urlBase64ToUint8Array(base64String) {
        const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
        const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
        const rawData = atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; i++) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }

    async function subscribeToPush() {
        if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;

        // don't re-prompt someone who already said no
        if (Notification.permission === "denied") return;

        const permission = await Notification.requestPermission();
        if (permission !== "granted") return;

        const registration = await navigator.serviceWorker.ready;

        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
            const { key } = await apiRequest("/api/push/vapid-public-key");
            if (!key) return; // server hasn't set VAPID keys yet

            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(key)
            });
        }

        try {
            await apiRequest("/api/push/subscribe", { method: "POST", body: { subscription } });
        } catch (e) { /* best-effort — try again next page load */ }
    }

    // Only bother once we know someone's actually signed in
    Planora.getCurrentUser().then((user) => {
        if (user) subscribeToPush();
    });
})();

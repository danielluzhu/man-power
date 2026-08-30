/**
 * sw.js — service worker, for arrivals only.
 *
 * Deliberately not a caching layer. Its whole job is to be running when the
 * page is not, so a courier that lands three weeks after you closed the tab can
 * still get your attention.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "A courier reached you" };
  }

  event.waitUntil(
    self.registration.showNotification(data.title || "A courier reached you", {
      body: data.body || "",
      // Same tag per message, so a replayed delivery replaces the old
      // notification rather than stacking a second one.
      tag: data.tag || "man-power",
      renotify: false,
      badge: "/icon-mono.png",
      icon: "/icon.png",
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";

  // Prefer an open tab over launching another one.
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.navigate?.(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

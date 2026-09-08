/**
 * The service worker that shows monitoring alerts.
 *
 * Served from /public so its scope is the whole origin — a worker at
 * /_next/… could only ever be woken for pages under that path, and a push
 * arrives when no page is open at all, which is the entire point of it.
 *
 * Deliberately tiny and dependency-free. It is the one piece of this app that
 * keeps running after every tab is closed, and it is cached by the browser
 * until the bytes change, so anything clever here outlives the deploy that
 * regretted it.
 */

self.addEventListener("install", () => {
  // Take over without waiting for the old worker's tabs to close. There is no
  // shared state between versions to migrate, so the only thing waiting would
  // achieve is a stale worker handling a push after an update.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    // A push with a body we cannot read is still worth showing: silence is
    // the one outcome that looks identical to the feature being broken.
    payload = { title: "Magnemite", body: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title ?? "Magnemite", {
      body: payload.body ?? "",
      icon: "/magnemite-256.png",
      badge: "/magnemite-256.png",
      // Same box, same signal replaces itself in the tray rather than
      // stacking. A box that flaps would otherwise bury everything else.
      tag: payload.tag,
      // A fault interrupts; an all-clear does not.
      silent: payload.silent === true,
      // Critical stays on screen until it is dealt with. Everything else is
      // allowed to auto-dismiss, because a tray that has to be cleared by
      // hand is a tray that gets ignored.
      requireInteraction: payload.level === "CRITICAL",
      data: { url: payload.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = event.notification.data?.url;
  if (!url) return;

  // Focus a tab that is already on the dashboard rather than opening a fourth
  // one. Matching on origin rather than on the exact URL: someone with the
  // fleet table open wants that tab taken to the box, not a new window beside
  // it.
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (new URL(client.url).origin === new URL(url).origin && "focus" in client) {
          return client.navigate(url).then((navigated) => navigated?.focus());
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});

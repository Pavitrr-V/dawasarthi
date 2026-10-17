/**
 * MedScan service worker.
 *
 * Responsibilities:
 *  - Show web-push notifications with the dose action buttons
 *    ("Taken", "Skip", "Snooze 10 min").
 *  - Handle a notification tap / action by POSTing the chosen action to the
 *    signed action URL in the notification data (no cookies required), then
 *    focus (or open) the app.
 *
 * The action URL and its short-lived token are minted server-side; this file
 * never sees or holds any secret. Web content is never executed here.
 */

const DEFAULT_ICON = "/icon-192.png";
const DEFAULT_BADGE = "/badge-72.png";
const DEFAULT_URL = "/home";

self.addEventListener("install", () => {
  // Activate the newest worker immediately so push keeps working after updates.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // A malformed payload must not drop the notification entirely.
    payload = { body: event.data ? event.data.text() : "" };
  }

  const data = payload && typeof payload === "object" ? payload : {};
  const hasActions = Boolean(data.actions && data.actionUrl);

  const options = {
    body:
      typeof data.body === "string" && data.body.length > 0
        ? data.body
        : "Open MedScan to see your reminders.",
    icon: typeof data.icon === "string" ? data.icon : DEFAULT_ICON,
    badge: typeof data.badge === "string" ? data.badge : DEFAULT_BADGE,
    tag: typeof data.tag === "string" ? data.tag : "medscan-dose",
    renotify: true,
    requireInteraction: true,
    data: {
      url: typeof data.url === "string" && data.url ? data.url : DEFAULT_URL,
      doseId: typeof data.doseId === "string" ? data.doseId : null,
      actionUrl: hasActions ? data.actionUrl : null,
    },
  };

  if (hasActions) {
    options.actions = [
      { action: "taken", title: "Taken" },
      { action: "skipped", title: "Skip" },
      { action: "snooze", title: "Snooze 10 min" },
    ];
  }

  const title =
    typeof data.title === "string" && data.title.length > 0
      ? data.title
      : "MedScan reminder";

  event.waitUntil(self.registration.showNotification(title, options));
});

// ---------------------------------------------------------------------------
// notificationclick
// ---------------------------------------------------------------------------

self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  const data = notification.data || {};
  const action = event.action || "";
  notification.close();

  event.waitUntil(
    (async () => {
      // A button was tapped: record the action through the signed URL. The
      // token authorises the write, so this works with no cookies (iOS, app
      // closed, different browser profile, ...).
      if (action && data.actionUrl) {
        try {
          await fetch(data.actionUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ action }),
          });
        } catch {
          // Offline or the token expired: stay silent. The pending dose is
          // still visible inside the app.
        }
      }

      await focusOrOpen(data.url || DEFAULT_URL);
    })()
  );
});

/** Focus an existing MedScan window, or open a new one. */
async function focusOrOpen(path) {
  const target = new URL(path, self.location.origin).href;
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });

  for (const client of windows) {
    if ("focus" in client) {
      await client.focus();
      if ("navigate" in client) {
        try {
          await client.navigate(target);
        } catch {
          // Cross-origin or unsupported: focusing alone is still fine.
        }
      }
      return;
    }
  }

  if (self.clients.openWindow) {
    await self.clients.openWindow(target);
  }
}

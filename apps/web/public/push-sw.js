self.addEventListener("message", (event) => {
  const { data } = event;

  if (data?.type === "notifications.clearSession" && typeof data.sessionId === "string" && data.sessionId) {
    event.waitUntil(closeNotifications({ sessionId: data.sessionId }));
  }

  if (data?.type === "notifications.clearRequest" && typeof data.requestId === "string" && data.requestId) {
    event.waitUntil(closeNotifications({ requestId: data.requestId }));
  }
});

self.addEventListener("push", (event) => {
  const payload = event.data ? event.data.json() : {};
  const title = payload.title || "Rmtcdx";
  const options = {
    body: payload.body || "A run has finished.",
    icon: payload.icon || "/icon-192.png",
    badge: payload.badge || "/icon-192.png",
    tag: payload.tag,
    renotify: Boolean(payload.renotify),
    requireInteraction: Boolean(payload.requireInteraction),
    data: payload.data || { url: "/" }
  };

  event.waitUntil(
    Promise.resolve()
      .then(() => {
        const requestId = typeof options.data?.requestId === "string" ? options.data.requestId : null;
        if (requestId) {
          return closeNotifications({ requestId });
        }

        return undefined;
      })
      .then(() => self.registration.showNotification(title, options))
  );
});

self.addEventListener("notificationclick", (event) => {
  const targetUrl = event.notification.data?.url || "/";
  const sessionId = typeof event.notification.data?.sessionId === "string" ? event.notification.data.sessionId : null;

  event.waitUntil(
    Promise.resolve()
      .then(() => {
        if (sessionId) {
          return closeNotifications({ sessionId });
        }

        event.notification.close();
        return undefined;
      })
      .then(() => self.clients.matchAll({ type: "window", includeUncontrolled: true }))
      .then((clients) => {
        for (const client of clients) {
          if ("focus" in client) {
            client.navigate(targetUrl);
            return client.focus();
          }
        }

        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }

        return undefined;
      })
  );
});

async function closeNotifications({ sessionId, requestId }) {
  if ((!sessionId && !requestId) || typeof self.registration.getNotifications !== "function") {
    return;
  }

  const notifications = await self.registration.getNotifications();
  for (const notification of notifications) {
    if (
      (sessionId && notification.data?.sessionId === sessionId)
      || (requestId && notification.data?.requestId === requestId)
    ) {
      notification.close();
    }
  }
}

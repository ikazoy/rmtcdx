type ClearSessionNotificationsMessage = {
  type: "notifications.clearSession";
  sessionId: string;
};

function serviceWorkerMessageTarget(registration: ServiceWorkerRegistration) {
  return registration.active ?? registration.waiting ?? registration.installing ?? null;
}

export async function clearPushNotificationsForSession(sessionId: string) {
  if (!sessionId || typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return false;
  }

  const getRegistration = navigator.serviceWorker.getRegistration?.bind(navigator.serviceWorker);
  if (!getRegistration) {
    return false;
  }

  try {
    const registration = await getRegistration();
    if (!registration) {
      return false;
    }

    const target = serviceWorkerMessageTarget(registration);
    if (!target) {
      return false;
    }

    const message: ClearSessionNotificationsMessage = {
      type: "notifications.clearSession",
      sessionId
    };
    target.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

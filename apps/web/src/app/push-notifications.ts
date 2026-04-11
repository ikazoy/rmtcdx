type ClearSessionNotificationsMessage = {
  type: "notifications.clearSession";
  sessionId: string;
};

type ClearRequestNotificationsMessage = {
  type: "notifications.clearRequest";
  requestId: string;
};

type PushNotificationsMessage = ClearSessionNotificationsMessage | ClearRequestNotificationsMessage;

function serviceWorkerMessageTarget(registration: ServiceWorkerRegistration) {
  return registration.active ?? registration.waiting ?? registration.installing ?? null;
}

async function postServiceWorkerMessage(message: PushNotificationsMessage) {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
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

    target.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

export async function clearPushNotificationsForSession(sessionId: string) {
  if (!sessionId) {
    return false;
  }

  const message: ClearSessionNotificationsMessage = {
    type: "notifications.clearSession",
    sessionId
  };
  return postServiceWorkerMessage(message);
}

export async function clearPushNotificationsForRequest(requestId: string) {
  if (!requestId) {
    return false;
  }

  const message: ClearRequestNotificationsMessage = {
    type: "notifications.clearRequest",
    requestId
  };
  return postServiceWorkerMessage(message);
}

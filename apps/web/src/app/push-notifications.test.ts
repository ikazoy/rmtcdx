import assert from "node:assert/strict";
import test from "node:test";

import { clearPushNotificationsForRequest, clearPushNotificationsForSession } from "./push-notifications";

function withNavigator(navigatorValue: Navigator | undefined) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: navigatorValue
  });

  return () => {
    if (descriptor) {
      Object.defineProperty(globalThis, "navigator", descriptor);
      return;
    }

    delete (globalThis as { navigator?: Navigator | undefined }).navigator;
  };
}

test("clearPushNotificationsForSession posts a clear message to the active worker", async () => {
  const messages: unknown[] = [];
  const restore = withNavigator({
    serviceWorker: {
      getRegistration: async () =>
        ({
          active: {
            postMessage: (message: unknown) => {
              messages.push(message);
            }
          }
        }) as ServiceWorkerRegistration
    } as ServiceWorkerContainer
  } as Navigator);

  try {
    const cleared = await clearPushNotificationsForSession("session-123");

    assert.equal(cleared, true);
    assert.deepEqual(messages, [
      {
        type: "notifications.clearSession",
        sessionId: "session-123"
      }
    ]);
  } finally {
    restore();
  }
});

test("clearPushNotificationsForRequest posts a clear message to the active worker", async () => {
  const messages: unknown[] = [];
  const restore = withNavigator({
    serviceWorker: {
      getRegistration: async () =>
        ({
          active: {
            postMessage: (message: unknown) => {
              messages.push(message);
            }
          }
        }) as ServiceWorkerRegistration
    } as ServiceWorkerContainer
  } as Navigator);

  try {
    const cleared = await clearPushNotificationsForRequest("request-123");

    assert.equal(cleared, true);
    assert.deepEqual(messages, [
      {
        type: "notifications.clearRequest",
        requestId: "request-123"
      }
    ]);
  } finally {
    restore();
  }
});

test("clearPushNotificationsForSession returns false when no registration is present", async () => {
  const restore = withNavigator({
    serviceWorker: {
      getRegistration: async () => undefined
    } as ServiceWorkerContainer
  } as Navigator);

  try {
    const cleared = await clearPushNotificationsForSession("session-123");

    assert.equal(cleared, false);
  } finally {
    restore();
  }
});

test("clearPushNotificationsForSession returns false when service workers are unavailable", async () => {
  const restore = withNavigator(undefined);

  try {
    const cleared = await clearPushNotificationsForSession("session-123");

    assert.equal(cleared, false);
  } finally {
    restore();
  }
});

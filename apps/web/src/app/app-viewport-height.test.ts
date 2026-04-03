import assert from "node:assert/strict";
import test from "node:test";

import {
  APP_VIEWPORT_HEIGHT_CSS_VAR,
  readAppViewportHeight,
  startAppViewportHeightTracking,
  syncAppViewportHeight
} from "./app-viewport-height";

class FakeStyle {
  private readonly properties = new Map<string, string>();

  getPropertyValue(name: string) {
    return this.properties.get(name) ?? "";
  }

  setProperty(name: string, value: string) {
    this.properties.set(name, value);
  }

  removeProperty(name: string) {
    this.properties.delete(name);
  }
}

function createViewportTrackingHarness() {
  const style = new FakeStyle();
  const visualViewport = new EventTarget();
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  const queuedFrames = new Map<number, FrameRequestCallback>();
  let nextFrameId = 1;

  const windowLike = Object.assign(windowTarget, {
    innerHeight: 851,
    visualViewport,
    requestAnimationFrame(callback: FrameRequestCallback) {
      const frameId = nextFrameId;
      nextFrameId += 1;
      queuedFrames.set(frameId, callback);
      return frameId;
    },
    cancelAnimationFrame(frameId: number) {
      queuedFrames.delete(frameId);
    }
  });

  const documentLike = Object.assign(documentTarget, {
    visibilityState: "visible" as DocumentVisibilityState,
    documentElement: {
      style
    }
  });

  const flushAnimationFrame = () => {
    const callbacks = [...queuedFrames.values()];
    queuedFrames.clear();
    for (const callback of callbacks) {
      callback(0);
    }
  };

  return {
    style,
    visualViewport,
    windowLike,
    documentLike,
    flushAnimationFrame
  };
}

test("readAppViewportHeight rounds positive viewport heights", () => {
  assert.equal(readAppViewportHeight({ innerHeight: 812.8 } as Pick<Window, "innerHeight">), 813);
  assert.equal(readAppViewportHeight({ innerHeight: 0 } as Pick<Window, "innerHeight">), null);
});

test("syncAppViewportHeight sets and clears the CSS viewport variable", () => {
  const style = new FakeStyle();
  const documentLike = {
    documentElement: {
      style
    }
  } as unknown as Parameters<typeof syncAppViewportHeight>[0];

  assert.equal(syncAppViewportHeight(documentLike, 640), true);
  assert.equal(style.getPropertyValue(APP_VIEWPORT_HEIGHT_CSS_VAR), "640px");
  assert.equal(syncAppViewportHeight(documentLike, 640), false);
  assert.equal(syncAppViewportHeight(documentLike, null), true);
  assert.equal(style.getPropertyValue(APP_VIEWPORT_HEIGHT_CSS_VAR), "");
});

test("startAppViewportHeightTracking refreshes the CSS viewport variable after page resume events", () => {
  const harness = createViewportTrackingHarness();
  const stop = startAppViewportHeightTracking(
    harness.windowLike as unknown as Parameters<typeof startAppViewportHeightTracking>[0],
    harness.documentLike as unknown as Parameters<typeof startAppViewportHeightTracking>[1]
  );

  try {
    harness.flushAnimationFrame();
    assert.equal(harness.style.getPropertyValue(APP_VIEWPORT_HEIGHT_CSS_VAR), "851px");

    harness.windowLike.innerHeight = 688;
    harness.windowLike.dispatchEvent(new Event("pageshow"));
    harness.flushAnimationFrame();

    assert.equal(harness.style.getPropertyValue(APP_VIEWPORT_HEIGHT_CSS_VAR), "688px");

    harness.windowLike.innerHeight = 612;
    harness.documentLike.visibilityState = "hidden";
    harness.documentLike.dispatchEvent(new Event("visibilitychange"));
    harness.flushAnimationFrame();
    assert.equal(harness.style.getPropertyValue(APP_VIEWPORT_HEIGHT_CSS_VAR), "688px");

    harness.documentLike.visibilityState = "visible";
    harness.documentLike.dispatchEvent(new Event("visibilitychange"));
    harness.flushAnimationFrame();

    assert.equal(harness.style.getPropertyValue(APP_VIEWPORT_HEIGHT_CSS_VAR), "612px");
  } finally {
    stop();
  }
});

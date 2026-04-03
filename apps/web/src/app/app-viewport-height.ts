export const APP_VIEWPORT_HEIGHT_CSS_VAR = "--app-viewport-height";

type WindowLike = Pick<
  Window,
  "addEventListener" | "removeEventListener" | "requestAnimationFrame" | "cancelAnimationFrame" | "innerHeight" | "visualViewport"
>;

type DocumentLike = Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState" | "documentElement">;

export function readAppViewportHeight(windowLike: Pick<Window, "innerHeight">) {
  return Number.isFinite(windowLike.innerHeight) && windowLike.innerHeight > 0
    ? Math.round(windowLike.innerHeight)
    : null;
}

export function syncAppViewportHeight(documentLike: DocumentLike, height: number | null) {
  const style = documentLike.documentElement.style;
  const nextValue = height === null ? "" : `${height}px`;
  const currentValue = style.getPropertyValue(APP_VIEWPORT_HEIGHT_CSS_VAR);

  if (!nextValue) {
    if (!currentValue) {
      return false;
    }

    style.removeProperty(APP_VIEWPORT_HEIGHT_CSS_VAR);
    return true;
  }

  if (currentValue === nextValue) {
    return false;
  }

  style.setProperty(APP_VIEWPORT_HEIGHT_CSS_VAR, nextValue);
  return true;
}

export function startAppViewportHeightTracking(windowLike: WindowLike, documentLike: DocumentLike) {
  let frameId: number | null = null;

  const updateViewportHeight = () => {
    frameId = null;
    syncAppViewportHeight(documentLike, readAppViewportHeight(windowLike));
  };

  const scheduleViewportHeightUpdate = () => {
    if (frameId !== null) {
      return;
    }

    frameId = windowLike.requestAnimationFrame(() => {
      updateViewportHeight();
    });
  };

  const handleVisibilityChange = () => {
    if (documentLike.visibilityState === "visible") {
      scheduleViewportHeightUpdate();
    }
  };

  scheduleViewportHeightUpdate();

  windowLike.addEventListener("resize", scheduleViewportHeightUpdate);
  windowLike.addEventListener("focus", scheduleViewportHeightUpdate);
  windowLike.addEventListener("pageshow", scheduleViewportHeightUpdate);
  documentLike.addEventListener("visibilitychange", handleVisibilityChange);
  windowLike.visualViewport?.addEventListener("resize", scheduleViewportHeightUpdate);
  windowLike.visualViewport?.addEventListener("scroll", scheduleViewportHeightUpdate);

  return () => {
    if (frameId !== null) {
      windowLike.cancelAnimationFrame(frameId);
    }

    windowLike.removeEventListener("resize", scheduleViewportHeightUpdate);
    windowLike.removeEventListener("focus", scheduleViewportHeightUpdate);
    windowLike.removeEventListener("pageshow", scheduleViewportHeightUpdate);
    documentLike.removeEventListener("visibilitychange", handleVisibilityChange);
    windowLike.visualViewport?.removeEventListener("resize", scheduleViewportHeightUpdate);
    windowLike.visualViewport?.removeEventListener("scroll", scheduleViewportHeightUpdate);
  };
}

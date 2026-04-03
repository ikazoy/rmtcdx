export type AppDisplayMode = "browser" | "standalone";

type NavigatorWithStandalone = Navigator & {
  standalone?: boolean;
};

type LegacyMediaQueryList = MediaQueryList & {
  addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
  removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
};

function isStandaloneDisplayMode() {
  if (typeof window === "undefined") {
    return false;
  }

  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    Boolean((window.navigator as NavigatorWithStandalone).standalone)
  );
}

export function readAppDisplayMode(): AppDisplayMode {
  return isStandaloneDisplayMode() ? "standalone" : "browser";
}

export function bindAppDisplayModeChange(listener: (displayMode: AppDisplayMode) => void) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const mediaQuery = window.matchMedia("(display-mode: standalone)");
  const syncDisplayMode = () => listener(readAppDisplayMode());
  syncDisplayMode();

  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", syncDisplayMode);
    return () => mediaQuery.removeEventListener("change", syncDisplayMode);
  }

  const legacyMediaQuery = mediaQuery as LegacyMediaQueryList;
  const legacyListener = syncDisplayMode as (event: MediaQueryListEvent) => void;
  legacyMediaQuery.addListener?.(legacyListener);
  return () => legacyMediaQuery.removeListener?.(legacyListener);
}

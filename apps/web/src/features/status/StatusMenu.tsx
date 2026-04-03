import { FloatingPortal } from "@floating-ui/react";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { AccountRateLimitSnapshot, AccountRateLimitWindow } from "@codex-remote/shared-types";
import { bindAppDisplayModeChange, readAppDisplayMode } from "../../app/display-mode";
import { queryKeys } from "../../app/query";
import { api } from "../../api/client";
import { formatCompactTimeUntil } from "../../components/formatters";
import { useAnchoredMenu } from "../../hooks/use-anchored-menu";

type Props = {
  isMobileViewport: boolean;
};

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
};

type NotificationState =
  | "unsupported"
  | "insecure"
  | "unavailable"
  | "off"
  | "requesting"
  | "enabled"
  | "blocked"
  | "error";

type Tone = "default" | "warning" | "danger";
type NotificationTone = "default" | "accent" | "danger";
type NotificationAction = "enable" | "disable" | "retry" | "help" | null;
type RateLimitWindowView = {
  key: string;
  label: string;
  usage: string;
  reset: string;
};

function isIosDevice(userAgent: string) {
  return /iphone|ipad|ipod/.test(userAgent);
}

function isIosSafari(userAgent: string) {
  return isIosDevice(userAgent) && /safari/.test(userAgent) && !/crios|fxios|edgios/.test(userAgent);
}

function isAndroidDevice(userAgent: string) {
  return /android/.test(userAgent);
}

function isDesktopSafari(userAgent: string) {
  return /safari/.test(userAgent) && !/chrome|chromium|crios|fxios|edgios/.test(userAgent) && !isIosDevice(userAgent);
}

function supportsPushNotifications() {
  return (
    typeof window !== "undefined" &&
    typeof Notification !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

function base64UrlToUint8Array(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = window.atob(padded);
  const output = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }

  return output;
}

function formatWindowDuration(windowDurationMins: number | null) {
  if (windowDurationMins === null || windowDurationMins <= 0) {
    return null;
  }
  if (windowDurationMins % 1440 === 0) {
    return `${windowDurationMins / 1440}d`;
  }
  if (windowDurationMins % 60 === 0) {
    return `${windowDurationMins / 60}h`;
  }
  return `${windowDurationMins}m`;
}

function formatWindowLabel(windowData: AccountRateLimitWindow) {
  const duration = formatWindowDuration(windowData.windowDurationMins);
  return duration ? duration.toUpperCase() : "Window";
}

function formatWindowUsage(windowData: AccountRateLimitWindow) {
  return `${Math.round(windowData.usedPercent)}% used`;
}

function formatWindowResetValue(windowData: AccountRateLimitWindow, now = Date.now()) {
  if (!windowData?.resetsAt) {
    return "Unavailable";
  }

  const resetIn = formatCompactTimeUntil(windowData.resetsAt, now);
  if (!resetIn) {
    return "Unavailable";
  }

  return resetIn === "now" ? "Now" : `In ${resetIn}`;
}

function buildRateLimitWindowView(windowData: AccountRateLimitWindow, index: number, now = Date.now()): RateLimitWindowView {
  const duration = windowData.windowDurationMins ?? index;
  const label = formatWindowLabel(windowData);

  return {
    key: `${label}-${duration}-${index}`,
    label,
    usage: formatWindowUsage(windowData),
    reset: formatWindowResetValue(windowData, now)
  };
}

function rateLimitTone(snapshot: AccountRateLimitSnapshot | null): Tone {
  const usedValues = [snapshot?.primary?.usedPercent ?? 0, snapshot?.secondary?.usedPercent ?? 0];
  const highest = Math.max(...usedValues);
  if (highest >= 95) {
    return "danger";
  }
  if (highest >= 80) {
    return "warning";
  }
  return "default";
}

function preferredSnapshot(snapshotData: {
  rateLimits: AccountRateLimitSnapshot;
  rateLimitsByLimitId: Record<string, AccountRateLimitSnapshot> | null;
}) {
  return snapshotData.rateLimitsByLimitId?.codex ?? snapshotData.rateLimits;
}

function buildNotificationRecoverySteps(userAgent: string, isStandalone: boolean) {
  if (isIosDevice(userAgent)) {
    if (!isStandalone) {
      return {
        steps: [
          "Add this app to your home screen first.",
          "Open it from the home screen icon.",
          "In iPhone or iPad Settings, allow notifications for Rmtcdx."
        ],
        note: "iOS push notifications only work from the installed web app."
      };
    }

    return {
      steps: [
        "Open iPhone or iPad Settings > Notifications.",
        "Find Rmtcdx and turn on Allow Notifications.",
        "Return here and enable notifications again."
      ],
      note: "Safari does not provide a standard web API to open these settings directly."
    };
  }

  if (isDesktopSafari(userAgent)) {
    return {
      steps: [
        "Open Safari Settings > Websites > Notifications.",
        "Allow notifications for this site.",
        "Reload this page and enable notifications again."
      ],
      note: "Safari keeps notification permission in browser website settings."
    };
  }

  return {
    steps: [
      "Open site settings for this page in your browser.",
      "Change Notifications to Allow.",
      "Reload this page and enable notifications again."
    ],
    note: "Browsers do not expose a standard web API to open site settings directly."
  };
}

async function registerPushWorker() {
  const registration = await navigator.serviceWorker.register("/push-sw.js", {
    scope: "/",
    updateViaCache: "none"
  });

  await navigator.serviceWorker.ready;
  return registration;
}

export function StatusMenu({ isMobileViewport }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [isStandalone, setIsStandalone] = useState(() => readAppDisplayMode() === "standalone");
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isPromptingInstall, setIsPromptingInstall] = useState(false);
  const [showNotificationHelp, setShowNotificationHelp] = useState(false);
  const [relativeNow, setRelativeNow] = useState(() => Date.now());
  const [notificationState, setNotificationState] = useState<NotificationState>(() => {
    if (typeof window === "undefined") {
      return "unsupported";
    }

    if (!window.isSecureContext) {
      return "insecure";
    }

    if (!supportsPushNotifications()) {
      return "unsupported";
    }

    if (Notification.permission === "denied") {
      return "blocked";
    }

    return "off";
  });
  const [notificationError, setNotificationError] = useState<string | null>(null);

  const notificationsConfigQuery = useQuery({
    queryKey: ["notifications", "config"],
    queryFn: api.notificationsConfig,
    staleTime: Number.POSITIVE_INFINITY
  });
  const accountRateLimitsQuery = useQuery({
    queryKey: queryKeys.accountRateLimits,
    queryFn: api.accountRateLimits,
    staleTime: 30_000
  });
  const menu = useAnchoredMenu({
    open: isOpen,
    onOpenChange: setIsOpen
  });

  useEffect(() => {
    return bindAppDisplayModeChange((displayMode) => {
      setIsStandalone(displayMode === "standalone");
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const intervalId = window.setInterval(() => {
      setRelativeNow(Date.now());
    }, 60_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleBeforeInstallPrompt = (event: Event) => {
      const installEvent = event as BeforeInstallPromptEvent;
      installEvent.preventDefault();
      setDeferredPrompt(installEvent);
    };

    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      setIsStandalone(true);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt as EventListener);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt as EventListener);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  useEffect(() => {
    if (notificationState !== "blocked") {
      setShowNotificationHelp(false);
    }
  }, [notificationState]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (!window.isSecureContext) {
      setNotificationState("insecure");
      return;
    }

    if (!supportsPushNotifications()) {
      setNotificationState("unsupported");
      return;
    }

    if (notificationsConfigQuery.isLoading) {
      return;
    }

    if (
      !notificationsConfigQuery.data?.notifications.available ||
      !notificationsConfigQuery.data.notifications.vapidPublicKey
    ) {
      setNotificationState("unavailable");
      return;
    }

    const vapidPublicKey = notificationsConfigQuery.data.notifications.vapidPublicKey;
    let cancelled = false;

    const syncSubscription = async () => {
      if (Notification.permission === "denied") {
        if (!cancelled) {
          setNotificationState("blocked");
        }
        return;
      }

      if (Notification.permission !== "granted") {
        if (!cancelled) {
          setNotificationState("off");
        }
        return;
      }

      try {
        const registration = await registerPushWorker();
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: base64UrlToUint8Array(vapidPublicKey)
          });
        }

        const json = subscription.toJSON();
        const keys = json.keys;
        if (!json.endpoint || !keys?.p256dh || !keys.auth) {
          throw new Error("Push subscription is missing required keys.");
        }

        await api.savePushSubscription({
          endpoint: json.endpoint,
          expirationTime: json.expirationTime ?? null,
          keys: {
            p256dh: keys.p256dh,
            auth: keys.auth
          },
          userAgent: navigator.userAgent,
          platform: navigator.platform
        });

        if (!cancelled) {
          setNotificationState("enabled");
          setNotificationError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setNotificationState("error");
          setNotificationError(error instanceof Error ? error.message : "Could not initialize notifications.");
        }
      }
    };

    void syncSubscription();

    return () => {
      cancelled = true;
    };
  }, [notificationsConfigQuery.data, notificationsConfigQuery.isLoading]);

  const userAgent = useMemo(() => {
    if (typeof navigator === "undefined") {
      return "";
    }

    return navigator.userAgent.toLowerCase();
  }, []);

  const homeScreenRow = useMemo(() => {
    if (!isMobileViewport) {
      return null;
    }

    if (isStandalone) {
      return {
        title: "Home screen",
        detail: "Opens from your app icon.",
        actionLabel: null,
        disabled: true
      };
    }

    if (isIosSafari(userAgent)) {
      return {
        title: "Home screen",
        detail: "Use Share > Add to Home Screen in Safari.",
        actionLabel: null,
        disabled: true
      };
    }

    if (isIosDevice(userAgent)) {
      return {
        title: "Home screen",
        detail: "Open this page in Safari to add it.",
        actionLabel: null,
        disabled: true
      };
    }

    if (deferredPrompt) {
      return {
        title: "Home screen",
        detail: "Add Rmtcdx to your home screen.",
        actionLabel: isPromptingInstall ? "Waiting..." : "Add",
        disabled: isPromptingInstall
      };
    }

    if (isAndroidDevice(userAgent)) {
      return {
        title: "Home screen",
        detail: "Use your browser menu and choose Add to Home screen.",
        actionLabel: null,
        disabled: true
      };
    }

    return null;
  }, [deferredPrompt, isMobileViewport, isPromptingInstall, isStandalone, userAgent]);

  const rateLimitView = useMemo(() => {
    if (accountRateLimitsQuery.isLoading && !accountRateLimitsQuery.data) {
      return {
        tone: "default" as Tone,
        detail: "Loading account usage...",
        windows: [] as RateLimitWindowView[]
      };
    }

    if (!accountRateLimitsQuery.data?.available || !accountRateLimitsQuery.data.rateLimits) {
      return {
        tone: "default" as Tone,
        detail: accountRateLimitsQuery.data?.error ?? "Usage data is not available in this environment.",
        windows: [] as RateLimitWindowView[]
      };
    }

    const snapshotData = accountRateLimitsQuery.data.rateLimits;
    const snapshot = preferredSnapshot(snapshotData);
    const tone = rateLimitTone(snapshot);
    const windows = [snapshot.primary, snapshot.secondary]
      .filter((value): value is AccountRateLimitWindow => Boolean(value))
      .sort((left, right) => {
        const leftDuration = left.windowDurationMins ?? Number.POSITIVE_INFINITY;
        const rightDuration = right.windowDurationMins ?? Number.POSITIVE_INFINITY;
        return leftDuration - rightDuration;
      })
      .map((windowData, index) => buildRateLimitWindowView(windowData, index, relativeNow));

    return {
      tone,
      detail: windows.length > 0 ? null : "No usage data yet.",
      windows
    };
  }, [accountRateLimitsQuery.data, accountRateLimitsQuery.isLoading, relativeNow]);

  const notificationRecovery = useMemo(
    () => buildNotificationRecoverySteps(userAgent, isStandalone),
    [isStandalone, userAgent]
  );

  const notificationRow = useMemo(() => {
    switch (notificationState) {
      case "enabled":
        return {
          title: "Notifications",
          detail: "Get a push notification when a run finishes or Codex needs your attention.",
          actionLabel: "Turn off",
          action: "disable" as NotificationAction,
          disabled: false,
          tone: "accent" as NotificationTone
        };
      case "requesting":
        return {
          title: "Notifications",
          detail: "Checking notification permission...",
          actionLabel: "Waiting...",
          action: null,
          disabled: true,
          tone: "default" as NotificationTone
        };
      case "blocked":
        return {
          title: "Notifications",
          detail: "Notifications are blocked in browser settings.",
          actionLabel: showNotificationHelp ? "Hide steps" : "How to fix",
          action: "help" as NotificationAction,
          disabled: false,
          tone: "danger" as NotificationTone
        };
      case "error":
        return {
          title: "Notifications",
          detail: notificationError ?? "Could not update notification settings.",
          actionLabel: "Retry",
          action: "retry" as NotificationAction,
          disabled: false,
          tone: "danger" as NotificationTone
        };
      case "insecure":
        return {
          title: "Notifications",
          detail: "Notifications require HTTPS or localhost.",
          actionLabel: null,
          action: null,
          disabled: true,
          tone: "default" as NotificationTone
        };
      case "unsupported":
        return {
          title: "Notifications",
          detail: "This browser does not support push notifications.",
          actionLabel: null,
          action: null,
          disabled: true,
          tone: "default" as NotificationTone
        };
      case "unavailable":
        return {
          title: "Notifications",
          detail: "Push notifications are not configured on the server yet.",
          actionLabel: null,
          action: null,
          disabled: true,
          tone: "default" as NotificationTone
        };
      case "off":
      default:
        return {
          title: "Notifications",
          detail: "Get a push notification when a run finishes or Codex needs your attention.",
          actionLabel: "Enable",
          action: "enable" as NotificationAction,
          disabled: false,
          tone: "default" as NotificationTone
        };
    }
  }, [notificationError, notificationState, showNotificationHelp]);

  const triggerTone =
    notificationState === "error" || notificationState === "blocked" || rateLimitView.tone === "danger"
      ? "danger"
      : "default";
  const hasAttention =
    (!isStandalone && isMobileViewport) ||
    notificationState === "off" ||
    notificationState === "error" ||
    notificationState === "blocked" ||
    rateLimitView.tone === "warning" ||
    rateLimitView.tone === "danger";

  const promptInstall = async () => {
    if (!deferredPrompt) {
      return;
    }

    setIsPromptingInstall(true);
    try {
      await deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      setDeferredPrompt(null);
    } finally {
      setIsPromptingInstall(false);
    }
  };

  const enableNotifications = async () => {
    if (
      !notificationsConfigQuery.data?.notifications.available ||
      !notificationsConfigQuery.data.notifications.vapidPublicKey ||
      !window.isSecureContext ||
      !supportsPushNotifications()
    ) {
      return;
    }

    const vapidPublicKey = notificationsConfigQuery.data.notifications.vapidPublicKey;
    setNotificationState("requesting");
    setNotificationError(null);

    try {
      const permission = await Notification.requestPermission();
      if (permission === "denied") {
        setNotificationState("blocked");
        return;
      }

      if (permission !== "granted") {
        setNotificationState("off");
        return;
      }

      const registration = await registerPushWorker();
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToUint8Array(vapidPublicKey)
        });
      }

      const json = subscription.toJSON();
      const keys = json.keys;
      if (!json.endpoint || !keys?.p256dh || !keys.auth) {
        throw new Error("Push subscription is missing required keys.");
      }

      await api.savePushSubscription({
        endpoint: json.endpoint,
        expirationTime: json.expirationTime ?? null,
        keys: {
          p256dh: keys.p256dh,
          auth: keys.auth
        },
        userAgent: navigator.userAgent,
        platform: navigator.platform
      });

      setNotificationState("enabled");
    } catch (error) {
      setNotificationState("error");
      setNotificationError(error instanceof Error ? error.message : "Could not enable notifications.");
    }
  };

  const disableNotifications = async () => {
    if (!supportsPushNotifications() || !window.isSecureContext) {
      return;
    }

    try {
      const registration = await registerPushWorker();
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe().catch(() => false);
        await api.deletePushSubscription({ endpoint });
      }
      setNotificationState("off");
      setNotificationError(null);
    } catch (error) {
      setNotificationState("error");
      setNotificationError(error instanceof Error ? error.message : "Could not disable notifications.");
    }
  };

  const handleNotificationAction = async () => {
    switch (notificationRow.action) {
      case "disable":
        await disableNotifications();
        return;
      case "help":
        setShowNotificationHelp((current) => !current);
        return;
      case "enable":
      case "retry":
        await enableNotifications();
        return;
      default:
        return;
    }
  };

  return (
    <div className="sidebar-menu">
      <button
        ref={menu.refs.setReference}
        {...menu.getReferenceProps({
          className: `sidebar-menu__trigger sidebar-menu__trigger--status sidebar-menu__trigger--${triggerTone}`,
          type: "button",
          "aria-expanded": isOpen,
          "aria-label": "Open status and settings"
        })}
      >
        <StatusIcon />
        {hasAttention ? <span className={`sidebar-menu__trigger-dot sidebar-menu__trigger-dot--${triggerTone}`} /> : null}
      </button>

      {isOpen ? (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            className="sidebar-menu__popover status-menu__popover"
            style={menu.floatingStyles}
            {...menu.getFloatingProps()}
          >
            <section className="sidebar-menu__section">
              <span className="sidebar-menu__section-title">Account</span>
              <div className={`status-menu__card status-menu__card--${rateLimitView.tone}`}>
                <div className="status-menu__card-head">
                  <strong>Usage</strong>
                </div>
                {rateLimitView.detail ? <p>{rateLimitView.detail}</p> : null}
                {rateLimitView.windows.length > 0 ? (
                  <div className="status-menu__window-list">
                    {rateLimitView.windows.map((windowData) => (
                      <section key={windowData.key} className="status-menu__window-card" aria-label={`${windowData.label} usage window`}>
                        <div className="status-menu__window-head">
                          <span className={`status-menu__pill status-menu__pill--${rateLimitView.tone}`}>{windowData.label}</span>
                        </div>
                        <dl className="status-menu__window-metrics">
                          <div className="status-menu__window-metric">
                            <dt>Usage</dt>
                            <dd>{windowData.usage}</dd>
                          </div>
                          <div className="status-menu__window-metric">
                            <dt>Reset</dt>
                            <dd>{windowData.reset}</dd>
                          </div>
                        </dl>
                      </section>
                    ))}
                  </div>
                ) : null}
              </div>
            </section>

            <section className="sidebar-menu__section">
              <span className="sidebar-menu__section-title">Device</span>
              <div className="sidebar-menu__list">
                {homeScreenRow ? (
                  <button
                    className="sidebar-menu__item status-menu__item"
                    onClick={() => void promptInstall()}
                    type="button"
                    disabled={homeScreenRow.disabled || !homeScreenRow.actionLabel}
                  >
                    <span className="status-menu__copy">
                      <span className="status-menu__title">{homeScreenRow.title}</span>
                      <span className="status-menu__detail">{homeScreenRow.detail}</span>
                    </span>
                    {homeScreenRow.actionLabel ? <span className="status-menu__action">{homeScreenRow.actionLabel}</span> : null}
                  </button>
                ) : null}

                <button
                  className={`sidebar-menu__item status-menu__item status-menu__item--${notificationRow.tone}`}
                  onClick={() => void handleNotificationAction()}
                  type="button"
                  disabled={notificationRow.disabled || !notificationRow.actionLabel || notificationsConfigQuery.isLoading}
                >
                  <span className="status-menu__copy">
                    <span className="status-menu__title">{notificationRow.title}</span>
                    <span className="status-menu__detail">{notificationRow.detail}</span>
                  </span>
                  {notificationRow.actionLabel ? <span className="status-menu__action">{notificationRow.actionLabel}</span> : null}
                </button>
              </div>

              {notificationState === "blocked" && showNotificationHelp ? (
                <div className="status-menu__help">
                  <strong>How to recover</strong>
                  <ol className="status-menu__steps">
                    {notificationRecovery.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                  <p className="status-menu__help-note">{notificationRecovery.note}</p>
                </div>
              ) : null}
            </section>
          </div>
        </FloatingPortal>
      ) : null}
    </div>
  );
}

function StatusIcon() {
  return (
    <svg className="sidebar-menu__trigger-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M10.22 4.67a1 1 0 0 1 1-.67h1.56a1 1 0 0 1 1 .67l.34 1.03a1 1 0 0 0 .95.69h.94a1 1 0 0 0 .7-.29l.79-.79a1 1 0 0 1 1.41 0l1.1 1.1a1 1 0 0 1 0 1.41l-.79.79a1 1 0 0 0-.29.7v.94a1 1 0 0 0 .69.95l1.03.34a1 1 0 0 1 .67 1v1.56a1 1 0 0 1-.67 1l-1.03.34a1 1 0 0 0-.69.95v.94a1 1 0 0 0 .29.7l.79.79a1 1 0 0 1 0 1.41l-1.1 1.1a1 1 0 0 1-1.41 0l-.79-.79a1 1 0 0 0-.7-.29h-.94a1 1 0 0 0-.95.69l-.34 1.03a1 1 0 0 1-1 .67h-1.56a1 1 0 0 1-1-.67l-.34-1.03a1 1 0 0 0-.95-.69h-.94a1 1 0 0 0-.7.29l-.79.79a1 1 0 0 1-1.41 0l-1.1-1.1a1 1 0 0 1 0-1.41l.79-.79a1 1 0 0 0 .29-.7v-.94a1 1 0 0 0-.69-.95l-1.03-.34a1 1 0 0 1-.67-1v-1.56a1 1 0 0 1 .67-1l1.03-.34a1 1 0 0 0 .69-.95v-.94a1 1 0 0 0-.29-.7l-.79-.79a1 1 0 0 1 0-1.41l1.1-1.1a1 1 0 0 1 1.41 0l.79.79a1 1 0 0 0 .7.29h.94a1 1 0 0 0 .95-.69l.34-1.03Z"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3.1" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

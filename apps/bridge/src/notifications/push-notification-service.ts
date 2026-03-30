import fs from "node:fs";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";
import webpush from "web-push";
import { z } from "zod";

import type {
  NotificationsConfigResponse,
  Run,
  SavePushSubscriptionRequest,
  SessionDetail
} from "@codex-remote/shared-types";
import type { AppConfig } from "../config/env";
import { nowIso } from "../utils/time";

const DEFAULT_VAPID_SUBJECT = "mailto:notifications@codex-remote.local";

const storedVapidDetailsSchema = z.object({
  publicKey: z.string().min(1),
  privateKey: z.string().min(1),
  subject: z.string().min(1)
});

const storedPushSubscriptionSchema = z.object({
  endpoint: z.string(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1)
  }),
  userAgent: z.string().optional(),
  platform: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

type StoredVapidDetails = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

type StoredPushSubscription = z.infer<typeof storedPushSubscriptionSchema>;

const notificationStateSchema = z.object({
  version: z.literal(1),
  notifications: z.object({
    vapid: storedVapidDetailsSchema.nullable(),
    subscriptions: z.array(storedPushSubscriptionSchema)
  })
});

type NotificationState = z.infer<typeof notificationStateSchema>;

type PushPayload = {
  title: string;
  body: string;
  tag: string;
  icon: string;
  badge: string;
  renotify: boolean;
  requireInteraction: boolean;
  data: {
    url: string;
    sessionId: string;
    runId: string;
  };
};

function buildPayload(detail: SessionDetail, run: Run): PushPayload {
  const encodedSessionId = encodeURIComponent(detail.session.id);
  const title = run.status === "error" ? "Codex Remote · Error" : "Codex Remote · Completed";
  const body =
    run.status === "error"
      ? `${detail.session.title} がエラーで終了しました。`
      : `${detail.session.title} が完了しました。`;

  return {
    title,
    body,
    tag: `run:${run.id}`,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    renotify: run.status === "error",
    requireInteraction: run.status === "error",
    data: {
      url: `/sessions/${encodedSessionId}`,
      sessionId: detail.session.id,
      runId: run.id
    }
  };
}

export class PushNotificationService {
  private readonly stateFile: string;
  private readonly state: NotificationState;
  private readonly vapidDetails: StoredVapidDetails;

  constructor(
    stateFile: string,
    config: AppConfig,
    private readonly logger: FastifyBaseLogger
  ) {
    this.stateFile = stateFile;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    this.state = this.readState();
    this.vapidDetails = this.resolveVapidDetails(config);

    webpush.setVapidDetails(
      this.vapidDetails.subject,
      this.vapidDetails.publicKey,
      this.vapidDetails.privateKey
    );
  }

  close() {
    // noop
  }

  getClientConfig(): NotificationsConfigResponse {
    return {
      notifications: {
        available: true,
        vapidPublicKey: this.vapidDetails.publicKey
      }
    };
  }

  saveSubscription(subscription: SavePushSubscriptionRequest) {
    const now = nowIso();
    const existing = this.state.notifications.subscriptions.find((entry) => entry.endpoint === subscription.endpoint);
    const nextSubscription: StoredPushSubscription = {
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime ?? null,
      keys: {
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth
      },
      userAgent: subscription.userAgent,
      platform: subscription.platform,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    if (existing) {
      const index = this.state.notifications.subscriptions.indexOf(existing);
      this.state.notifications.subscriptions.splice(index, 1, nextSubscription);
    } else {
      this.state.notifications.subscriptions.push(nextSubscription);
    }

    this.persistState();
  }

  deleteSubscription(endpoint: string) {
    const nextSubscriptions = this.state.notifications.subscriptions.filter((entry) => entry.endpoint !== endpoint);
    if (nextSubscriptions.length === this.state.notifications.subscriptions.length) {
      return;
    }

    this.state.notifications.subscriptions = nextSubscriptions;
    this.persistState();
  }

  async notifyRun(detail: SessionDetail, run: Run) {
    if (run.status !== "completed" && run.status !== "error") {
      return;
    }

    const subscriptions = [...this.state.notifications.subscriptions].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    );

    if (subscriptions.length === 0) {
      return;
    }

    const payload = JSON.stringify(buildPayload(detail, run));

    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: subscription.endpoint,
              expirationTime: subscription.expirationTime ?? null,
              keys: {
                p256dh: subscription.keys.p256dh,
                auth: subscription.keys.auth
              }
            },
            payload
          );
        } catch (error) {
          const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 0;
          if (statusCode === 404 || statusCode === 410) {
            this.deleteSubscription(subscription.endpoint);
            return;
          }

          this.logger.warn(
            {
              err: error,
              endpoint: subscription.endpoint,
              runId: run.id,
              sessionId: run.sessionId
            },
            "Unable to deliver push notification"
          );
        }
      })
    );
  }

  private readState(): NotificationState {
    if (!fs.existsSync(this.stateFile)) {
      return this.emptyState();
    }

    try {
      const raw = fs.readFileSync(this.stateFile, "utf8");
      const parsed = notificationStateSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        return parsed.data;
      }

      this.logger.warn(
        {
          path: this.stateFile,
          issues: parsed.error.issues
        },
        "Notification state file is invalid, starting with an empty state"
      );
    } catch (error) {
      this.logger.warn({ err: error, path: this.stateFile }, "Unable to read notification state file");
    }

    return this.emptyState();
  }

  private resolveVapidDetails(config: AppConfig) {
    if (config.vapidPublicKey && config.vapidPrivateKey) {
      return {
        publicKey: config.vapidPublicKey,
        privateKey: config.vapidPrivateKey,
        subject: config.vapidSubject ?? DEFAULT_VAPID_SUBJECT
      } satisfies StoredVapidDetails;
    }

    const stored = this.state.notifications.vapid;
    if (stored) {
      return {
        ...stored,
        subject: config.vapidSubject ?? stored.subject ?? DEFAULT_VAPID_SUBJECT
      };
    }

    const generated = webpush.generateVAPIDKeys();
    const vapidDetails = {
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
      subject: config.vapidSubject ?? DEFAULT_VAPID_SUBJECT
    } satisfies StoredVapidDetails;

    this.state.notifications.vapid = vapidDetails;
    this.persistState();

    this.logger.info("Generated persistent VAPID keys for push notifications");
    return vapidDetails;
  }

  private persistState() {
    const tmpPath = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, this.stateFile);
  }

  private emptyState(): NotificationState {
    return {
      version: 1,
      notifications: {
        vapid: null,
        subscriptions: []
      }
    };
  }
}

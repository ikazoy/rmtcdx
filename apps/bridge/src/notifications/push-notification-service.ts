import fs from "node:fs";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";
import BetterSqlite3 from "better-sqlite3";
import webpush from "web-push";

import type {
  NotificationsConfigResponse,
  Run,
  SavePushSubscriptionRequest,
  SessionDetail
} from "../../../../packages/shared-types/src/index";
import type { AppConfig } from "../config/env";
import { nowIso } from "../utils/time";

const VAPID_SETTING_KEY = "push.vapid";
const DEFAULT_VAPID_SUBJECT = "mailto:notifications@codex-remote.local";

type PushSubscriptionRow = {
  endpoint: string;
  expiration_time: number | null;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  platform: string | null;
  created_at: string;
  updated_at: string;
};

type NotificationSettingRow = {
  key: string;
  value_json: string;
};

type StoredVapidDetails = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

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
  private readonly sqlite: BetterSqlite3.Database;
  private readonly vapidDetails: StoredVapidDetails;

  constructor(
    dbFile: string,
    config: AppConfig,
    private readonly logger: FastifyBaseLogger
  ) {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    this.sqlite = new BetterSqlite3(dbFile);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.init();
    this.vapidDetails = this.resolveVapidDetails(config);

    webpush.setVapidDetails(
      this.vapidDetails.subject,
      this.vapidDetails.publicKey,
      this.vapidDetails.privateKey
    );
  }

  close() {
    this.sqlite.close();
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
    this.sqlite
      .prepare(
        `
          INSERT INTO push_subscriptions (
            endpoint, expiration_time, p256dh, auth, user_agent, platform, created_at, updated_at
          ) VALUES (
            @endpoint, @expirationTime, @p256dh, @auth, @userAgent, @platform, @createdAt, @updatedAt
          )
          ON CONFLICT(endpoint) DO UPDATE SET
            expiration_time = excluded.expiration_time,
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            user_agent = excluded.user_agent,
            platform = excluded.platform,
            updated_at = excluded.updated_at
        `
      )
      .run({
        endpoint: subscription.endpoint,
        expirationTime: subscription.expirationTime ?? null,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        userAgent: subscription.userAgent ?? null,
        platform: subscription.platform ?? null,
        createdAt: now,
        updatedAt: now
      });
  }

  deleteSubscription(endpoint: string) {
    this.sqlite.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  async notifyRun(detail: SessionDetail, run: Run) {
    if (run.status !== "completed" && run.status !== "error") {
      return;
    }

    const subscriptions = this.sqlite
      .prepare<[], PushSubscriptionRow>("SELECT * FROM push_subscriptions ORDER BY updated_at DESC")
      .all();

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
              expirationTime: subscription.expiration_time,
              keys: {
                p256dh: subscription.p256dh,
                auth: subscription.auth
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

  private init() {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        expiration_time INTEGER,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user_agent TEXT,
        platform TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notification_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
    `);
  }

  private resolveVapidDetails(config: AppConfig) {
    if (config.vapidPublicKey && config.vapidPrivateKey) {
      return {
        publicKey: config.vapidPublicKey,
        privateKey: config.vapidPrivateKey,
        subject: config.vapidSubject ?? DEFAULT_VAPID_SUBJECT
      } satisfies StoredVapidDetails;
    }

    const stored = this.sqlite
      .prepare<[string], NotificationSettingRow>("SELECT * FROM notification_settings WHERE key = ?")
      .get(VAPID_SETTING_KEY);

    if (stored) {
      const parsed = JSON.parse(stored.value_json) as StoredVapidDetails;
      return {
        ...parsed,
        subject: config.vapidSubject ?? parsed.subject ?? DEFAULT_VAPID_SUBJECT
      };
    }

    const generated = webpush.generateVAPIDKeys();
    const vapidDetails = {
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
      subject: config.vapidSubject ?? DEFAULT_VAPID_SUBJECT
    } satisfies StoredVapidDetails;

    this.sqlite
      .prepare("INSERT INTO notification_settings (key, value_json) VALUES (?, ?)")
      .run(VAPID_SETTING_KEY, JSON.stringify(vapidDetails));

    this.logger.info("Generated persistent VAPID keys for push notifications");
    return vapidDetails;
  }
}

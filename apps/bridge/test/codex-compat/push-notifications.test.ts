import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { FastifyBaseLogger } from "fastify";
import webpush from "web-push";

import type { AppConfig } from "../../src/config/env";
import { PushNotificationService } from "../../src/notifications/push-notification-service";
import type { CodexPendingRequest, Run, SessionDetail, SessionSummary } from "@codex-remote/shared-types";

const logger = {
  info() {},
  warn() {}
} as unknown as FastifyBaseLogger;

test("push notifications include interrupted status and thread title", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-push-notifications-"));
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  t.mock.method(webpush, "generateVAPIDKeys", () => ({
    publicKey: "public-key",
    privateKey: "private-key"
  }));
  t.mock.method(webpush, "setVapidDetails", () => {});

  const sentPayloads: string[] = [];
  t.mock.method(webpush, "sendNotification", async (_subscription: unknown, payload: string | Buffer) => {
    sentPayloads.push(payload.toString());
  });

  const config = createConfig(rootDir);
  const service = new PushNotificationService(path.join(rootDir, "state.json"), config, logger);

  service.saveSubscription({
    endpoint: "https://example.test/push/subscription",
    keys: {
      p256dh: "p256dh-key",
      auth: "auth-key"
    }
  });

  await service.notifyRun(createSessionDetail("Deploy preview"), createRun("interrupted"));

  assert.equal(sentPayloads.length, 1);
  assert.deepEqual(JSON.parse(sentPayloads[0] ?? "{}"), {
    title: "Rmtcdx · Interrupted",
    body: "Thread: Deploy preview · Status: interrupted",
    tag: "run:run-1",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    renotify: false,
    requireInteraction: false,
    data: {
      url: "/sessions/thread-1",
      sessionId: "thread-1",
      runId: "run-1"
    }
  });
});

test("push notifications include pending request labels and session links", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-push-notifications-"));
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  t.mock.method(webpush, "generateVAPIDKeys", () => ({
    publicKey: "public-key",
    privateKey: "private-key"
  }));
  t.mock.method(webpush, "setVapidDetails", () => {});

  const sentPayloads: string[] = [];
  t.mock.method(webpush, "sendNotification", async (_subscription: unknown, payload: string | Buffer) => {
    sentPayloads.push(payload.toString());
  });

  const config = createConfig(rootDir);
  const service = new PushNotificationService(path.join(rootDir, "state.json"), config, logger);

  service.saveSubscription({
    endpoint: "https://example.test/push/subscription",
    keys: {
      p256dh: "p256dh-key",
      auth: "auth-key"
    }
  });

  await service.notifyPendingRequest(createSessionDetail("Deploy preview"), createPendingRequest("request_user_input"));

  assert.equal(sentPayloads.length, 1);
  assert.deepEqual(JSON.parse(sentPayloads[0] ?? "{}"), {
    title: "Rmtcdx · Input required",
    body: "Thread: Deploy preview · Input required",
    tag: "request:request-1",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    renotify: true,
    requireInteraction: true,
    data: {
      url: "/sessions/thread-1",
      sessionId: "thread-1",
      requestId: "request-1"
    }
  });
});

function createConfig(rootDir: string): AppConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    reposFile: path.join(rootDir, "repos.json"),
    dataDir: rootDir,
    stateFile: path.join(rootDir, "state.json"),
    runtimeFile: path.join(rootDir, "runtime.json"),
    codexDebugLogFile: path.join(rootDir, "codex-app-server.jsonl"),
    uploadsDir: path.join(rootDir, "uploads"),
    webDistDir: path.join(rootDir, "web-dist"),
    codexMode: "mock",
    maxPromptLength: 12_000,
    maxImageAttachments: 5,
    maxImageAttachmentBytes: 10_485_760,
    devSimulatorEnabled: false
  };
}

function createSessionDetail(title: string): SessionDetail {
  return {
    session: createSessionSummary(title),
    activeRun: null,
    latestRun: null,
    runSettings: null
  };
}

function createSessionSummary(title: string): SessionSummary {
  const now = "2026-03-30T12:00:00.000Z";

  return {
    id: "thread-1",
    repoId: "repo-1",
    repoName: "Fixture Repo",
    title,
    summary: title,
    status: "running",
    isArchived: false,
    unreadCount: 0,
    lastEventSeq: 0,
    lastReadEventSeq: 0,
    lastMessageAt: now,
    pendingRequestCount: 0,
    hasUnreadCompletion: false,
    hasUnreadError: false,
    createdAt: now,
    updatedAt: now
  };
}

function createRun(status: Run["status"]): Run {
  return {
    id: "run-1",
    sessionId: "thread-1",
    status,
    startedAt: "2026-03-30T12:00:00.000Z",
    finishedAt: "2026-03-30T12:01:00.000Z"
  };
}

function createPendingRequest(type: CodexPendingRequest["type"]): CodexPendingRequest {
  const base = {
    id: "request-1",
    sessionId: "thread-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: null,
    createdAt: "2026-03-30T12:00:30.000Z"
  };

  switch (type) {
    case "command_approval":
      return {
        ...base,
        type,
        approvalId: null,
        reason: "Need approval to run a command.",
        networkApprovalContext: null,
        command: "npm test",
        cwd: "/tmp/repo",
        commandActions: null,
        requestedPermissions: null,
        availableDecisions: ["accept", "decline", "cancel"]
      };
    case "file_change_approval":
      return {
        ...base,
        type,
        reason: "Need approval to edit files.",
        grantRoot: "/tmp/repo"
      };
    case "permissions_approval":
      return {
        ...base,
        type,
        reason: "Need broader permissions.",
        permissions: {
          network: {
            enabled: true
          },
          fileSystem: {
            read: ["/tmp/repo"],
            write: ["/tmp/repo"]
          }
        }
      };
    case "request_user_input":
      return {
        ...base,
        type,
        questions: [
          {
            id: "confirm",
            header: "Confirm",
            question: "Proceed?",
            isOther: false,
            isSecret: false,
            options: null
          }
        ]
      };
    case "mcp_elicitation":
      return {
        ...base,
        type,
        mode: "form",
        serverName: "linear",
        message: "Approve MCP action",
        meta: null,
        requestedSchema: {}
      };
  }
}

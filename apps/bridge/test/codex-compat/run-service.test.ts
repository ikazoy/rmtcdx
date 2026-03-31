import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { FastifyBaseLogger } from "fastify";

import type { Repository, Run, SessionDetail, SessionSummary } from "@codex-remote/shared-types";
import type { CodexBackend, CodexBridgeEvent, StartRunParams } from "../../src/codex/types";
import type { AppConfig } from "../../src/config/env";
import { RealtimeGateway } from "../../src/realtime/realtime-gateway";
import { RunService } from "../../src/runs/run-service";
import { SessionRunSettingsStore } from "../../src/runs/session-run-settings-store";

const logger = {
  warn() {}
} as unknown as FastifyBaseLogger;

test("run service sends push notifications for terminal transitions from running", async () => {
  for (const [eventType, expectedStatus] of [
    ["run.completed", "completed"],
    ["run.interrupted", "interrupted"],
    ["run.error", "error"]
  ] as const) {
    const harness = createHarness();
    const run = await harness.service.start({
      repoId: "repo-1",
      prompt: "Check deployment status"
    });

    harness.backend.emitTerminalEvent(eventType, run.id, run.turnId ?? "turn-1");
    await flushAsyncWork();

    assert.equal(harness.notifications.length, 1, `${eventType} should trigger a push notification`);
    assert.equal(harness.notifications[0]?.detail.session.title, "Deploy preview");
    assert.equal(harness.notifications[0]?.run.status, expectedStatus);
  }
});

test("run service only sends one push notification for duplicate interrupted events", async () => {
  const harness = createHarness();
  const run = await harness.service.start({
    repoId: "repo-1",
    prompt: "Interrupt this run"
  });

  harness.backend.emitTerminalEvent("run.interrupted", run.id, run.turnId ?? "turn-1");
  await flushAsyncWork();
  harness.backend.emitTerminalEvent("run.interrupted", run.id, run.turnId ?? "turn-1");
  await flushAsyncWork();

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0]?.run.status, "interrupted");
});

test("run service exposes the last effective run settings for the thread", async () => {
  const harness = createHarness();

  await harness.service.start({
    sessionId: "thread-1",
    prompt: "Use elevated settings",
    codex: {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      serviceTier: "fast",
      model: "gpt-5.4"
    }
  });

  const detail = harness.service.presentSessionDetail(harness.detail);

  assert.deepEqual(detail.runSettings, {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    serviceTier: "fast",
    model: "gpt-5.4"
  });
});

function createHarness() {
  const backend = new FakeCodexBackend();
  const detail = createSessionDetail("Deploy preview");
  const notifications: Array<{ detail: SessionDetail; run: Run }> = [];
  const runSettingsStore = new SessionRunSettingsStore(
    path.join(os.tmpdir(), `rmtcdx-run-settings-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
  );

  const service = new RunService(
    createConfig(),
    {
      async getRepo(repoId: string) {
        return createRepo(repoId);
      },
      async getSessionDetail() {
        return detail;
      },
      async getThread() {
        return {
          id: "thread-1",
          cwd: "/tmp/repo"
        };
      }
    } as never,
    new RealtimeGateway(() => {}),
    backend as unknown as CodexBackend,
    {
      async stage() {
        return [];
      }
    } as never,
    {
      async notifyRun(sessionDetail: SessionDetail, run: Run) {
        notifications.push({ detail: sessionDetail, run });
      }
    } as never,
    logger,
    undefined,
    runSettingsStore
  );

  return {
    backend,
    detail,
    notifications,
    service
  };
}

function createConfig(): AppConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    reposFile: "/tmp/repos.json",
    dataDir: "/tmp",
    stateFile: "/tmp/state.json",
    runtimeFile: "/tmp/runtime.json",
    codexDebugLogFile: "/tmp/codex-app-server.jsonl",
    uploadsDir: "/tmp/uploads",
    webDistDir: "/tmp/web-dist",
    codexMode: "mock",
    maxPromptLength: 12_000,
    maxImageAttachments: 5,
    maxImageAttachmentBytes: 10_485_760,
    devSimulatorEnabled: false
  };
}

function createRepo(id: string): Repository {
  const now = "2026-03-30T12:00:00.000Z";

  return {
    id,
    name: "Fixture Repo",
    path: "/tmp/repo",
    pinned: false,
    runningSessionCount: 0,
    createdAt: now,
    updatedAt: now
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

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
}

class FakeCodexBackend extends EventEmitter {
  async startRun(_params: StartRunParams) {
    return {
      threadId: "thread-1",
      turnId: "turn-1"
    };
  }

  async interruptRun() {}

  emitTerminalEvent(
    eventType: Extract<CodexBridgeEvent["type"], "run.completed" | "run.interrupted" | "run.error">,
    runId: string,
    turnId: string
  ) {
    const event: CodexBridgeEvent =
      eventType === "run.error"
        ? {
            type: eventType,
            sessionId: "thread-1",
            runId,
            turnId,
            message: "The run failed."
          }
        : {
            type: eventType,
            sessionId: "thread-1",
            runId,
            turnId
          };

    this.emit("event", event);
  }
}

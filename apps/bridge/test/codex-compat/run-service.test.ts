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
import { SessionUnreadService } from "../../src/sessions/session-unread-service";

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

test("run service clears a raw active run when the matching local run is interrupted", async () => {
  const harness = createHarness();
  const run = await harness.service.start({
    sessionId: "thread-1",
    prompt: "Interrupt immediately"
  });
  const turnId = run.turnId ?? "turn-1";
  await harness.service.interrupt(run.id);

  harness.detail.session.status = "running";
  harness.detail.session.statusReasonCode = "thread_active";
  harness.detail.session.statusConfidence = "authoritative";
  harness.detail.session.latestTurnId = turnId;
  harness.detail.session.latestTurnStatus = "inProgress";
  harness.detail.session.threadStatusType = "active";
  harness.detail.activeRun = {
    id: turnId,
    sessionId: "thread-1",
    turnId,
    status: "running",
    startedAt: "2026-03-30T12:00:01.000Z"
  };
  harness.detail.latestRun = {
    ...harness.detail.activeRun
  };

  harness.backend.emitTerminalEvent("run.interrupted", run.id, turnId);
  await flushAsyncWork();

  const presented = harness.service.presentSessionDetail(harness.detail);

  assert.equal(presented.session.status, "interrupted");
  assert.equal(presented.session.statusReasonCode, "local_latest_run_interrupted");
  assert.equal(presented.session.interruptEvidence, "confirmed");
  assert.equal(presented.activeRun, null);
  assert.equal(presented.latestRun?.id, run.id);
  assert.equal(presented.latestRun?.turnId, turnId);
  assert.equal(presented.latestRun?.status, "interrupted");
  assert.equal(presented.interruptOrigin, "local");
  assert.equal(presented.interruptLooksSuspicious, false);
});

test("run service only applies local terminal summary state when the latest turn id still matches", async () => {
  const harness = createHarness();
  const run = await harness.service.start({
    sessionId: "thread-1",
    prompt: "Interrupt and move on"
  });
  const turnId = run.turnId ?? "turn-1";

  await harness.service.interrupt(run.id);
  harness.backend.emitTerminalEvent("run.interrupted", run.id, turnId);
  await flushAsyncWork();

  const matchingSummary = harness.service.presentSessionSummary({
    ...createSessionSummary("Deploy preview"),
    status: "running",
    statusReasonCode: "thread_active",
    statusConfidence: "authoritative",
    latestTurnId: turnId,
    latestTurnStatus: "inProgress",
    threadStatusType: "active"
  });
  assert.equal(matchingSummary.status, "interrupted");
  assert.equal(matchingSummary.statusReasonCode, "local_latest_run_interrupted");
  assert.equal(matchingSummary.interruptEvidence, "confirmed");

  const movedOnSummary = harness.service.presentSessionSummary({
    ...createSessionSummary("Deploy preview"),
    status: "running",
    statusReasonCode: "thread_active",
    statusConfidence: "authoritative",
    latestTurnId: "turn-2",
    latestTurnStatus: "inProgress",
    threadStatusType: "active"
  });
  assert.equal(movedOnSummary.status, "running");
  assert.equal(movedOnSummary.statusReasonCode, "thread_active");
});

test("run service treats interrupted local runs without a local stop request as external or unknown", async () => {
  const harness = createHarness();
  const run = await harness.service.start({
    sessionId: "thread-1",
    prompt: "Interrupt from another client"
  });
  const turnId = run.turnId ?? "turn-1";

  harness.backend.emitTerminalEvent("run.interrupted", run.id, turnId);
  await flushAsyncWork();

  const presented = harness.service.presentSessionDetail({
    ...harness.detail,
    session: {
      ...harness.detail.session,
      latestTurnId: turnId,
      latestTurnStatus: "interrupted",
      threadStatusType: "notLoaded",
      status: "interrupted",
      statusReasonCode: "latest_turn_interrupted",
      statusConfidence: "authoritative"
    },
    latestRun: {
      id: turnId,
      sessionId: "thread-1",
      turnId,
      status: "interrupted",
      startedAt: "2026-03-30T12:00:01.000Z",
      finishedAt: "2026-03-30T12:00:05.000Z"
    }
  });

  assert.equal(presented.session.status, "interrupted");
  assert.equal(presented.session.statusReasonCode, "latest_turn_interrupted");
  assert.equal(presented.session.statusConfidence, "authoritative");
  assert.equal(presented.session.interruptEvidence, "confirmed");
  assert.equal(presented.interruptOrigin, "external_or_unknown");
  assert.equal(presented.interruptLooksSuspicious, false);
});

test("run service downgrades snapshot-only interrupted sessions to completed when there are no active hints", () => {
  const harness = createHarness();
  harness.detail.session.status = "interrupted";
  harness.detail.session.statusReasonCode = "latest_turn_interrupted";
  harness.detail.session.statusConfidence = "authoritative";
  harness.detail.session.latestTurnId = "turn-snapshot";
  harness.detail.session.latestTurnStatus = "interrupted";
  harness.detail.session.threadStatusType = "notLoaded";
  harness.detail.latestRun = {
    id: "turn-snapshot",
    sessionId: "thread-1",
    turnId: "turn-snapshot",
    status: "interrupted",
    startedAt: "2026-03-30T12:00:01.000Z",
    finishedAt: "2026-03-30T12:00:05.000Z"
  };
  harness.detail.latestTurnHasAssistantOutput = true;

  const presented = harness.service.presentSessionDetail(harness.detail);

  assert.equal(presented.session.status, "completed");
  assert.equal(presented.session.statusReasonCode, "snapshot_only_interrupted");
  assert.equal(presented.session.statusConfidence, "suspicious");
  assert.equal(presented.session.interruptEvidence, "snapshot_only");
  assert.equal(presented.interruptOrigin, "external_or_unknown");
  assert.equal(presented.interruptLooksSuspicious, true);
});

test("run service downgrades snapshot-only interrupted sessions to running when the thread is still active", () => {
  const harness = createHarness();
  harness.detail.session.status = "interrupted";
  harness.detail.session.statusReasonCode = "latest_turn_interrupted";
  harness.detail.session.statusConfidence = "authoritative";
  harness.detail.session.latestTurnId = "turn-active";
  harness.detail.session.latestTurnStatus = "interrupted";
  harness.detail.session.threadStatusType = "active";

  const presented = harness.service.presentSessionDetail(harness.detail);

  assert.equal(presented.session.status, "running");
  assert.equal(presented.session.statusReasonCode, "snapshot_only_interrupted");
  assert.equal(presented.session.statusConfidence, "suspicious");
  assert.equal(presented.session.interruptEvidence, "snapshot_only");
  assert.equal(presented.interruptOrigin, "external_or_unknown");
});

test("run service records completion unread only after a counted final assistant message completes the turn", async () => {
  const harness = createHarness();
  const run = await harness.service.start({
    repoId: "repo-1",
    prompt: "Ship it"
  });

  harness.backend.emitMessageFinal(run.id, run.turnId ?? "turn-1", true);
  await flushAsyncWork();
  harness.backend.emitTerminalEvent("run.completed", run.id, run.turnId ?? "turn-1");
  await flushAsyncWork();

  const presented = harness.unread.presentSessionDetail(harness.service.presentSessionDetail(harness.detail));
  assert.equal(presented.session.unreadCount, 1);
  assert.equal(presented.session.lastEventSeq, 1);
  assert.equal(presented.session.hasUnreadCompletion, true);
  assert.equal(presented.session.hasUnreadError, false);
});

test("run service ignores completion unread for commentary-only assistant output", async () => {
  const harness = createHarness();
  const run = await harness.service.start({
    repoId: "repo-1",
    prompt: "Talk me through it"
  });

  harness.backend.emitMessageFinal(run.id, run.turnId ?? "turn-1", false);
  await flushAsyncWork();
  harness.backend.emitTerminalEvent("run.completed", run.id, run.turnId ?? "turn-1");
  await flushAsyncWork();

  const presented = harness.unread.presentSessionDetail(harness.service.presentSessionDetail(harness.detail));
  assert.equal(presented.session.unreadCount, 0);
  assert.equal(presented.session.lastEventSeq, 0);
});

test("run service records error unread on failed runs", async () => {
  const harness = createHarness();
  const run = await harness.service.start({
    repoId: "repo-1",
    prompt: "Break it"
  });

  harness.backend.emitTerminalEvent("run.error", run.id, run.turnId ?? "turn-1");
  await flushAsyncWork();

  const presented = harness.unread.presentSessionDetail(harness.service.presentSessionDetail(harness.detail));
  assert.equal(presented.session.unreadCount, 1);
  assert.equal(presented.session.lastEventSeq, 1);
  assert.equal(presented.session.hasUnreadCompletion, false);
  assert.equal(presented.session.hasUnreadError, true);
});

function createHarness() {
  const backend = new FakeCodexBackend();
  const detail = createSessionDetail("Deploy preview");
  const notifications: Array<{ detail: SessionDetail; run: Run }> = [];
  const runSettingsStore = new SessionRunSettingsStore(
    path.join(os.tmpdir(), `rmtcdx-run-settings-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
  );
  const unread = new SessionUnreadService(
    path.join(os.tmpdir(), `rmtcdx-session-unread-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
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
    unread,
    logger,
    undefined,
    runSettingsStore
  );

  return {
    backend,
    detail,
    notifications,
    unread,
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
    codexHomeDir: "/tmp",
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

  listPendingRequests() {
    return [];
  }

  emitMessageFinal(runId: string, turnId: string, countsUnread: boolean) {
    const event: CodexBridgeEvent = {
      type: "item.completed",
      sessionId: "thread-1",
      runId,
      turnId,
      item: {
        type: "agentMessage",
        id: countsUnread ? "assistant-final" : "assistant-commentary",
        text: countsUnread ? "Final answer" : "Thinking aloud",
        phase: countsUnread ? "final_answer" : "commentary"
      }
    };

    this.emit("event", event);
  }

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

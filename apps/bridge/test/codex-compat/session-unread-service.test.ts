import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SessionSummary } from "@codex-remote/shared-types";
import { SessionUnreadService } from "../../src/sessions/session-unread-service";

test("session unread service persists unread cursors across restarts", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rmtcdx-session-unread-"));
  const filePath = path.join(tempDir, "session-read-state.json");

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const service = new SessionUnreadService(filePath);
  service.stageCompletion({
    sessionId: "thread-1",
    runId: "run-1",
    turnId: "turn-1",
    createdAt: "2026-03-31T12:00:00.000Z"
  });
  assert.equal(service.recordCompletion("thread-1", "run-1", "turn-1"), true);
  assert.equal(service.recordError("thread-1", "run-2", "turn-2", "2026-03-31T12:01:00.000Z"), true);
  assert.equal(service.markRead("thread-1"), true);
  service.stageCompletion({
    sessionId: "thread-1",
    runId: "run-3",
    turnId: "turn-3",
    createdAt: "2026-03-31T12:02:00.000Z"
  });
  assert.equal(service.recordCompletion("thread-1", "run-3", "turn-3"), true);

  const restored = new SessionUnreadService(filePath);
  const presented = restored.presentSessionSummary(createSessionSummary());

  assert.equal(presented.unreadCount, 1);
  assert.equal(presented.lastEventSeq, 3);
  assert.equal(presented.lastReadEventSeq, 2);
  assert.equal(presented.hasUnreadCompletion, true);
  assert.equal(presented.hasUnreadError, false);
});

test("session unread service does not backfill completion unread without a staged live final message", () => {
  const service = new SessionUnreadService(path.join(os.tmpdir(), `rmtcdx-session-unread-${Date.now()}.json`));

  assert.equal(service.recordCompletion("thread-1", "run-1", "turn-1"), false);

  const presented = service.presentSessionSummary(createSessionSummary());
  assert.equal(presented.unreadCount, 0);
  assert.equal(presented.lastEventSeq, 0);
  assert.equal(presented.hasUnreadCompletion, false);
});

function createSessionSummary(): SessionSummary {
  const now = "2026-03-31T12:00:00.000Z";

  return {
    id: "thread-1",
    repoId: "repo-1",
    repoName: "Fixture Repo",
    title: "Unread fixture",
    summary: "Unread fixture",
    status: "completed",
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

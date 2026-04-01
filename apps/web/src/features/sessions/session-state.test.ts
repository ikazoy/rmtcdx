import assert from "node:assert/strict";
import test from "node:test";

import type { SessionSummary } from "@codex-remote/shared-types";
import { sessionIndicatorTone } from "./session-state";

function createSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  const now = "2026-04-01T12:00:00.000Z";

  return {
    id: "session-1",
    repoId: "repo-1",
    repoName: "Repo 1",
    title: "Session 1",
    summary: "Summary",
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
    updatedAt: now,
    ...overrides
  };
}

test("sessionIndicatorTone hides the dot for read completions and interrupted sessions", () => {
  assert.equal(sessionIndicatorTone(createSession()), "none");
  assert.equal(sessionIndicatorTone(createSession({ status: "interrupted" })), "none");
});

test("sessionIndicatorTone shows green only for unread completions", () => {
  assert.equal(sessionIndicatorTone(createSession({ hasUnreadCompletion: true, unreadCount: 1 })), "completed");
});

test("sessionIndicatorTone prioritizes pending requests and errors over completion unread", () => {
  assert.equal(
    sessionIndicatorTone(
      createSession({
        status: "error",
        hasUnreadCompletion: true,
        hasUnreadError: true
      })
    ),
    "error"
  );
  assert.equal(
    sessionIndicatorTone(
      createSession({
        status: "running",
        pendingRequestCount: 2,
        hasUnreadCompletion: true
      })
    ),
    "pending"
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "@codex-remote/shared-types";
import {
  DEFAULT_REPO_GROUP_VISIBLE_SESSION_LIMIT,
  EXPANDED_REPO_GROUP_VISIBLE_SESSION_LIMIT,
  getVisibleRepoGroupSessions,
  getRepoGroupIndicators,
  repoGroupToggleLabel,
  repoGroupIndicatorsLabel,
  shouldAutoExpandRepoGroup,
  shouldLimitRepoGroupSessions
} from "./repo-group-display";

function createSession(index: number, overrides: Partial<SessionSummary> = {}): SessionSummary {
  const iso = `2026-03-${String(30 - Math.min(index, 29)).padStart(2, "0")}T12:00:00.000Z`;

  return {
    id: `session-${index}`,
    repoId: "repo-1",
    repoName: "Repo 1",
    title: `Session ${index}`,
    summary: `Summary ${index}`,
    status: "completed",
    isArchived: false,
    unreadCount: 0,
    lastEventSeq: 0,
    lastReadEventSeq: 0,
    lastMessageAt: iso,
    pendingRequestCount: 0,
    hasUnreadCompletion: false,
    hasUnreadError: false,
    createdAt: iso,
    updatedAt: iso,
    ...overrides
  };
}

test("shouldLimitRepoGroupSessions only limits the grouped unfiltered view", () => {
  assert.equal(
    shouldLimitRepoGroupSessions({
      selectedRepoId: null,
      search: "",
      filter: "all"
    }),
    true
  );

  assert.equal(
    shouldLimitRepoGroupSessions({
      selectedRepoId: null,
      search: "bug",
      filter: "all"
    }),
    false
  );

  assert.equal(
    shouldLimitRepoGroupSessions({
      selectedRepoId: "repo-1",
      search: "",
      filter: "all"
    }),
    false
  );
});

test("getVisibleRepoGroupSessions limits collapsed groups to ten and expanded groups to thirty", () => {
  const sessions = Array.from({ length: 34 }, (_unused, index) => createSession(index));

  assert.equal(
    getVisibleRepoGroupSessions(sessions, {
      isExpanded: false
    }).length,
    DEFAULT_REPO_GROUP_VISIBLE_SESSION_LIMIT
  );

  assert.equal(
    getVisibleRepoGroupSessions(sessions, {
      isExpanded: true
    }).length,
    EXPANDED_REPO_GROUP_VISIBLE_SESSION_LIMIT
  );
});

test("shouldAutoExpandRepoGroup expands when the selected session is beyond the default limit", () => {
  const sessions = Array.from({ length: 14 }, (_unused, index) => createSession(index));

  assert.equal(shouldAutoExpandRepoGroup(sessions, "session-3"), false);
  assert.equal(shouldAutoExpandRepoGroup(sessions, "session-11"), true);
});

test("repoGroupToggleLabel switches between show more and show less", () => {
  assert.equal(
    repoGroupToggleLabel({
      totalCount: 34,
      visibleCount: 10
    }),
    "Show 20 more"
  );

  assert.equal(
    repoGroupToggleLabel({
      totalCount: 34,
      visibleCount: 30
    }),
    "Show less"
  );
});

test("getRepoGroupIndicators returns attention states in fixed priority order", () => {
  const sessions = [
    createSession(1, {
      status: "running"
    }),
    createSession(2, {
      pendingRequestCount: 1
    }),
    createSession(3, {
      hasUnreadCompletion: true,
      unreadCount: 1
    }),
    createSession(4, {
      hasUnreadError: true,
      unreadCount: 1
    })
  ];

  assert.deepEqual(getRepoGroupIndicators(sessions), ["error", "pending", "unread"]);
});

test("getRepoGroupIndicators shows running only when there is no attention state", () => {
  assert.deepEqual(getRepoGroupIndicators([createSession(1, { status: "running" })]), ["running"]);
  assert.deepEqual(
    getRepoGroupIndicators([
      createSession(1, { status: "running" }),
      createSession(2, { hasUnreadCompletion: true, unreadCount: 1 })
    ]),
    ["unread"]
  );
});

test("getRepoGroupIndicators applies the selected session pending override", () => {
  assert.deepEqual(
    getRepoGroupIndicators([createSession(1)], {
      selectedSessionId: "session-1",
      selectedSessionPendingRequestCount: 2
    }),
    ["pending"]
  );
});

test("repoGroupIndicatorsLabel summarizes the visible states", () => {
  assert.equal(repoGroupIndicatorsLabel(["running"]), "Has running threads");
  assert.equal(
    repoGroupIndicatorsLabel(["error", "pending", "unread"]),
    "Needs attention: errors, pending requests, unread threads"
  );
  assert.equal(repoGroupIndicatorsLabel([]), null);
});

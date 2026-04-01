import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "@codex-remote/shared-types";
import {
  DEFAULT_REPO_GROUP_VISIBLE_SESSION_LIMIT,
  getVisibleRepoGroupSessions,
  repoGroupToggleLabel,
  shouldAutoExpandRepoGroup,
  shouldLimitRepoGroupSessions
} from "./repo-group-display";

function createSession(index: number): SessionSummary {
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
    updatedAt: iso
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

test("getVisibleRepoGroupSessions limits collapsed groups to the latest ten sessions", () => {
  const sessions = Array.from({ length: 14 }, (_unused, index) => createSession(index));

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
    sessions.length
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
      totalCount: 14,
      visibleCount: 10
    }),
    "Show 4 more"
  );

  assert.equal(
    repoGroupToggleLabel({
      totalCount: 14,
      visibleCount: 14
    }),
    "Show less"
  );
});

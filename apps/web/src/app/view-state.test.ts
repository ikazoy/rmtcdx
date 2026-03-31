import assert from "node:assert/strict";
import test from "node:test";

import type { Message, SessionDetail, SessionSummary } from "@codex-remote/shared-types";
import { buildChatViewState, mergeSessionSummaryIntoDetail, sessionDetailSyncKey } from "./view-state";

const summary: SessionSummary = {
  id: "session-1",
  repoId: "repo-1",
  repoName: "remote-control-codex",
  title: "Test session",
  summary: "Test summary",
  status: "completed",
  isArchived: false,
  unreadCount: 0,
  lastEventSeq: 0,
  lastReadEventSeq: 0,
  lastMessageAt: "2026-03-31T15:00:00.000Z",
  statusReasonCode: "history_present",
  statusConfidence: "authoritative",
  latestTurnStatus: "completed",
  threadStatusType: "idle",
  pendingRequestCount: 0,
  hasUnreadCompletion: false,
  hasUnreadError: false,
  createdAt: "2026-03-31T15:00:00.000Z",
  updatedAt: "2026-03-31T15:00:00.000Z"
};

const detail: SessionDetail = {
  session: summary,
  activeRun: null,
  latestRun: null,
  runSettings: null
};

const message: Message = {
  id: "message-1",
  sessionId: "session-1",
  role: "user",
  text: "hello",
  createdAt: "2026-03-31T15:00:00.000Z",
  kind: "user_message"
};

test("buildChatViewState preserves a messages error instead of treating the thread as empty", () => {
  const state = buildChatViewState({
    sessionId: "session-1",
    draftDetail: null,
    selectedSessionSummary: summary,
    detail,
    detailIsPending: false,
    detailError: null,
    messages: [],
    messagesError: new Error("messages failed"),
    messagesIsFetching: false,
    repoName: "remote-control-codex"
  });

  assert.equal(state.kind, "ready");
  assert.equal(state.messages.length, 0);
  assert.equal(state.messagesError, "messages failed");
});

test("buildChatViewState keeps showing loaded messages even if a later refresh fails", () => {
  const state = buildChatViewState({
    sessionId: "session-1",
    draftDetail: null,
    selectedSessionSummary: summary,
    detail,
    detailIsPending: false,
    detailError: null,
    messages: [message],
    messagesError: new Error("messages failed"),
    messagesIsFetching: false,
    repoName: "remote-control-codex"
  });

  assert.equal(state.kind, "ready");
  assert.equal(state.messages.length, 1);
  assert.equal(state.messagesError, "messages failed");
});

test("mergeSessionSummaryIntoDetail refreshes the session summary while preserving detail-only fields", () => {
  const nextSummary: SessionSummary = {
    ...summary,
    title: "Updated session",
    status: "running",
    statusReasonCode: "thread_active",
    latestTurnStatus: "inProgress",
    threadStatusType: "active",
    updatedAt: "2026-03-31T15:01:00.000Z"
  };
  const detailWithExtras: SessionDetail = {
    session: summary,
    activeRun: {
      id: "run-1",
      sessionId: "session-1",
      status: "running",
      startedAt: "2026-03-31T15:00:30.000Z"
    },
    latestRun: {
      id: "run-1",
      sessionId: "session-1",
      status: "running",
      startedAt: "2026-03-31T15:00:30.000Z"
    },
    runSettings: {
      model: "gpt-5.4"
    }
  };

  const merged = mergeSessionSummaryIntoDetail(detailWithExtras, nextSummary);

  assert.equal(merged?.session, nextSummary);
  assert.equal(merged?.activeRun, detailWithExtras.activeRun);
  assert.equal(merged?.latestRun, detailWithExtras.latestRun);
  assert.equal(merged?.runSettings, detailWithExtras.runSettings);
});

test("sessionDetailSyncKey changes when a polled summary gets ahead of detail state", () => {
  const polledSummary: SessionSummary = {
    ...summary,
    status: "running",
    statusReasonCode: "thread_active",
    latestTurnStatus: "inProgress",
    threadStatusType: "active",
    lastUserMessageAt: "2026-03-31T15:02:00.000Z",
    updatedAt: "2026-03-31T15:02:00.000Z"
  };

  assert.notEqual(sessionDetailSyncKey(summary), sessionDetailSyncKey(polledSummary));
});

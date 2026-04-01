import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import type { LiveActivity } from "@codex-remote/shared-types";
import {
  activityMapForSessionIds,
  hasActivitiesForSessionIds,
  hasStreamingTextForSessionIds,
  streamingTextForSessionIds,
  useUiStore
} from "./ui-store";

function waitForQueuedUiFlush() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function resetTransientUiState() {
  useUiStore.setState({
    streaming: {},
    activities: {}
  });
}

afterEach(async () => {
  await waitForQueuedUiFlush();
  resetTransientUiState();
});

test("streamingTextForSessionIds returns the first non-empty selected session text", () => {
  assert.equal(
    streamingTextForSessionIds(
      {
        "session-a": "",
        "session-b": "from-b",
        "session-c": "from-c"
      },
      ["session-c", "session-b"]
    ),
    "from-c"
  );

  assert.equal(
    hasStreamingTextForSessionIds(
      {
        "session-a": "",
        "session-b": ""
      },
      ["session-a", "session-b"]
    ),
    false
  );
});

test("activityMapForSessionIds returns the first non-empty selected activity map", () => {
  const activity: LiveActivity = {
    sessionId: "session-b",
    runId: "run-1",
    turnId: "turn-1",
    itemId: "activity-1",
    kind: "command",
    label: "npm test",
    output: "",
    startedAt: "2026-04-01T09:59:00.000Z",
    updatedAt: "2026-04-01T10:00:00.000Z"
  };

  const activities = {
    "session-a": {},
    "session-b": {
      [activity.itemId]: activity
    }
  };

  assert.equal(activityMapForSessionIds(activities, ["session-a", "session-b"]), activities["session-b"]);
  assert.equal(hasActivitiesForSessionIds(activities, ["session-a", "session-b"]), true);
});

test("appendStreaming batches multiple deltas until the scheduled flush", async () => {
  const { appendStreaming } = useUiStore.getState();

  appendStreaming("session-1", "hel");
  appendStreaming("session-1", "lo");

  assert.equal(useUiStore.getState().streaming["session-1"], undefined);

  await waitForQueuedUiFlush();

  assert.equal(useUiStore.getState().streaming["session-1"], "hello");
});

test("clearStreaming discards queued deltas for a session before they flush", async () => {
  const { appendStreaming, clearStreaming } = useUiStore.getState();

  appendStreaming("session-1", "hello");
  clearStreaming("session-1");

  await waitForQueuedUiFlush();

  assert.equal(useUiStore.getState().streaming["session-1"], undefined);
});

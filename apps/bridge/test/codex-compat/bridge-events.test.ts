import assert from "node:assert/strict";
import test from "node:test";

import {
  activityFromItem,
  parseBridgeNotification,
  toolNameFromItem
} from "../../src/codex/parsers/bridge-events";

const runByTurn = new Map([
  [
    "turn_1",
    {
      sessionId: "session_1",
      runId: "run_1"
    }
  ]
]);

test("maps supported notifications into bridge events in Step 1 order", () => {
  const sequence = [
    {
      method: "item/agentMessage/delta",
      params: { turnId: "turn_1", delta: "Hello" }
    },
    {
      method: "item/commandExecution/outputDelta",
      params: { turnId: "turn_1", itemId: "cmd_1", delta: "stdout" }
    },
    {
      method: "item/started",
      params: { turnId: "turn_1", item: { id: "cmd_1", type: "commandExecution", command: "git status" } }
    },
    {
      method: "item/completed",
      params: { turnId: "turn_1", item: { type: "agentMessage", text: "Final answer", phase: "final" } }
    },
    {
      method: "turn/completed",
      params: { turn: { id: "turn_1", status: "completed" } }
    }
  ];

  const parsed = sequence.map((entry) => parseBridgeNotification(entry.method, entry.params, runByTurn));
  const events = parsed.flatMap((entry) => entry.events);

  assert.deepEqual(events, [
    {
      type: "message.delta",
      sessionId: "session_1",
      runId: "run_1",
      turnId: "turn_1",
      text: "Hello"
    },
    {
      type: "activity.updated",
      sessionId: "session_1",
      runId: "run_1",
      turnId: "turn_1",
      itemId: "cmd_1",
      delta: "stdout"
    },
    {
      type: "activity.started",
      sessionId: "session_1",
      runId: "run_1",
      turnId: "turn_1",
      itemId: "cmd_1",
      kind: "command",
      label: "git status"
    },
    {
      type: "tool.start",
      sessionId: "session_1",
      runId: "run_1",
      turnId: "turn_1",
      name: "shell:git"
    },
    {
      type: "message.final",
      sessionId: "session_1",
      runId: "run_1",
      turnId: "turn_1",
      text: "Final answer",
      countsUnread: true
    },
    {
      type: "run.completed",
      sessionId: "session_1",
      runId: "run_1",
      turnId: "turn_1"
    }
  ]);
  assert.deepEqual(parsed.at(-1)?.finishedTurn, {
    turnId: "turn_1",
    status: "completed"
  });
});

test("tolerates unknown notification methods and records debug metadata", () => {
  const parsed = parseBridgeNotification("item/futureUnknownType", { turnId: "turn_1", extra: true }, runByTurn);

  assert.deepEqual(parsed.events, []);
  assert.deepEqual(parsed.finishedTurn, null);
  assert.deepEqual(parsed.debugEntries, [
    {
      event: "notification.unhandled",
      fields: {
        method: "item/futureUnknownType",
        params: { turnId: "turn_1", extra: true }
      }
    }
  ]);
});

test("tolerates known notifications with extra fields and missing mappings", () => {
  const withExtraFields = parseBridgeNotification(
    "item/completed",
    {
      turnId: "turn_1",
      item: {
        type: "agentMessage",
        text: "Commentary",
        phase: "commentary",
        futureField: { nested: true }
      }
    },
    runByTurn
  );
  const withoutMapping = parseBridgeNotification(
    "item/agentMessage/delta",
    { turnId: "turn_missing", delta: "ignored" },
    runByTurn
  );

  assert.deepEqual(withExtraFields.events, [
    {
      type: "message.final",
      sessionId: "session_1",
      runId: "run_1",
      turnId: "turn_1",
      text: "Commentary",
      countsUnread: false
    }
  ]);
  assert.deepEqual(withoutMapping.events, []);
  assert.deepEqual(withoutMapping.debugEntries, []);
});

test("surface helpers keep their mappings stable for known and unknown items", () => {
  assert.deepEqual(activityFromItem({ type: "webSearch" }), {
    kind: "search",
    label: "Running web search"
  });
  assert.equal(toolNameFromItem({ type: "mcpToolCall", server: "linear", tool: "list_issues" }), "linear:list_issues");
  assert.equal(toolNameFromItem({ type: "futureUnknownType" }), null);
  assert.equal(activityFromItem({ type: "futureUnknownType" }), null);
});

test("backend error without turn id degrades the backend instead of crashing a run", () => {
  const parsed = parseBridgeNotification(
    "error",
    {
      threadId: "thread_1",
      error: {
        message: "Backend exploded"
      }
    },
    runByTurn
  );

  assert.deepEqual(parsed.events, [
    {
      type: "backend.degraded",
      reason: "Backend exploded"
    }
  ]);
  assert.deepEqual(parsed.debugEntries, [
    {
      event: "backend.error",
      fields: {
        threadId: "thread_1",
        message: "Backend exploded"
      }
    }
  ]);
});

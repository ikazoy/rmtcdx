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

test("maps file change output deltas into activity updates", () => {
  const parsed = parseBridgeNotification(
    "item/fileChange/outputDelta",
    {
      turnId: "turn_1",
      itemId: "patch_1",
      delta: "Success. Updated the following files:\nM notes.txt\n"
    },
    runByTurn
  );

  assert.deepEqual(parsed.events, [
    {
      type: "activity.updated",
      sessionId: "session_1",
      runId: "run_1",
      turnId: "turn_1",
      itemId: "patch_1",
      delta: "Success. Updated the following files:\nM notes.txt\n"
    }
  ]);
  assert.deepEqual(parsed.debugEntries, []);
});

test("records real-canary thread and account notifications without marking them unhandled", () => {
  const started = parseBridgeNotification(
    "thread/started",
    {
      thread: {
        id: "thread_1",
        cwd: "/tmp/canary",
        path: "/tmp/canary/thread.jsonl",
        status: { type: "idle" }
      }
    },
    runByTurn
  );
  const statusChanged = parseBridgeNotification(
    "thread/status/changed",
    {
      threadId: "thread_1",
      status: { type: "active", activeFlags: [] }
    },
    runByTurn
  );
  const turnStarted = parseBridgeNotification(
    "turn/started",
    {
      threadId: "thread_1",
      turn: { id: "turn_1", status: "inProgress" }
    },
    runByTurn
  );
  const diffUpdated = parseBridgeNotification(
    "turn/diff/updated",
    {
      threadId: "thread_1",
      turnId: "turn_1",
      diff: "diff --git a/notes.txt b/notes.txt\n+compat-tool-ok\n"
    },
    runByTurn
  );
  const tokenUsage = parseBridgeNotification(
    "thread/tokenUsage/updated",
    {
      threadId: "thread_1",
      turnId: "turn_1",
      tokenUsage: {
        total: { totalTokens: 42 },
        last: { totalTokens: 10 },
        modelContextWindow: 128_000
      }
    },
    runByTurn
  );
  const rateLimits = parseBridgeNotification(
    "account/rateLimits/updated",
    {
      rateLimits: {
        limitId: "codex",
        planType: "pro",
        primary: { usedPercent: 9 },
        secondary: { usedPercent: 29 }
      }
    },
    runByTurn
  );

  assert.deepEqual(started.events, []);
  assert.deepEqual(started.debugEntries, [
    {
      event: "thread.started",
      fields: {
        threadId: "thread_1",
        cwd: "/tmp/canary",
        path: "/tmp/canary/thread.jsonl",
        status: "idle"
      }
    }
  ]);

  assert.deepEqual(statusChanged.debugEntries, [
    {
      event: "thread.status.changed",
      fields: {
        threadId: "thread_1",
        status: "active",
        activeFlags: []
      }
    }
  ]);
  assert.deepEqual(turnStarted.debugEntries, [
    {
      event: "turn.started",
      fields: {
        threadId: "thread_1",
        turnId: "turn_1",
        status: "inProgress"
      }
    }
  ]);
  assert.deepEqual(diffUpdated.debugEntries, [
    {
      event: "turn.diff.updated",
      fields: {
        threadId: "thread_1",
        turnId: "turn_1",
        diffLength: 51,
        diffLineCount: 3
      }
    }
  ]);
  assert.deepEqual(tokenUsage.debugEntries, [
    {
      event: "thread.token_usage.updated",
      fields: {
        threadId: "thread_1",
        turnId: "turn_1",
        totalTokens: 42,
        lastTokens: 10,
        modelContextWindow: 128_000
      }
    }
  ]);
  assert.deepEqual(rateLimits.debugEntries, [
    {
      event: "account.rate_limits.updated",
      fields: {
        limitId: "codex",
        planType: "pro",
        primaryUsedPercent: 9,
        secondaryUsedPercent: 29
      }
    }
  ]);

  for (const parsed of [started, statusChanged, turnStarted, diffUpdated, tokenUsage, rateLimits]) {
    assert.equal(parsed.debugEntries.some((entry) => entry.event === "notification.unhandled"), false);
  }
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

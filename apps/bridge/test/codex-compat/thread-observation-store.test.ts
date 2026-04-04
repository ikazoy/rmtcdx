import assert from "node:assert/strict";
import test from "node:test";

import { CodexThreadObservationStore } from "../../src/codex/thread-observation-store";
import type { CodexThread } from "../../src/codex/types";

test("materializeThread replays the live observed item order for a turn", () => {
  const store = new CodexThreadObservationStore();
  const sessionId = "session_1";
  const turnId = "turn_1";

  store.observe({
    type: "item.started",
    sessionId,
    runId: "run_1",
    turnId,
    item: {
      type: "agentMessage",
      id: "assistant_commentary_1",
      text: "",
      phase: "commentary"
    }
  });
  store.observe({
    type: "item.started",
    sessionId,
    runId: "run_1",
    turnId,
    item: {
      type: "commandExecution",
      id: "command_1",
      command: "git status --short",
      cwd: "/repo",
      status: "in_progress",
      aggregatedOutput: null,
      exitCode: null
    }
  });
  store.observe({
    type: "item.completed",
    sessionId,
    runId: "run_1",
    turnId,
    item: {
      type: "commandExecution",
      id: "command_1",
      command: "git status --short",
      cwd: "/repo",
      status: "completed",
      aggregatedOutput: "",
      exitCode: 0
    }
  });
  store.observe({
    type: "item.completed",
    sessionId,
    runId: "run_1",
    turnId,
    item: {
      type: "agentMessage",
      id: "assistant_commentary_1",
      text: "Checking branch and diff first.",
      phase: "commentary"
    }
  });
  store.observe({
    type: "item.completed",
    sessionId,
    runId: "run_1",
    turnId,
    item: {
      type: "agentMessage",
      id: "assistant_final_1",
      text: "Created the PR.",
      phase: "final_answer"
    }
  });

  const thread: CodexThread = {
    id: sessionId,
    preview: "Create a PR",
    createdAt: 1_774_899_488,
    updatedAt: 1_774_899_499,
    status: { type: "idle" },
    cwd: "/repo",
    path: null,
    name: null,
    modelProvider: "openai",
    source: "appServer",
    gitInfo: null,
    turns: [
      {
        id: turnId,
        status: "completed",
        error: null,
        items: [
          {
            type: "userMessage",
            id: "user_1",
            content: [{ type: "text", text: "Create a PR", text_elements: [] }]
          },
          {
            type: "agentMessage",
            id: "assistant_final_1",
            text: "Created the PR.",
            phase: "final_answer"
          },
          {
            type: "commandExecution",
            id: "command_1",
            command: "git status --short",
            cwd: "/repo",
            status: "completed",
            aggregatedOutput: "",
            exitCode: 0
          },
          {
            type: "agentMessage",
            id: "assistant_commentary_1",
            text: "Checking branch and diff first.",
            phase: "commentary"
          }
        ]
      }
    ]
  };

  const materialized = store.materializeThread(thread);

  assert.deepEqual(
    materialized.turns[0]?.items.map((item) => item.id),
    ["user_1", "assistant_commentary_1", "command_1", "assistant_final_1"]
  );
});

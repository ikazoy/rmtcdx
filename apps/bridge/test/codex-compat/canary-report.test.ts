import assert from "node:assert/strict";
import test from "node:test";

import { summarizeCanaryRun, summarizeCanaryScenario } from "../../src/compat/canary-report";
import type { CodexBridgeEvent, CodexThread } from "../../src/codex/types";

test("summarizeCanaryScenario returns pass for a clean completed run", () => {
  const thread = makeThread([
    {
      type: "userMessage",
      id: "user_1",
      content: [{ type: "text", text: "hello", text_elements: [] }]
    },
    {
      type: "agentMessage",
      id: "assistant_1",
      text: "compat-basic-ok",
      phase: "final"
    }
  ]);
  const events: CodexBridgeEvent[] = [
    {
      type: "run.completed",
      sessionId: "thread_1",
      runId: "run_1",
      turnId: "turn_1"
    }
  ];

  const summary = summarizeCanaryScenario({
    scenarioId: "basic-text",
    thread,
    bridgeEvents: events,
    expectations: {
      requiredTerminalEvent: "run.completed",
      finalTextIncludes: "compat-basic-ok"
    }
  });

  assert.equal(summary.status, "pass");
  assert.deepEqual(summary.failedAssertions, []);
  assert.equal(summary.terminalEventType, "run.completed");
});

test("summarizeCanaryScenario returns pass_with_drift when unknown item types are observed", () => {
  const thread = makeThread([
    {
      type: "userMessage",
      id: "user_1",
      content: [{ type: "text", text: "hello", text_elements: [] }]
    },
    {
      type: "futureUnknownType",
      id: "unknown_1"
    },
    {
      type: "agentMessage",
      id: "assistant_1",
      text: "compat-basic-ok",
      phase: "final"
    }
  ]);
  const events: CodexBridgeEvent[] = [
    {
      type: "run.completed",
      sessionId: "thread_1",
      runId: "run_1",
      turnId: "turn_1"
    }
  ];

  const summary = summarizeCanaryScenario({
    scenarioId: "basic-text",
    thread,
    bridgeEvents: events,
    expectations: {
      requiredTerminalEvent: "run.completed"
    }
  });

  assert.equal(summary.status, "pass_with_drift");
  assert.deepEqual(summary.unknownItemTypes, ["futureUnknownType"]);
});

test("summarizeCanaryScenario returns fail when required assertions are missing", () => {
  const thread = makeThread([
    {
      type: "userMessage",
      id: "user_1",
      content: [{ type: "text", text: "hello", text_elements: [] }]
    }
  ]);
  const events: CodexBridgeEvent[] = [
    {
      type: "run.error",
      sessionId: "thread_1",
      runId: "run_1",
      turnId: "turn_1",
      message: "failed"
    }
  ];

  const summary = summarizeCanaryScenario({
    scenarioId: "tool-edit",
    thread,
    bridgeEvents: events,
    expectations: {
      requiredTerminalEvent: "run.completed",
      requiredItemTypes: ["fileChange"],
      finalTextIncludes: "compat-tool-ok"
    },
    workspaceChecks: [
      {
        path: "notes.txt",
        ok: false,
        details: "Expected file to contain compat-tool-ok."
      }
    ]
  });

  assert.equal(summary.status, "fail");
  assert.ok(summary.failedAssertions.some((entry) => entry.includes("run.completed")));
  assert.ok(summary.failedAssertions.some((entry) => entry.includes("fileChange")));
});

test("summarizeCanaryRun escalates overall status from scenario results", () => {
  const report = summarizeCanaryRun([
    {
      scenarioId: "basic-text",
      status: "pass",
      terminalEventType: "run.completed",
      threadStatus: "idle",
      turnStatus: "completed",
      bridgeEventTypes: ["run.completed"],
      itemTypes: ["agentMessage", "userMessage"],
      unknownItemTypes: [],
      finalAssistantText: "ok",
      failedAssertions: [],
      workspaceChecks: []
    },
    {
      scenarioId: "tool-edit",
      status: "pass_with_drift",
      terminalEventType: "run.completed",
      threadStatus: "idle",
      turnStatus: "completed",
      bridgeEventTypes: ["run.completed"],
      itemTypes: ["futureUnknownType", "userMessage"],
      unknownItemTypes: ["futureUnknownType"],
      finalAssistantText: "ok",
      failedAssertions: [],
      workspaceChecks: []
    }
  ]);

  assert.equal(report.status, "pass_with_drift");
});

function makeThread(items: CodexThread["turns"][number]["items"]): CodexThread {
  return {
    id: "thread_1",
    preview: "preview",
    createdAt: 1711756800,
    updatedAt: 1711756860,
    status: { type: "idle" },
    cwd: "/tmp/canary",
    path: null,
    name: null,
    modelProvider: "openai",
    source: "appServer",
    gitInfo: null,
    turns: [
      {
        id: "turn_1",
        items,
        status: "completed",
        error: null
      }
    ]
  };
}

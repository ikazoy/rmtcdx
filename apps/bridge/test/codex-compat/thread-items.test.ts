import assert from "node:assert/strict";
import test from "node:test";

import type { CodexThreadItem } from "../../src/codex/types";
import { mapThreadItemToMessage } from "../../src/codex/parsers/thread-items";

const createdAt = "2026-03-30T00:00:00.000Z";
const uploads = {
  publicUrlForPath(filePath: string) {
    if (filePath.startsWith("/uploads/")) {
      return `https://example.test${filePath}`;
    }
    return null;
  },
  displayNameForPath(filePath: string) {
    return filePath.split("/").at(-1) ?? "image";
  }
};

test("maps all known thread item kinds used by the catalog", () => {
  const cases: Array<{ name: string; item: CodexThreadItem; expectedKind: string }> = [
    {
      name: "userMessage",
      item: {
        type: "userMessage",
        id: "user_1",
        content: [
          { type: "text", text: "Prompt", text_elements: [] },
          { type: "mention", name: "repo", path: "app://repo" },
          { type: "skill", name: "compat", path: "/skills/compat" },
          { type: "localImage", path: "/uploads/image.png" },
          { type: "image", url: "https://example.test/remote.png" }
        ]
      },
      expectedKind: "user_message"
    },
    {
      name: "agentMessage",
      item: {
        type: "agentMessage",
        id: "assistant_1",
        text: "Answer",
        phase: "final"
      },
      expectedKind: "assistant_message"
    },
    {
      name: "plan",
      item: {
        type: "plan",
        id: "plan_1",
        text: "Plan text"
      },
      expectedKind: "plan"
    },
    {
      name: "reasoning",
      item: {
        type: "reasoning",
        id: "reasoning_1",
        summary: ["Summary"],
        content: ["Details"]
      },
      expectedKind: "reasoning"
    },
    {
      name: "commandExecution",
      item: {
        type: "commandExecution",
        id: "command_1",
        command: "npm test",
        cwd: "/repo",
        status: "completed",
        aggregatedOutput: "ok",
        exitCode: 0
      },
      expectedKind: "command_execution"
    },
    {
      name: "fileChange",
      item: {
        type: "fileChange",
        id: "file_1",
        status: "completed",
        changes: [
          {
            path: "src/app.ts",
            kind: { type: "update", move_path: null },
            diff: "@@"
          }
        ]
      },
      expectedKind: "file_change"
    },
    {
      name: "mcpToolCall",
      item: {
        type: "mcpToolCall",
        id: "mcp_1",
        server: "linear",
        tool: "list_issues",
        status: "completed"
      },
      expectedKind: "mcp_tool_call"
    },
    {
      name: "dynamicToolCall",
      item: {
        type: "dynamicToolCall",
        id: "dynamic_1",
        tool: "search_docs",
        status: "completed"
      },
      expectedKind: "dynamic_tool_call"
    },
    {
      name: "collabAgentToolCall",
      item: {
        type: "collabAgentToolCall",
        id: "agent_1",
        tool: "worker",
        status: "completed",
        prompt: "Investigate"
      },
      expectedKind: "collab_agent_tool_call"
    },
    {
      name: "webSearch",
      item: {
        type: "webSearch",
        id: "search_1",
        query: "Codex compatibility"
      },
      expectedKind: "web_search"
    },
    {
      name: "imageView",
      item: {
        type: "imageView",
        id: "image_view_1",
        path: "/tmp/screenshot.png"
      },
      expectedKind: "image_view"
    },
    {
      name: "imageGeneration",
      item: {
        type: "imageGeneration",
        id: "image_gen_1",
        status: "completed",
        revisedPrompt: "Draw a cat",
        result: "done"
      },
      expectedKind: "image_generation"
    },
    {
      name: "enteredReviewMode",
      item: {
        type: "enteredReviewMode",
        id: "review_on",
        review: "Enabled"
      },
      expectedKind: "review_mode_entered"
    },
    {
      name: "exitedReviewMode",
      item: {
        type: "exitedReviewMode",
        id: "review_off",
        review: "Disabled"
      },
      expectedKind: "review_mode_exited"
    },
    {
      name: "contextCompaction",
      item: {
        type: "contextCompaction",
        id: "compact_1"
      },
      expectedKind: "context_compaction"
    }
  ];

  for (const entry of cases) {
    const message = mapThreadItemToMessage("session_1", entry.item, createdAt, { uploads });
    assert.ok(message, `${entry.name} should map to a message`);
    assert.equal(message.kind, entry.expectedKind);
  }
});

test("unknown item types do not throw and can be observed", () => {
  const unknownItems: CodexThreadItem[] = [];
  const message = mapThreadItemToMessage(
    "session_1",
    {
      type: "futureUnknownType",
      id: "unknown_1"
    },
    createdAt,
    {
      uploads,
      onUnknownItem(item) {
        unknownItems.push(item);
      }
    }
  );

  assert.equal(message, null);
  assert.deepEqual(unknownItems, [
    {
      type: "futureUnknownType",
      id: "unknown_1"
    }
  ]);
});

test("known items with extra fields still map and partial items drop safely", () => {
  const knownWithExtraFields = mapThreadItemToMessage(
    "session_1",
    {
      type: "agentMessage",
      id: "assistant_2",
      text: "Still valid",
      phase: "commentary",
      futureField: true
    } as CodexThreadItem,
    createdAt,
    { uploads }
  );

  const partialItem = mapThreadItemToMessage(
    "session_1",
    {
      type: "agentMessage",
      id: "assistant_3",
      phase: "final"
    } as CodexThreadItem,
    createdAt,
    { uploads }
  );

  assert.ok(knownWithExtraFields);
  assert.equal(knownWithExtraFields.kind, "assistant_thinking");
  assert.equal(partialItem, null);
});

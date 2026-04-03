import assert from "node:assert/strict";
import test from "node:test";

import type { Message } from "@codex-remote/shared-types";
import { collectThreadFileChanges, summarizeThreadFileChanges, summarizeUnifiedDiff } from "./thread-file-changes";

test("summarizeThreadFileChanges collapses duplicate paths and keeps the latest representative", () => {
  const summary = summarizeThreadFileChanges([
    {
      path: "apps/web/src/features/chat/ChatPane.tsx",
      kind: "update",
      diff: "@@ first"
    },
    {
      path: "apps/web/src/features/chat/Other.tsx",
      kind: "add",
      diff: "@@ new"
    },
    {
      path: "apps/web/src/features/chat/ChatPane.tsx",
      kind: "update",
      diff: "@@ latest"
    }
  ]);

  assert.ok(summary);
  assert.equal(summary.count, 2);
  assert.equal(summary.rawCount, 3);
  assert.deepEqual(
    summary.changes.map((change) => ({
      path: change.path,
      firstPath: change.firstPath,
      occurrenceCount: change.occurrenceCount,
      diff: change.diff,
      diffStat: change.diffStat
    })),
    [
      {
        path: "apps/web/src/features/chat/ChatPane.tsx",
        firstPath: "apps/web/src/features/chat/ChatPane.tsx",
        occurrenceCount: 2,
        diff: "@@ latest",
        diffStat: null
      },
      {
        path: "apps/web/src/features/chat/Other.tsx",
        firstPath: "apps/web/src/features/chat/Other.tsx",
        occurrenceCount: 1,
        diff: "@@ new",
        diffStat: null
      }
    ]
  );
});

test("summarizeThreadFileChanges groups a rename under the destination path and preserves the original path", () => {
  const summary = summarizeThreadFileChanges([
    {
      path: "apps/web/src/old-name.ts",
      kind: "update",
      movePath: "apps/web/src/new-name.ts",
      diff: "@@ rename"
    },
    {
      path: "apps/web/src/new-name.ts",
      kind: "update",
      diff: "@@ follow-up"
    }
  ]);

  assert.ok(summary);
  assert.equal(summary.count, 1);
  assert.equal(summary.rawCount, 2);
  assert.equal(summary.changes[0]?.path, "apps/web/src/new-name.ts");
  assert.equal(summary.changes[0]?.kind, "update");
  assert.equal(summary.changes[0]?.movePath, undefined);
  assert.equal(summary.changes[0]?.diff, "@@ follow-up");
  assert.equal(summary.changes[0]?.firstPath, "apps/web/src/old-name.ts");
  assert.equal(summary.changes[0]?.occurrenceCount, 2);
});

test("collectThreadFileChanges only reads file change items from thread messages", () => {
  const messages: Message[] = [
    {
      id: "message-1",
      sessionId: "session-1",
      role: "assistant",
      kind: "assistant_message",
      text: "hello",
      createdAt: "2026-03-31T15:00:00.000Z"
    },
    {
      id: "message-2",
      sessionId: "session-1",
      role: "system",
      kind: "file_change",
      text: "Updated 1 file.",
      createdAt: "2026-03-31T15:00:01.000Z",
      metadata: {
        type: "file_change",
        changes: [
          {
            path: "apps/web/src/features/chat/ChatPane.tsx",
            kind: "update",
            diff: "@@"
          }
        ]
      }
    }
  ];

  const summary = collectThreadFileChanges(messages);

  assert.ok(summary);
  assert.equal(summary.count, 1);
  assert.equal(summary.rawCount, 1);
  assert.equal(summary.changes[0]?.path, "apps/web/src/features/chat/ChatPane.tsx");
});

test("summarizeUnifiedDiff counts additions and deletions from unified diffs", () => {
  assert.deepEqual(
    summarizeUnifiedDiff([
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -1,2 +1,3 @@",
      "-const oldValue = 1;",
      "+const newValue = 2;",
      "+console.log(newValue);",
      " unchanged();"
    ].join("\n")),
    {
      additions: 2,
      deletions: 1
    }
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { resolveFileChangeApprovalDecisions } from "./request-decisions";

test("resolveFileChangeApprovalDecisions falls back to the minimal file change choices", () => {
  assert.deepEqual(resolveFileChangeApprovalDecisions({ availableDecisions: null }), [
    "accept",
    "decline",
    "cancel"
  ]);
});

test("resolveFileChangeApprovalDecisions preserves upstream-provided choices", () => {
  assert.deepEqual(resolveFileChangeApprovalDecisions({ availableDecisions: ["accept", "acceptForSession", "cancel"] }), [
    "accept",
    "acceptForSession",
    "cancel"
  ]);
});

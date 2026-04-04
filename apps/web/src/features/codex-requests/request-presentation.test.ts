import test from "node:test";
import assert from "node:assert/strict";

import type { CodexMcpElicitationRequest } from "@codex-remote/shared-types";

import {
  isConfirmationOnlyMcpSchema,
  presentMcpElicitation,
  requestSubtitle,
  requestTitle,
  toolNameFromMcpMessage
} from "./request-presentation";

type CodexMcpFormElicitationRequest = Extract<CodexMcpElicitationRequest, { mode: "form" }>;

function baseMcpRequest(
  overrides: Partial<CodexMcpFormElicitationRequest> = {}
): CodexMcpFormElicitationRequest {
  return {
    type: "mcp_elicitation",
    id: "request_1",
    sessionId: "session_1",
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: null,
    createdAt: "2026-04-04T12:00:00.000Z",
    mode: "form",
    serverName: "chrome-devtools",
    message: 'Allow the chrome-devtools MCP server to run tool "browser_navigate"?',
    meta: null,
    requestedSchema: {
      type: "object",
      properties: {}
    },
    ...overrides
  };
}

test("toolNameFromMcpMessage extracts quoted tool names", () => {
  assert.equal(toolNameFromMcpMessage('Allow the MCP server to run tool "browser_navigate"?'), "browser_navigate");
  assert.equal(toolNameFromMcpMessage("No tool is mentioned here."), null);
});

test("isConfirmationOnlyMcpSchema detects empty object forms", () => {
  assert.equal(isConfirmationOnlyMcpSchema({ type: "object", properties: {} }), true);
  assert.equal(isConfirmationOnlyMcpSchema({ type: "object", properties: { url: { type: "string" } } }), false);
  assert.equal(isConfirmationOnlyMcpSchema({ type: "object", required: ["url"] }), false);
});

test("presentMcpElicitation summarizes confirmation-only tool approvals", () => {
  const request = baseMcpRequest();

  assert.deepEqual(presentMcpElicitation(request), {
    toolName: "browser_navigate",
    requiresResponseJson: false,
    title: "Tool approval required",
    subtitle: "chrome-devtools wants to run browser_navigate",
    primaryActionLabel: "Allow",
    confirmationCopy: "No additional input is required. Allow this MCP request if it looks correct."
  });
});

test("request title and subtitle use MCP presentation details", () => {
  const request = baseMcpRequest();

  assert.equal(requestTitle(request), "Tool approval required");
  assert.equal(requestSubtitle(request), "chrome-devtools wants to run browser_navigate");
});

test("presentMcpElicitation keeps structured forms explicit", () => {
  const request = baseMcpRequest({
    serverName: "github",
    message: "Fill out the repository details.",
    requestedSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" }
      },
      required: ["owner", "repo"]
    }
  });

  assert.deepEqual(presentMcpElicitation(request), {
    toolName: null,
    requiresResponseJson: true,
    title: "MCP confirmation required",
    subtitle: "github",
    primaryActionLabel: "Submit response",
    confirmationCopy: null
  });
});

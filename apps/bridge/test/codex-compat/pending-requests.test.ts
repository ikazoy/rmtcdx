import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import type { CodexPendingRequestResponse } from "@codex-remote/shared-types";
import {
  parsePendingServerRequest,
  resultForPendingRequestResponse
} from "../../src/codex/parsers/pending-requests";

const fixturesDir = new URL("./fixtures/codex-cli-0.116.0/", import.meta.url);
const createdAt = "2026-03-30T20:00:00.000Z";
const sessionIdForRequest = (threadId: string, turnId: string | null) =>
  turnId ? `${threadId}:${turnId}` : threadId;

type ParseCase = {
  name: string;
  requestId: number | string;
  method: string;
  params: unknown;
  expected: unknown;
};

type ResponseCase = {
  name: string;
  request: {
    requestId: number | string;
    method: string;
    params: unknown;
  };
  response: CodexPendingRequestResponse;
  expected: unknown;
};

type NullCase = {
  name: string;
  requestId: number | string;
  method: string;
  params: unknown;
};

type PendingRequestFixtures = {
  parseCases: ParseCase[];
  responseCases: ResponseCase[];
  nullCases: NullCase[];
  unsupportedResponseCase: {
    request: {
      requestId: number | string;
      method: string;
      params: unknown;
    };
    response: CodexPendingRequestResponse;
  };
};

test("parses supported server request payloads into pending request models", async () => {
  const fixtures = await readFixtures();

  for (const entry of fixtures.parseCases) {
    const parsed = parsePendingServerRequest({
      requestId: entry.requestId,
      method: entry.method,
      createdAt,
      sessionIdForRequest,
      params: entry.params
    });

    assert.deepEqual(parsed, entry.expected, entry.name);
  }
});

test("maps pending request responses back to server payloads and rejects unsupported combinations", async () => {
  const fixtures = await readFixtures();

  for (const entry of fixtures.responseCases) {
    const parsed = parsePendingServerRequest({
      requestId: entry.request.requestId,
      method: entry.request.method,
      createdAt,
      sessionIdForRequest,
      params: entry.request.params
    });

    assert.ok(parsed, `${entry.name} should parse before response mapping`);
    assert.deepEqual(resultForPendingRequestResponse(parsed, entry.response), entry.expected, entry.name);
  }

  const unsupported = parsePendingServerRequest({
    requestId: fixtures.unsupportedResponseCase.request.requestId,
    method: fixtures.unsupportedResponseCase.request.method,
    createdAt,
    sessionIdForRequest,
    params: fixtures.unsupportedResponseCase.request.params
  });

  assert.ok(unsupported, "unsupported response case should still parse the request");
  assert.throws(
    () => resultForPendingRequestResponse(unsupported, fixtures.unsupportedResponseCase.response),
    /Unsupported Codex request response/
  );
});

test("returns null for incomplete or unknown server request payloads", async () => {
  const fixtures = await readFixtures();

  for (const entry of fixtures.nullCases) {
    const parsed = parsePendingServerRequest({
      requestId: entry.requestId,
      method: entry.method,
      createdAt,
      sessionIdForRequest,
      params: entry.params
    });

    assert.equal(parsed, null, entry.name);
  }
});

async function readFixtures(): Promise<PendingRequestFixtures> {
  return JSON.parse(
    await fs.readFile(new URL("pending-server-requests.json", fixturesDir), "utf8")
  ) as PendingRequestFixtures;
}

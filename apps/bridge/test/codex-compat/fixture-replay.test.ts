import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import test from "node:test";

import { LiveCatalogService } from "../../src/catalog/live-catalog-service";
import { parseBridgeNotification } from "../../src/codex/parsers/bridge-events";
import type {
  CodexAccountRateLimits,
  CodexBackend,
  CodexRuntimeState,
  CodexThread,
  EnsureThreadParams,
  ListThreadsParams,
  SimulatePendingRequestParams,
  StartRunParams,
  StartRunResult
} from "../../src/codex/types";
import { ImageUploadService } from "../../src/uploads/image-upload-service";
import type { CodexAvailableModel, CodexPendingRequest, CodexPendingRequestResponse } from "@codex-remote/shared-types";

const fixturesDir = new URL("./fixtures/codex-cli-0.116.0/", import.meta.url);
const realCanaryFixturesDir = new URL("./fixtures/codex-cli-0.116.0/real-canary/", import.meta.url);
const uploads = new ImageUploadService("/tmp/compat-uploads", "/uploads/", 5, 10_485_760);

test("fixture thread/read payloads still produce session details and message lists", async () => {
  const basicThread = await readThreadFixture("thread-read-basic.json");
  const toolsThread = await readThreadFixture("thread-read-tools.json");
  const reasoningThread = await readThreadFixture("thread-read-reasoning.json");
  const unknownThread = await readThreadFixture("thread-read-unknown-item.json");

  const backend = new FixtureCodexBackend([basicThread, toolsThread, reasoningThread, unknownThread]);
  const catalog = new LiveCatalogService(
    backend,
    [
      {
        id: "fixture_repo",
        path: "/fixtures/repo",
        name: "Fixture Repo",
        pinned: false
      }
    ],
    uploads
  );

  const basicDetail = await catalog.getSessionDetail(basicThread.id);
  const basicMessages = await catalog.listMessages(basicThread.id);
  const toolsMessages = await catalog.listMessages(toolsThread.id);
  const reasoningMessages = await catalog.listMessages(reasoningThread.id);
  const unknownMessages = await catalog.listMessages(unknownThread.id);

  assert.equal(basicDetail.session.title, "Ask Codex to summarize this repo");
  assert.equal(basicDetail.session.status, "completed");
  assert.deepEqual(
    basicMessages.map((message) => ({ kind: message.kind, role: message.role })),
    [
      { kind: "user_message", role: "user" },
      { kind: "assistant_message", role: "assistant" }
    ]
  );
  assert.deepEqual(
    toolsMessages.map((message) => message.kind),
    [
      "user_message",
      "command_execution",
      "file_change",
      "mcp_tool_call",
      "dynamic_tool_call",
      "collab_agent_tool_call",
      "web_search",
      "image_view",
      "image_generation",
      "review_mode_entered",
      "review_mode_exited",
      "context_compaction",
      "assistant_message"
    ]
  );
  assert.deepEqual(
    reasoningMessages.map((message) => message.kind),
    ["user_message", "plan", "reasoning", "assistant_message"]
  );
  assert.deepEqual(
    unknownMessages.map((message) => message.kind),
    ["user_message", "assistant_message"]
  );
});

test("notification fixtures replay into the expected event stream", async () => {
  const notifications = await readNotificationFixture("notifications-basic.jsonl");
  const runByTurn = new Map([
    [
      "turn_fixture_1",
      {
        sessionId: "thread_basic",
        runId: "run_fixture_1"
      }
    ]
  ]);

  const parsed = notifications.map((notification) =>
    parseBridgeNotification(notification.method, notification.params, runByTurn)
  );
  const events = parsed.flatMap((entry) => entry.events);
  const debugEntries = parsed.flatMap((entry) => entry.debugEntries);

  assert.deepEqual(events.map((event) => event.type), [
    "message.delta",
    "activity.started",
    "tool.start",
    "activity.updated",
    "message.final",
    "run.completed"
  ]);
  assert.deepEqual(debugEntries, [
    {
      event: "notification.unhandled",
      fields: {
        method: "item/futureUnknownType",
        params: {
          turnId: "turn_fixture_1",
          item: {
            id: "unknown_item_1",
            type: "futureUnknownType"
          }
        }
      }
    }
  ]);
});

test("sanitized real-canary fixtures still replay into catalog and bridge event views", async () => {
  const basicThread = await readRealCanaryThreadFixture("thread-read-basic.json");
  const toolEditThread = await readRealCanaryThreadFixture("thread-read-tool-edit.json");

  const backend = new FixtureCodexBackend([basicThread, toolEditThread]);
  const catalog = new LiveCatalogService(
    backend,
    [
      {
        id: "fixture_repo",
        path: "/fixtures/repo",
        name: "Fixture Repo",
        pinned: false
      }
    ],
    uploads
  );

  const basicMessages = await catalog.listMessages(basicThread.id);
  const toolEditMessages = await catalog.listMessages(toolEditThread.id);
  const toolEditEvents = await readBridgeEventFixture("bridge-events-tool-edit.jsonl");

  assert.equal(basicThread.cwd, "/fixtures/workspaces/basic-text");
  assert.equal(toolEditThread.cwd, "/fixtures/workspaces/tool-edit");
  assert.equal(toolEditThread.path, "/fixtures/codex/sessions/tool-edit.jsonl");
  assert.deepEqual(
    basicMessages.map((message) => ({ kind: message.kind, role: message.role })),
    [
      { kind: "user_message", role: "user" },
      { kind: "assistant_message", role: "assistant" }
    ]
  );
  assert.deepEqual(
    toolEditMessages.map((message) => message.kind),
    [
      "user_message",
      "assistant_thinking",
      "command_execution",
      "assistant_thinking",
      "file_change",
      "command_execution",
      "assistant_message"
    ]
  );
  assert.ok(toolEditEvents.some((event) => event.type === "activity.updated"));
  assert.ok(toolEditEvents.some((event) => event.type === "run.completed"));
  assert.ok(toolEditEvents.some((event) => event.type === "message.final"));
});

class FixtureCodexBackend extends EventEmitter implements CodexBackend {
  private readonly threads = new Map<string, CodexThread>();

  constructor(threads: CodexThread[]) {
    super();
    for (const thread of threads) {
      this.threads.set(thread.id, thread);
    }
  }

  async start() {}

  async stop() {}

  async createThread(_cwd: string): Promise<{ threadId: string }> {
    throw new Error("Not implemented in fixture backend");
  }

  async listThreads(params?: ListThreadsParams) {
    const archived = params?.archived ?? false;
    return archived ? [] : [...this.threads.values()];
  }

  async readThread(threadId: string, _options?: { includeTurns?: boolean }) {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`Unknown fixture thread: ${threadId}`);
    }
    return thread;
  }

  async listModels(): Promise<CodexAvailableModel[]> {
    return [];
  }

  async readAccountRateLimits(): Promise<CodexAccountRateLimits | null> {
    return null;
  }

  async setThreadName(_threadId: string, _name: string) {
    throw new Error("Not implemented in fixture backend");
  }

  async archiveThread(_threadId: string) {
    throw new Error("Not implemented in fixture backend");
  }

  async unarchiveThread(_threadId: string) {
    throw new Error("Not implemented in fixture backend");
  }

  async ensureThread(params: EnsureThreadParams) {
    return { threadId: params.threadId ?? "fixture_thread" };
  }

  async startRun(_params: StartRunParams): Promise<StartRunResult> {
    throw new Error("Not implemented in fixture backend");
  }

  async interruptRun(_runId: string, _threadId: string, _turnId: string) {
    throw new Error("Not implemented in fixture backend");
  }

  listPendingRequests(_sessionId?: string): CodexPendingRequest[] {
    return [];
  }

  async respondToRequest(
    _requestId: string,
    _response: CodexPendingRequestResponse
  ): Promise<CodexPendingRequest | null> {
    return null;
  }

  async simulatePendingRequest(_params: SimulatePendingRequestParams): Promise<CodexPendingRequest> {
    throw new Error("Not implemented in fixture backend");
  }

  getState(): CodexRuntimeState {
    return {
      mode: "mock",
      ready: true,
      childAlive: false,
      restarts: 0
    };
  }
}

async function readThreadFixture(fileName: string) {
  const payload = JSON.parse(await fs.readFile(new URL(fileName, fixturesDir), "utf8")) as { thread: CodexThread };
  return payload.thread;
}

async function readRealCanaryThreadFixture(fileName: string) {
  const payload = JSON.parse(await fs.readFile(new URL(fileName, realCanaryFixturesDir), "utf8")) as {
    thread: CodexThread;
  };
  return payload.thread;
}

async function readNotificationFixture(fileName: string) {
  const contents = await fs.readFile(new URL(fileName, fixturesDir), "utf8");
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; params: unknown });
}

async function readBridgeEventFixture(fileName: string) {
  const contents = await fs.readFile(new URL(fileName, realCanaryFixturesDir), "utf8");
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string });
}

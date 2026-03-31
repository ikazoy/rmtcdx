import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  CodexAvailableModel,
  CodexPendingRequest,
  CodexPendingRequestResponse,
  ServerWsEvent
} from "@codex-remote/shared-types";
import { buildApp } from "../../src/app";
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
import type { AppConfig } from "../../src/config/env";

test("fixture backend smoke test covers sessions, messages, and pending request websocket events", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-smoke-"));
  const repoPath = path.join(rootDir, "repo");
  const dataDir = path.join(rootDir, "data");
  const uploadsDir = path.join(dataDir, "uploads");
  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(uploadsDir, { recursive: true });

  const thread: CodexThread = {
    id: "fixture_thread_request",
    preview: "Review pending request support",
    createdAt: 1711756800,
    updatedAt: 1711756860,
    status: { type: "idle" },
    cwd: repoPath,
    path: null,
    name: null,
    modelProvider: "openai",
    source: "appServer",
    gitInfo: {
      sha: "abc123",
      branch: "main",
      originUrl: "https://example.test/repo.git"
    },
    turns: [
      {
        id: "fixture_turn_request_1",
        status: "completed",
        error: null,
        items: [
          {
            type: "userMessage",
            id: "fixture_user_1",
            content: [
              {
                type: "text",
                text: "Review pending request support",
                text_elements: []
              }
            ]
          },
          {
            type: "agentMessage",
            id: "fixture_assistant_1",
            text: "Pending request support is available.",
            phase: "final"
          }
        ]
      }
    ]
  };

  const backend = new FixtureBridgeBackend([thread]);
  const config: AppConfig = {
    port: 0,
    host: "127.0.0.1",
    reposFile: path.join(rootDir, "repos.json"),
    dataDir,
    stateFile: path.join(dataDir, "state.json"),
    runtimeFile: path.join(dataDir, "runtime.json"),
    codexDebugLogFile: path.join(dataDir, "codex-app-server.jsonl"),
    uploadsDir,
    webDistDir: path.join(rootDir, "missing-web-dist"),
    codexMode: "mock",
    maxPromptLength: 12_000,
    maxImageAttachments: 5,
    maxImageAttachmentBytes: 10_485_760,
    devSimulatorEnabled: true
  };

  const { app, realtime } = await buildApp({
    config,
    codex: backend,
    repoConfig: [
      {
        id: "fixture_repo",
        name: "Fixture Repo",
        path: repoPath,
        pinned: false
      }
    ]
  });

  const wsEvents = createWebSocketCollector();
  try {
    realtime.register(wsEvents.socket, backend.getState().mode);
    await wsEvents.waitFor((event) => event.type === "hello");

    const sessionsResponse = await app.inject({
      method: "GET",
      url: "/api/sessions"
    });
    assert.equal(sessionsResponse.statusCode, 200);
    const sessionsPayload = sessionsResponse.json() as {
      sessions: Array<{ id: string; title: string; repoId: string; status: string; threadStatusType?: string }>;
    };
    assert.equal(sessionsPayload.sessions.length, 1);
    assert.deepEqual(
      sessionsPayload.sessions.map((session) => ({
        id: session.id,
        title: session.title,
        repoId: session.repoId,
        status: session.status,
        threadStatusType: session.threadStatusType
      })),
      [
        {
          id: "fixture_thread_request",
          title: "Review pending request support",
          repoId: "fixture_repo",
          status: "completed",
          threadStatusType: "idle"
        }
      ]
    );

    const messagesResponse = await app.inject({
      method: "GET",
      url: "/api/sessions/fixture_thread_request/messages"
    });
    assert.equal(messagesResponse.statusCode, 200);
    const messagesPayload = messagesResponse.json() as {
      messages: Array<{ kind: string; role: string }>;
    };
    assert.deepEqual(
      messagesPayload.messages.map((message) => ({ kind: message.kind, role: message.role })),
      [
        { kind: "user_message", role: "user" },
        { kind: "assistant_message", role: "assistant" }
      ]
    );

    const createRequestResponse = await app.inject({
      method: "POST",
      url: "/api/dev/sessions/fixture_thread_request/codex/requests",
      payload: {
        scenario: "command_approval"
      }
    });
    assert.equal(createRequestResponse.statusCode, 200);
    const createRequestPayload = createRequestResponse.json() as { request: CodexPendingRequest };
    assert.equal(createRequestPayload.request.type, "command_approval");

    const pendingRequestsResponse = await app.inject({
      method: "GET",
      url: "/api/sessions/fixture_thread_request/codex/requests"
    });
    assert.equal(pendingRequestsResponse.statusCode, 200);
    const pendingRequestsPayload = pendingRequestsResponse.json() as { requests: CodexPendingRequest[] };
    assert.equal(pendingRequestsPayload.requests.length, 1);
    assert.equal(pendingRequestsPayload.requests[0]?.id, createRequestPayload.request.id);

    const createdEvent = await wsEvents.waitFor(
      (event): event is Extract<ServerWsEvent, { type: "codex.request.created" }> =>
        event.type === "codex.request.created" && event.request.id === createRequestPayload.request.id
    );
    assert.equal(createdEvent.sessionId, "fixture_thread_request");
    assert.equal(createdEvent.request.type, "command_approval");

    const resolveRequestResponse = await app.inject({
      method: "POST",
      url: `/api/codex/requests/${createRequestPayload.request.id}/respond`,
      payload: {
        type: "command_approval",
        decision: "accept"
      } satisfies CodexPendingRequestResponse
    });
    assert.equal(resolveRequestResponse.statusCode, 200);

    const resolvedEvent = await wsEvents.waitFor(
      (event): event is Extract<ServerWsEvent, { type: "codex.request.resolved" }> =>
        event.type === "codex.request.resolved" && event.requestId === createRequestPayload.request.id
    );
    assert.equal(resolvedEvent.sessionId, "fixture_thread_request");
  } finally {
    wsEvents.socket.emit("close");
    await app.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

class FixtureBridgeBackend extends EventEmitter implements CodexBackend {
  private readonly threads = new Map<string, CodexThread>();
  private readonly pendingRequests = new Map<string, CodexPendingRequest>();

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

  listPendingRequests(sessionId?: string): CodexPendingRequest[] {
    return [...this.pendingRequests.values()].filter((request) => (sessionId ? request.sessionId === sessionId : true));
  }

  async respondToRequest(requestId: string, _response: CodexPendingRequestResponse): Promise<CodexPendingRequest | null> {
    const request = this.pendingRequests.get(requestId) ?? null;
    if (!request) {
      return null;
    }

    this.pendingRequests.delete(requestId);
    this.emit("event", {
      type: "request.resolved",
      sessionId: request.sessionId,
      requestId
    });
    return request;
  }

  async simulatePendingRequest(params: SimulatePendingRequestParams): Promise<CodexPendingRequest> {
    const request: CodexPendingRequest = {
      type: "command_approval",
      id: `fixture_req_${randomUUID()}`,
      sessionId: params.sessionId,
      threadId: params.threadId,
      turnId: null,
      itemId: null,
      createdAt: new Date().toISOString(),
      approvalId: null,
      reason: "Simulated command approval for bridge smoke test.",
      networkApprovalContext: null,
      command: "npm test",
      cwd: params.cwd,
      commandActions: null,
      requestedPermissions: null,
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"]
    };
    this.pendingRequests.set(request.id, request);
    this.emit("event", {
      type: "request.created",
      sessionId: request.sessionId,
      request
    });
    return request;
  }

  getState(): CodexRuntimeState {
    return {
      mode: "real",
      ready: true,
      childAlive: false,
      restarts: 0
    };
  }
}

class FixtureSocket extends EventEmitter {
  readonly readyState = 1;

  send(payload: string) {
    const event = JSON.parse(payload) as ServerWsEvent;
    this.emit("sent", event);
  }
}

function createWebSocketCollector() {
  const socket = new FixtureSocket();
  const events: ServerWsEvent[] = [];
  const waiters = new Set<{
    predicate: (event: ServerWsEvent) => boolean;
    resolve: (event: ServerWsEvent) => void;
  }>();

  socket.on("sent", (event: ServerWsEvent) => {
    events.push(event);

    for (const waiter of [...waiters]) {
      if (!waiter.predicate(event)) {
        continue;
      }
      waiters.delete(waiter);
      waiter.resolve(event);
    }
  });

  return {
    socket,
    events,
    waitFor<TEvent extends ServerWsEvent>(predicate: (event: ServerWsEvent) => event is TEvent, timeoutMs = 5_000) {
      const existing = events.find(predicate);
      if (existing) {
        return Promise.resolve(existing);
      }

      return new Promise<TEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for WebSocket event after ${timeoutMs}ms`));
        }, timeoutMs);

        const waiter = {
          predicate: (event: ServerWsEvent) => {
            if (!predicate(event)) {
              return false;
            }
            clearTimeout(timer);
            resolve(event);
            return true;
          },
          resolve: (_event: ServerWsEvent) => {}
        };

        waiters.add(waiter);
      });
    }
  };
}

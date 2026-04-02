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
  CodexBridgeEvent,
  CodexFileMetadata,
  CodexFileReadResult,
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

  const backend = new FixtureBridgeBackend([thread], {
    syncThreadStateFromRunEvents: true
  });
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

test("bridge smoke test tracks unread from live completion events and clears it on read", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-unread-"));
  const repoPath = path.join(rootDir, "repo");
  const dataDir = path.join(rootDir, "data");
  const uploadsDir = path.join(dataDir, "uploads");
  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(uploadsDir, { recursive: true });

  const thread: CodexThread = {
    id: "fixture_thread_unread",
    preview: "Unread fixture",
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
        id: "fixture_turn_unread_1",
        status: "completed",
        error: null,
        items: [
          {
            type: "userMessage",
            id: "fixture_user_unread_1",
            content: [
              {
                type: "text",
                text: "Unread fixture",
                text_elements: []
              }
            ]
          },
          {
            type: "agentMessage",
            id: "fixture_assistant_unread_1",
            text: "Already completed before app start.",
            phase: "final"
          }
        ]
      }
    ]
  };

  const backend = new FixtureBridgeBackend([thread], {
    syncThreadStateFromRunEvents: true
  });
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

    const initialSessions = await app.inject({
      method: "GET",
      url: "/api/sessions"
    });
    assert.equal(initialSessions.statusCode, 200);
    const initialPayload = initialSessions.json() as {
      sessions: Array<{ id: string; unreadCount: number; hasUnreadCompletion: boolean }>;
    };
    assert.equal(initialPayload.sessions[0]?.id, "fixture_thread_unread");
    assert.equal(initialPayload.sessions[0]?.unreadCount, 0);
    assert.equal(initialPayload.sessions[0]?.hasUnreadCompletion, false);

    const startRunResponse = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: {
        sessionId: "fixture_thread_unread",
        prompt: "Generate a fresh unread completion"
      }
    });
    assert.equal(startRunResponse.statusCode, 200);
    const startRunPayload = startRunResponse.json() as {
      run: { id: string; turnId?: string };
    };

    backend.emit("event", {
      type: "message.final",
      sessionId: "fixture_thread_unread",
      runId: startRunPayload.run.id,
      turnId: startRunPayload.run.turnId ?? "fixture_turn_unread_2",
      text: "Fresh unread completion",
      countsUnread: true
    } satisfies CodexBridgeEvent);
    backend.emit("event", {
      type: "run.completed",
      sessionId: "fixture_thread_unread",
      runId: startRunPayload.run.id,
      turnId: startRunPayload.run.turnId ?? "fixture_turn_unread_2"
    } satisfies CodexBridgeEvent);
    await flushAsyncWork();

    const unreadSessions = await app.inject({
      method: "GET",
      url: "/api/sessions"
    });
    assert.equal(unreadSessions.statusCode, 200);
    const unreadPayload = unreadSessions.json() as {
      sessions: Array<{
        id: string;
        unreadCount: number;
        lastEventSeq: number;
        lastReadEventSeq: number;
        hasUnreadCompletion: boolean;
        hasUnreadError: boolean;
      }>;
    };
    assert.equal(unreadPayload.sessions[0]?.id, "fixture_thread_unread");
    assert.equal(unreadPayload.sessions[0]?.unreadCount, 1);
    assert.equal(unreadPayload.sessions[0]?.lastEventSeq, 1);
    assert.equal(unreadPayload.sessions[0]?.lastReadEventSeq, 0);
    assert.equal(unreadPayload.sessions[0]?.hasUnreadCompletion, true);
    assert.equal(unreadPayload.sessions[0]?.hasUnreadError, false);

    const unreadFilteredSessions = await app.inject({
      method: "GET",
      url: "/api/sessions?filter=unread"
    });
    assert.equal(unreadFilteredSessions.statusCode, 200);
    const unreadFilteredPayload = unreadFilteredSessions.json() as {
      sessions: Array<{ id: string }>;
    };
    assert.deepEqual(
      unreadFilteredPayload.sessions.map((session) => session.id),
      ["fixture_thread_unread"]
    );

    const readResponse = await app.inject({
      method: "POST",
      url: "/api/sessions/fixture_thread_unread/read"
    });
    assert.equal(readResponse.statusCode, 200);

    const sessionUpdated = await wsEvents.waitFor(
      (event): event is Extract<ServerWsEvent, { type: "sessions.updated" }> =>
        event.type === "sessions.updated" && event.session.id === "fixture_thread_unread"
    );
    assert.equal(sessionUpdated.session.unreadCount, 0);
    assert.equal(sessionUpdated.session.lastEventSeq, 1);
    assert.equal(sessionUpdated.session.lastReadEventSeq, 1);

    const readSessions = await app.inject({
      method: "GET",
      url: "/api/sessions"
    });
    assert.equal(readSessions.statusCode, 200);
    const readPayload = readSessions.json() as {
      sessions: Array<{ id: string; unreadCount: number; lastEventSeq: number; lastReadEventSeq: number }>;
    };
    assert.equal(readPayload.sessions[0]?.id, "fixture_thread_unread");
    assert.equal(readPayload.sessions[0]?.unreadCount, 0);
    assert.equal(readPayload.sessions[0]?.lastEventSeq, 1);
    assert.equal(readPayload.sessions[0]?.lastReadEventSeq, 1);

    const readFilteredSessions = await app.inject({
      method: "GET",
      url: "/api/sessions?filter=unread"
    });
    assert.equal(readFilteredSessions.statusCode, 200);
    const readFilteredPayload = readFilteredSessions.json() as {
      sessions: Array<{ id: string }>;
    };
    assert.equal(readFilteredPayload.sessions.length, 0);
  } finally {
    wsEvents.socket.emit("close");
    await app.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("bridge smoke test applies filters to presented unread and run state", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-filter-state-"));
  const repoPath = path.join(rootDir, "repo");
  const dataDir = path.join(rootDir, "data");
  const uploadsDir = path.join(dataDir, "uploads");
  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(uploadsDir, { recursive: true });

  const thread: CodexThread = {
    id: "fixture_thread_filters",
    preview: "",
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
    turns: []
  };

  const backend = new FixtureBridgeBackend([thread], {
    syncThreadStateFromRunEvents: true
  });
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

  const { app } = await buildApp({
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

  async function filteredSessionIds(filter: "unread" | "running" | "completed" | "interrupted" | "error") {
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions?filter=${filter}`
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json() as {
      sessions: Array<{ id: string }>;
    };
    return payload.sessions.map((session) => session.id);
  }

  try {
    assert.deepEqual(await filteredSessionIds("unread"), []);
    assert.deepEqual(await filteredSessionIds("running"), []);
    assert.deepEqual(await filteredSessionIds("completed"), []);
    assert.deepEqual(await filteredSessionIds("interrupted"), []);
    assert.deepEqual(await filteredSessionIds("error"), []);

    const runningRun = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: {
        sessionId: "fixture_thread_filters",
        prompt: "Make this look running"
      }
    });
    assert.equal(runningRun.statusCode, 200);
    const runningPayload = runningRun.json() as {
      run: { id: string; turnId?: string };
    };
    assert.deepEqual(await filteredSessionIds("running"), ["fixture_thread_filters"]);

    backend.emit("event", {
      type: "message.final",
      sessionId: "fixture_thread_filters",
      runId: runningPayload.run.id,
      turnId: runningPayload.run.turnId ?? "fixture_turn_filters_1",
      text: "Completed with unread output",
      countsUnread: true
    } satisfies CodexBridgeEvent);
    backend.emit("event", {
      type: "run.completed",
      sessionId: "fixture_thread_filters",
      runId: runningPayload.run.id,
      turnId: runningPayload.run.turnId ?? "fixture_turn_filters_1"
    } satisfies CodexBridgeEvent);
    await flushAsyncWork();

    assert.deepEqual(await filteredSessionIds("unread"), ["fixture_thread_filters"]);
    assert.deepEqual(await filteredSessionIds("completed"), ["fixture_thread_filters"]);

    const interruptedRun = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: {
        sessionId: "fixture_thread_filters",
        prompt: "Now interrupt it"
      }
    });
    assert.equal(interruptedRun.statusCode, 200);
    const interruptedPayload = interruptedRun.json() as {
      run: { id: string; turnId?: string };
    };

    backend.emit("event", {
      type: "run.interrupted",
      sessionId: "fixture_thread_filters",
      runId: interruptedPayload.run.id,
      turnId: interruptedPayload.run.turnId ?? "fixture_turn_filters_2"
    } satisfies CodexBridgeEvent);
    await flushAsyncWork();

    assert.deepEqual(await filteredSessionIds("interrupted"), ["fixture_thread_filters"]);

    const errorRun = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: {
        sessionId: "fixture_thread_filters",
        prompt: "Now fail it"
      }
    });
    assert.equal(errorRun.statusCode, 200);
    const errorPayload = errorRun.json() as {
      run: { id: string; turnId?: string };
    };

    backend.emit("event", {
      type: "run.error",
      sessionId: "fixture_thread_filters",
      runId: errorPayload.run.id,
      turnId: errorPayload.run.turnId ?? "fixture_turn_filters_3",
      message: "Simulated failure"
    } satisfies CodexBridgeEvent);
    await flushAsyncWork();

    assert.deepEqual(await filteredSessionIds("error"), ["fixture_thread_filters"]);
  } finally {
    await app.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("bridge smoke test previews session files from the current workspace", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-preview-"));
  const repoPath = path.join(rootDir, "repo");
  const docsPath = path.join(repoPath, "docs");
  const dataDir = path.join(rootDir, "data");
  const uploadsDir = path.join(dataDir, "uploads");
  const previewFilePath = path.join(docsPath, "preview.md");
  const previewDiff = ["@@ -0,0 +1,3 @@", "+# Preview file", "+", "+This markdown file is available."].join("\n");
  await fs.mkdir(docsPath, { recursive: true });
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.writeFile(previewFilePath, "# Preview file\n\nThis markdown file is available.\n", "utf8");
  const expectedResolvedPath = await fs.realpath(previewFilePath).catch(() => previewFilePath);

  const thread: CodexThread = {
    id: "fixture_thread_preview",
    preview: "Preview file support",
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
    turns: []
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

  const { app } = await buildApp({
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

  try {
    const previewResponse = await app.inject({
      method: "POST",
      url: "/api/sessions/fixture_thread_preview/files/preview",
      payload: {
        path: "docs/preview.md",
        diff: previewDiff,
        changeKind: "add"
      }
    });
    assert.equal(previewResponse.statusCode, 200);
    const previewPayload = previewResponse.json() as {
      path: string;
      resolvedPath: string | null;
      contentStatus: string;
      isMarkdown: boolean;
      text: string | null;
      imageDataUrl: string | null;
      diff: string | null;
      sizeBytes: number | null;
    };
    assert.equal(previewPayload.path, "docs/preview.md");
    assert.equal(previewPayload.resolvedPath, expectedResolvedPath);
    assert.equal(previewPayload.contentStatus, "ok");
    assert.equal(previewPayload.isMarkdown, true);
    assert.match(previewPayload.text ?? "", /# Preview file/);
    assert.equal(previewPayload.imageDataUrl, null);
    assert.equal(previewPayload.diff, previewDiff);
    assert.ok((previewPayload.sizeBytes ?? 0) > 0);

    const outsideResponse = await app.inject({
      method: "POST",
      url: "/api/sessions/fixture_thread_preview/files/preview",
      payload: {
        path: path.join(rootDir, "outside.md")
      }
    });
    assert.equal(outsideResponse.statusCode, 400);
  } finally {
    await app.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("bridge smoke test previews png files as images", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-preview-image-"));
  const repoPath = path.join(rootDir, "repo");
  const assetsPath = path.join(repoPath, "assets");
  const dataDir = path.join(rootDir, "data");
  const uploadsDir = path.join(dataDir, "uploads");
  const previewFilePath = path.join(assetsPath, "preview.png");
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFz8AAAAASUVORK5CYII=";
  await fs.mkdir(assetsPath, { recursive: true });
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.writeFile(previewFilePath, Buffer.from(pngBase64, "base64"));
  const expectedResolvedPath = await fs.realpath(previewFilePath).catch(() => previewFilePath);

  const thread: CodexThread = {
    id: "fixture_thread_preview_image",
    preview: "Preview image support",
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
    turns: []
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

  const { app } = await buildApp({
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

  try {
    const previewResponse = await app.inject({
      method: "POST",
      url: "/api/sessions/fixture_thread_preview_image/files/preview",
      payload: {
        path: "assets/preview.png",
        diff: "Binary files differ",
        changeKind: "add"
      }
    });
    assert.equal(previewResponse.statusCode, 200);
    const previewPayload = previewResponse.json() as {
      path: string;
      resolvedPath: string | null;
      contentStatus: string;
      mediaType: string | null;
      isMarkdown: boolean;
      text: string | null;
      imageDataUrl: string | null;
      diff: string | null;
      sizeBytes: number | null;
    };
    assert.equal(previewPayload.path, "assets/preview.png");
    assert.equal(previewPayload.resolvedPath, expectedResolvedPath);
    assert.equal(previewPayload.contentStatus, "ok");
    assert.equal(previewPayload.mediaType, "image/png");
    assert.equal(previewPayload.isMarkdown, false);
    assert.equal(previewPayload.text, null);
    assert.match(previewPayload.imageDataUrl ?? "", /^data:image\/png;base64,/);
    assert.equal(previewPayload.diff, "Binary files differ");
    assert.ok((previewPayload.sizeBytes ?? 0) > 0);
  } finally {
    await app.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("bridge smoke test previews utf-8 markdown when multibyte characters cross the old sample boundary", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-preview-ja-"));
  const repoPath = path.join(rootDir, "repo");
  const dataDir = path.join(rootDir, "data");
  const uploadsDir = path.join(dataDir, "uploads");
  const previewFilePath = path.join(repoPath, "README.ja.md");
  let prefix = "# UTF-8 boundary regression\n\n";
  while (Buffer.byteLength(prefix, "utf8") % 3 !== 0) {
    prefix += "x";
  }
  const body = "あ".repeat(4_000);
  const previewContent = `${prefix}${body}\n`;
  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.writeFile(previewFilePath, previewContent, "utf8");
  const expectedResolvedPath = await fs.realpath(previewFilePath).catch(() => previewFilePath);

  assert.ok(Buffer.byteLength(previewContent, "utf8") > 8_192);
  assert.equal(Buffer.byteLength(prefix, "utf8") % 3, 0);

  const thread: CodexThread = {
    id: "fixture_thread_preview_ja",
    preview: "Preview multibyte markdown support",
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
    turns: []
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

  const { app } = await buildApp({
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

  try {
    const previewResponse = await app.inject({
      method: "POST",
      url: "/api/sessions/fixture_thread_preview_ja/files/preview",
      payload: {
        path: "README.ja.md"
      }
    });
    assert.equal(previewResponse.statusCode, 200);
    const previewPayload = previewResponse.json() as {
      path: string;
      resolvedPath: string | null;
      contentStatus: string;
      isMarkdown: boolean;
      text: string | null;
      imageDataUrl: string | null;
      sizeBytes: number | null;
    };
    assert.equal(previewPayload.path, "README.ja.md");
    assert.equal(previewPayload.resolvedPath, expectedResolvedPath);
    assert.equal(previewPayload.contentStatus, "ok");
    assert.equal(previewPayload.isMarkdown, true);
    assert.equal(previewPayload.imageDataUrl, null);
    assert.equal(previewPayload.text, previewContent);
    assert.equal(previewPayload.sizeBytes, Buffer.byteLength(previewContent, "utf8"));
  } finally {
    await app.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("bridge smoke test broadcasts session updates when a session is renamed", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-rename-"));
  const repoPath = path.join(rootDir, "repo");
  const dataDir = path.join(rootDir, "data");
  const uploadsDir = path.join(dataDir, "uploads");
  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(uploadsDir, { recursive: true });

  const thread: CodexThread = {
    id: "fixture_thread_rename",
    preview: "Original thread title source",
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
        id: "fixture_turn_rename_1",
        status: "completed",
        error: null,
        items: [
          {
            type: "userMessage",
            id: "fixture_user_rename_1",
            content: [
              {
                type: "text",
                text: "Original thread title source",
                text_elements: []
              }
            ]
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

    const renameResponse = await app.inject({
      method: "PATCH",
      url: "/api/sessions/fixture_thread_rename",
      payload: {
        title: "Renamed session"
      }
    });
    assert.equal(renameResponse.statusCode, 200);
    const renamePayload = renameResponse.json() as {
      session: { id: string; title: string };
    };
    assert.equal(renamePayload.session.id, "fixture_thread_rename");
    assert.equal(renamePayload.session.title, "Renamed session");

    const sessionUpdated = await wsEvents.waitFor(
      (event): event is Extract<ServerWsEvent, { type: "sessions.updated" }> =>
        event.type === "sessions.updated" && event.session.id === "fixture_thread_rename"
    );
    assert.equal(sessionUpdated.session.title, "Renamed session");

    const detailUpdated = await wsEvents.waitFor(
      (event): event is Extract<ServerWsEvent, { type: "session.updated" }> =>
        event.type === "session.updated" && event.detail.session.id === "fixture_thread_rename"
    );
    assert.equal(detailUpdated.detail.session.title, "Renamed session");

    const sessionsResponse = await app.inject({
      method: "GET",
      url: "/api/sessions"
    });
    assert.equal(sessionsResponse.statusCode, 200);
    const sessionsPayload = sessionsResponse.json() as {
      sessions: Array<{ id: string; title: string }>;
    };
    assert.equal(sessionsPayload.sessions[0]?.id, "fixture_thread_rename");
    assert.equal(sessionsPayload.sessions[0]?.title, "Renamed session");
  } finally {
    wsEvents.socket.emit("close");
    await app.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("bridge smoke test allows archiving after an immediate interrupt when the raw thread is still active", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-archive-interrupt-"));
  const repoPath = path.join(rootDir, "repo");
  const dataDir = path.join(rootDir, "data");
  const uploadsDir = path.join(dataDir, "uploads");
  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(uploadsDir, { recursive: true });

  const thread: CodexThread = {
    id: "fixture_thread_interrupt_archive",
    preview: "Interrupt then archive",
    createdAt: 1711756800,
    updatedAt: 1711756860,
    status: {
      type: "active",
      activeFlags: []
    },
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
        id: "fixture_turn_interrupt_archive_1",
        status: "inProgress",
        error: null,
        items: [
          {
            type: "userMessage",
            id: "fixture_user_interrupt_archive_1",
            content: [
              {
                type: "text",
                text: "Interrupt then archive",
                text_elements: []
              }
            ]
          }
        ]
      }
    ]
  };

  const backend = new FixtureBridgeBackend([thread], {
    startTurnIdBySession: {
      fixture_thread_interrupt_archive: "fixture_turn_interrupt_archive_1"
    }
  });
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

  const { app } = await buildApp({
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

  try {
    const startRunResponse = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: {
        sessionId: "fixture_thread_interrupt_archive",
        prompt: "Stop right away"
      }
    });
    assert.equal(startRunResponse.statusCode, 200);
    const startRunPayload = startRunResponse.json() as {
      run: { id: string; turnId?: string };
    };
    assert.equal(startRunPayload.run.turnId, "fixture_turn_interrupt_archive_1");

    backend.emit("event", {
      type: "run.interrupted",
      sessionId: "fixture_thread_interrupt_archive",
      runId: startRunPayload.run.id,
      turnId: "fixture_turn_interrupt_archive_1"
    } satisfies CodexBridgeEvent);
    await flushAsyncWork();

    const detailResponse = await app.inject({
      method: "GET",
      url: "/api/sessions/fixture_thread_interrupt_archive"
    });
    assert.equal(detailResponse.statusCode, 200);
    const detailPayload = detailResponse.json() as {
      session: { status: string; statusReasonCode?: string };
      activeRun: { status: string } | null;
      latestRun: { status: string } | null;
    };
    assert.equal(detailPayload.session.status, "interrupted");
    assert.equal(detailPayload.session.statusReasonCode, "local_latest_run_interrupted");
    assert.equal(detailPayload.activeRun, null);
    assert.equal(detailPayload.latestRun?.status, "interrupted");

    const archiveResponse = await app.inject({
      method: "POST",
      url: "/api/sessions/fixture_thread_interrupt_archive/archive"
    });
    assert.equal(archiveResponse.statusCode, 200);
    const archivePayload = archiveResponse.json() as {
      session: { id: string; isArchived: boolean };
      activeRun: null;
    };
    assert.equal(archivePayload.session.id, "fixture_thread_interrupt_archive");
    assert.equal(archivePayload.session.isArchived, true);
    assert.equal(archivePayload.activeRun, null);
  } finally {
    await app.close();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

class FixtureBridgeBackend extends EventEmitter implements CodexBackend {
  private readonly threads = new Map<string, CodexThread>();
  private readonly archivedThreadIds = new Set<string>();
  private readonly pendingRequests = new Map<string, CodexPendingRequest>();
  private readonly startTurnIdBySession: Map<string, string>;
  private readonly syncThreadStateFromRunEvents: boolean;

  constructor(
    threads: CodexThread[],
    options?: {
      startTurnIdBySession?: Record<string, string>;
      syncThreadStateFromRunEvents?: boolean;
    }
  ) {
    super();
    for (const thread of threads) {
      this.threads.set(thread.id, thread);
    }
    this.startTurnIdBySession = new Map(Object.entries(options?.startTurnIdBySession ?? {}));
    this.syncThreadStateFromRunEvents = options?.syncThreadStateFromRunEvents === true;
    if (this.syncThreadStateFromRunEvents) {
      this.on("event", (event: CodexBridgeEvent) => {
        this.applyRunEvent(event);
      });
    }
  }

  async start() {}

  async stop() {}

  async createThread(_cwd: string): Promise<{ threadId: string }> {
    throw new Error("Not implemented in fixture backend");
  }

  async listThreads(params?: ListThreadsParams) {
    const archived = params?.archived ?? false;
    return [...this.threads.values()].filter((thread) =>
      archived ? this.archivedThreadIds.has(thread.id) : !this.archivedThreadIds.has(thread.id)
    );
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

  async readFile(_path: string): Promise<CodexFileReadResult> {
    const data = await fs.readFile(_path);
    return {
      dataBase64: data.toString("base64")
    };
  }

  async getFileMetadata(_path: string): Promise<CodexFileMetadata> {
    const stat = await fs.stat(_path);
    return {
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile(),
      createdAtMs: Number.isFinite(stat.birthtimeMs) ? Math.round(stat.birthtimeMs) : null,
      modifiedAtMs: Number.isFinite(stat.mtimeMs) ? Math.round(stat.mtimeMs) : null,
      sizeBytes: stat.isFile() ? stat.size : null
    };
  }

  async setThreadName(threadId: string, name: string) {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`Unknown fixture thread: ${threadId}`);
    }

    this.threads.set(threadId, {
      ...thread,
      name,
      updatedAt: thread.updatedAt + 1
    });
  }

  async archiveThread(threadId: string) {
    if (!this.threads.has(threadId)) {
      throw new Error(`Unknown fixture thread: ${threadId}`);
    }

    this.archivedThreadIds.add(threadId);
  }

  async unarchiveThread(threadId: string) {
    if (!this.threads.has(threadId)) {
      throw new Error(`Unknown fixture thread: ${threadId}`);
    }

    this.archivedThreadIds.delete(threadId);
  }

  async ensureThread(params: EnsureThreadParams) {
    return { threadId: params.threadId ?? "fixture_thread" };
  }

  async startRun(_params: StartRunParams): Promise<StartRunResult> {
    const threadId = _params.sessionId ?? _params.threadId ?? [...this.threads.keys()][0] ?? "fixture_thread";
    const turnId = this.startTurnIdBySession.get(threadId) ?? `fixture_turn_${randomUUID()}`;

    if (this.syncThreadStateFromRunEvents) {
      this.markThreadActive(threadId, turnId);
    }

    return {
      threadId,
      turnId
    };
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

  private markThreadActive(threadId: string, turnId: string) {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return;
    }

    const nextTurn = {
      id: turnId,
      items: [],
      status: "inProgress" as const,
      error: null
    };
    const turns = thread.turns.some((turn) => turn.id === turnId)
      ? thread.turns.map((turn) => (turn.id === turnId ? nextTurn : turn))
      : [...thread.turns, nextTurn];

    this.threads.set(threadId, {
      ...thread,
      status: {
        type: "active",
        activeFlags: []
      },
      updatedAt: thread.updatedAt + 1,
      turns
    });
  }

  private applyRunEvent(event: CodexBridgeEvent) {
    if (event.type !== "run.completed" && event.type !== "run.interrupted" && event.type !== "run.error") {
      return;
    }

    const thread = this.threads.get(event.sessionId);
    if (!thread) {
      return;
    }

    const nextTurnStatus: "completed" | "interrupted" | "failed" =
      event.type === "run.completed"
        ? "completed"
        : event.type === "run.interrupted"
          ? "interrupted"
          : "failed";
    const nextTurn = {
      id: event.turnId,
      items: [],
      status: nextTurnStatus,
      error: event.type === "run.error" ? { message: event.message } : null
    };
    const turns = thread.turns.some((turn) => turn.id === event.turnId)
      ? thread.turns.map((turn) => (turn.id === event.turnId ? nextTurn : turn))
      : [...thread.turns, nextTurn];

    this.threads.set(event.sessionId, {
      ...thread,
      status: { type: "idle" },
      updatedAt: thread.updatedAt + 1,
      turns
    });
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

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
}

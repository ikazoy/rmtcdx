import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LiveCatalogService } from "../../src/catalog/live-catalog-service";
import { parseBridgeNotification } from "../../src/codex/parsers/bridge-events";
import type {
  CodexAccountRateLimits,
  CodexBackend,
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
import { ImageUploadService } from "../../src/uploads/image-upload-service";
import type { CodexAvailableModel, CodexPendingRequest, CodexPendingRequestResponse } from "@codex-remote/shared-types";
import { createIsolatedGitEnv } from "../../src/utils/git-env";

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
  assert.equal(basicDetail.session.statusReasonCode, "latest_turn_completed");
  assert.equal(basicDetail.session.statusConfidence, "authoritative");
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

test("catalog marks an in-progress turn on an inactive thread as suspicious interrupted", async () => {
  const thread: CodexThread = {
    id: "thread_suspect",
    preview: "Long-running task from another client",
    createdAt: 1_774_899_488,
    updatedAt: 1_774_899_499,
    status: { type: "idle" },
    cwd: "/fixtures/workspaces/external-client",
    path: "/fixtures/codex/sessions/external-client.jsonl",
    name: null,
    modelProvider: "openai",
    source: "vscode",
    gitInfo: null,
    turns: [
      {
        id: "turn_suspect_1",
        items: [],
        status: "inProgress",
        error: null
      }
    ]
  };

  const backend = new FixtureCodexBackend([thread]);
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

  const detail = await catalog.getSessionDetail(thread.id);

  assert.equal(detail.session.status, "interrupted");
  assert.equal(detail.session.statusReasonCode, "in_progress_but_thread_inactive");
  assert.equal(detail.session.statusConfidence, "suspicious");
  assert.equal(detail.latestRun?.status, "interrupted");
  assert.equal(detail.activeRun, null);
});

test("catalog keeps the original thread title while previewing the latest user message", async () => {
  const thread: CodexThread = {
    id: "thread_latest_user_preview",
    preview: "Initial request title",
    createdAt: 1_774_899_488,
    updatedAt: 1_774_899_499,
    status: { type: "idle" },
    cwd: "/fixtures/repo",
    path: "/fixtures/codex/sessions/latest-user-preview.jsonl",
    name: null,
    modelProvider: "openai",
    source: "cli",
    gitInfo: null,
    turns: [
      {
        id: "turn_latest_user_preview_1",
        items: [
          {
            type: "userMessage",
            id: "user_latest_user_preview_1",
            content: [{ type: "text", text: "Initial request title", text_elements: [] }]
          },
          {
            type: "agentMessage",
            id: "assistant_latest_user_preview_1",
            text: "First answer",
            phase: "final"
          }
        ],
        status: "completed",
        error: null
      },
      {
        id: "turn_latest_user_preview_2",
        items: [
          {
            type: "userMessage",
            id: "user_latest_user_preview_2",
            content: [{ type: "text", text: "Latest follow-up request", text_elements: [] }]
          },
          {
            type: "agentMessage",
            id: "assistant_latest_user_preview_2",
            text: "Second answer",
            phase: "final"
          }
        ],
        status: "completed",
        error: null
      }
    ]
  };

  const backend = new FixtureCodexBackend([thread]);
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

  const sessions = await catalog.listSessions();

  assert.equal(sessions[0]?.title, "Initial request title");
  assert.equal(sessions[0]?.latestUserPrompt, "Latest follow-up request");
});

test("catalog search matches readable thread previews beyond the title", async () => {
  const latestPromptThread: CodexThread = {
    id: "thread_search_latest_prompt",
    preview: "Initial request title",
    createdAt: 1_774_899_488,
    updatedAt: 1_774_899_500,
    status: { type: "idle" },
    cwd: "/fixtures/repo",
    path: "/fixtures/codex/sessions/search-latest-prompt.jsonl",
    name: null,
    modelProvider: "openai",
    source: "cli",
    gitInfo: null,
    turns: [
      {
        id: "turn_search_latest_prompt_1",
        items: [
          {
            type: "userMessage",
            id: "user_search_latest_prompt_1",
            content: [{ type: "text", text: "Initial request title", text_elements: [] }]
          },
          {
            type: "agentMessage",
            id: "assistant_search_latest_prompt_1",
            text: "First answer",
            phase: "final"
          }
        ],
        status: "completed",
        error: null
      },
      {
        id: "turn_search_latest_prompt_2",
        items: [
          {
            type: "userMessage",
            id: "user_search_latest_prompt_2",
            content: [{ type: "text", text: "Searchable follow-up request", text_elements: [] }]
          }
        ],
        status: "completed",
        error: null
      }
    ]
  };
  const summaryThread: CodexThread = {
    id: "thread_search_summary",
    preview: "Searchable summary preview",
    createdAt: 1_774_899_488,
    updatedAt: 1_774_899_499,
    status: { type: "idle" },
    cwd: "/fixtures/repo",
    path: "/fixtures/codex/sessions/search-summary.jsonl",
    name: "Something else entirely",
    modelProvider: "openai",
    source: "cli",
    gitInfo: null,
    turns: []
  };

  const backend = new FixtureCodexBackend([latestPromptThread, summaryThread]);
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

  const promptMatches = await catalog.listSessions(undefined, { search: "follow-up request" });
  const summaryMatches = await catalog.listSessions(undefined, { search: "summary preview" });

  assert.deepEqual(promptMatches.map((session) => session.id), ["thread_search_latest_prompt"]);
  assert.deepEqual(summaryMatches.map((session) => session.id), ["thread_search_summary"]);
});

test("worktree sessions inherit the configured repo name while keeping a worktree-specific branch", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-worktree-fixture-"));
  const repoPath = path.join(tempDir, "fixture-repo");
  const worktreePath = path.join(tempDir, "rcx-build-worktree");

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await fs.mkdir(repoPath, { recursive: true });
  runGit(repoPath, ["init"]);
  runGit(repoPath, ["config", "user.name", "Fixture User"]);
  runGit(repoPath, ["config", "user.email", "fixture@example.com"]);
  await fs.writeFile(path.join(repoPath, "README.md"), "# fixture\n");
  runGit(repoPath, ["add", "README.md"]);
  runGit(repoPath, ["commit", "-m", "init"]);
  runGit(repoPath, ["branch", "-M", "main"]);
  runGit(repoPath, ["worktree", "add", worktreePath, "-b", "build"]);

  const thread: CodexThread = {
    id: "thread_worktree",
    preview: "Ship the build pipeline update",
    createdAt: 1_774_899_488,
    updatedAt: 1_774_899_499,
    status: { type: "idle" },
    cwd: worktreePath,
    path: null,
    name: null,
    modelProvider: "openai",
    source: "cli",
    gitInfo: null,
    turns: []
  };

  const backend = new FixtureCodexBackend([thread]);
  const catalog = new LiveCatalogService(
    backend,
    [
      {
        id: "fixture_repo",
        path: repoPath,
        name: "Fixture Repo",
        pinned: false
      }
    ],
    uploads
  );

  const sessions = await catalog.listSessions();
  const repos = await catalog.listRepos();
  const worktreeRepo = repos.find((repo) => repo.name === "Fixture Repo" && repo.branch === "build");

  assert.equal(sessions[0]?.repoName, "Fixture Repo");
  assert.ok(worktreeRepo);
  assert.equal(worktreeRepo?.name, "Fixture Repo");
  assert.equal(worktreeRepo?.branch, "build");
  assert.notEqual(worktreeRepo?.id, "fixture_repo");
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
    "item.delta",
    "item.started",
    "activity.started",
    "tool.start",
    "item.delta",
    "activity.updated",
    "item.completed",
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
  assert.ok(toolEditEvents.some((event) => event.type === "item.completed"));
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

function runGit(cwd: string, args: string[]) {
  execFileSync("git", ["-C", cwd, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: createIsolatedGitEnv()
  });
}

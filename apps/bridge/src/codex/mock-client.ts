import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fsp } from "node:fs";

import type { CodexAvailableModel, CodexPendingRequest, CodexPendingRequestResponse } from "@codex-remote/shared-types";

import type {
  CodexAccountRateLimits,
  CodexBackend,
  CodexRuntimeState,
  CodexThread,
  CodexThreadItem,
  CodexThreadTurn,
  CodexUserInput,
  EnsureThreadParams,
  ListThreadsParams,
  LoggerLike,
  SimulatePendingRequestParams,
  StartRunParams
} from "./types";

type MockRunHandle = {
  timers: NodeJS.Timeout[];
  sessionId: string;
  runId: string;
  turnId: string;
  threadId: string;
};

export class MockCodexClient extends EventEmitter implements CodexBackend {
  private readonly runs = new Map<string, MockRunHandle>();
  private readonly threads = new Map<string, CodexThread>();
  private readonly archivedThreadIds = new Set<string>();
  private readonly pendingRequests = new Map<string, CodexPendingRequest>();

  constructor(private readonly logger: LoggerLike) {
    super();
  }

  async start() {
    this.logger.info("Mock Codex backend ready");
  }

  async stop() {
    for (const run of this.runs.values()) {
      run.timers.forEach((timer) => clearTimeout(timer));
    }
    this.runs.clear();
  }

  async createThread(cwd: string) {
    const threadId = `mock_thread_${randomUUID()}`;
    const now = this.nowSeconds();
    this.threads.set(threadId, {
      id: threadId,
      preview: "",
      createdAt: now,
      updatedAt: now,
      status: { type: "idle" },
      cwd,
      path: null,
      name: null,
      modelProvider: "mock",
      source: "appServer",
      gitInfo: {
        sha: null,
        branch: null,
        originUrl: null
      },
      turns: []
    });
    return { threadId };
  }

  async listThreads(params: ListThreadsParams = {}) {
    return [...this.threads.values()]
      .filter((thread) => (params.cwd ? thread.cwd === params.cwd : true))
      .filter((thread) => {
        const archived = this.archivedThreadIds.has(thread.id);
        return params.archived === true ? archived : !archived;
      })
      .filter((thread) =>
        params.searchTerm
          ? `${thread.name ?? ""}\n${thread.preview}`.toLowerCase().includes(params.searchTerm.toLowerCase())
          : true
      )
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async readThread(threadId: string, _options?: { includeTurns?: boolean }) {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`Unknown mock thread: ${threadId}`);
    }
    return thread;
  }

  async listModels(): Promise<CodexAvailableModel[]> {
    return [
      {
        id: "mock-gpt-5_4",
        model: "gpt-5.4",
        displayName: "GPT-5.4",
        description: "Default mock frontier model.",
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Faster responses with lighter reasoning." },
          { reasoningEffort: "medium", description: "Balanced speed and depth." },
          { reasoningEffort: "high", description: "Deeper reasoning for harder tasks." },
          { reasoningEffort: "xhigh", description: "Maximum reasoning depth." }
        ],
        defaultReasoningEffort: "medium",
        inputModalities: ["text", "image"],
        supportsPersonality: true,
        isDefault: true
      },
      {
        id: "mock-gpt-5_4-mini",
        model: "gpt-5.4-mini",
        displayName: "GPT-5.4 Mini",
        description: "Smaller frontier model for faster iteration.",
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fastest response." },
          { reasoningEffort: "medium", description: "Balanced default." },
          { reasoningEffort: "high", description: "More reasoning for harder tasks." }
        ],
        defaultReasoningEffort: "medium",
        inputModalities: ["text", "image"],
        supportsPersonality: true,
        isDefault: false
      },
      {
        id: "mock-gpt-5_3-codex",
        model: "gpt-5.3-codex",
        displayName: "GPT-5.3 Codex",
        description: "Codex-optimized model for code-heavy tasks.",
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast coding assistance." },
          { reasoningEffort: "medium", description: "Balanced coding mode." },
          { reasoningEffort: "high", description: "Deeper reasoning for complex code." }
        ],
        defaultReasoningEffort: "medium",
        inputModalities: ["text", "image"],
        supportsPersonality: true,
        isDefault: false
      }
    ];
  }

  async readAccountRateLimits(): Promise<CodexAccountRateLimits | null> {
    return null;
  }

  async readFile(path: string) {
    const data = await fsp.readFile(path);
    return {
      dataBase64: data.toString("base64")
    };
  }

  async getFileMetadata(path: string) {
    const stat = await fsp.stat(path);
    return {
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile(),
      createdAtMs: Number.isFinite(stat.birthtimeMs) ? Math.round(stat.birthtimeMs) : null,
      modifiedAtMs: Number.isFinite(stat.mtimeMs) ? Math.round(stat.mtimeMs) : null,
      sizeBytes: stat.isFile() ? stat.size : null
    };
  }

  async setThreadName(threadId: string, name: string) {
    this.updateThread(threadId, {
      name
    });
  }

  async archiveThread(threadId: string) {
    if (!this.threads.has(threadId)) {
      throw new Error(`Unknown mock thread: ${threadId}`);
    }

    this.archivedThreadIds.add(threadId);
  }

  async unarchiveThread(threadId: string) {
    if (!this.threads.has(threadId)) {
      throw new Error(`Unknown mock thread: ${threadId}`);
    }

    this.archivedThreadIds.delete(threadId);
  }

  async ensureThread(params: EnsureThreadParams) {
    if (params.threadId) {
      return { threadId: params.threadId };
    }
    return this.createThread(params.cwd);
  }

  async startRun(params: StartRunParams) {
    const threadId = params.threadId ?? (await this.createThread(params.cwd)).threadId;
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`Unknown mock thread: ${threadId}`);
    }

    const turnId = `mock_turn_${randomUUID()}`;
    const sessionId = params.sessionId ?? threadId;
    const prompt = this.inputText(params.input);
    const imageCount = this.inputImageCount(params.input);
    const chunks = [
      "Planning the changes against the selected repository.\n",
      "Scanning current files and deriving the first implementation pass.\n",
      "Applying the main update now.\n"
    ];

    this.pushTurn(thread, {
      id: turnId,
      status: "inProgress",
      error: null,
      items: [
        {
          type: "userMessage",
          id: `item_${randomUUID()}`,
          content: params.input
        } as CodexThreadItem
      ]
    });

    const timers = chunks.map((chunk, index) =>
      setTimeout(() => {
        this.emit("event", {
          type: "message.delta",
          sessionId,
          runId: params.runId,
          turnId,
          text: chunk
        });
      }, 500 + index * 700)
    );

    timers.push(
      setTimeout(() => {
        const text = [
          prompt
            ? `Mock run completed for prompt: ${prompt}`
            : `Mock run completed with ${imageCount} attached image${imageCount === 1 ? "" : "s"}.`,
          "",
          "This is a fallback response from the local mock backend.",
          "Switch CODEX_MODE=real to force Codex app-server usage."
        ].join("\n");

        this.pushThreadItem(threadId, turnId, {
          type: "agentMessage",
          id: `item_${randomUUID()}`,
          text,
          phase: "final"
        });
        this.updateThread(threadId, {
          preview: prompt || this.imagePreview(imageCount),
          name: thread.name ?? this.deriveTitle(prompt, imageCount),
          status: { type: "idle" }
        });
        this.finishTurn(threadId, turnId, "completed");

        this.emit("event", {
          type: "message.final",
          sessionId,
          runId: params.runId,
          turnId,
          text,
          countsUnread: true
        });
        this.emit("event", {
          type: "run.completed",
          sessionId,
          runId: params.runId,
          turnId
        });
        this.runs.delete(params.runId);
      }, 2900)
    );

    this.runs.set(params.runId, {
      sessionId,
      runId: params.runId,
      turnId,
      threadId,
      timers
    });

    return { threadId, turnId };
  }

  async interruptRun(runId: string) {
    const handle = this.runs.get(runId);
    if (!handle) {
      return;
    }

    handle.timers.forEach((timer) => clearTimeout(timer));
    this.runs.delete(runId);
    this.finishTurn(handle.threadId, handle.turnId, "interrupted");
    this.emit("event", {
      type: "run.interrupted",
      sessionId: handle.sessionId,
      runId: handle.runId,
      turnId: handle.turnId
    });
  }

  listPendingRequests(_sessionId?: string): CodexPendingRequest[] {
    return [...this.pendingRequests.values()].filter((request) => (_sessionId ? request.sessionId === _sessionId : true));
  }

  async respondToRequest(
    requestId: string,
    _response: CodexPendingRequestResponse
  ): Promise<CodexPendingRequest | null> {
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
    const request = this.pendingRequestFromSimulation(params);
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
      mode: "mock",
      ready: true,
      childAlive: false,
      restarts: 0
    };
  }

  private deriveTitle(prompt: string, imageCount: number) {
    return prompt.trim().split("\n")[0]?.slice(0, 48) || this.imagePreview(imageCount) || "New session";
  }

  private imagePreview(imageCount: number) {
    return imageCount > 0 ? `${imageCount} image attached${imageCount === 1 ? "" : "s"}` : "";
  }

  private inputText(input: CodexUserInput[]) {
    return input
      .filter((item): item is Extract<CodexUserInput, { type: "text" }> => item.type === "text")
      .map((item) => item.text)
      .join("\n")
      .trim();
  }

  private inputImageCount(input: CodexUserInput[]) {
    return input.filter((item) => item.type === "image" || item.type === "localImage").length;
  }

  private nowSeconds() {
    return Math.floor(Date.now() / 1000);
  }

  private updateThread(threadId: string, patch: Partial<CodexThread>) {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return;
    }
    this.threads.set(threadId, {
      ...thread,
      ...patch,
      updatedAt: this.nowSeconds()
    });
  }

  private pushTurn(thread: CodexThread, turn: CodexThreadTurn) {
    this.threads.set(thread.id, {
      ...thread,
      turns: [...thread.turns, turn],
      updatedAt: this.nowSeconds(),
      status: { type: "active", activeFlags: ["turn"] }
    });
  }

  private pushThreadItem(threadId: string, turnId: string, item: CodexThreadItem) {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return;
    }

    this.threads.set(threadId, {
      ...thread,
      turns: thread.turns.map((turn) =>
        turn.id === turnId
          ? {
              ...turn,
              items: [...turn.items, item]
            }
          : turn
      ),
      updatedAt: this.nowSeconds()
    });
  }

  private finishTurn(threadId: string, turnId: string, status: CodexThreadTurn["status"]) {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return;
    }

    this.threads.set(threadId, {
      ...thread,
      status: status === "failed" ? { type: "systemError" } : { type: "idle" },
      updatedAt: this.nowSeconds(),
      turns: thread.turns.map((turn) =>
        turn.id === turnId
          ? {
              ...turn,
              status
            }
          : turn
      )
    });
  }

  private pendingRequestFromSimulation(params: SimulatePendingRequestParams): CodexPendingRequest {
    const id = `mock_dev_req_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const cwd = params.cwd;

    switch (params.scenario) {
      case "command_approval":
        return {
          type: "command_approval",
          id,
          sessionId: params.sessionId,
          threadId: params.threadId,
          turnId: null,
          itemId: null,
          createdAt,
          approvalId: null,
          reason: "Simulated command approval for UI verification.",
          networkApprovalContext: null,
          command: "npm test -- --runInBand",
          cwd,
          commandActions: [
            { type: "read", command: "cat package.json", name: "cat", path: `${cwd}/package.json` }
          ],
          requestedPermissions: {
            network: { enabled: true },
            fileSystem: {
              read: [`${cwd}/package.json`],
              write: [`${cwd}/tmp`]
            }
          },
          availableDecisions: ["accept", "acceptForSession", "decline", "cancel"]
        };
      case "file_change_approval":
        return {
          type: "file_change_approval",
          id,
          sessionId: params.sessionId,
          threadId: params.threadId,
          turnId: null,
          itemId: null,
          createdAt,
          reason: "Simulated file change approval for UI verification.",
          grantRoot: cwd
        };
      case "permissions_approval":
        return {
          type: "permissions_approval",
          id,
          sessionId: params.sessionId,
          threadId: params.threadId,
          turnId: null,
          itemId: null,
          createdAt,
          reason: "Simulated additional permissions request for UI verification.",
          permissions: {
            network: { enabled: true },
            fileSystem: {
              read: [`${cwd}/docs`],
              write: [`${cwd}/apps/web/src`]
            }
          }
        };
      case "request_user_input":
        return {
          type: "request_user_input",
          id,
          sessionId: params.sessionId,
          threadId: params.threadId,
          turnId: null,
          itemId: null,
          createdAt,
          questions: [
            {
              id: "target_env",
              header: "Target env",
              question: "Which environment should Codex use?",
              isOther: false,
              isSecret: false,
              options: [
                { label: "staging", description: "Use staging configuration." },
                { label: "production", description: "Use production configuration." }
              ]
            }
          ]
        };
      case "mcp_elicitation":
        return {
          type: "mcp_elicitation",
          id,
          sessionId: params.sessionId,
          threadId: params.threadId,
          turnId: null,
          itemId: null,
          createdAt,
          mode: "form",
          serverName: "github",
          message: "Simulated MCP confirmation for UI verification.",
          meta: { requestId: id },
          requestedSchema: {
            type: "object",
            properties: {
              owner: { type: "string" },
              repo: { type: "string" }
            },
            required: ["owner", "repo"]
          }
        };
    }
  }
}

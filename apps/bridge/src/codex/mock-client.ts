import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

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

  async readAccountRateLimits(): Promise<CodexAccountRateLimits | null> {
    return null;
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
}
